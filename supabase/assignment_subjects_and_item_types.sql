-- TPS｜教师端作业管理：Assignment 科目 + 题型扩展
--
-- Run in the Supabase SQL Editor before deploying the matching app code.
--
-- Scope
--   * Adds `writing_assignments.subject` (写作 / 阅读). Historical rows stay
--     `writing` and keep working unchanged.
--   * Extends the Assignment item type set with the Build a Sentence writing
--     item and the Reading item types (CTW / RDL / RAP / Full Set). The
--     existing Assignment Group / item abstraction is reused: `question_id`
--     carries the stable catalog item identity, `question_snapshot` keeps only
--     lightweight catalog metadata (never question / passage content).
--   * Replaces the create / withdrawn-edit RPCs with subject-aware validation.
--     Overloads change signature (a new p_subject argument), so the previous
--     versions are dropped first.
--
-- Re-running this file is safe: every statement is idempotent (IF EXISTS /
-- IF NOT EXISTS) and the functions are replaced, not appended.

-- ---------------------------------------------------------------------------
-- 1. subject column + constraints
-- ---------------------------------------------------------------------------

alter table public.writing_assignments
  add column if not exists subject text not null default 'writing';

update public.writing_assignments
set subject = 'writing'
where subject is null or btrim(subject) = '';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'writing_assignments_subject_check'
      and conrelid = 'public.writing_assignments'::regclass
  ) then
    alter table public.writing_assignments
      add constraint writing_assignments_subject_check
      check (subject in ('writing', 'reading'));
  end if;
end $$;

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
    'full_set'
  ));

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'writing_assignments_subject_item_type_check'
      and conrelid = 'public.writing_assignments'::regclass
  ) then
    -- One Assignment item always belongs to exactly one subject.
    alter table public.writing_assignments
      add constraint writing_assignments_subject_item_type_check
      check (
        (subject = 'writing' and task_type in ('email', 'academic_discussion', 'build_sentence'))
        or (subject = 'reading' and task_type in ('ctw', 'rdl', 'rap', 'full_set'))
      );
  end if;
end $$;

-- Backfill guards for any row created between the column addition and the
-- consistency constraint (defensive; normally a no-op).
update public.writing_assignments
set subject = 'reading'
where task_type in ('ctw', 'rdl', 'rap', 'full_set')
  and subject <> 'reading';
update public.writing_assignments
set subject = 'writing'
where task_type in ('email', 'academic_discussion', 'build_sentence')
  and subject <> 'writing';

create index if not exists writing_assignments_teacher_subject_created_idx
  on public.writing_assignments(teacher_id, subject, created_at desc)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- 2. create_writing_assignment_group (student mode, subject-aware)
-- ---------------------------------------------------------------------------

drop function if exists public.create_writing_assignment_group(uuid, jsonb, uuid[], text, boolean);
drop function if exists public.create_writing_assignment_group(uuid, jsonb, uuid[], text, boolean, uuid);

