-- Final production hotfix for teacher-side Writing Assignment recipient checks.
--
-- Problem: the deployed create_writing_assignment_group and
-- update_withdrawn_writing_assignment validated recipients through the legacy
-- profiles.owner_id path (public.can_assign_student_as). Phase 7 recipients are
-- bound through teacher_student_bindings, so every binding-based assignment
-- creation and withdrawn-assignment edit failed with
-- "One or more students are invalid" / "INVALID_STUDENT".
--
-- Run once in the Supabase SQL Editor after the existing writing assignment
-- migrations. Only the two function definitions change; no table data is
-- touched, and re-running this file is safe.
--
-- Kept rules:
--   * Only an active role='teacher' profile can create a group.
--   * Assignment owner (teacher_id on assignments, group.teacher_id) stays the
--     current Teacher; historical ownership is untouched.
--   * Every recipient must be an active Student with a writing-domain
--     teacher_student_bindings row for this Teacher. owner_id is never a
--     fallback, so owner_id=teacher without a writing binding still fails.
--   * Both RPCs stay a single atomic transaction with the existing
--     withdrawn-edit restrictions (QUESTION_LOCKED_AFTER_SUBMISSION,
--     STUDENT_HAS_ATTEMPT) unchanged.
--   * EXECUTE stays granted to service_role only.

create or replace function public.create_writing_assignment_group(
  p_teacher_id uuid,
  p_assignments jsonb,
  p_student_ids uuid[]
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
begin
  if not exists (
    select 1 from public.profiles
    where id = p_teacher_id and role = 'teacher' and is_active = true
  ) then
    raise exception 'Invalid teacher';
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

  -- Recipients are active Students bound to this Teacher for the writing
  -- domain. Legacy profiles.owner_id is never used as an assignment fallback.
  select count(*) into valid_student_count
  from (select distinct unnest(p_student_ids) as id) students
  join public.profiles student
    on student.id = students.id
   and student.role = 'student'
   and student.is_active = true
  join public.teacher_student_bindings binding
    on binding.teacher_id = p_teacher_id
   and binding.student_id = students.id
   and binding.domain = 'writing';
  if valid_student_count <> requested_student_count then
    raise exception 'One or more students are invalid';
  end if;

  for assignment_data in select value from jsonb_array_elements(p_assignments)
  loop
    if assignment_data ->> 'task_type' not in ('email', 'academic_discussion') then
      raise exception 'Invalid writing task type';
    end if;
    if assignment_data ->> 'question_source' not in ('question_bank', 'custom') then
      raise exception 'Invalid question source';
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

  insert into public.writing_assignment_groups (teacher_id)
  values (p_teacher_id)
  returning group_id into created_group_id;

  for assignment_data in select value from jsonb_array_elements(p_assignments)
  loop
    position := position + 1;
    insert into public.writing_assignments (
      teacher_id, group_id, group_position, task_type, question_source,
      question_id, question_snapshot, due_at
    ) values (
      p_teacher_id, created_group_id, position,
      assignment_data ->> 'task_type',
      assignment_data ->> 'question_source',
      nullif(assignment_data ->> 'question_id', ''),
      assignment_data -> 'question_snapshot',
      nullif(assignment_data ->> 'due_at', '')::timestamptz
    ) returning assignment_id into created_assignment_id;

    assignment_ids := array_append(assignment_ids, created_assignment_id);
    insert into public.writing_assignment_students (assignment_id, student_id)
    select created_assignment_id, id
    from (select distinct unnest(p_student_ids) as id) students;
  end loop;

  return jsonb_build_object(
    'group_id', created_group_id,
    'assignment_ids', to_jsonb(assignment_ids)
  );
end;
$$;

revoke all on function public.create_writing_assignment_group(uuid, jsonb, uuid[])
  from public, anon, authenticated;
grant execute on function public.create_writing_assignment_group(uuid, jsonb, uuid[])
  to service_role;

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
begin
  select * into current_assignment from public.writing_assignments
  where assignment_id = p_assignment_id and teacher_id = p_teacher_id for update;
  if not found or current_assignment.deleted_at is not null then raise exception 'ASSIGNMENT_NOT_FOUND'; end if;
  if current_assignment.status <> 'withdrawn' then raise exception 'ASSIGNMENT_NOT_WITHDRAWN'; end if;
  if p_task_type not in ('email', 'academic_discussion') then raise exception 'INVALID_TASK_TYPE'; end if;
  if p_question_source not in ('question_bank', 'custom') then raise exception 'INVALID_QUESTION_SOURCE'; end if;
  if jsonb_typeof(p_question_snapshot) is distinct from 'object' then raise exception 'INVALID_QUESTION_SNAPSHOT'; end if;

  select count(*) into requested_student_count
  from (select distinct unnest(coalesce(p_student_ids, array[]::uuid[])) as id) students;
  if requested_student_count < 1 then raise exception 'STUDENT_REQUIRED'; end if;
  -- Recipients are active Students bound to this Teacher for the writing
  -- domain. Legacy profiles.owner_id is never used as an assignment fallback.
  select count(*) into valid_student_count
  from (select distinct unnest(p_student_ids) as id) students
  join public.profiles student
    on student.id = students.id
   and student.role = 'student'
   and student.is_active = true
  join public.teacher_student_bindings binding
    on binding.teacher_id = p_teacher_id
   and binding.student_id = students.id
   and binding.domain = 'writing';
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
  set task_type = p_task_type, question_source = p_question_source,
      question_id = p_question_id, question_snapshot = p_question_snapshot,
      due_at = p_due_at,
      status = case when p_reactivate then 'active' else 'withdrawn' end
  where assignment_id = p_assignment_id;

  delete from public.writing_assignment_students member
  where member.assignment_id = p_assignment_id
    and not (member.student_id = any(p_student_ids));
  insert into public.writing_assignment_students (assignment_id, student_id)
  select p_assignment_id, id from (select distinct unnest(p_student_ids) as id) students
  on conflict (assignment_id, student_id) do nothing;
end;
$$;

revoke all on function public.update_withdrawn_writing_assignment(uuid, uuid, text, text, text, jsonb, timestamptz, uuid[], boolean)
  from public, anon, authenticated;
grant execute on function public.update_withdrawn_writing_assignment(uuid, uuid, text, text, text, jsonb, timestamptz, uuid[], boolean)
  to service_role;
