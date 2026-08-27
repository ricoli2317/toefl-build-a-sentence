-- Incremental repair for databases where these three migrations already succeeded:
--   1. account_role_admin_enum.sql
--   2. account_roles_and_ownership.sql
--   3. admin_self_assignment.sql
-- and admin_test_account_merge.sql failed with INVALID_STUDENT_OWNER.
--
-- This does not migrate business history and does not modify/delete teacher@test.com.

begin;

create or replace function public.enforce_student_owner_quota()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  owner_role public.user_role;
  owner_limit integer;
  owned_count integer;
begin
  if new.owner_id is not null and new.owner_id = new.id then
    raise exception 'SELF_STUDENT_OWNER_NOT_ALLOWED';
  end if;

  if new.role <> 'student' then
    new.owner_id := null;
    return new;
  end if;

  if new.owner_id is null then
    raise exception 'STUDENT_OWNER_REQUIRED';
  end if;

  select role, student_account_limit
    into owner_role, owner_limit
  from public.profiles
  where id = new.owner_id and is_active = true
  for update;

  if owner_role is null or owner_role not in ('teacher', 'admin') then
    raise exception 'INVALID_STUDENT_OWNER';
  end if;

  if owner_role = 'teacher' then
    select count(*) into owned_count
    from public.profiles
    where role = 'student'
      and is_active = true
      and owner_id = new.owner_id
      and id is distinct from new.id;

    if owned_count >= owner_limit then
      raise exception 'STUDENT_ACCOUNT_LIMIT_REACHED';
    end if;
  end if;

  -- Admin owners intentionally bypass Teacher quota.
  return new;
end;
$$;

do $$
declare
  final_admin_id constant uuid := '6f333422-384a-44fb-8a83-e9c1aadb0caf';
begin
  if not exists (
    select 1 from public.profiles
    where id = final_admin_id
      and lower(email) = 'student@test.com'
      and is_active = true
  ) then
    raise exception 'Expected active student@test.com profile was not found';
  end if;

  -- The failed merge DO block was atomic, so this is the only data preparation
  -- needed before rerunning the corrected merge migration.
  update public.profiles
  set role = 'admin', owner_id = null, is_active = true
  where id = final_admin_id;
end;
$$;

commit;

select id, email, role, owner_id, is_active
from public.profiles
where id = '6f333422-384a-44fb-8a83-e9c1aadb0caf';
