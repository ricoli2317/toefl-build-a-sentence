-- TPS student practice entitlements V5 (phase 5: teacher category Assignments).
--
-- MANUAL, additive migration. Execute in the Supabase SQL Editor before
-- deploying the matching application code.
--
-- Scope:
--   * extend writing_assignments task types with bas_category / rap_category;
--   * freeze one multi-category manifest per category Assignment;
--   * create category-specific Assignment create / withdrawn-edit RPCs;
--   * extend BAS Grammar and RAP Question Category sessions for teacher
--     assignments, positive timing, multi-category manifests and Retake;
--   * owner-authorized Student Start/Resume and idempotent Retake;
--   * teacher progress/result locators through the existing Assignment system.
--
-- This migration does NOT:
--   * enable practice_entitlement_runtime_config.enforcement_enabled;
--   * create a second Assignment platform or a second category session table;
--   * spend bas_category / rap_category quota for teacher Assignments;
--   * write ordinary canonical unlocks from category Assignments;
--   * rewrite historical attempts, answers, session progress or results;
--   * implement phase-6 Student quota UI.

begin;

-- ---------------------------------------------------------------------------
-- 0. Production-shape guards
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.practice_entitlement_enforcement_enabled()') is null
     or to_regprocedure('public.practice_grammar_question_has_tag(text,text)') is null then
    raise exception 'TPS_PHASE5_V4_GRAMMAR_HELPERS_REQUIRED';
  end if;
  if to_regclass('public.writing_assignments') is null
     or to_regclass('public.writing_assignment_students') is null
     or to_regclass('public.writing_assignment_groups') is null then
    raise exception 'TPS_PHASE5_ASSIGNMENT_TABLES_REQUIRED';
  end if;
  if to_regclass('public.bas_grammar_practice_sessions') is null
     or to_regclass('public.reading_question_category_sessions') is null then
    raise exception 'TPS_PHASE5_CATEGORY_SESSIONS_REQUIRED';
  end if;
  if to_regclass('public.reading_questions') is null
     or to_regclass('public.questions') is null then
    raise exception 'TPS_PHASE5_QUESTION_BANKS_REQUIRED';
  end if;
  if to_regprocedure('public.reading_category_session_json(public.reading_question_category_sessions)') is null then
    raise exception 'TPS_PHASE5_RAP_CATEGORY_JSON_REQUIRED';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Assignment task types and subject mapping
-- ---------------------------------------------------------------------------
alter table public.writing_assignments
  drop constraint if exists writing_assignments_task_type_check;
alter table public.writing_assignments
  add constraint writing_assignments_task_type_check
  check (task_type in (
    'email',
    'academic_discussion',
    'build_sentence',
    'ctw',
    'rdl',
    'rap',
    'full_set',
    'bas_category',
    'rap_category'
  ));

alter table public.writing_assignments
  drop constraint if exists writing_assignments_subject_item_type_check;
alter table public.writing_assignments
  add constraint writing_assignments_subject_item_type_check
  check (
    (subject = 'writing' and task_type in (
      'email', 'academic_discussion', 'build_sentence', 'bas_category'
    ))
    or (subject = 'reading' and task_type in (
      'ctw', 'rdl', 'rap', 'full_set', 'rap_category'
    ))
  );

create index if not exists writing_assignments_category_assignment_idx
  on public.writing_assignments(teacher_id, task_type, created_at desc)
  where deleted_at is null and task_type in ('bas_category', 'rap_category');

-- Correct-answer snapshots are teacher/service-only. The assigned
-- writing_assignments row is directly SELECTable by its student, so its
-- question_snapshot must never carry this map.
create table if not exists public.category_assignment_answer_snapshots (
  assignment_id uuid primary key
    references public.writing_assignments(assignment_id) on delete cascade,
  answers jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint category_assignment_answer_snapshots_object_check
    check (jsonb_typeof(answers) = 'object')
);

alter table public.category_assignment_answer_snapshots enable row level security;
revoke all on table public.category_assignment_answer_snapshots
  from public, anon, authenticated;
grant select, insert, update, delete
  on table public.category_assignment_answer_snapshots to service_role;

comment on table public.category_assignment_answer_snapshots is
  'Teacher/service-only frozen correct-answer map for category Assignments.';

-- ---------------------------------------------------------------------------
-- 2. One shared frozen category-manifest validator
-- ---------------------------------------------------------------------------
create or replace function public.validate_category_assignment_manifest(
  p_task_type text,
  p_manifest jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total integer;
  v_category_total integer;
  v_first_category text;
begin
  if p_task_type not in ('bas_category', 'rap_category')
     or jsonb_typeof(p_manifest) is distinct from 'object' then
    raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
  end if;

  if p_manifest ->> 'item_type' is distinct from p_task_type
     or nullif(btrim(p_manifest ->> 'item_id'), '') is null then
    raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
  end if;
  if p_task_type = 'bas_category' then
    if p_manifest ->> 'kind' is distinct from 'bas_category_assignment' then
      raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
    end if;
  else
    if p_manifest ->> 'kind' is distinct from 'category_assignment' then
      raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
    end if;
  end if;

  if jsonb_typeof(p_manifest -> 'categories') is distinct from 'array'
     or jsonb_array_length(p_manifest -> 'categories') < 1
     or jsonb_array_length(p_manifest -> 'categories') > 50 then
    raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_manifest -> 'categories') config_category
    where jsonb_typeof(config_category) is distinct from 'object'
      or nullif(btrim(config_category ->> 'category'), '') is null
      or not coalesce(config_category ->> 'count', '') ~ '^[0-9]{1,3}$'
      or (config_category ->> 'count')::integer < 1
  ) or exists (
    select 1 from jsonb_array_elements(p_manifest -> 'categories') config_category
    group by config_category ->> 'category'
    having count(*) > 1
  ) then
    raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
  end if;

  select sum((config_category ->> 'count')::integer)
    into v_category_total
  from jsonb_array_elements(p_manifest -> 'categories') config_category;
  if v_category_total is null
     or v_category_total < 1
     or v_category_total > 500
     or not coalesce(p_manifest ->> 'totalQuestions', '') ~ '^[0-9]{1,3}$'
     or (p_manifest ->> 'totalQuestions')::integer <> v_category_total then
    raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
  end if;
  v_total := v_category_total;

  if p_task_type = 'rap_category' then
    if exists (
      select 1 from jsonb_array_elements(p_manifest -> 'categories') config_category
      where config_category ->> 'category' not in (
        '事实信息题','否定信息题','主旨题','词汇题','选句题',
        '句子简化题','指代题','推断题','修辞目的题','句子插入题'
      )
    ) then
      raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
    end if;
    if jsonb_typeof(p_manifest -> 'groups') is distinct from 'array'
       or jsonb_array_length(p_manifest -> 'groups') < 1 then
      raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
    end if;
    if exists (
      select 1 from jsonb_array_elements(p_manifest -> 'groups') grp
      where jsonb_typeof(grp) is distinct from 'object'
        or nullif(btrim(grp ->> 'logicalItemId'), '') is null
        or jsonb_typeof(grp -> 'targets') is distinct from 'array'
        or jsonb_array_length(grp -> 'targets') < 1
    ) or exists (
      select 1
      from jsonb_array_elements(p_manifest -> 'groups') grp,
        lateral jsonb_array_elements(grp -> 'targets') target
      group by target ->> 'questionId'
      having count(*) > 1
    ) then
      raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(p_manifest -> 'groups') grp
      cross join lateral jsonb_array_elements(grp -> 'targets') target
      left join public.reading_questions question
        on question.question_id = target ->> 'questionId'
       and question.logical_item_id = grp ->> 'logicalItemId'
      where question.question_id is null
        or question.module <> 'rap'
        or question.question_category is distinct from target ->> 'questionCategory'
        or not exists (
          select 1 from jsonb_array_elements(p_manifest -> 'categories') config_category
          where config_category ->> 'category' = target ->> 'questionCategory'
        )
    ) then
      raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
    end if;
    select count(*) into v_category_total
    from jsonb_array_elements(p_manifest -> 'groups') grp
    cross join lateral jsonb_array_elements(grp -> 'targets') target;
    if v_category_total <> v_total then
      raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(p_manifest -> 'categories') config_category
      left join (
        select target ->> 'questionCategory' actual_category, count(*)::integer count
        from jsonb_array_elements(p_manifest -> 'groups') grp
        cross join lateral jsonb_array_elements(grp -> 'targets') target
        group by target ->> 'questionCategory'
      ) actual on actual.actual_category = config_category ->> 'category'
      where coalesce(actual.count, 0) <> (config_category ->> 'count')::integer
    ) then
      raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
    end if;
  else
    if jsonb_typeof(p_manifest -> 'questions') is distinct from 'array'
       or jsonb_array_length(p_manifest -> 'questions') <> v_total then
      raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
    end if;
    if exists (
      select 1 from jsonb_array_elements(p_manifest -> 'questions') question
      where jsonb_typeof(question) is distinct from 'object'
        or nullif(btrim(question ->> 'question_id'), '') is null
        or nullif(btrim(question ->> 'category'), '') is null
        or not coalesce(question ->> 'question_order', '') ~ '^[0-9]{1,3}$'
    ) or exists (
      select 1 from jsonb_array_elements(p_manifest -> 'questions') question
      group by question ->> 'question_id'
      having count(*) > 1
    ) then
      raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(p_manifest -> 'questions') question
      left join public.questions source
        on source.question_id::text = question ->> 'question_id'
      where source.question_id is null
        or not public.practice_grammar_question_has_tag(
          source.grammar_tags_text,
          question ->> 'category'
        )
        or not exists (
          select 1 from jsonb_array_elements(p_manifest -> 'categories') config_category
          where config_category ->> 'category' = question ->> 'category'
        )
    ) then
      raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(p_manifest -> 'categories') config_category
      left join (
        select question ->> 'category' actual_category, count(*)::integer count
        from jsonb_array_elements(p_manifest -> 'questions') question
        group by question ->> 'category'
      ) actual on actual.actual_category = config_category ->> 'category'
      where coalesce(actual.count, 0) <> (config_category ->> 'count')::integer
    ) then
      raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
    end if;
  end if;
