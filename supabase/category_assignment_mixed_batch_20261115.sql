-- TPS mixed Assignment batch: normal items + one category practice.
--
-- MANUAL, additive migration. Execute in the Supabase SQL Editor before
-- deploying the matching application code. It never rewrites V1-V5 and never
-- touches the practice entitlement switch.
--
-- Scope:
--   * create_writing_assignment_group (student mode) accepts optional
--     bas_category / rap_category items in the same group;
--   * create_writing_assignment_group (class mode) does the same;
--   * update_withdrawn_writing_assignment_group can edit such a mixed group.
--
-- A category item is still one frozen Manifest and one submission. Its answer
-- map is written to category_assignment_answer_snapshots in the same
-- transaction and is never stored on writing_assignments.question_snapshot.

begin;

do $$
begin
  if to_regclass('public.category_assignment_answer_snapshots') is null
     or to_regprocedure('public.validate_category_assignment_manifest(text,jsonb)') is null then
    raise exception 'TPS_MIXED_ASSIGNMENT_V5_REQUIRED';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Student-mode create (subject-aware, mixed normal + category items)
-- ---------------------------------------------------------------------------
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
  v_item_type text;
  v_manifest jsonb;
  v_answers jsonb;
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

  if (
    select count(*)
    from jsonb_array_elements(p_assignments) item
    where item ->> 'task_type' in ('bas_category', 'rap_category')
  ) > 1 then
    raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
  end if;

  select count(*) into requested_student_count
  from (select distinct unnest(coalesce(p_student_ids, array[]::uuid[])) as id) students;
  if requested_student_count < 1 then
    raise exception 'At least one student is required';
  end if;

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
    v_item_type := assignment_data ->> 'task_type';
    if v_item_type not in (
      'email', 'academic_discussion', 'build_sentence', 'ctw', 'rdl', 'rap',
      'full_set', 'bas_category', 'rap_category'
    ) then
      raise exception 'Invalid assignment item type';
    end if;
    if assignment_data ->> 'question_source' not in ('question_bank', 'custom') then
      raise exception 'Invalid question source';
    end if;
    if p_subject = 'writing' then
      if v_item_type not in (
        'email', 'academic_discussion', 'build_sentence', 'bas_category'
      ) then
        raise exception 'MIXED_ASSIGNMENT_SUBJECT';
      end if;
    else
      if v_item_type not in ('ctw', 'rdl', 'rap', 'full_set', 'rap_category') then
        raise exception 'MIXED_ASSIGNMENT_SUBJECT';
      end if;
    end if;
    if jsonb_typeof(assignment_data -> 'question_snapshot') is distinct from 'object' then
      raise exception 'Question snapshot must be an object';
    end if;
    if assignment_data ->> 'question_source' = 'custom'
      and v_item_type not in ('email', 'academic_discussion') then
      raise exception 'Reading assignment requires question_bank source';
    end if;
    if assignment_data ->> 'question_source' = 'question_bank'
      and nullif(assignment_data ->> 'question_id', '') is null then
      raise exception 'Question bank assignment requires question_id';
    end if;
    if assignment_data ->> 'question_source' = 'custom'
      and nullif(assignment_data ->> 'question_id', '') is not null then
      raise exception 'Custom assignment cannot include question_id';
    end if;

    if v_item_type in ('bas_category', 'rap_category') then
      if assignment_data ->> 'question_source' <> 'question_bank' then
        raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
      end if;
      v_manifest := assignment_data -> 'question_snapshot';
      v_answers := coalesce(v_manifest -> 'answers', '{}'::jsonb);
      if jsonb_typeof(v_answers) is distinct from 'object' then
        raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
      end if;
      v_manifest := v_manifest - 'answers';
      perform public.validate_category_assignment_manifest(v_item_type, v_manifest);
      if btrim(assignment_data ->> 'question_id')
           is distinct from v_manifest ->> 'item_id' then
        raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
      end if;
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
  values (p_teacher_id, final_title, null)
  returning group_id into created_group_id;

  for assignment_data in select value from jsonb_array_elements(p_assignments)
  loop
    position := position + 1;
    v_item_type := assignment_data ->> 'task_type';
    if v_item_type in ('bas_category', 'rap_category') then
      v_answers := coalesce(
        assignment_data -> 'question_snapshot' -> 'answers',
        '{}'::jsonb
      );
      v_manifest := (assignment_data -> 'question_snapshot') - 'answers';
    else
      v_answers := null;
      v_manifest := assignment_data -> 'question_snapshot';
    end if;

    insert into public.writing_assignments (
      teacher_id, subject, group_id, group_position, task_type, question_source,
      question_id, question_snapshot, due_at
    ) values (
      p_teacher_id, p_subject, created_group_id, position,
      v_item_type,
      assignment_data ->> 'question_source',
      nullif(assignment_data ->> 'question_id', ''),
      v_manifest,
      nullif(assignment_data ->> 'due_at', '')::timestamptz
    ) returning assignment_id into created_assignment_id;

    assignment_ids := array_append(assignment_ids, created_assignment_id);

    if v_answers is not null then
      insert into public.category_assignment_answer_snapshots (assignment_id, answers, updated_at)
      values (created_assignment_id, v_answers, clock_timestamp())
      on conflict (assignment_id) do update
      set answers = excluded.answers, updated_at = clock_timestamp();
    end if;

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
-- 2. Class-mode create (subject-aware, mixed normal + category items)
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
  v_item_type text;
  v_manifest jsonb;
  v_answers jsonb;
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
      from unnest(class_row.subjects) as subject(domain)
      where class_row.teacher_id = p_teacher_id
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

  if (
    select count(*)
    from jsonb_array_elements(p_assignments) item
    where item ->> 'task_type' in ('bas_category', 'rap_category')
  ) > 1 then
    raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
  end if;

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
    v_item_type := assignment_data ->> 'task_type';
    if v_item_type not in (
      'email', 'academic_discussion', 'build_sentence', 'ctw', 'rdl', 'rap',
      'full_set', 'bas_category', 'rap_category'
    ) then
      raise exception 'Invalid assignment item type';
    end if;
    if assignment_data ->> 'question_source' not in ('question_bank', 'custom') then
      raise exception 'Invalid question source';
    end if;
    if p_subject = 'writing' then
      if v_item_type not in (
        'email', 'academic_discussion', 'build_sentence', 'bas_category'
      ) then
        raise exception 'MIXED_ASSIGNMENT_SUBJECT';
      end if;
    else
      if v_item_type not in ('ctw', 'rdl', 'rap', 'full_set', 'rap_category') then
        raise exception 'MIXED_ASSIGNMENT_SUBJECT';
      end if;
    end if;
    if assignment_data ->> 'question_source' = 'custom'
      and v_item_type not in ('email', 'academic_discussion') then
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

    if v_item_type in ('bas_category', 'rap_category') then
      if assignment_data ->> 'question_source' <> 'question_bank' then
        raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
      end if;
      v_manifest := assignment_data -> 'question_snapshot';
      v_answers := coalesce(v_manifest -> 'answers', '{}'::jsonb);
      if jsonb_typeof(v_answers) is distinct from 'object' then
        raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
      end if;
      v_manifest := v_manifest - 'answers';
      perform public.validate_category_assignment_manifest(v_item_type, v_manifest);
      if btrim(assignment_data ->> 'question_id')
           is distinct from v_manifest ->> 'item_id' then
        raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
      end if;
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
    v_item_type := assignment_data ->> 'task_type';
    if v_item_type in ('bas_category', 'rap_category') then
      v_answers := coalesce(
        assignment_data -> 'question_snapshot' -> 'answers',
        '{}'::jsonb
      );
      v_manifest := (assignment_data -> 'question_snapshot') - 'answers';
    else
      v_answers := null;
      v_manifest := assignment_data -> 'question_snapshot';
    end if;

    insert into public.writing_assignments (
      teacher_id, subject, group_id, group_position, task_type, question_source,
      question_id, question_snapshot, due_at
    ) values (
      p_teacher_id, p_subject, created_group_id, position,
      v_item_type,
      assignment_data ->> 'question_source',
      nullif(assignment_data ->> 'question_id', ''),
      v_manifest,
      nullif(assignment_data ->> 'due_at', '')::timestamptz
    ) returning assignment_id into created_assignment_id;

    assignment_ids := array_append(assignment_ids, created_assignment_id);

    if v_answers is not null then
      insert into public.category_assignment_answer_snapshots (assignment_id, answers, updated_at)
      values (created_assignment_id, v_answers, clock_timestamp())
      on conflict (assignment_id) do update
      set answers = excluded.answers, updated_at = clock_timestamp();
    end if;

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
-- 3. Withdrawn group edit (mixed normal + category items)
-- ---------------------------------------------------------------------------
create or replace function public.update_withdrawn_writing_assignment_group(
  p_teacher_id uuid,
  p_group_id uuid,
  p_legacy_assignment_id uuid,
  p_title text,
  p_items jsonb,
  p_student_ids uuid[],
  p_due_at timestamptz,
  p_reactivate boolean default false,
  p_class_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  effective_group_id uuid;
  current_legacy public.writing_assignments%rowtype;
  provided_item jsonb;
  item_record record;
  provided_assignment_id text;
  provided_existing_ids uuid[];
  owned_item_ids uuid[];
  recipient_ids uuid[];
  class_row public.teacher_classes%rowtype;
  current_item_count integer;
  provided_item_count integer;
  requested_student_count integer;
  valid_student_count integer;
  removed_with_attempt_count integer;
  removed_item_count integer;
  updated_item_count integer := 0;
  inserted_item_count integer := 0;
  next_position integer;
  derived_subject text;
  group_subjects text[];
  new_assignment_id uuid;
  v_item_type text;
  v_manifest jsonb;
  v_answers jsonb;
begin
  -- 1. Resolve and lock the effective group (existing group or legacy item).
  if p_group_id is not null then
    perform 1
    from public.writing_assignment_groups
    where group_id = p_group_id
      and teacher_id = p_teacher_id
    for update;
    if not found then
      raise exception 'ASSIGNMENT_GROUP_NOT_FOUND';
    end if;
    effective_group_id := p_group_id;
  elsif p_legacy_assignment_id is not null then
    select * into current_legacy
    from public.writing_assignments
    where assignment_id = p_legacy_assignment_id
      and teacher_id = p_teacher_id
      and deleted_at is null
    for update;
    if not found then
      raise exception 'ASSIGNMENT_NOT_FOUND';
    end if;
    if current_legacy.status <> 'withdrawn' then
      raise exception 'ASSIGNMENT_NOT_WITHDRAWN';
    end if;
    if current_legacy.group_id is not null then
      effective_group_id := current_legacy.group_id;
      perform 1
      from public.writing_assignment_groups
      where group_id = effective_group_id
        and teacher_id = p_teacher_id
      for update;
      if not found then
        raise exception 'ASSIGNMENT_GROUP_NOT_FOUND';
      end if;
    else
      insert into public.writing_assignment_groups (teacher_id, title)
      values (p_teacher_id, nullif(btrim(coalesce(p_title, '')), ''))
      returning group_id into effective_group_id;
      update public.writing_assignments
      set group_id = effective_group_id,
          group_position = 1
      where assignment_id = p_legacy_assignment_id;
    end if;
  else
    raise exception 'ASSIGNMENT_GROUP_NOT_FOUND';
  end if;

  perform 1
  from public.writing_assignments
  where group_id = effective_group_id
    and deleted_at is null
  for update;

  select count(*) into current_item_count
  from public.writing_assignments
  where group_id = effective_group_id
    and deleted_at is null;
  if current_item_count < 1 then
    raise exception 'ASSIGNMENT_GROUP_NOT_FOUND';
  end if;

  if exists (
    select 1 from public.writing_assignments
    where group_id = effective_group_id
      and deleted_at is null
      and status <> 'withdrawn'
  ) then
    raise exception 'ASSIGNMENT_GROUP_NOT_WITHDRAWN';
  end if;

  -- 2. Validate the payload shape and the provided existing item ids.
  if jsonb_typeof(p_items) is distinct from 'array'
    or jsonb_array_length(p_items) < 1
    or jsonb_array_length(p_items) > 50 then
    raise exception 'INVALID_GROUP_ITEMS';
  end if;
  provided_item_count := jsonb_array_length(p_items);

  if (
    select count(*)
    from jsonb_array_elements(p_items) item
    where item ->> 'task_type' in ('bas_category', 'rap_category')
  ) > 1 then
    raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
  end if;

  select coalesce(array_agg((value ->> 'assignment_id')::uuid), array[]::uuid[])
  into provided_existing_ids
  from jsonb_array_elements(p_items)
  where nullif(value ->> 'assignment_id', '') is not null;

  if (select count(distinct id) from unnest(provided_existing_ids) as ids(id))
     <> coalesce(array_length(provided_existing_ids, 1), 0) then
    raise exception 'INVALID_GROUP_ITEMS';
  end if;

  select coalesce(array_agg(assignment_id), array[]::uuid[])
  into owned_item_ids
  from public.writing_assignments
  where group_id = effective_group_id
    and deleted_at is null;

  if exists (
    select 1
    from unnest(provided_existing_ids) as provided(id)
    where provided.id <> all(owned_item_ids)
  ) then
    raise exception 'INVALID_GROUP_ITEMS';
  end if;

  -- 3. Per-item validation (types, question identity, frozen questions).
  for provided_item in select value from jsonb_array_elements(p_items)
  loop
    v_item_type := provided_item ->> 'task_type';
    if v_item_type not in (
      'email', 'academic_discussion', 'build_sentence', 'ctw', 'rdl', 'rap',
      'full_set', 'bas_category', 'rap_category'
    ) then
      raise exception 'INVALID_TASK_TYPE';
    end if;
    if provided_item ->> 'question_source' not in ('question_bank', 'custom') then
      raise exception 'INVALID_QUESTION_SOURCE';
    end if;
    if provided_item ->> 'question_source' = 'custom'
      and v_item_type not in ('email', 'academic_discussion') then
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

    if v_item_type in ('bas_category', 'rap_category') then
      if provided_item ->> 'question_source' <> 'question_bank' then
        raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
      end if;
      v_manifest := provided_item -> 'question_snapshot';
      v_answers := coalesce(v_manifest -> 'answers', '{}'::jsonb);
      if jsonb_typeof(v_answers) is distinct from 'object' then
        raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
      end if;
      v_manifest := v_manifest - 'answers';
      perform public.validate_category_assignment_manifest(v_item_type, v_manifest);
      if btrim(provided_item ->> 'question_id')
           is distinct from v_manifest ->> 'item_id' then
        raise exception 'INVALID_CATEGORY_ASSIGNMENT_MANIFEST';
      end if;
    end if;

    if nullif(provided_item ->> 'assignment_id', '') is not null then
      select * into item_record
      from public.writing_assignments
      where assignment_id = (provided_item ->> 'assignment_id')::uuid
        and group_id = effective_group_id
        and deleted_at is null;
      if not found then
        raise exception 'INVALID_GROUP_ITEMS';
      end if;

      if exists (
        select 1 from public.writing_attempts
        where assignment_id = item_record.assignment_id
          and status = 'submitted'
      ) and (
        item_record.task_type is distinct from v_item_type
        or item_record.question_source is distinct from provided_item ->> 'question_source'
        or item_record.question_id is distinct from nullif(provided_item ->> 'question_id', '')
        or item_record.question_snapshot is distinct from (
          case
            when v_item_type in ('bas_category', 'rap_category')
              then (provided_item -> 'question_snapshot') - 'answers'
            else provided_item -> 'question_snapshot'
          end
        )
      ) then
        raise exception 'QUESTION_LOCKED_AFTER_SUBMISSION';
      end if;
    end if;
  end loop;

  select array_agg(distinct case
      when value ->> 'task_type' in (
        'ctw', 'rdl', 'rap', 'full_set', 'rap_category'
      ) then 'reading'
      else 'writing'
    end)
  into group_subjects
  from jsonb_array_elements(p_items);
  if group_subjects is null or array_length(group_subjects, 1) <> 1 then
    raise exception 'MIXED_ASSIGNMENT_SUBJECT';
  end if;
  derived_subject := group_subjects[1];

  -- 4. Recipients: explicit student list or the selected class members.
  if p_class_id is not null then
    select * into class_row
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
        from unnest(class_row.subjects) as subject(domain)
        where class_row.teacher_id = p_teacher_id
        union all
        select unnest(link.subjects) as domain
        from public.teacher_class_bindings link
        where link.class_id = p_class_id
          and link.teacher_id = p_teacher_id
      ) acting_subject
      where acting_subject.domain = derived_subject
    ) then
      if derived_subject = 'reading' then
        raise exception 'CLASS_NOT_READING_CLASS';
      end if;
      raise exception 'CLASS_NOT_WRITING_CLASS';
    end if;

    select coalesce(array_agg(member.student_id order by member.joined_at, member.student_id), array[]::uuid[])
    into recipient_ids
    from public.class_members member
    where member.class_id = p_class_id;
    if coalesce(array_length(recipient_ids, 1), 0) < 1 then
      raise exception 'CLASS_HAS_NO_MEMBERS';
    end if;

    requested_student_count := array_length(recipient_ids, 1);
    select count(*) into valid_student_count
    from unnest(recipient_ids) as students(id)
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
  else
    select coalesce(array_agg(ordered.id order by ordered.position), array[]::uuid[])
    into recipient_ids
    from (
      select id, min(ordinality)::integer as position
      from unnest(coalesce(p_student_ids, array[]::uuid[])) with ordinality as submitted(id, ordinality)
      where id is not null
      group by id
    ) ordered;
    requested_student_count := coalesce(array_length(recipient_ids, 1), 0);
    if requested_student_count < 1 then
      raise exception 'STUDENT_REQUIRED';
    end if;
    select count(*) into valid_student_count
    from unnest(recipient_ids) as students(id)
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
  end if;

  -- 5. Remove the visible items that are no longer part of the payload.
  select count(*) into removed_with_attempt_count
  from public.writing_assignments item
  where item.group_id = effective_group_id
    and item.deleted_at is null
    and item.assignment_id <> all(provided_existing_ids)
    and exists (
      select 1 from public.writing_attempts attempt
      where attempt.assignment_id = item.assignment_id
    );
  if removed_with_attempt_count > 0 then
    raise exception 'ITEM_HAS_ATTEMPT';
  end if;

  delete from public.writing_assignment_students member
  where member.assignment_id in (
    select item.assignment_id
    from public.writing_assignments item
    where item.group_id = effective_group_id
      and item.deleted_at is null
      and item.assignment_id <> all(provided_existing_ids)
  );

  delete from public.category_assignment_answer_snapshots snapshot
  using public.writing_assignments item
  where snapshot.assignment_id = item.assignment_id
    and item.group_id = effective_group_id
    and item.deleted_at is null
    and item.assignment_id <> all(provided_existing_ids);

  update public.writing_assignments
  set deleted_at = now()
  where group_id = effective_group_id
    and deleted_at is null
    and assignment_id <> all(provided_existing_ids);
  get diagnostics removed_item_count = row_count;

  select count(*) into removed_with_attempt_count
  from public.writing_assignment_students member
  join public.writing_assignments item
    on item.assignment_id = member.assignment_id
   and item.group_id = effective_group_id
   and item.deleted_at is null
  where not (member.student_id = any(recipient_ids))
    and exists (
      select 1 from public.writing_attempts attempt
      where attempt.assignment_id = member.assignment_id
        and attempt.user_id = member.student_id
    );
  if removed_with_attempt_count > 0 then
    raise exception 'STUDENT_HAS_ATTEMPT';
  end if;

  -- 6. Apply the title, class association, items and recipients atomically.
  if p_title is not null and btrim(p_title) <> '' then
    if char_length(btrim(p_title)) > 120 then
      raise exception 'Assignment title is too long';
    end if;
    update public.writing_assignment_groups
    set title = btrim(p_title)
    where group_id = effective_group_id
      and teacher_id = p_teacher_id;
  end if;

  update public.writing_assignment_groups
  set class_id = p_class_id
  where group_id = effective_group_id
    and teacher_id = p_teacher_id;

  select coalesce(max(group_position), 0) into next_position
  from public.writing_assignments
  where group_id = effective_group_id;

  for provided_item in select value from jsonb_array_elements(p_items)
  loop
    provided_assignment_id := nullif(provided_item ->> 'assignment_id', '');
    v_item_type := provided_item ->> 'task_type';
    if v_item_type in ('bas_category', 'rap_category') then
      v_answers := coalesce(
        provided_item -> 'question_snapshot' -> 'answers',
        '{}'::jsonb
      );
      v_manifest := (provided_item -> 'question_snapshot') - 'answers';
    else
      v_answers := null;
      v_manifest := provided_item -> 'question_snapshot';
    end if;

    if provided_assignment_id is null then
      next_position := next_position + 1;
      insert into public.writing_assignments (
        teacher_id, subject, group_id, group_position, task_type, question_source,
        question_id, question_snapshot, due_at, status
      ) values (
        p_teacher_id,
        derived_subject,
        effective_group_id,
        next_position,
        v_item_type,
        provided_item ->> 'question_source',
        nullif(provided_item ->> 'question_id', ''),
        v_manifest,
        p_due_at,
        case when coalesce(p_reactivate, false) then 'active' else 'withdrawn' end
      ) returning assignment_id into new_assignment_id;
      inserted_item_count := inserted_item_count + 1;

      if v_answers is not null then
        insert into public.category_assignment_answer_snapshots (assignment_id, answers, updated_at)
        values (new_assignment_id, v_answers, clock_timestamp())
        on conflict (assignment_id) do update
        set answers = excluded.answers, updated_at = clock_timestamp();
      end if;

      insert into public.writing_assignment_students (assignment_id, student_id, sort_order)
      select new_assignment_id, selected.id, selected.position
      from (
        select id, min(ordinality)::integer as position
        from unnest(recipient_ids) with ordinality as ordered(id, ordinality)
        group by id
      ) selected
      on conflict (assignment_id, student_id)
        do update set sort_order = excluded.sort_order;
    else
      update public.writing_assignments
      set task_type = v_item_type,
          subject = derived_subject,
          question_source = provided_item ->> 'question_source',
          question_id = nullif(provided_item ->> 'question_id', ''),
          question_snapshot = v_manifest,
          due_at = p_due_at,
          status = case when coalesce(p_reactivate, false) then 'active' else 'withdrawn' end
      where assignment_id = provided_assignment_id::uuid
        and group_id = effective_group_id
        and deleted_at is null;
      updated_item_count := updated_item_count + 1;

      if v_answers is not null then
        insert into public.category_assignment_answer_snapshots (assignment_id, answers, updated_at)
        values (provided_assignment_id::uuid, v_answers, clock_timestamp())
        on conflict (assignment_id) do update
        set answers = excluded.answers, updated_at = clock_timestamp();
      else
        delete from public.category_assignment_answer_snapshots
        where assignment_id = provided_assignment_id::uuid;
      end if;

      delete from public.writing_assignment_students member
      where member.assignment_id = provided_assignment_id::uuid
        and not (member.student_id = any(recipient_ids));
      insert into public.writing_assignment_students (assignment_id, student_id, sort_order)
      select provided_assignment_id::uuid, selected.id, selected.position
      from (
        select id, min(ordinality)::integer as position
        from unnest(recipient_ids) with ordinality as ordered(id, ordinality)
        group by id
      ) selected
      on conflict (assignment_id, student_id)
        do update set sort_order = excluded.sort_order;
    end if;
  end loop;

  return jsonb_build_object(
    'group_id', effective_group_id,
    'item_count', updated_item_count + inserted_item_count,
    'updated_item_count', updated_item_count,
    'inserted_item_count', inserted_item_count,
    'removed_item_count', removed_item_count,
    'student_count', requested_student_count,
    'class_id', p_class_id,
    'status', case when coalesce(p_reactivate, false) then 'active' else 'withdrawn' end
  );
end;
$$;

revoke all on function public.update_withdrawn_writing_assignment_group(uuid, uuid, uuid, text, jsonb, uuid[], timestamptz, boolean, uuid)
  from public, anon, authenticated;
grant execute on function public.update_withdrawn_writing_assignment_group(uuid, uuid, uuid, text, jsonb, uuid[], timestamptz, boolean, uuid)
  to service_role;

commit;
