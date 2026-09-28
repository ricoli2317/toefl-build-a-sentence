-- TPS｜教师端作业管理：撤回后完整编辑整组作业（加题 / 删题 / 换题型 / 换学生班级）
--
-- Run in the Supabase SQL Editor before deploying the matching app code.
--
-- Scope
--   * Replaces `update_withdrawn_writing_assignment_group` with a signature
--     that matches the shared withdrawn-edit wizard:
--       - items may be existing (`assignment_id` present) or new (no
--         `assignment_id`); visible items missing from the payload are
--         soft-deleted, so 撤回后的编辑 can add / remove / re-type items;
--       - `p_group_id` may be NULL for a historical group-less Assignment,
--         which is adopted into a fresh group in the same transaction
--         (`p_legacy_assignment_id`);
--       - `p_class_id` re-targets the group to a class (recipients resolved
--         from the class members at save time) or clears the association when
--         NULL and `p_student_ids` is used;
--       - `p_title` updates the persisted Assignment Group title when a
--         non-empty title is provided.
--   * Safety is unchanged: only a fully withdrawn group can be edited; the
--     group row and every visible item are row-locked; a student or item with
--     any attempt can never be removed; an item with a submitted attempt keeps
--     its frozen question; recipients must be active Students bound to the
--     Teacher for the item subject; the whole group stays single-subject.
--   * The previous 6-argument overload is dropped, not shadowed.
--
-- Re-running this file is safe: it drops the old signature (if it still
-- exists) and replaces the function.

drop function if exists public.update_withdrawn_writing_assignment_group(
  uuid, uuid, jsonb, uuid[], timestamptz, boolean
);

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
begin
  -- -------------------------------------------------------------------------
  -- 1. Resolve and lock the effective group (existing group or legacy item).
  -- -------------------------------------------------------------------------
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

  -- Lock every visible item of the group. The active-assignment trigger takes
  -- FOR KEY SHARE on the same rows, so attempts and question edits cannot
  -- interleave.
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

  -- Editing follows the historical rule: only a fully withdrawn group can be
  -- edited.
  if exists (
    select 1 from public.writing_assignments
    where group_id = effective_group_id
      and deleted_at is null
      and status <> 'withdrawn'
  ) then
    raise exception 'ASSIGNMENT_GROUP_NOT_WITHDRAWN';
  end if;

  -- -------------------------------------------------------------------------
  -- 2. Validate the payload shape and the provided existing item ids.
  -- -------------------------------------------------------------------------
  if jsonb_typeof(p_items) is distinct from 'array'
    or jsonb_array_length(p_items) < 1
    or jsonb_array_length(p_items) > 50 then
    raise exception 'INVALID_GROUP_ITEMS';
  end if;
  provided_item_count := jsonb_array_length(p_items);

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

  -- -------------------------------------------------------------------------
  -- 3. Per-item validation (types, question identity, frozen questions).
  -- -------------------------------------------------------------------------
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

    if nullif(provided_item ->> 'assignment_id', '') is not null then
      select * into item_record
      from public.writing_assignments
      where assignment_id = (provided_item ->> 'assignment_id')::uuid
        and group_id = effective_group_id
        and deleted_at is null;
      if not found then
        raise exception 'INVALID_GROUP_ITEMS';
      end if;

      -- Submitted items keep their frozen question, same as before.
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
    end if;
  end loop;

  -- Every provided item must share exactly one subject; the group can never
  -- become mixed.
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

  -- -------------------------------------------------------------------------
  -- 4. Recipients: explicit student list or the selected class members.
  -- -------------------------------------------------------------------------
  if p_class_id is not null then
    select * into class_row
    from public.teacher_classes
    where class_id = p_class_id
      and teacher_id = p_teacher_id
    for update;
    if not found then
      raise exception 'CLASS_NOT_FOUND';
    end if;
    if not (derived_subject = any(class_row.subjects)) then
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

  -- -------------------------------------------------------------------------
  -- 5. Remove the visible items that are no longer part of the payload.
  --    Any item with an attempt is never removable.
  -- -------------------------------------------------------------------------
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

  update public.writing_assignments
  set deleted_at = now()
  where group_id = effective_group_id
    and deleted_at is null
    and assignment_id <> all(provided_existing_ids);
  get diagnostics removed_item_count = row_count;

  -- A student with any attempt on a remaining item of the group cannot be
  -- removed.
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

  -- -------------------------------------------------------------------------
  -- 6. Apply the title, class association, items and recipients atomically.
  -- -------------------------------------------------------------------------
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
  where group_id = effective_group_id
    and deleted_at is null;

  for provided_item in select value from jsonb_array_elements(p_items)
  loop
    provided_assignment_id := nullif(provided_item ->> 'assignment_id', '');
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
        provided_item ->> 'task_type',
        provided_item ->> 'question_source',
        nullif(provided_item ->> 'question_id', ''),
        provided_item -> 'question_snapshot',
        p_due_at,
        case when coalesce(p_reactivate, false) then 'active' else 'withdrawn' end
      ) returning assignment_id into new_assignment_id;
      inserted_item_count := inserted_item_count + 1;

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
      set task_type = provided_item ->> 'task_type',
          subject = derived_subject,
          question_source = provided_item ->> 'question_source',
          question_id = nullif(provided_item ->> 'question_id', ''),
          question_snapshot = provided_item -> 'question_snapshot',
          due_at = p_due_at,
          status = case when coalesce(p_reactivate, false) then 'active' else 'withdrawn' end
      where assignment_id = provided_assignment_id::uuid
        and group_id = effective_group_id
        and deleted_at is null;
      updated_item_count := updated_item_count + 1;

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

revoke all on function public.update_withdrawn_writing_assignment_group(
  uuid, uuid, uuid, text, jsonb, uuid[], timestamptz, boolean, uuid
) from public, anon, authenticated;
grant execute on function public.update_withdrawn_writing_assignment_group(
  uuid, uuid, uuid, text, jsonb, uuid[], timestamptz, boolean, uuid
) to service_role;

-- ---------------------------------------------------------------------------
-- Verification SQL (read-only; run after applying)
-- ---------------------------------------------------------------------------
--
-- 1. The function exists exactly once, with the new signature:
--
-- select p.proname, pg_get_function_identity_arguments(p.oid)
-- from pg_proc p
-- join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public'
--   and p.proname = 'update_withdrawn_writing_assignment_group';
--
-- 2. A withdrawn group with its items and recipients (replace the values):
--
-- select a.assignment_id, a.group_position, a.task_type, a.question_source,
--        a.question_id, a.status, a.deleted_at
-- from public.writing_assignments a
-- where a.group_id = '<group_id>'
-- order by a.group_position, a.assignment_id;
--
-- select s.assignment_id, s.student_id, s.sort_order
-- from public.writing_assignment_students s
-- join public.writing_assignments a on a.assignment_id = s.assignment_id
-- where a.group_id = '<group_id>'
-- order by s.assignment_id, s.sort_order;
--
-- 3. No withdrawn item may carry an attempt (should return 0 rows):
--
-- select a.assignment_id
-- from public.writing_assignments a
-- join public.writing_attempts t on t.assignment_id = a.assignment_id
-- where a.status = 'withdrawn' and a.deleted_at is null;