end;
$$;

revoke all on function public.validate_category_assignment_manifest(text,jsonb)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Category Assignment creation (one frozen manifest = one Assignment row)
-- ---------------------------------------------------------------------------
create or replace function public.create_category_writing_assignment_group(
  p_teacher_id uuid,
  p_assignment jsonb,
  p_student_ids uuid[],
  p_title text,
  p_title_is_automatic boolean,
  p_subject text,
  p_class_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task_type text;
  v_manifest jsonb;
  v_answers jsonb;
  v_created_assignment_id uuid;
  v_created_group_id uuid;
  v_requested_student_count integer;
  v_valid_student_count integer;
  v_class public.teacher_classes%rowtype;
  v_member_ids uuid[];
  v_recipient_ids uuid[];
  v_base_title text;
  v_final_title text;
  v_base_title_taken boolean := false;
  v_max_sequence integer := 0;
  v_next_sequence integer;
begin
  if not exists (
    select 1 from public.profiles
    where id = p_teacher_id and role = 'teacher' and is_active = true
  ) then
    raise exception 'Invalid teacher';
  end if;
  if p_subject not in ('writing', 'reading') then
    raise exception 'Invalid assignment subject';
  end if;
  if jsonb_typeof(p_assignment) is distinct from 'object' then
    raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
  end if;
  v_task_type := p_assignment ->> 'task_type';
  if v_task_type not in ('bas_category', 'rap_category')
     or (v_task_type = 'bas_category' and p_subject <> 'writing')
     or (v_task_type = 'rap_category' and p_subject <> 'reading') then
    raise exception 'MIXED_ASSIGNMENT_SUBJECT';
  end if;
  if p_assignment ->> 'question_source' <> 'question_bank'
     or nullif(btrim(p_assignment ->> 'question_id'), '') is null then
    raise exception 'Question bank assignment requires question_id';
  end if;
  v_manifest := p_assignment -> 'question_snapshot';
  if jsonb_typeof(v_manifest) is distinct from 'object' then
    raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
  end if;
  v_answers := coalesce(v_manifest -> 'answers', '{}'::jsonb);
  if jsonb_typeof(v_answers) is distinct from 'object' then
    raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
  end if;
  v_manifest := v_manifest - 'answers';
  perform public.validate_category_assignment_manifest(v_task_type, v_manifest);
  if btrim(p_assignment ->> 'question_id')
       is distinct from v_manifest ->> 'item_id' then
    raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
  end if;

  if p_class_id is not null then
    select * into v_class
    from public.teacher_classes
    where class_id = p_class_id
      and public.is_class_teacher(p_class_id, p_teacher_id)
    for update;
    if not found then
      raise exception 'CLASS_NOT_FOUND';
    end if;
    if not exists (
      select 1
      from (
        select subject.domain
        from unnest(v_class.subjects) as subject(domain)
        where v_class.teacher_id = p_teacher_id
        union all
        select unnest(link.subjects) as domain
        from public.teacher_class_bindings link
        where link.class_id = p_class_id
          and link.teacher_id = p_teacher_id
      ) acting_subject
      where acting_subject.domain = p_subject
    ) then
      if p_subject = 'reading' then
        raise exception 'CLASS_NOT_READING_CLASS';
      end if;
      raise exception 'CLASS_NOT_WRITING_CLASS';
    end if;
    select coalesce(array_agg(member.student_id order by member.joined_at, member.student_id), array[]::uuid[])
      into v_member_ids
    from public.class_members member
    where member.class_id = p_class_id;
    if coalesce(array_length(v_member_ids, 1), 0) < 1 then
      raise exception 'CLASS_HAS_NO_MEMBERS';
    end if;
    v_recipient_ids := v_member_ids;
  else
    select coalesce(array_agg(ordered.id order by ordered.position), array[]::uuid[])
      into v_recipient_ids
    from (
      select id, min(ordinality)::integer as position
      from unnest(coalesce(p_student_ids, array[]::uuid[])) with ordinality as submitted(id, ordinality)
      where id is not null
      group by id
    ) ordered;
    if coalesce(array_length(v_recipient_ids, 1), 0) < 1 then
      raise exception 'At least one student is required';
    end if;
  end if;

  v_requested_student_count := array_length(v_recipient_ids, 1);
  select count(*) into v_valid_student_count
  from unnest(v_recipient_ids) as students(id)
  join public.profiles student
    on student.id = students.id
   and student.role = 'student'
   and student.is_active = true
  join public.teacher_student_bindings binding
    on binding.teacher_id = p_teacher_id
   and binding.student_id = students.id
   and binding.domain = p_subject;
  if v_valid_student_count <> v_requested_student_count then
    raise exception 'One or more students are invalid';
  end if;

  v_base_title := nullif(btrim(coalesce(p_title, '')), '');
  if v_base_title is not null and char_length(v_base_title) > 120 then
    raise exception 'Assignment title is too long';
  end if;

  if v_base_title is not null and coalesce(p_title_is_automatic, false) then
    perform pg_advisory_xact_lock(
      hashtextextended(p_teacher_id::text || '|' || v_base_title, 0)
    );
    select
      coalesce(bool_or(group_row.title = v_base_title), false),
      coalesce(max(
        case
          when group_row.title = v_base_title then 1
          else nullif(substring(group_row.title from ' \((\d+)\)$'), '')::integer
        end
      ), 0)
    into v_base_title_taken, v_max_sequence
    from public.writing_assignment_groups group_row
    where group_row.teacher_id = p_teacher_id
      and group_row.title is not null
      and left(group_row.title, char_length(v_base_title)) = v_base_title
      and (group_row.title = v_base_title
        or substring(group_row.title from ' \((\d+)\)$') is not null)
      and exists (
        select 1 from public.writing_assignments item
        where item.group_id = group_row.group_id
          and item.deleted_at is null
      );

    if not v_base_title_taken then
      v_final_title := v_base_title;
    else
      select free.sequence into v_next_sequence
      from generate_series(2, greatest(v_max_sequence, 1) + 1) as free(sequence)
      where not exists (
        select 1 from public.writing_assignment_groups taken
        where taken.teacher_id = p_teacher_id
          and taken.title = v_base_title || ' (' || free.sequence || ')'
          and exists (
            select 1 from public.writing_assignments item
            where item.group_id = taken.group_id
              and item.deleted_at is null
          )
      )
      order by free.sequence
      limit 1;
      v_final_title := v_base_title || ' (' || v_next_sequence || ')';
    end if;
    if char_length(v_final_title) > 120 then
      raise exception 'Assignment title is too long';
    end if;
  else
    v_final_title := v_base_title;
  end if;

  insert into public.writing_assignment_groups (teacher_id, title, class_id)
  values (p_teacher_id, v_final_title, p_class_id)
  returning group_id into v_created_group_id;

  insert into public.writing_assignments (
    teacher_id, subject, group_id, group_position, task_type, question_source,
    question_id, question_snapshot, due_at
  ) values (
    p_teacher_id, p_subject, v_created_group_id, 1,
    v_task_type, 'question_bank',
    btrim(p_assignment ->> 'question_id'),
    v_manifest,
    nullif(p_assignment ->> 'due_at', '')::timestamptz
  ) returning assignment_id into v_created_assignment_id;

  insert into public.category_assignment_answer_snapshots (assignment_id, answers, updated_at)
  values (v_created_assignment_id, v_answers, clock_timestamp())
  on conflict (assignment_id) do update
  set answers = excluded.answers, updated_at = clock_timestamp();

  insert into public.writing_assignment_students (assignment_id, student_id, sort_order)
  select v_created_assignment_id, ordered.id, ordered.position
  from (
    select id, ordinality::integer as position
    from unnest(v_recipient_ids) with ordinality as ordered(id, ordinality)
  ) ordered;

  return jsonb_build_object(
    'group_id', v_created_group_id,
    'assignment_ids', jsonb_build_array(v_created_assignment_id),
    'title', v_final_title,
    'subject', p_subject,
    'class_id', p_class_id
  );
end;
$$;

revoke all on function public.create_category_writing_assignment_group(uuid,jsonb,uuid[],text,boolean,text,uuid)
  from public, anon, authenticated;
grant execute on function public.create_category_writing_assignment_group(uuid,jsonb,uuid[],text,boolean,text,uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4. Category Assignment withdrawn edit (one manifest item)
-- ---------------------------------------------------------------------------
create or replace function public.update_withdrawn_category_assignment_group(
  p_teacher_id uuid,
  p_group_id uuid,
  p_legacy_assignment_id uuid,
  p_title text,
  p_item jsonb,
  p_student_ids uuid[],
  p_due_at timestamptz,
  p_reactivate boolean default false,
  p_class_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_effective_group_id uuid;
  v_current public.writing_assignments%rowtype;
  v_task_type text;
  v_manifest jsonb;
  v_answers jsonb;
  v_assignment_id uuid;
  v_subject text;
  v_class public.teacher_classes%rowtype;
  v_recipient_ids uuid[];
  v_requested_student_count integer;
  v_valid_student_count integer;
  v_visible_count integer;
begin
  if p_group_id is not null then
    perform 1 from public.writing_assignment_groups
    where group_id = p_group_id and teacher_id = p_teacher_id
    for update;
    if not found then raise exception 'ASSIGNMENT_GROUP_NOT_FOUND'; end if;
    v_effective_group_id := p_group_id;
    perform 1 from public.writing_assignments
    where group_id = p_group_id and deleted_at is null
    for update;
  elsif p_legacy_assignment_id is not null then
    select * into v_current from public.writing_assignments
    where assignment_id = p_legacy_assignment_id
      and teacher_id = p_teacher_id
      and deleted_at is null
    for update;
    if not found then raise exception 'ASSIGNMENT_NOT_FOUND'; end if;
    if v_current.group_id is null then
      insert into public.writing_assignment_groups (teacher_id, title)
      values (p_teacher_id, nullif(btrim(coalesce(p_title, '')), ''))
      returning group_id into v_effective_group_id;
      update public.writing_assignments
      set group_id = v_effective_group_id, group_position = 1
      where assignment_id = p_legacy_assignment_id;
    else
      v_effective_group_id := v_current.group_id;
      perform 1 from public.writing_assignment_groups
      where group_id = v_effective_group_id and teacher_id = p_teacher_id
      for update;
      if not found then raise exception 'ASSIGNMENT_GROUP_NOT_FOUND'; end if;
    end if;
    perform 1 from public.writing_assignments
    where group_id = v_effective_group_id and deleted_at is null
    for update;
  else
    raise exception 'ASSIGNMENT_GROUP_NOT_FOUND';
  end if;

  select count(*) into v_visible_count
  from public.writing_assignments
  where group_id = v_effective_group_id and deleted_at is null;
  if v_visible_count <> 1 then raise exception 'INVALID_GROUP_ITEMS'; end if;
  if exists (
    select 1 from public.writing_assignments
    where group_id = v_effective_group_id and deleted_at is null and status <> 'withdrawn'
  ) then
    raise exception 'ASSIGNMENT_GROUP_NOT_WITHDRAWN';
  end if;
  if jsonb_typeof(p_item) is distinct from 'object' then
    raise exception 'INVALID_GROUP_ITEMS';
  end if;
  v_task_type := p_item ->> 'task_type';
  v_subject := case
    when v_task_type = 'bas_category' then 'writing'
    when v_task_type = 'rap_category' then 'reading'
    else null
  end;
  if v_subject is null then raise exception 'INVALID_TASK_TYPE'; end if;
  if p_item ->> 'question_source' <> 'question_bank'
     or nullif(btrim(p_item ->> 'question_id'), '') is null then
    raise exception 'QUESTION_REQUIRED';
  end if;
  v_manifest := p_item -> 'question_snapshot';
  if jsonb_typeof(v_manifest) is distinct from 'object' then
    raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
  end if;
  v_answers := coalesce(v_manifest -> 'answers', '{}'::jsonb);
  if jsonb_typeof(v_answers) is distinct from 'object' then
    raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
  end if;
  v_manifest := v_manifest - 'answers';
  perform public.validate_category_assignment_manifest(v_task_type, v_manifest);
  if btrim(p_item ->> 'question_id')
       is distinct from v_manifest ->> 'item_id' then
    raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
  end if;
  if nullif(btrim(p_item ->> 'assignment_id'), '') is not null
     and (p_item ->> 'assignment_id')::uuid <> (
       select assignment_id from public.writing_assignments
       where group_id = v_effective_group_id and deleted_at is null
     ) then
    raise exception 'INVALID_GROUP_ITEMS';
  end if;

  if p_class_id is not null then
    select * into v_class from public.teacher_classes
    where class_id = p_class_id
      and public.is_class_teacher(p_class_id, p_teacher_id)
    for update;
    if not found then raise exception 'CLASS_NOT_FOUND'; end if;
    if not exists (
      select 1 from (
        select subject.domain from unnest(v_class.subjects) as subject(domain)
        where v_class.teacher_id = p_teacher_id
        union all
        select unnest(link.subjects) from public.teacher_class_bindings link
        where link.class_id = p_class_id and link.teacher_id = p_teacher_id
      ) acting_subject
      where acting_subject.domain = v_subject
    ) then
      if v_subject = 'reading' then raise exception 'CLASS_NOT_READING_CLASS'; end if;
      raise exception 'CLASS_NOT_WRITING_CLASS';
    end if;
    select coalesce(array_agg(member.student_id order by member.joined_at, member.student_id), array[]::uuid[])
      into v_recipient_ids
    from public.class_members member
    where member.class_id = p_class_id;
    if coalesce(array_length(v_recipient_ids, 1), 0) < 1 then
      raise exception 'CLASS_HAS_NO_MEMBERS';
    end if;
  else
    select coalesce(array_agg(ordered.id order by ordered.position), array[]::uuid[])
      into v_recipient_ids
    from (
      select id, min(ordinality)::integer as position
      from unnest(coalesce(p_student_ids, array[]::uuid[])) with ordinality as submitted(id, ordinality)
      where id is not null
      group by id
    ) ordered;
    if coalesce(array_length(v_recipient_ids, 1), 0) < 1 then
      raise exception 'STUDENT_REQUIRED';
    end if;
  end if;
  v_requested_student_count := array_length(v_recipient_ids, 1);
  select count(*) into v_valid_student_count
  from unnest(v_recipient_ids) as students(id)
  join public.profiles student
    on student.id = students.id and student.role = 'student' and student.is_active = true
  join public.teacher_student_bindings binding
    on binding.teacher_id = p_teacher_id
   and binding.student_id = students.id
   and binding.domain = v_subject;
  if v_valid_student_count <> v_requested_student_count then
    raise exception 'INVALID_STUDENT';
  end if;

  if p_title is not null and btrim(p_title) <> '' then
    if char_length(btrim(p_title)) > 120 then raise exception 'Assignment title is too long'; end if;
    update public.writing_assignment_groups
    set title = btrim(p_title)
    where group_id = v_effective_group_id and teacher_id = p_teacher_id;
  end if;
  update public.writing_assignment_groups
  set class_id = p_class_id
  where group_id = v_effective_group_id and teacher_id = p_teacher_id;

  update public.writing_assignments
  set task_type = v_task_type,
      subject = v_subject,
      question_source = 'question_bank',
      question_id = btrim(p_item ->> 'question_id'),
      question_snapshot = v_manifest,
      due_at = p_due_at,
      status = case when coalesce(p_reactivate, false) then 'active' else 'withdrawn' end
  where group_id = v_effective_group_id
    and deleted_at is null
  returning assignment_id into v_assignment_id;

  insert into public.category_assignment_answer_snapshots (assignment_id, answers, updated_at)
  values (v_assignment_id, v_answers, clock_timestamp())
  on conflict (assignment_id) do update
  set answers = excluded.answers, updated_at = clock_timestamp();

  delete from public.writing_assignment_students member
  where member.assignment_id in (
    select assignment_id from public.writing_assignments
    where group_id = v_effective_group_id and deleted_at is null
  )
    and not (member.student_id = any(v_recipient_ids));
  insert into public.writing_assignment_students (assignment_id, student_id, sort_order)
  select item.assignment_id, ordered.id, ordered.position
  from public.writing_assignments item
  cross join (
    select id, ordinality::integer as position
    from unnest(v_recipient_ids) with ordinality as ordered(id, ordinality)
  ) ordered
  where item.group_id = v_effective_group_id
    and item.deleted_at is null
  on conflict (assignment_id, student_id)
    do update set sort_order = excluded.sort_order;

  return jsonb_build_object(
    'group_id', v_effective_group_id,
    'item_count', 1,
    'student_count', v_requested_student_count,
    'class_id', p_class_id,
    'status', case when coalesce(p_reactivate, false) then 'active' else 'withdrawn' end
  );
end;
$$;

revoke all on function public.update_withdrawn_category_assignment_group(uuid,uuid,uuid,text,jsonb,uuid[],timestamptz,boolean,uuid)
  from public, anon, authenticated;
grant execute on function public.update_withdrawn_category_assignment_group(uuid,uuid,uuid,text,jsonb,uuid[],timestamptz,boolean,uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 5. Withdrawal must also see category sessions
-- ---------------------------------------------------------------------------
create or replace function public.withdraw_writing_assignment_group(
  p_teacher_id uuid,
  p_group_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item_count integer;
  v_active_count integer;
  v_attempt_count integer;
  v_category_session_count integer;
  v_withdrawn_count integer := 0;
begin
  perform 1 from public.writing_assignment_groups
  where group_id = p_group_id and teacher_id = p_teacher_id
  for update;
  if not found then raise exception 'ASSIGNMENT_GROUP_NOT_FOUND'; end if;
  perform 1 from public.writing_assignments
  where group_id = p_group_id and deleted_at is null
  for update;
  select count(*) into v_item_count from public.writing_assignments
  where group_id = p_group_id and deleted_at is null;
  if v_item_count < 1 then raise exception 'ASSIGNMENT_GROUP_NOT_FOUND'; end if;
  select count(*) into v_active_count from public.writing_assignments
  where group_id = p_group_id and deleted_at is null and status = 'active';
  if v_active_count <> v_item_count then raise exception 'ASSIGNMENT_GROUP_NOT_ACTIVE'; end if;

  select count(*) into v_attempt_count from public.writing_attempts attempt
  where attempt.assignment_id in (
    select item.assignment_id from public.writing_assignments item
    where item.group_id = p_group_id and item.deleted_at is null
  );
  select count(*) into v_category_session_count
  from (
    select 1 from public.bas_grammar_practice_sessions session
    where session.assignment_id in (
      select item.assignment_id from public.writing_assignments item
      where item.group_id = p_group_id and item.deleted_at is null
    )
    union all
    select 1 from public.reading_question_category_sessions session
    where session.assignment_id in (
      select item.assignment_id from public.writing_assignments item
      where item.group_id = p_group_id and item.deleted_at is null
    )
  ) category_session;
  if v_attempt_count + v_category_session_count > 0 then
    raise exception 'ASSIGNMENT_GROUP_HAS_ATTEMPT';
  end if;

  update public.writing_assignments
  set status = 'withdrawn'
  where group_id = p_group_id and deleted_at is null and status = 'active';
  get diagnostics v_withdrawn_count = row_count;
  return jsonb_build_object('group_id', p_group_id, 'withdrawn_count', v_withdrawn_count);
end;
$$;

revoke all on function public.withdraw_writing_assignment_group(uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.withdraw_writing_assignment_group(uuid,uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 6. BAS Grammar category Assignment sessions
-- ---------------------------------------------------------------------------
alter table public.bas_grammar_practice_sessions
  add column if not exists categories jsonb not null default '[]'::jsonb;

do $$
declare
  v_name text;
begin
  for v_name in
    select conname from pg_constraint
    where conrelid = 'public.bas_grammar_practice_sessions'::regclass
      and contype = 'c'
      and (
        pg_get_constraintdef(oid) like '%mode = ''random''%'
        or pg_get_constraintdef(oid) like '%total_questions%'
      )
  loop
    execute format('alter table public.bas_grammar_practice_sessions drop constraint %I', v_name);
  end loop;
end;
$$;

alter table public.bas_grammar_practice_sessions
  drop constraint if exists bas_grammar_practice_sessions_mode_check,
  drop constraint if exists bas_grammar_practice_sessions_categories_check,
  drop constraint if exists bas_grammar_practice_sessions_total_check,
  drop constraint if exists bas_grammar_practice_sessions_correct_check,
  drop constraint if exists bas_grammar_practice_sessions_origin_assignment_check;

alter table public.bas_grammar_practice_sessions
  add constraint bas_grammar_practice_sessions_mode_check
    check (mode in ('random', 'assignment')),
  add constraint bas_grammar_practice_sessions_categories_check
    check (jsonb_typeof(categories) = 'array'),
  add constraint bas_grammar_practice_sessions_total_check
    check (total_questions between 0 and 500),
  add constraint bas_grammar_practice_sessions_correct_check
    check (correct_count between 0 and total_questions),
  add constraint bas_grammar_practice_sessions_origin_assignment_check
    check (
      (origin = 'self_practice' and assignment_id is null)
      or (origin = 'teacher_assigned' and assignment_id is not null)
    );

create unique index if not exists bas_grammar_practice_active_assignment_uidx
  on public.bas_grammar_practice_sessions(student_id, assignment_id)
  where status = 'active' and assignment_id is not null;
create index if not exists bas_grammar_practice_assignment_history_idx
  on public.bas_grammar_practice_sessions(student_id, assignment_id, started_at desc)
  where assignment_id is not null;
create index if not exists bas_grammar_practice_assignment_idx
  on public.bas_grammar_practice_sessions(assignment_id)
  where assignment_id is not null;

create or replace function public.guard_bas_grammar_practice_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_question_count integer;
begin
  if tg_op = 'UPDATE' then
    if new.student_id is distinct from old.student_id
       or new.category is distinct from old.category
       or new.mode is distinct from old.mode
       or new.origin is distinct from old.origin
       or new.assignment_id is distinct from old.assignment_id
       or new.start_request_id is distinct from old.start_request_id
       or new.manifest is distinct from old.manifest
       or new.categories is distinct from old.categories then
      raise exception 'BAS_GRAMMAR_SESSION_IDENTITY_IMMUTABLE';
    end if;
    if old.status = 'completed' and (
      new.status is distinct from old.status
      or new.completed_at is distinct from old.completed_at
      or new.elapsed_seconds is distinct from old.elapsed_seconds
      or new.total_questions is distinct from old.total_questions
      or new.correct_count is distinct from old.correct_count
      or new.attempt_id is distinct from old.attempt_id
      or new.draft is distinct from old.draft
    ) then
      raise exception 'BAS_GRAMMAR_SESSION_COMPLETED_IMMUTABLE';
    end if;
    return new;
  end if;

  if not exists (
    select 1 from public.profiles profile
    where profile.id = new.student_id
      and profile.is_active
      and profile.role::text in ('student', 'teacher', 'admin')
  ) then
    raise exception 'BAS_GRAMMAR_STUDENT_REQUIRED';
  end if;

  if new.origin = 'self_practice' then
    if new.mode <> 'random' or new.assignment_id is not null then
      raise exception 'BAS_GRAMMAR_ORIGIN_NOT_AVAILABLE';
    end if;
    if new.manifest ->> 'kind' is distinct from 'bas_grammar'
       or new.manifest ->> 'category' is distinct from new.category
       or jsonb_typeof(new.manifest -> 'questions') is distinct from 'array' then
      raise exception 'BAS_GRAMMAR_INVALID_MANIFEST';
    end if;
    v_count := jsonb_array_length(new.manifest -> 'questions');
    if v_count < 1 or v_count > 10 then
      raise exception 'BAS_GRAMMAR_INVALID_MANIFEST';
    end if;
    if exists (
      select 1 from jsonb_array_elements(new.manifest -> 'questions') question
      where jsonb_typeof(question) is distinct from 'object'
        or nullif(btrim(question ->> 'question_id'), '') is null
    ) or exists (
      select 1 from jsonb_array_elements(new.manifest -> 'questions') question
      group by question ->> 'question_id'
      having count(*) > 1
    ) or exists (
      select 1 from jsonb_array_elements(new.manifest -> 'questions') question
      left join public.questions source
        on source.question_id::text = question ->> 'question_id'
      where source.question_id is null
        or not public.practice_grammar_question_has_tag(
          source.grammar_tags_text,
          new.category
        )
    ) then
      raise exception 'BAS_GRAMMAR_INVALID_MANIFEST';
    end if;
    return new;
  end if;

  if new.origin <> 'teacher_assigned'
     or new.mode <> 'assignment'
     or new.assignment_id is null then
    raise exception 'BAS_GRAMMAR_ORIGIN_NOT_AVAILABLE';
  end if;
  if not exists (
    select 1 from public.writing_assignments assignment
    where assignment.assignment_id = new.assignment_id
      and assignment.task_type = 'bas_category'
      and assignment.status = 'active'
      and assignment.deleted_at is null
  ) then
    raise exception 'BAS_GRAMMAR_ASSIGNMENT_NOT_AVAILABLE';
  end if;
  if new.manifest ? 'answers' then
    raise exception 'BAS_GRAMMAR_INVALID_MANIFEST';
  end if;
  perform public.validate_category_assignment_manifest(
    'bas_category',
    new.manifest
  );
  if new.categories is distinct from new.manifest -> 'categories' then
    raise exception 'BAS_GRAMMAR_INVALID_MANIFEST';
  end if;
  v_question_count := jsonb_array_length(new.manifest -> 'questions');
  if new.total_questions <> v_question_count then
    raise exception 'BAS_GRAMMAR_INVALID_MANIFEST';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_bas_grammar_practice_session()
  from public, anon, authenticated;

drop trigger if exists bas_grammar_practice_session_guard
  on public.bas_grammar_practice_sessions;
create trigger bas_grammar_practice_session_guard
before insert or update on public.bas_grammar_practice_sessions
for each row execute function public.guard_bas_grammar_practice_session();

create or replace function public.bas_grammar_session_json(
  p_session public.bas_grammar_practice_sessions
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'sessionId', p_session.session_id,
    'category', p_session.category,
    'mode', p_session.mode,
    'origin', p_session.origin,
    'assignmentId', p_session.assignment_id,
    'status', p_session.status,
    'questions', p_session.manifest -> 'questions',
    'categories', p_session.categories,
    'draft', p_session.draft,
    'startedAt', p_session.started_at,
    'completedAt', p_session.completed_at,
    'elapsedSeconds', p_session.elapsed_seconds,
    'totalQuestions', coalesce(nullif(p_session.total_questions, 0),
      jsonb_array_length(p_session.manifest -> 'questions')),
    'correctCount', p_session.correct_count,
    'attemptId', p_session.attempt_id
  );
$$;

revoke all on function public.bas_grammar_session_json(public.bas_grammar_practice_sessions)
  from public, anon, authenticated;

create or replace function public.get_or_create_bas_category_assignment_session(
  p_assignment_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_assignment public.writing_assignments%rowtype;
  v_existing public.bas_grammar_practice_sessions%rowtype;
  v_session public.bas_grammar_practice_sessions%rowtype;
  v_manifest jsonb;
  v_categories jsonb;
  v_total integer;
  v_summary text;
  v_first_category text;
begin
  if v_user_id is null or p_assignment_id is null or p_request_id is null then
    raise exception using errcode = '42501', message = 'BAS_GRAMMAR_UNAUTHORIZED';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = v_user_id and role = 'student' and is_active = true
  ) then
    raise exception using errcode = '42501', message = 'BAS_GRAMMAR_UNAUTHORIZED';
  end if;

  select * into v_assignment
  from public.writing_assignments assignment
  where assignment.assignment_id = p_assignment_id
    and assignment.task_type = 'bas_category'
    and assignment.status = 'active'
    and assignment.deleted_at is null;
  if not found then
    raise exception 'BAS_GRAMMAR_ASSIGNMENT_NOT_AVAILABLE';
  end if;
  if not exists (
    select 1 from public.writing_assignment_students membership
    where membership.assignment_id = p_assignment_id
      and membership.student_id = v_user_id
  ) then
    raise exception 'BAS_GRAMMAR_ASSIGNMENT_NOT_ASSIGNED';
  end if;
  -- The Assignment snapshot keeps the answer map for teacher/result use, but
  -- the Student-owned session manifest must never carry correct answers.
  v_manifest := v_assignment.question_snapshot - 'answers';
  perform public.validate_category_assignment_manifest('bas_category', v_manifest);
  if btrim(v_assignment.question_id) is distinct from v_manifest ->> 'item_id' then
    raise exception 'BAS_GRAMMAR_ASSIGNMENT_NOT_AVAILABLE';
  end if;
  v_categories := v_manifest -> 'categories';
  v_total := (v_manifest ->> 'totalQuestions')::integer;
  v_summary := coalesce(
    nullif(v_manifest ->> 'categorySummary', ''),
    nullif(v_manifest ->> 'set_title', ''),
    '分类练习'
  );
  v_first_category := v_categories -> 0 ->> 'category';

  perform pg_advisory_xact_lock(
    hashtextextended(v_user_id::text || '|' || p_assignment_id::text, 0)
  );

  select * into v_existing
  from public.bas_grammar_practice_sessions session
  where session.student_id = v_user_id
    and session.start_request_id = p_request_id;
  if found then
    if v_existing.assignment_id is distinct from p_assignment_id then
      raise exception 'BAS_GRAMMAR_REQUEST_ID_CONFLICT';
    end if;
    return jsonb_build_object(
      'created', false,
      'session', public.bas_grammar_session_json(v_existing)
    );
  end if;
  select * into v_existing
  from public.bas_grammar_practice_sessions session
  where session.student_id = v_user_id
    and session.assignment_id = p_assignment_id
    and session.status = 'active'
  order by session.started_at desc
  limit 1
  for update;
  if found then
    return jsonb_build_object(
      'created', false,
      'session', public.bas_grammar_session_json(v_existing)
    );
  end if;

  insert into public.bas_grammar_practice_sessions (
    student_id, category, mode, origin, assignment_id, start_request_id,
    manifest, categories, draft, status, total_questions, correct_count
  ) values (
    v_user_id, v_summary, 'assignment', 'teacher_assigned', p_assignment_id,
    p_request_id, v_manifest, v_categories, '{}'::jsonb, 'active', v_total, 0
  )
  returning * into v_session;

  return jsonb_build_object(
    'created', true,
    'session', public.bas_grammar_session_json(v_session)
  );
end;
$$;

revoke all on function public.get_or_create_bas_category_assignment_session(uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.get_or_create_bas_category_assignment_session(uuid,uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 7. RAP Question Category Assignment sessions
-- ---------------------------------------------------------------------------
alter table public.reading_question_category_sessions
  add column if not exists categories jsonb not null default '[]'::jsonb;

do $$
declare
  v_name text;
begin
  for v_name in
    select conname from pg_constraint
    where conrelid = 'public.reading_question_category_sessions'::regclass
      and contype = 'c'
      and (
        pg_get_constraintdef(oid) like '%amount%'
        or pg_get_constraintdef(oid) like '%total_points%'
      )
  loop
    execute format('alter table public.reading_question_category_sessions drop constraint %I', v_name);
  end loop;
end;
$$;

alter table public.reading_question_category_sessions
  drop constraint if exists reading_category_amount_check,
  drop constraint if exists reading_category_categories_check,
  drop constraint if exists reading_category_total_points_check,
  drop constraint if exists reading_category_correct_points_check;

alter table public.reading_question_category_sessions
  add constraint reading_category_amount_check
    check (amount between 1 and 500),
  add constraint reading_category_categories_check
    check (jsonb_typeof(categories) = 'array'),
  add constraint reading_category_total_points_check
    check (total_points between 0 and 500),
  add constraint reading_category_correct_points_check
    check (correct_points between 0 and total_points);

create unique index if not exists reading_category_active_assignment_uidx
  on public.reading_question_category_sessions(student_id, assignment_id)
  where status = 'active' and assignment_id is not null;
create index if not exists reading_category_assignment_history_idx
  on public.reading_question_category_sessions(student_id, assignment_id, created_at desc)
  where assignment_id is not null;
create index if not exists reading_category_assignment_idx
  on public.reading_question_category_sessions(assignment_id)
  where assignment_id is not null;

create or replace function public.guard_reading_category_manifest()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_pool integer;
  v_total integer;
  v_first_category text;
begin
  if tg_op = 'UPDATE' then
    if new.manifest is distinct from old.manifest
       or new.student_id <> old.student_id
       or new.question_category <> old.question_category
       or new.amount <> old.amount
       or new.categories is distinct from old.categories then
      raise exception 'READING_INVALID_CATEGORY_MANIFEST_MUTATION';
    end if;
    if old.status = 'completed' and (
      new.status <> old.status
      or new.completed_at is distinct from old.completed_at
      or new.progress is distinct from old.progress
      or new.elapsed_seconds <> old.elapsed_seconds
      or new.total_points <> old.total_points
      or new.correct_points <> old.correct_points
    ) then
      raise exception 'READING_INVALID_COMPLETED_CATEGORY_MUTATION';
    end if;
    return new;
  end if;

  if not exists (
    select 1 from public.profiles
    where id = new.student_id and is_active
      and role::text in ('student', 'teacher', 'admin')
  ) then
    raise exception 'READING_STUDENT_REQUIRED';
  end if;

  if new.manifest ->> 'kind' = 'category_assignment' then
    if new.origin <> 'teacher_assigned' or new.assignment_id is null then
      raise exception 'READING_INVALID_CATEGORY_MANIFEST';
    end if;
    if not exists (
      select 1 from public.writing_assignments assignment
      where assignment.assignment_id = new.assignment_id
        and assignment.task_type = 'rap_category'
        and assignment.status = 'active'
        and assignment.deleted_at is null
    ) then
      raise exception 'READING_ASSIGNMENT_NOT_AVAILABLE';
    end if;
    if new.manifest ? 'answers' then
      raise exception 'READING_INVALID_CATEGORY_MANIFEST';
    end if;
    perform public.validate_category_assignment_manifest(
      'rap_category',
      new.manifest
    );
    v_first_category := new.manifest -> 'categories' -> 0 ->> 'category';
    v_total := (new.manifest ->> 'totalQuestions')::integer;
    if new.categories is distinct from new.manifest -> 'categories'
       or new.amount <> v_total
       or new.question_category is distinct from v_first_category then
      raise exception 'READING_INVALID_CATEGORY_MANIFEST';
    end if;
    return new;
  end if;

  if new.origin <> 'self_practice'
     or new.assignment_id is not null
     or new.amount not in (5, 10, 15, 20) then
    raise exception 'READING_INVALID_CATEGORY_MANIFEST';
  end if;
  if new.manifest ->> 'kind' is distinct from 'question_category'
     or new.manifest ->> 'category' is distinct from new.question_category
     or jsonb_typeof(new.manifest -> 'groups') is distinct from 'array'
     or jsonb_array_length(new.manifest -> 'groups') = 0 then
    raise exception 'READING_INVALID_CATEGORY_MANIFEST';
  end if;
  if exists (
    select 1 from jsonb_array_elements(new.manifest -> 'groups') grp
    where jsonb_typeof(grp -> 'targets') is distinct from 'array'
      or jsonb_array_length(grp -> 'targets') = 0
  ) or exists (
    select 1 from jsonb_array_elements(new.manifest -> 'groups') grp
    group by grp ->> 'logicalItemId'
    having count(*) > 1
  ) then
    raise exception 'READING_INVALID_CATEGORY_MANIFEST';
  end if;
  select count(*) into v_count
  from jsonb_array_elements(new.manifest -> 'groups') grp,
    lateral jsonb_array_elements(grp -> 'targets') target;
  select count(*) into v_pool
  from public.reading_questions
  where module = 'rap' and question_category = new.question_category;
  if v_count <> least(new.amount, v_pool) or v_count = 0 or exists (
    select 1 from jsonb_array_elements(new.manifest -> 'groups') grp
    cross join lateral jsonb_array_elements(grp -> 'targets') target
    left join public.reading_questions question
      on question.question_id = target ->> 'questionId'
     and question.logical_item_id = grp ->> 'logicalItemId'
    left join public.reading_logical_items item
      on item.logical_item_id = question.logical_item_id
    where question.question_id is null
      or question.module <> 'rap'
      or item.module <> 'rap'
      or question.question_category is distinct from new.question_category
  ) or exists (
    select 1 from jsonb_array_elements(new.manifest -> 'groups') grp,
      lateral jsonb_array_elements(grp -> 'targets') target
    group by target ->> 'questionId'
    having count(*) > 1
  ) then
    raise exception 'READING_INVALID_CATEGORY_MANIFEST';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_reading_category_manifest()
  from public, anon, authenticated;

drop trigger if exists reading_category_manifest_guard
  on public.reading_question_category_sessions;
create trigger reading_category_manifest_guard
before insert or update on public.reading_question_category_sessions
for each row execute function public.guard_reading_category_manifest();

create or replace function public.reading_category_session_json(
  p_session public.reading_question_category_sessions
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'sessionId', p_session.session_id,
    'questionCategory', p_session.question_category,
    'amount', p_session.amount,
    'groups', p_session.manifest -> 'groups',
    'progress', p_session.progress,
    'draft', p_session.draft,
    'status', p_session.status,
    'elapsedSeconds', p_session.elapsed_seconds,
    'totalPoints', p_session.total_points,
    'correctPoints', p_session.correct_points,
    'createdAt', p_session.created_at,
    'completedAt', p_session.completed_at,
    'categories', p_session.categories,
    'totalQuestions', (
      select count(*)
      from jsonb_array_elements(p_session.manifest -> 'groups') grp
      cross join lateral jsonb_array_elements(grp -> 'targets') target
    ),
    'origin', p_session.origin,
    'assignmentId', p_session.assignment_id,
    'startRequestId', p_session.start_request_id
  );
$$;

revoke all on function public.reading_category_session_json(public.reading_question_category_sessions)
  from public, anon, authenticated;

create or replace function public.submit_reading_question_category_group(
  p_session_id uuid,
  p_logical_item_id text,
  p_elapsed_seconds integer,
  p_answers jsonb,
  p_finalize boolean,
  p_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.reading_question_category_sessions%rowtype;
  v_group jsonb;
  v_progress jsonb;
  v_workspaces jsonb;
  v_current text;
  v_events jsonb;
  v_correct integer;
  v_total integer;
  v_expected integer;
  v_elapsed integer;
  v_all_saved boolean;
begin
  if auth.uid() is null or not public.can_use_student_experience() then
    raise exception 'READING_STUDENT_REQUIRED';
  end if;
  select * into v_session from public.reading_question_category_sessions
    where session_id = p_session_id and student_id = auth.uid() for update;
  if not found then raise exception 'READING_ATTEMPT_NOT_FOUND'; end if;
  select grp into v_group
  from jsonb_array_elements(v_session.manifest -> 'groups') grp
  where grp ->> 'logicalItemId' = p_logical_item_id;
  if v_group is null then raise exception 'READING_INVALID_CATEGORY_GROUP'; end if;
  if v_session.status = 'completed' then
    return jsonb_build_object(
      'alreadySubmitted', true, 'completedNow', false,
      'group', v_session.progress -> p_logical_item_id,
      'session', public.reading_category_session_json(v_session),
      'answers', public.reading_category_answers_json(p_session_id)
    );
  end if;
  select grp ->> 'logicalItemId' into v_current
  from jsonb_array_elements(v_session.manifest -> 'groups') with ordinality e(grp, n)
  where not v_session.progress ? (grp ->> 'logicalItemId')
  order by n limit 1;
  if not v_session.progress ? p_logical_item_id
     and v_current is distinct from p_logical_item_id then
    raise exception 'READING_INVALID_CATEGORY_GROUP';
  end if;
  if p_finalize is null or p_revision is null
     or p_revision not between 1 and 9007199254740991
     or p_elapsed_seconds is null
     or p_elapsed_seconds not between 0 and 604800
     or jsonb_typeof(p_answers) is distinct from 'array' then
    raise exception 'READING_INVALID_SUBMISSION';
  end if;
  if p_finalize and v_session.manifest -> 'groups' -> -1 ->> 'logicalItemId'
       is distinct from p_logical_item_id then
    raise exception 'READING_INVALID_CATEGORY_FINALIZE';
  end if;
  v_workspaces := coalesce(v_session.draft -> 'workspaces', '{}'::jsonb);
  if v_session.draft ->> 'logicalItemId' is not null
     and v_session.draft -> 'workspace' is not null then
    v_workspaces := v_workspaces || jsonb_build_object(
      v_session.draft ->> 'logicalItemId',
      v_session.draft -> 'workspace'
    );
  end if;
  if p_revision < coalesce((v_workspaces -> p_logical_item_id ->> 'revision')::bigint, 0)
     or p_revision <= coalesce((v_session.progress -> p_logical_item_id ->> 'revision')::bigint, 0) then
    if p_finalize or not v_session.progress ? p_logical_item_id then
      raise exception 'READING_INVALID_STALE_CATEGORY_SAVE';
    end if;
    return jsonb_build_object(
      'alreadySubmitted', false, 'completedNow', false, 'alreadySaved', true,
      'group', v_session.progress -> p_logical_item_id,
      'session', public.reading_category_session_json(v_session),
      'answers', public.reading_category_answers_json(p_session_id, p_logical_item_id)
    );
  end if;
  v_total := jsonb_array_length(v_group -> 'targets');
  if jsonb_array_length(p_answers) <> v_total or exists (
    select 1 from jsonb_array_elements(p_answers) answer
    where jsonb_typeof(answer) is distinct from 'object'
      or coalesce(answer ->> 'slotId', '') <> ''
      or (jsonb_typeof(answer -> 'studentAnswer') is distinct from 'string'
        and jsonb_typeof(answer -> 'studentAnswer') is distinct from 'null')
      or not coalesce(answer ->> 'questionTimeSeconds', '') ~ '^[0-9]{1,6}$'
  ) or exists (
    select 1 from jsonb_array_elements(p_answers) answer
    group by answer ->> 'questionId'
    having count(*) > 1
  ) then
    raise exception 'READING_INVALID_SUBMISSION';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(v_group -> 'targets') target
    left join lateral (
      select answer from jsonb_array_elements(p_answers) answer
      where answer ->> 'questionId' = target ->> 'questionId'
    ) submitted on true
    left join public.reading_questions question
      on question.question_id = target ->> 'questionId'
     and question.logical_item_id = p_logical_item_id
    where submitted.answer is null
      or question.question_id is null
      or question.module <> 'rap'
      or question.question_category is distinct from coalesce(
        target ->> 'questionCategory',
        target ->> 'category',
        v_session.question_category
      )
      or question.question_type not in (
        'rap_multiple_choice', 'rap_sentence_insertion', 'rap_sentence_selection'
      )
      or submitted.answer ->> 'kind' is distinct from case question.question_type
        when 'rap_multiple_choice' then 'option'
        when 'rap_sentence_insertion' then 'insertion_anchor'
        else 'sentence_selection'
      end
      or (submitted.answer ->> 'questionTimeSeconds')::integer > 604800
      or (
        nullif(submitted.answer ->> 'studentAnswer', '') is not null
        and (
          (question.question_type = 'rap_multiple_choice' and not exists (
            select 1 from public.reading_question_options option
            where option.question_id = question.question_id
              and option.option_id = submitted.answer ->> 'studentAnswer'
          ))
          or (question.question_type = 'rap_sentence_insertion' and not exists (
            select 1 from public.reading_rap_insertion_anchors anchor
            where anchor.question_id = question.question_id
              and anchor.anchor_id = submitted.answer ->> 'studentAnswer'
          ))
          or (question.question_type = 'rap_sentence_selection' and not exists (
            select 1 from public.reading_passage_sentences sentence
            where sentence.passage_id = question.passage_id
              and sentence.paragraph_id = question.target_paragraph_id
              and sentence.sentence_id = submitted.answer ->> 'studentAnswer'
          ))
        )
      )
  ) then
    raise exception 'READING_ANSWER_ID_NOT_IN_ITEM';
  end if;

  insert into public.reading_question_category_session_answers as answer(
    session_id, logical_item_id, question_id, answer_kind,
    student_answer, is_correct, question_time_seconds
  )
  select p_session_id, p_logical_item_id, question.question_id,
    submitted.answer ->> 'kind', nullif(submitted.answer ->> 'studentAnswer', ''),
    coalesce(
      nullif(submitted.answer ->> 'studentAnswer', '') = case question.question_type
        when 'rap_multiple_choice' then question.correct_option_id
        when 'rap_sentence_insertion' then question.correct_anchor_id
        else question.correct_sentence_id
      end,
      false
    ),
    (submitted.answer ->> 'questionTimeSeconds')::integer
  from jsonb_array_elements(v_group -> 'targets') target
  join public.reading_questions question
    on question.question_id = target ->> 'questionId'
   and question.logical_item_id = p_logical_item_id
  join lateral (
    select answer from jsonb_array_elements(p_answers) answer
    where answer ->> 'questionId' = question.question_id
  ) submitted on true
  on conflict (session_id, question_id) do update
  set student_answer = excluded.student_answer,
      is_correct = excluded.is_correct,
      answer_kind = excluded.answer_kind,
      question_time_seconds = greatest(answer.question_time_seconds, excluded.question_time_seconds);

  update public.reading_question_category_session_answers answer
  set is_correct = coalesce(
    answer.student_answer = case question.question_type
      when 'rap_multiple_choice' then question.correct_option_id
      when 'rap_sentence_insertion' then question.correct_anchor_id
      else question.correct_sentence_id
    end,
    false
  )
  from public.reading_questions question
  where answer.session_id = p_session_id
    and answer.question_id = question.question_id
    and answer.logical_item_id = question.logical_item_id;

  select count(*) filter (where is_correct) into v_correct
  from public.reading_question_category_session_answers
  where session_id = p_session_id and logical_item_id = p_logical_item_id;
  v_elapsed := greatest(
    p_elapsed_seconds,
    coalesce((v_session.progress -> p_logical_item_id ->> 'elapsedSeconds')::integer, 0)
  );
  v_progress := v_session.progress || jsonb_build_object(
    p_logical_item_id,
    jsonb_build_object(
      'correctPoints', v_correct,
      'totalPoints', v_total,
      'elapsedSeconds', v_elapsed,
      'submittedAt', now(),
      'revision', p_revision
    )
  );
  select jsonb_object_agg(key, value || jsonb_build_object('correctPoints', (
    select count(*) filter (where answer.is_correct)
    from public.reading_question_category_session_answers answer
    where answer.session_id = p_session_id and answer.logical_item_id = key
  ))) into v_progress
  from jsonb_each(v_progress) entry(key, value);
  select count(*), count(*) filter (where is_correct) into v_total, v_correct
  from public.reading_question_category_session_answers
  where session_id = p_session_id;
  select coalesce(sum((entry.value ->> 'elapsedSeconds')::integer), 0)
    into v_elapsed
  from jsonb_each(v_progress) entry;
  select not exists (
    select 1 from jsonb_array_elements(v_session.manifest -> 'groups') grp
    where not v_progress ? (grp ->> 'logicalItemId')
  ) into v_all_saved;
  select count(*) into v_expected
  from jsonb_array_elements(v_session.manifest -> 'groups') grp
  cross join lateral jsonb_array_elements(grp -> 'targets') target;
  v_workspaces := v_workspaces - p_logical_item_id;
  if p_finalize and (
    not v_all_saved or v_total <> v_expected or v_workspaces <> '{}'::jsonb
  ) then
    raise exception 'READING_INVALID_CATEGORY_FINALIZE';
  end if;
  if p_finalize then
    select coalesce(jsonb_agg(jsonb_build_object(
      'event', 'wrong', 'taskType', 'rap',
      'questionKey', logical_item_id || ':' || question_id || ':question',
      'logicalItemId', logical_item_id, 'questionId', question_id, 'slotId', null
    )), '[]'::jsonb)
    into v_events
    from public.reading_question_category_session_answers
    where session_id = p_session_id and not is_correct;
    perform public.apply_student_wrong_question_events(
      v_session.student_id,
      (statement_timestamp() at time zone 'Asia/Shanghai')::date,
      v_events
    );
  end if;
  update public.reading_question_category_sessions
  set progress = v_progress,
      draft = case when p_finalize
        then '{}'::jsonb
        else jsonb_build_object('workspaces', v_workspaces)
      end,
      elapsed_seconds = v_elapsed,
      total_points = v_total,
      correct_points = v_correct,
      status = case when p_finalize then 'completed' else 'active' end,
      completed_at = case when p_finalize then now() else null end
  where session_id = p_session_id
  returning * into v_session;
  return jsonb_build_object(
    'alreadySubmitted', false,
    'completedNow', p_finalize,
    'group', v_progress -> p_logical_item_id,
    'session', public.reading_category_session_json(v_session),
    'answers', public.reading_category_answers_json(
      p_session_id,
      case when p_finalize then null else p_logical_item_id end
    )
  );
end;
$$;

revoke all on function public.submit_reading_question_category_group(uuid,text,integer,jsonb,boolean,bigint)
  from public, anon, authenticated;
grant execute on function public.submit_reading_question_category_group(uuid,text,integer,jsonb,boolean,bigint)
  to authenticated;

create or replace function public.get_or_create_rap_category_assignment_session(
  p_assignment_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_assignment public.writing_assignments%rowtype;
  v_existing public.reading_question_category_sessions%rowtype;
  v_session public.reading_question_category_sessions%rowtype;
  v_manifest jsonb;
  v_categories jsonb;
  v_total integer;
  v_first_category text;
begin
  if v_user_id is null or p_assignment_id is null or p_request_id is null then
    raise exception using errcode = '42501', message = 'READING_STUDENT_REQUIRED';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = v_user_id and role = 'student' and is_active = true
  ) then
    raise exception using errcode = '42501', message = 'READING_STUDENT_REQUIRED';
  end if;
  select * into v_assignment
  from public.writing_assignments assignment
  where assignment.assignment_id = p_assignment_id
    and assignment.task_type = 'rap_category'
    and assignment.status = 'active'
    and assignment.deleted_at is null;
  if not found then
    raise exception 'READING_CATEGORY_ASSIGNMENT_NOT_AVAILABLE';
  end if;
  if not exists (
    select 1 from public.writing_assignment_students membership
    where membership.assignment_id = p_assignment_id
      and membership.student_id = v_user_id
  ) then
    raise exception 'READING_CATEGORY_ASSIGNMENT_NOT_ASSIGNED';
  end if;
  -- The Assignment snapshot keeps the answer map for teacher/result use, but
  -- the Student-owned session manifest must never carry correct answers.
  v_manifest := v_assignment.question_snapshot - 'answers';
  perform public.validate_category_assignment_manifest('rap_category', v_manifest);
  if btrim(v_assignment.question_id) is distinct from v_manifest ->> 'item_id' then
    raise exception 'READING_CATEGORY_ASSIGNMENT_NOT_AVAILABLE';
  end if;
  v_categories := v_manifest -> 'categories';
  v_total := (v_manifest ->> 'totalQuestions')::integer;
  v_first_category := v_categories -> 0 ->> 'category';

  perform pg_advisory_xact_lock(
    hashtextextended(v_user_id::text || '|' || p_assignment_id::text, 0)
  );
  select * into v_existing
  from public.reading_question_category_sessions session
  where session.student_id = v_user_id
    and session.start_request_id = p_request_id;
  if found then
    if v_existing.assignment_id is distinct from p_assignment_id then
      raise exception 'CATEGORY_REQUEST_ID_CONFLICT';
    end if;
    return jsonb_build_object(
      'created', false,
      'session', public.reading_category_session_json(v_existing),
      'answers', public.reading_category_answers_json(v_existing.session_id)
    );
  end if;
  select * into v_existing
  from public.reading_question_category_sessions session
  where session.student_id = v_user_id
    and session.assignment_id = p_assignment_id
    and session.status = 'active'
  order by session.created_at desc
  limit 1
  for update;
  if found then
    return jsonb_build_object(
      'created', false,
      'session', public.reading_category_session_json(v_existing),
      'answers', public.reading_category_answers_json(v_existing.session_id)
    );
  end if;

  insert into public.reading_question_category_sessions (
    student_id, question_category, amount, manifest, categories,
    start_request_id, origin, assignment_id, status
  ) values (
    v_user_id, v_first_category, v_total, v_manifest, v_categories,
    p_request_id, 'teacher_assigned', p_assignment_id, 'active'
  )
  returning * into v_session;

  return jsonb_build_object(
    'created', true,
    'session', public.reading_category_session_json(v_session),
    'answers', public.reading_category_answers_json(v_session.session_id)
  );
end;
$$;

revoke all on function public.get_or_create_rap_category_assignment_session(uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.get_or_create_rap_category_assignment_session(uuid,uuid)
  to authenticated;

notify pgrst, 'reload schema';

commit;
