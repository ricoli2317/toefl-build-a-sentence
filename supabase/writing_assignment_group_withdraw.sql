-- Transactional Assignment Group withdrawal.
--
-- Run in the Supabase SQL Editor before deploying the matching app code.
-- This replaces the previous route-level flow (withdraw item A, item B, then
-- restore A when B fails) with one database transaction:
--   * the group row and every visible item are row-locked;
--   * all items must still be active and the group must have no attempt at all;
--   * only then is the whole group updated to withdrawn in the same transaction.
-- A student starting an attempt at the same time either blocks until this
-- transaction finishes (and is then rejected by the existing active-assignment
-- trigger) or wins the lock first (and the withdrawal raises and changes
-- nothing).
--
-- Independent from the title / sort_order migration, the Phase B cleanup and
-- the create_writing_assignment_group overloads. Re-running this file is safe:
-- it only replaces this one function.

create or replace function public.withdraw_writing_assignment_group(
  p_teacher_id uuid,
  p_group_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  item_count integer;
  active_count integer;
  attempt_count integer;
  withdrawn_count integer := 0;
begin
  -- Lock the group row: it both verifies ownership and serializes concurrent
  -- group mutations against each other.
  perform 1
  from public.writing_assignment_groups
  where group_id = p_group_id
    and teacher_id = p_teacher_id
  for update;
  if not found then
    raise exception 'ASSIGNMENT_GROUP_NOT_FOUND';
  end if;

  -- Lock every visible item. The active-assignment trigger takes FOR KEY SHARE
  -- on these same rows, so an attempt started concurrently can never coexist
  -- with a committed group withdrawal.
  perform 1
  from public.writing_assignments
  where group_id = p_group_id
    and deleted_at is null
  for update;

  select count(*) into item_count
  from public.writing_assignments
  where group_id = p_group_id
    and deleted_at is null;
  if item_count < 1 then
    raise exception 'ASSIGNMENT_GROUP_NOT_FOUND';
  end if;

  select count(*) into active_count
  from public.writing_assignments
  where group_id = p_group_id
    and deleted_at is null
    and status = 'active';
  if active_count <> item_count then
    raise exception 'ASSIGNMENT_GROUP_NOT_ACTIVE';
  end if;

  -- Checked inside the same transaction and after the item locks, so a
  -- just-started attempt can no longer slip in behind the check.
  select count(*) into attempt_count
  from public.writing_attempts attempt
  where attempt.assignment_id in (
    select item.assignment_id
    from public.writing_assignments item
    where item.group_id = p_group_id
      and item.deleted_at is null
  );
  if attempt_count > 0 then
    raise exception 'ASSIGNMENT_GROUP_HAS_ATTEMPT';
  end if;

  update public.writing_assignments
  set status = 'withdrawn'
  where group_id = p_group_id
    and deleted_at is null
    and status = 'active';
  get diagnostics withdrawn_count = row_count;

  return jsonb_build_object(
    'group_id', p_group_id,
    'withdrawn_count', withdrawn_count
  );
end;
$$;

revoke all on function public.withdraw_writing_assignment_group(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.withdraw_writing_assignment_group(uuid, uuid)
  to service_role;
