-- Admin-only historical Writing Assignment ownership transfer.
-- Run after supabase/writing_assignments.sql and supabase/writing_assignment_groups.sql.
--
-- This moves ownership only. writing_assignment_students, writing_attempts,
-- writing_reviews, and writing_review_ai_logs keep their rows untouched and
-- stay attached through assignment_id / attempt_id.
--
-- The function is the single atomic mutation point: every check runs in the
-- same transaction as the ownership updates, so a failure rolls the whole
-- transfer back (no partial group migration).

create or replace function public.transfer_writing_assignment_ownership(
  p_assignment_id uuid,
  p_group_id uuid,
  p_target_teacher_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  source_teacher_id uuid;
  source_role text;
  target_role text;
  target_is_active boolean;
  group_teacher_id uuid;
  assignment_ids uuid[];
  locked_assignment_ids uuid[];
  missing_student_ids uuid[];
  transferred_count integer;
begin
  if (p_assignment_id is null) = (p_group_id is null) then
    raise exception 'TRANSFER_UNIT_REQUIRED';
  end if;

  select role, is_active into target_role, target_is_active
  from public.profiles
  where id = p_target_teacher_id
  for share;

  if target_role is distinct from 'teacher' or target_is_active is distinct from true then
    raise exception 'INVALID_TARGET_TEACHER';
  end if;

  if p_group_id is not null then
    select teacher_id into group_teacher_id
    from public.writing_assignment_groups
    where group_id = p_group_id
    for update;

    if not found then
      raise exception 'TRANSFER_UNIT_NOT_FOUND';
    end if;

    select array_agg(locked.assignment_id)
    into locked_assignment_ids
    from (
      select assignment_id
      from public.writing_assignments
      where group_id = p_group_id
      for update
    ) locked;

    if locked_assignment_ids is null then
      raise exception 'TRANSFER_UNIT_NOT_FOUND';
    end if;

    if exists (
      select 1
      from public.writing_assignments
      where group_id = p_group_id
        and teacher_id is distinct from group_teacher_id
    ) then
      raise exception 'TRANSFER_OWNER_MISMATCH';
    end if;

    assignment_ids := locked_assignment_ids;
    source_teacher_id := group_teacher_id;
  else
    select teacher_id into source_teacher_id
    from public.writing_assignments
    where assignment_id = p_assignment_id
      and group_id is null
    for update;

    if not found then
      if exists (
        select 1
        from public.writing_assignments
        where assignment_id = p_assignment_id
      ) then
        raise exception 'TRANSFER_GROUP_REQUIRED';
      end if;
      raise exception 'TRANSFER_UNIT_NOT_FOUND';
    end if;

    assignment_ids := array[p_assignment_id];
  end if;

  select role into source_role
  from public.profiles
  where id = source_teacher_id
  for share;

  if source_role is distinct from 'admin' then
    raise exception 'TRANSFER_SOURCE_NOT_ADMIN';
  end if;

  -- Hold the existing binding rows so a concurrent binding deletion cannot
  -- race past the recipient check before the ownership update commits.
  perform 1
  from public.teacher_student_bindings binding
  where binding.teacher_id = p_target_teacher_id
    and binding.domain = 'writing'
    and binding.student_id in (
      select member.student_id
      from public.writing_assignment_students member
      where member.assignment_id = any(assignment_ids)
    )
  for share;

  select array_agg(distinct member.student_id)
  into missing_student_ids
  from public.writing_assignment_students member
  where member.assignment_id = any(assignment_ids)
    and not exists (
      select 1
      from public.teacher_student_bindings binding
      where binding.teacher_id = p_target_teacher_id
        and binding.student_id = member.student_id
        and binding.domain = 'writing'
    );

  if coalesce(array_length(missing_student_ids, 1), 0) > 0 then
    raise exception 'TRANSFER_MISSING_WRITING_BINDING';
  end if;

  if p_group_id is not null then
    update public.writing_assignment_groups
    set teacher_id = p_target_teacher_id
    where group_id = p_group_id;
  end if;

  update public.writing_assignments
  set teacher_id = p_target_teacher_id
  where assignment_id = any(assignment_ids);

  get diagnostics transferred_count = row_count;

  return jsonb_build_object(
    'group_id', p_group_id,
    'assignment_ids', to_jsonb(assignment_ids),
    'teacher_id', p_target_teacher_id,
    'transferred_assignment_count', transferred_count
  );
end;
$$;

revoke all on function public.transfer_writing_assignment_ownership(uuid, uuid, uuid) from public;
revoke all on function public.transfer_writing_assignment_ownership(uuid, uuid, uuid) from anon;
revoke all on function public.transfer_writing_assignment_ownership(uuid, uuid, uuid) from authenticated;
grant execute on function public.transfer_writing_assignment_ownership(uuid, uuid, uuid) to service_role;