create or replace function public.create_writing_assignment_group(
  p_teacher_id uuid,
  p_assignments jsonb,
  p_student_ids uuid[],
  p_title text,
  p_title_is_automatic boolean,
  p_subject text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  assignment_data jsonb;
  assignment_ids uuid[] := array[]::uuid[];
  created_assignment_id uuid;
  created_group_id uuid;
  position integer := 0;
  requested_student_count integer;
  valid_student_count integer;
  base_title text;
  final_title text;
  base_title_taken boolean := false;
  max_sequence integer := 0;
  next_sequence integer;
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

  if jsonb_typeof(p_assignments) is distinct from 'array'
    or jsonb_array_length(p_assignments) < 1
    or jsonb_array_length(p_assignments) > 50 then
    raise exception 'Assignments must contain between 1 and 50 items';
  end if;

  select count(*) into requested_student_count
  from (select distinct unnest(coalesce(p_student_ids, array[]::uuid[])) as id) students;
  if requested_student_count < 1 then
    raise exception 'At least one student is required';
  end if;

  -- Recipients are active Students bound to this Teacher for the Assignment
  -- subject (写作 / 阅读). Legacy profiles.owner_id is never used as an
  -- assignment fallback.
  select count(*) into valid_student_count
  from (select distinct unnest(p_student_ids) as id) students
  join public.profiles student
    on student.id = students.id
   and student.role = 'student'
   and student.is_active = true
  join public.teacher_student_bindings binding
    on binding.teacher_id = p_teacher_id
   and binding.student_id = students.id
   and binding.domain = p_subject;
  if valid_student_count <> requested_student_count then
    raise exception 'One or more students are invalid';
  end if;

  for assignment_data in select value from jsonb_array_elements(p_assignments)
  loop
    if assignment_data ->> 'task_type' not in (
      'email', 'academic_discussion', 'build_sentence', 'ctw', 'rdl', 'rap', 'full_set'
    ) then
      raise exception 'Invalid assignment item type';
    end if;
    if assignment_data ->> 'question_source' not in ('question_bank', 'custom') then
      raise exception 'Invalid question source';
    end if;
    if p_subject = 'writing' then
      if assignment_data ->> 'task_type' not in ('email', 'academic_discussion', 'build_sentence') then
        raise exception 'MIXED_ASSIGNMENT_SUBJECT';
      end if;
    else
      if assignment_data ->> 'task_type' not in ('ctw', 'rdl', 'rap', 'full_set') then
        raise exception 'MIXED_ASSIGNMENT_SUBJECT';
      end if;
    end if;
    if assignment_data ->> 'question_source' = 'custom'
      and assignment_data ->> 'task_type' not in ('email', 'academic_discussion') then
      raise exception 'Reading assignment requires question_bank source';
    end if;
    if jsonb_typeof(assignment_data -> 'question_snapshot') is distinct from 'object' then
      raise exception 'Question snapshot must be an object';
    end if;
    if assignment_data ->> 'question_source' = 'question_bank'
      and nullif(assignment_data ->> 'question_id', '') is null then
      raise exception 'Question bank assignment requires question_id';
    end if;
    if assignment_data ->> 'question_source' = 'custom'
      and nullif(assignment_data ->> 'question_id', '') is not null then
      raise exception 'Custom assignment cannot include question_id';
    end if;
  end loop;

  base_title := nullif(btrim(coalesce(p_title, '')), '');
  if base_title is not null and char_length(base_title) > 120 then
    raise exception 'Assignment title is too long';
  end if;

  -- Automatic titles are numbered per teacher and base title. The base title
  -- already contains the subject (写作 / 阅读), so 写作 and 阅读 never share a
  -- sequence. The advisory lock serializes concurrent creates with the same
  -- base so both cannot pick the same free sequence.
  if base_title is not null and coalesce(p_title_is_automatic, false) then
    perform pg_advisory_xact_lock(
      hashtextextended(p_teacher_id::text || '|' || base_title, 0)
    );

    select
      coalesce(bool_or(group_row.title = base_title), false),
      coalesce(max(
        case
          when group_row.title = base_title then 1
          else nullif(substring(group_row.title from ' \((\d+)\)$'), '')::integer
        end
      ), 0)
    into base_title_taken, max_sequence
    from public.writing_assignment_groups group_row
    where group_row.teacher_id = p_teacher_id
      and group_row.title is not null
      and left(group_row.title, char_length(base_title)) = base_title
      and (group_row.title = base_title
        or substring(group_row.title from ' \((\d+)\)$') is not null)
      and exists (
        select 1 from public.writing_assignments item
        where item.group_id = group_row.group_id
          and item.deleted_at is null
      );

    if not base_title_taken then
      final_title := base_title;
    else
      select free.sequence into next_sequence
      from generate_series(2, greatest(max_sequence, 1) + 1) as free(sequence)
      where not exists (
        select 1 from public.writing_assignment_groups taken
        where taken.teacher_id = p_teacher_id
          and taken.title = base_title || ' (' || free.sequence || ')'
          and exists (
            select 1 from public.writing_assignments item
            where item.group_id = taken.group_id
              and item.deleted_at is null
          )
      )
      order by free.sequence
      limit 1;
      final_title := base_title || ' (' || next_sequence || ')';
    end if;

    if char_length(final_title) > 120 then
      raise exception 'Assignment title is too long';
    end if;
  else
    final_title := base_title;
  end if;

  insert into public.writing_assignment_groups (teacher_id, title, class_id)
  values (p_teacher_id, final_title, null)
  returning group_id into created_group_id;

  for assignment_data in select value from jsonb_array_elements(p_assignments)
  loop
    position := position + 1;
    insert into public.writing_assignments (
      teacher_id, subject, group_id, group_position, task_type, question_source,
      question_id, question_snapshot, due_at
    ) values (
      p_teacher_id, p_subject, created_group_id, position,
      assignment_data ->> 'task_type',
      assignment_data ->> 'question_source',
      nullif(assignment_data ->> 'question_id', ''),
      assignment_data -> 'question_snapshot',
      nullif(assignment_data ->> 'due_at', '')::timestamptz
    ) returning assignment_id into created_assignment_id;

    assignment_ids := array_append(assignment_ids, created_assignment_id);

    insert into public.writing_assignment_students (assignment_id, student_id, sort_order)
    select created_assignment_id, selected.id, selected.position
    from (
      select id, min(ordinality)::integer as position
      from unnest(p_student_ids) with ordinality as ordered(id, ordinality)
      group by id
    ) selected;
  end loop;

  return jsonb_build_object(
    'group_id', created_group_id,
    'assignment_ids', to_jsonb(assignment_ids),
    'title', final_title,
    'subject', p_subject
  );
end;
$$;

revoke all on function public.create_writing_assignment_group(uuid, jsonb, uuid[], text, boolean, text)
  from public, anon, authenticated;
grant execute on function public.create_writing_assignment_group(uuid, jsonb, uuid[], text, boolean, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 3. create_writing_assignment_group (class mode, subject-aware)
-- ---------------------------------------------------------------------------

create or replace function public.create_writing_assignment_group(
  p_teacher_id uuid,
  p_assignments jsonb,
  p_student_ids uuid[],
  p_title text,
  p_title_is_automatic boolean,
  p_subject text,
  p_class_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  assignment_data jsonb;
  assignment_ids uuid[] := array[]::uuid[];
  created_assignment_id uuid;
  created_group_id uuid;
  position integer := 0;
  requested_student_count integer;
  valid_student_count integer;
  class_row public.teacher_classes%rowtype;
  member_ids uuid[];
  base_title text;
  final_title text;
  base_title_taken boolean := false;
  max_sequence integer := 0;
  next_sequence integer;
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

  if p_class_id is null then
    raise exception 'CLASS_NOT_FOUND';
  end if;

  select * into class_row
  from public.teacher_classes
  where class_id = p_class_id and teacher_id = p_teacher_id
  for update;
  if not found then
    raise exception 'CLASS_NOT_FOUND';
  end if;
  if not (p_subject = any(class_row.subjects)) then
    if p_subject = 'reading' then
      raise exception 'CLASS_NOT_READING_CLASS';
    end if;
    raise exception 'CLASS_NOT_WRITING_CLASS';
  end if;

  select coalesce(array_agg(member.student_id order by member.joined_at, member.student_id), array[]::uuid[])
    into member_ids
  from public.class_members member
  where member.class_id = p_class_id;

  requested_student_count := coalesce(array_length(member_ids, 1), 0);
  if requested_student_count < 1 then
    raise exception 'CLASS_HAS_NO_MEMBERS';
  end if;

  if jsonb_typeof(p_assignments) is distinct from 'array'
    or jsonb_array_length(p_assignments) < 1
    or jsonb_array_length(p_assignments) > 50 then
    raise exception 'Assignments must contain between 1 and 50 items';
  end if;

  -- Class recipients must hold the subject binding; the creation-time member
  -- snapshot stays authoritative for later membership changes.
  select count(*) into valid_student_count
  from (select distinct unnest(member_ids) as id) students
  join public.profiles student
    on student.id = students.id
   and student.role = 'student'
   and student.is_active = true
  join public.teacher_student_bindings binding
    on binding.teacher_id = p_teacher_id
   and binding.student_id = students.id
   and binding.domain = p_subject;
  if valid_student_count <> requested_student_count then
    raise exception 'One or more students are invalid';
  end if;

  for assignment_data in select value from jsonb_array_elements(p_assignments)
  loop
    if assignment_data ->> 'task_type' not in (
      'email', 'academic_discussion', 'build_sentence', 'ctw', 'rdl', 'rap', 'full_set'
    ) then
      raise exception 'Invalid assignment item type';
    end if;
    if assignment_data ->> 'question_source' not in ('question_bank', 'custom') then
      raise exception 'Invalid question source';
    end if;
    if p_subject = 'writing' then
      if assignment_data ->> 'task_type' not in ('email', 'academic_discussion', 'build_sentence') then
        raise exception 'MIXED_ASSIGNMENT_SUBJECT';
      end if;
    else
      if assignment_data ->> 'task_type' not in ('ctw', 'rdl', 'rap', 'full_set') then
        raise exception 'MIXED_ASSIGNMENT_SUBJECT';
      end if;
    end if;
    if assignment_data ->> 'question_source' = 'custom'
      and assignment_data ->> 'task_type' not in ('email', 'academic_discussion') then
      raise exception 'Reading assignment requires question_bank source';
    end if;
    if jsonb_typeof(assignment_data -> 'question_snapshot') is distinct from 'object' then
      raise exception 'Question snapshot must be an object';
    end if;
    if assignment_data ->> 'question_source' = 'question_bank'
      and nullif(assignment_data ->> 'question_id', '') is null then
      raise exception 'Question bank assignment requires question_id';
    end if;
    if assignment_data ->> 'question_source' = 'custom'
      and nullif(assignment_data ->> 'question_id', '') is not null then
      raise exception 'Custom assignment cannot include question_id';
    end if;
  end loop;

  base_title := nullif(btrim(coalesce(p_title, '')), '');
  if base_title is not null and char_length(base_title) > 120 then
    raise exception 'Assignment title is too long';
  end if;

  if base_title is not null and coalesce(p_title_is_automatic, false) then
    perform pg_advisory_xact_lock(
      hashtextextended(p_teacher_id::text || '|' || base_title, 0)
    );

    select
      coalesce(bool_or(group_row.title = base_title), false),
      coalesce(max(
        case
          when group_row.title = base_title then 1
          else nullif(substring(group_row.title from ' \((\d+)\)$'), '')::integer
        end
      ), 0)
    into base_title_taken, max_sequence
    from public.writing_assignment_groups group_row
    where group_row.teacher_id = p_teacher_id
      and group_row.title is not null
      and left(group_row.title, char_length(base_title)) = base_title
      and (group_row.title = base_title
        or substring(group_row.title from ' \((\d+)\)$') is not null)
      and exists (
        select 1 from public.writing_assignments item
        where item.group_id = group_row.group_id
          and item.deleted_at is null
      );

    if not base_title_taken then
      final_title := base_title;
    else
      select free.sequence into next_sequence
      from generate_series(2, greatest(max_sequence, 1) + 1) as free(sequence)
      where not exists (
        select 1 from public.writing_assignment_groups taken
        where taken.teacher_id = p_teacher_id
          and taken.title = base_title || ' (' || free.sequence || ')'
          and exists (
            select 1 from public.writing_assignments item
            where item.group_id = taken.group_id
              and item.deleted_at is null
          )
      )
      order by free.sequence
      limit 1;
      final_title := base_title || ' (' || next_sequence || ')';
    end if;

    if char_length(final_title) > 120 then
      raise exception 'Assignment title is too long';
    end if;
  else
    final_title := base_title;
  end if;

  insert into public.writing_assignment_groups (teacher_id, title, class_id)
  values (p_teacher_id, final_title, p_class_id)
  returning group_id into created_group_id;

  for assignment_data in select value from jsonb_array_elements(p_assignments)
  loop
    position := position + 1;
    insert into public.writing_assignments (
      teacher_id, subject, group_id, group_position, task_type, question_source,
      question_id, question_snapshot, due_at
    ) values (
      p_teacher_id, p_subject, created_group_id, position,
      assignment_data ->> 'task_type',
      assignment_data ->> 'question_source',
      nullif(assignment_data ->> 'question_id', ''),
      assignment_data -> 'question_snapshot',
      nullif(assignment_data ->> 'due_at', '')::timestamptz
    ) returning assignment_id into created_assignment_id;

    assignment_ids := array_append(assignment_ids, created_assignment_id);

    -- Class mode: the creation-time member snapshot, ordered by joined_at.
    insert into public.writing_assignment_students (assignment_id, student_id, sort_order)
    select created_assignment_id, ordered.id, ordered.position
    from (
      select id, ordinality::integer as position
      from unnest(member_ids) with ordinality as ordered(id, ordinality)
    ) ordered;
  end loop;

  return jsonb_build_object(
    'group_id', created_group_id,
    'assignment_ids', to_jsonb(assignment_ids),
    'title', final_title,
    'subject', p_subject,
    'class_id', p_class_id
  );
end;
$$;

revoke all on function public.create_writing_assignment_group(uuid, jsonb, uuid[], text, boolean, text, uuid)
  from public, anon, authenticated;
grant execute on function public.create_writing_assignment_group(uuid, jsonb, uuid[], text, boolean, text, uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4. update_withdrawn_writing_assignment (single item edit, subject-aware)
-- ---------------------------------------------------------------------------

create or replace function public.update_withdrawn_writing_assignment(
  p_assignment_id uuid,
  p_teacher_id uuid,
  p_task_type text,
  p_question_source text,
  p_question_id text,
  p_question_snapshot jsonb,
  p_due_at timestamptz,
  p_student_ids uuid[],
  p_reactivate boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_assignment public.writing_assignments%rowtype;
  requested_student_count integer;
  valid_student_count integer;
  has_submitted_attempt boolean;
  derived_subject text;
begin
  select * into current_assignment from public.writing_assignments
  where assignment_id = p_assignment_id and teacher_id = p_teacher_id for update;
  if not found or current_assignment.deleted_at is not null then raise exception 'ASSIGNMENT_NOT_FOUND'; end if;
  if current_assignment.status <> 'withdrawn' then raise exception 'ASSIGNMENT_NOT_WITHDRAWN'; end if;
  if p_task_type not in (
    'email', 'academic_discussion', 'build_sentence', 'ctw', 'rdl', 'rap', 'full_set'
  ) then raise exception 'INVALID_TASK_TYPE'; end if;
  derived_subject := case
    when p_task_type in ('ctw', 'rdl', 'rap', 'full_set') then 'reading'
    else 'writing'
  end;
  if p_question_source not in ('question_bank', 'custom') then raise exception 'INVALID_QUESTION_SOURCE'; end if;
  if p_question_source = 'custom'
    and p_task_type not in ('email', 'academic_discussion') then
    raise exception 'INVALID_QUESTION_SOURCE';
  end if;
  if jsonb_typeof(p_question_snapshot) is distinct from 'object' then raise exception 'INVALID_QUESTION_SNAPSHOT'; end if;

  select count(*) into requested_student_count
  from (select distinct unnest(coalesce(p_student_ids, array[]::uuid[])) as id) students;
  if requested_student_count < 1 then raise exception 'STUDENT_REQUIRED'; end if;
  -- Recipients are active Students bound to this Teacher for the item subject.
  select count(*) into valid_student_count
  from (select distinct unnest(p_student_ids) as id) students
  join public.profiles student
    on student.id = students.id
   and student.role = 'student'
   and student.is_active = true
  join public.teacher_student_bindings binding
    on binding.teacher_id = p_teacher_id
   and binding.student_id = students.id
   and binding.domain = derived_subject;
  if valid_student_count <> requested_student_count then raise exception 'INVALID_STUDENT'; end if;

  select exists (
    select 1 from public.writing_attempts
    where assignment_id = p_assignment_id and status = 'submitted'
  ) into has_submitted_attempt;
  if has_submitted_attempt and (
    current_assignment.task_type is distinct from p_task_type
    or current_assignment.question_source is distinct from p_question_source
    or current_assignment.question_id is distinct from p_question_id
    or current_assignment.question_snapshot is distinct from p_question_snapshot
  ) then raise exception 'QUESTION_LOCKED_AFTER_SUBMISSION'; end if;

  if exists (
    select 1 from public.writing_assignment_students member
    where member.assignment_id = p_assignment_id
      and not (member.student_id = any(p_student_ids))
      and exists (
        select 1 from public.writing_attempts attempt
        where attempt.assignment_id = p_assignment_id and attempt.user_id = member.student_id
      )
  ) then raise exception 'STUDENT_HAS_ATTEMPT'; end if;

  update public.writing_assignments
  set task_type = p_task_type,
      subject = derived_subject,
      question_source = p_question_source,
      question_id = p_question_id,
      question_snapshot = p_question_snapshot,
      due_at = p_due_at,
      status = case when p_reactivate then 'active' else 'withdrawn' end
  where assignment_id = p_assignment_id;

  delete from public.writing_assignment_students member
  where member.assignment_id = p_assignment_id
    and not (member.student_id = any(p_student_ids));
  insert into public.writing_assignment_students (assignment_id, student_id)
  select p_assignment_id, id from (select distinct unnest(p_student_ids) as id) students
  on conflict (assignment_id, student_id) do nothing;

  -- Keeping the whole group single-subject: the assignment-level subject must
  -- always match its group siblings.
  if current_assignment.group_id is not null then
    update public.writing_assignments
    set subject = derived_subject
    where group_id = current_assignment.group_id
      and deleted_at is null
      and assignment_id <> p_assignment_id;
  end if;
end;
$$;

revoke all on function public.update_withdrawn_writing_assignment(uuid, uuid, text, text, text, jsonb, timestamptz, uuid[], boolean)
  from public, anon, authenticated;
grant execute on function public.update_withdrawn_writing_assignment(uuid, uuid, text, text, text, jsonb, timestamptz, uuid[], boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- 5. update_withdrawn_writing_assignment_group (whole-group edit, item types)
-- ---------------------------------------------------------------------------

create or replace function public.update_withdrawn_writing_assignment_group(
  p_group_id uuid,
  p_teacher_id uuid,
  p_items jsonb,
  p_student_ids uuid[],
  p_due_at timestamptz,
  p_reactivate boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  item_record record;
  provided_item jsonb;
  current_item_count integer;
  provided_item_count integer;
  matched_item_count integer;
  requested_student_count integer;
  valid_student_count integer;
  removed_with_attempt_count integer;
  updated_item_count integer := 0;
  derived_subject text;
  group_subjects text[];
begin
  -- Lock the group row: ownership check plus serialization of concurrent
  -- group mutations.
  perform 1
  from public.writing_assignment_groups
  where group_id = p_group_id
    and teacher_id = p_teacher_id
  for update;
  if not found then
    raise exception 'ASSIGNMENT_GROUP_NOT_FOUND';
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) < 1 then
    raise exception 'INVALID_GROUP_ITEMS';
  end if;

  -- Lock every visible item. The active-assignment trigger takes FOR KEY SHARE
  -- on the same rows, so attempts and question edits cannot interleave.
  perform 1
  from public.writing_assignments
  where group_id = p_group_id
    and deleted_at is null
  for update;

  select count(*) into current_item_count
  from public.writing_assignments
  where group_id = p_group_id
    and deleted_at is null;
  if current_item_count < 1 then
    raise exception 'ASSIGNMENT_GROUP_NOT_FOUND';
  end if;

  -- Editing follows the historical rule: only a fully withdrawn group can be
  -- edited.
  if exists (
    select 1 from public.writing_assignments
    where group_id = p_group_id
      and deleted_at is null
      and status <> 'withdrawn'
  ) then
    raise exception 'ASSIGNMENT_GROUP_NOT_WITHDRAWN';
  end if;

  provided_item_count := jsonb_array_length(p_items);
  if provided_item_count <> current_item_count then
    raise exception 'INVALID_GROUP_ITEMS';
  end if;

  -- Every payload item must map to exactly one visible item of this group.
  select count(distinct (value ->> 'assignment_id')::uuid)
  into matched_item_count
  from jsonb_array_elements(p_items)
  where nullif(value ->> 'assignment_id', '') is not null
    and (value ->> 'assignment_id')::uuid in (
      select assignment_id from public.writing_assignments
      where group_id = p_group_id and deleted_at is null
    );
  if matched_item_count <> current_item_count then
    raise exception 'INVALID_GROUP_ITEMS';
  end if;

  -- Every item must share exactly one subject; the group can never become mixed.
  select array_agg(distinct case
      when value ->> 'task_type' in ('ctw', 'rdl', 'rap', 'full_set') then 'reading'
      else 'writing'
    end)
  into group_subjects
  from jsonb_array_elements(p_items);
  if group_subjects is null or array_length(group_subjects, 1) <> 1 then
    raise exception 'MIXED_ASSIGNMENT_SUBJECT';
  end if;
  derived_subject := group_subjects[1];

  for provided_item in select value from jsonb_array_elements(p_items)
  loop
    if provided_item ->> 'task_type' not in (
      'email', 'academic_discussion', 'build_sentence', 'ctw', 'rdl', 'rap', 'full_set'
    ) then
      raise exception 'INVALID_TASK_TYPE';
    end if;
    if provided_item ->> 'question_source' not in ('question_bank', 'custom') then
      raise exception 'INVALID_QUESTION_SOURCE';
    end if;
    if provided_item ->> 'question_source' = 'custom'
      and provided_item ->> 'task_type' not in ('email', 'academic_discussion') then
      raise exception 'INVALID_QUESTION_SOURCE';
    end if;
    if jsonb_typeof(provided_item -> 'question_snapshot') is distinct from 'object' then
      raise exception 'INVALID_QUESTION_SNAPSHOT';
    end if;
    if provided_item ->> 'question_source' = 'question_bank'
      and nullif(provided_item ->> 'question_id', '') is null then
      raise exception 'QUESTION_REQUIRED';
    end if;
    if provided_item ->> 'question_source' = 'custom'
      and nullif(provided_item ->> 'question_id', '') is not null then
      raise exception 'CUSTOM_QUESTION_HAS_ID';
    end if;

    select * into item_record
    from public.writing_assignments
    where assignment_id = (provided_item ->> 'assignment_id')::uuid
      and group_id = p_group_id
      and deleted_at is null;
    if not found then
      raise exception 'INVALID_GROUP_ITEMS';
    end if;

    -- Submitted items keep their frozen question, same as the single edit RPC.
    if exists (
      select 1 from public.writing_attempts
      where assignment_id = item_record.assignment_id
        and status = 'submitted'
    ) and (
      item_record.task_type is distinct from provided_item ->> 'task_type'
      or item_record.question_source is distinct from provided_item ->> 'question_source'
      or item_record.question_id is distinct from nullif(provided_item ->> 'question_id', '')
      or item_record.question_snapshot is distinct from (provided_item -> 'question_snapshot')
    ) then
      raise exception 'QUESTION_LOCKED_AFTER_SUBMISSION';
    end if;
  end loop;

  select count(*) into requested_student_count
  from (select distinct unnest(coalesce(p_student_ids, array[]::uuid[])) as id) students;
  if requested_student_count < 1 then
    raise exception 'STUDENT_REQUIRED';
  end if;
  -- Recipients are active Students bound to this Teacher for the item subject,
  -- same rule as the single edit RPC.
  select count(*) into valid_student_count
  from (select distinct unnest(p_student_ids) as id) students
  join public.profiles student
    on student.id = students.id
   and student.role = 'student'
   and student.is_active = true
  join public.teacher_student_bindings binding
    on binding.teacher_id = p_teacher_id
   and binding.student_id = students.id
   and binding.domain = derived_subject;
  if valid_student_count <> requested_student_count then
    raise exception 'INVALID_STUDENT';
  end if;

  -- A student with any attempt on any item of the group cannot be removed.
  select count(*) into removed_with_attempt_count
  from public.writing_assignment_students member
  join public.writing_assignments item
    on item.assignment_id = member.assignment_id
   and item.group_id = p_group_id
   and item.deleted_at is null
  where not (member.student_id = any(p_student_ids))
    and exists (
      select 1 from public.writing_attempts attempt
      where attempt.assignment_id = member.assignment_id
        and attempt.user_id = member.student_id
    );
  if removed_with_attempt_count > 0 then
    raise exception 'STUDENT_HAS_ATTEMPT';
  end if;

  -- Apply every item in the same transaction; the group stays or becomes one
  -- lifecycle unit.
  for provided_item in select value from jsonb_array_elements(p_items)
  loop
    update public.writing_assignments
    set task_type = provided_item ->> 'task_type',
        subject = derived_subject,
        question_source = provided_item ->> 'question_source',
        question_id = nullif(provided_item ->> 'question_id', ''),
        question_snapshot = provided_item -> 'question_snapshot',
        due_at = p_due_at,
        status = case when p_reactivate then 'active' else 'withdrawn' end
    where assignment_id = (provided_item ->> 'assignment_id')::uuid
      and group_id = p_group_id
      and deleted_at is null;
    updated_item_count := updated_item_count + 1;
  end loop;

  -- Re-apply recipients to every item, preserving the submitted order.
  for item_record in
    select assignment_id from public.writing_assignments
    where group_id = p_group_id and deleted_at is null
  loop
    delete from public.writing_assignment_students member
    where member.assignment_id = item_record.assignment_id
      and not (member.student_id = any(p_student_ids));

    insert into public.writing_assignment_students (assignment_id, student_id, sort_order)
    select item_record.assignment_id, selected.id, selected.position
    from (
      select id, min(ordinality)::integer as position
      from unnest(p_student_ids) with ordinality as ordered(id, ordinality)
      group by id
    ) selected
    on conflict (assignment_id, student_id)
      do update set sort_order = excluded.sort_order;
  end loop;

  return jsonb_build_object(
    'group_id', p_group_id,
    'item_count', updated_item_count,
    'student_count', requested_student_count,
    'status', case when p_reactivate then 'active' else 'withdrawn' end
  );
end;
$$;

revoke all on function public.update_withdrawn_writing_assignment_group(uuid, uuid, jsonb, uuid[], timestamptz, boolean)
  from public, anon, authenticated;
grant execute on function public.update_withdrawn_writing_assignment_group(uuid, uuid, jsonb, uuid[], timestamptz, boolean)
  to service_role;

-- ---------------------------------------------------------------------------
-- Verification SQL (read-only)
-- ---------------------------------------------------------------------------
--
-- select subject, task_type, count(*)
-- from public.writing_assignments
-- group by subject, task_type
-- order by subject, task_type;
--
-- select conname, pg_get_constraintdef(oid)
-- from pg_constraint
-- where conrelid = 'public.writing_assignments'::regclass
--   and conname in (
--     'writing_assignments_subject_check',
--     'writing_assignments_task_type_check',
--     'writing_assignments_subject_item_type_check'
--   );
--
-- select p.proname, pg_get_function_identity_arguments(p.oid)
-- from pg_proc p
-- join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public' and p.proname = 'create_writing_assignment_group';
