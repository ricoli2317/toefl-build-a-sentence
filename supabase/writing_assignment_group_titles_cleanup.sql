-- Phase B cleanup for the two-phase Writing Assignment title deployment.
--
-- Run this file ONLY after supabase/writing_assignment_group_titles.sql (Phase
-- A, 5-argument version) has been applied AND the new code is deployed and
-- verified in production (new single-type, mixed-type and multi-student
-- assignments all persist their title and recipient order correctly).
--
-- It removes every legacy create_writing_assignment_group overload that Phase A
-- intentionally kept for forward compatibility:
--   * create_writing_assignment_group(uuid, jsonb, uuid[])            (original)
--   * create_writing_assignment_group(uuid, jsonb, uuid[], text)      (previous Phase A)
-- then verifies that exactly the 5-argument overload remains with
-- service_role-only execute permission. Dropping each overload also removes its
-- object and ACL entries; the guarded revokes make that explicit and leave no
-- execute grant behind.
--
-- Do not run this in the same step as Phase A.

do $$
begin
  if not exists (
    select 1
    from pg_proc function_row
    join pg_namespace namespace_row on namespace_row.oid = function_row.pronamespace
    where namespace_row.nspname = 'public'
      and function_row.proname = 'create_writing_assignment_group'
      and function_row.pronargs = 5
  ) then
    raise exception 'Phase A is missing: the 5-argument create_writing_assignment_group does not exist';
  end if;
end $$;

-- Guarded revokes for the legacy overloads. Dropping a function already removes
-- it and its privileges; the explicit revoke documents that no execute grant is
-- left behind and is skipped when an overload does not exist.
do $$
begin
  if to_regprocedure(
    'public.create_writing_assignment_group(uuid, jsonb, uuid[])'
  ) is not null then
    execute 'revoke all on function public.create_writing_assignment_group(uuid, jsonb, uuid[]) from public, anon, authenticated, service_role';
  end if;
  if to_regprocedure(
    'public.create_writing_assignment_group(uuid, jsonb, uuid[], text)'
  ) is not null then
    execute 'revoke all on function public.create_writing_assignment_group(uuid, jsonb, uuid[], text) from public, anon, authenticated, service_role';
  end if;
end $$;

drop function if exists public.create_writing_assignment_group(uuid, jsonb, uuid[]);
drop function if exists public.create_writing_assignment_group(uuid, jsonb, uuid[], text);

do $$
declare
  total_count integer;
  five_arg_count integer;
begin
  select
    count(*),
    count(*) filter (where function_row.pronargs = 5)
  into total_count, five_arg_count
  from pg_proc function_row
  join pg_namespace namespace_row on namespace_row.oid = function_row.pronamespace
  where namespace_row.nspname = 'public'
    and function_row.proname = 'create_writing_assignment_group';

  if total_count <> 1 or five_arg_count <> 1 then
    raise exception 'Cleanup expected exactly one 5-argument create_writing_assignment_group, found % overload(s) with % five-argument version(s)', total_count, five_arg_count;
  end if;
end $$;

revoke all on function public.create_writing_assignment_group(uuid, jsonb, uuid[], text, boolean)
  from public, anon, authenticated;
grant execute on function public.create_writing_assignment_group(uuid, jsonb, uuid[], text, boolean)
  to service_role;
