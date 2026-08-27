-- TPS Admin / Teacher / Student account model.
-- Run account_role_admin_enum.sql first, then run this migration separately.
-- Run this migration before admin_self_assignment.sql and admin_test_account_merge.sql.
-- It is intentionally additive and does not delete or rewrite learning history.

alter table public.profiles
  add column if not exists owner_id uuid null references public.profiles(id) on delete restrict,
  add column if not exists student_account_limit integer not null default 20,
  add column if not exists is_active boolean not null default true;

alter table public.profiles drop constraint if exists profiles_student_account_limit_positive;
alter table public.profiles add constraint profiles_student_account_limit_positive
  check (student_account_limit > 0);

create index if not exists profiles_owner_students_idx
  on public.profiles(owner_id, id) where role = 'student' and is_active = true;
create index if not exists profiles_active_role_idx
  on public.profiles(role, id) where is_active = true;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requested_role public.user_role;
  requested_owner uuid;
  requested_limit integer;
begin
  -- Never trust client-supplied metadata to grant teacher/admin privileges.
  -- Privileged roles are applied only by protected service-role endpoints after creation.
  requested_role := 'student';
  requested_owner := nullif(new.raw_user_meta_data ->> 'owner_id', '')::uuid;
  requested_limit := greatest(
    coalesce(nullif(new.raw_user_meta_data ->> 'student_account_limit', '')::integer, 20),
    1
  );

  insert into public.profiles (
    id, email, full_name, role, owner_id, student_account_limit, is_active
  ) values (
    new.id,
    new.email,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'full_name', ''),
      nullif(new.raw_user_meta_data ->> 'display_name', ''),
      new.email
    ),
    requested_role,
    case when requested_role = 'student' then requested_owner else null end,
    case when requested_role = 'teacher' then requested_limit else 20 end,
    true
  );
  return new;
end;
$$;

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and is_active = true
  );
$$;

create or replace function public.is_teacher()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('teacher', 'admin') and is_active = true
  );
$$;

create or replace function public.can_access_student(p_student_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select public.is_admin() or exists (
    select 1 from public.profiles student
    where student.id = p_student_id
      and student.role = 'student'
      and student.is_active = true
      and student.owner_id = auth.uid()
  );
$$;

-- Used by service-role assignment RPCs. Admin may target itself without creating
-- a teacher/student ownership row; teachers may target only their owned students.
create or replace function public.can_assign_student_as(
  p_teacher_id uuid,
  p_recipient_id uuid
)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.profiles actor
    join public.profiles recipient on recipient.id = p_recipient_id
    where actor.id = p_teacher_id
      and actor.is_active = true
      and recipient.is_active = true
      and (
        (actor.role = 'admin' and (recipient.role = 'student' or recipient.id = actor.id))
        or
        (actor.role = 'teacher' and recipient.role = 'student' and recipient.owner_id = actor.id)
      )
  );
$$;

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
    where role = 'student' and is_active = true and owner_id = new.owner_id
      and id is distinct from new.id;
    if owned_count >= owner_limit then
      raise exception 'STUDENT_ACCOUNT_LIMIT_REACHED';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_enforce_student_owner_quota on public.profiles;
create trigger profiles_enforce_student_owner_quota
before insert or update of role, owner_id, is_active on public.profiles
for each row execute function public.enforce_student_owner_quota();

-- Replace the old "all profiles/all attempts" teacher policies with ownership-aware rules.
drop policy if exists "teachers_select_all_profiles" on public.profiles;
drop policy if exists "account_managers_select_profiles" on public.profiles;
create policy "account_managers_select_profiles"
on public.profiles for select to authenticated
using (
  auth.uid() = id
  or public.is_admin()
  or (public.is_teacher() and role = 'student' and owner_id = auth.uid())
);

-- The former own-row UPDATE policy was column-unrestricted and could allow role,
-- ownership, quota, or activation changes. Keep only safe name editing.
revoke update on public.profiles from authenticated;
grant update (full_name) on public.profiles to authenticated;

drop policy if exists "teachers_select_all_attempts" on public.attempts;
drop policy if exists "account_managers_select_attempts" on public.attempts;
create policy "account_managers_select_attempts"
on public.attempts for select to authenticated
using (public.is_teacher() and public.can_access_student(student_id));

drop policy if exists "teachers_select_all_attempt_answers" on public.attempt_answers;
drop policy if exists "account_managers_select_attempt_answers" on public.attempt_answers;
create policy "account_managers_select_attempt_answers"
on public.attempt_answers for select to authenticated
using (public.is_teacher() and public.can_access_student(student_id));

-- Admin-only quota mutations used by the protected server endpoints.
create or replace function public.admin_set_all_teacher_limits(p_limit integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare changed integer;
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_limit is null or p_limit < 1 then raise exception 'INVALID_LIMIT'; end if;
  update public.profiles set student_account_limit = p_limit
  where role = 'teacher' and is_active = true;
  get diagnostics changed = row_count;
  return changed;
end;
$$;
revoke all on function public.admin_set_all_teacher_limits(integer) from public, anon;
grant execute on function public.admin_set_all_teacher_limits(integer) to authenticated, service_role;

create or replace function public.admin_set_teacher_limit(p_teacher_id uuid, p_limit integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'ADMIN_REQUIRED'; end if;
  if p_limit is null or p_limit < 1 then raise exception 'INVALID_LIMIT'; end if;
  update public.profiles set student_account_limit = p_limit
  where id = p_teacher_id and role = 'teacher' and is_active = true;
  if not found then raise exception 'TEACHER_NOT_FOUND'; end if;
end;
$$;
revoke all on function public.admin_set_teacher_limit(uuid, integer) from public, anon;
grant execute on function public.admin_set_teacher_limit(uuid, integer) to authenticated, service_role;

-- Ownership-aware writing mode access.
drop policy if exists "Teachers can read writing mode settings" on public.student_writing_mode_settings;
create policy "Teachers can read owned writing mode settings"
on public.student_writing_mode_settings for select to authenticated
using (public.is_teacher() and public.can_access_student(student_id));

drop policy if exists "Teachers can create writing mode settings" on public.student_writing_mode_settings;
create policy "Teachers can create owned writing mode settings"
on public.student_writing_mode_settings for insert to authenticated
with check (public.is_teacher() and public.can_access_student(student_id));

drop policy if exists "Teachers can update writing mode settings" on public.student_writing_mode_settings;
create policy "Teachers can update owned writing mode settings"
on public.student_writing_mode_settings for update to authenticated
using (public.is_teacher() and public.can_access_student(student_id))
with check (public.is_teacher() and public.can_access_student(student_id));

-- AI log access follows the writing attempt's student ownership.
drop policy if exists "Teachers can read writing AI logs" on public.writing_review_ai_logs;
create policy "Teachers can read owned writing AI logs"
on public.writing_review_ai_logs for select to authenticated
using (
  public.is_teacher() and exists (
    select 1 from public.writing_attempts attempt
    where attempt.attempt_id = writing_review_ai_logs.attempt_id
      and public.can_access_student(attempt.user_id)
  )
);
