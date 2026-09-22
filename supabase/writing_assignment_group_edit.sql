-- Transactional withdrawn Assignment Group edit.
--
-- Run in the Supabase SQL Editor before deploying the matching app code.
-- Edits a whole withdrawn group in one transaction: every item keeps its
-- assignment_id (no add/remove), recipients are re-applied to every item in
-- the submitted order, and the group is left withdrawn or reactivated as one
-- unit. A legacy single assignment keeps using
-- update_withdrawn_writing_assignment and is not affected by this file.
--
-- Independent from the title / sort_order migration, the Phase B cleanup, the
-- create_writing_assignment_group overloads and the group withdraw RPC.
-- Re-running this file is safe: it only replaces this one function.

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

  for provided_item in select value from jsonb_array_elements(p_items)
  loop
    if provided_item ->> 'task_type' not in ('email', 'academic_discussion') then
      raise exception 'INVALID_TASK_TYPE';
    end if;
    if provided_item ->> 'question_source' not in ('question_bank', 'custom') then
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
  -- Recipients are active Students bound to this Teacher for the writing
  -- domain, same rule as the single edit RPC.
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
