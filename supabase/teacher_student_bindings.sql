-- Admin-managed Teacher <-> Student <-> Domain bindings.
--
-- This is an additive configuration layer only. It intentionally does not
-- touch account ownership or learning-history data. Existing Teacher-side
-- permissions remain on the legacy owner mechanism for now.

create table if not exists public.teacher_student_bindings (
  binding_id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  domain text not null
    constraint teacher_student_bindings_domain_check
    check (domain in ('reading', 'writing')),
  created_at timestamptz not null default now(),
  constraint teacher_student_bindings_unique unique (teacher_id, student_id, domain)
);

create index if not exists teacher_student_bindings_student_domain_idx
  on public.teacher_student_bindings(student_id, domain);
create index if not exists teacher_student_bindings_teacher_domain_idx
  on public.teacher_student_bindings(teacher_id, domain);

-- Validates that every row is an ACTIVE teacher -> ACTIVE student pair.
-- Admin profiles are role 'admin', so an Admin can never be written as the
-- teacher (or student) side of a teaching binding.
create or replace function public.enforce_teacher_student_binding_roles()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.profiles
    where id = new.teacher_id
      and role = 'teacher'
      and is_active = true
  ) then
    raise exception 'INVALID_TEACHER_BINDING';
  end if;
  if not exists (
    select 1 from public.profiles
    where id = new.student_id
      and role = 'student'
      and is_active = true
  ) then
    raise exception 'INVALID_STUDENT_BINDING';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_teacher_student_binding_roles() from public;
revoke all on function public.enforce_teacher_student_binding_roles() from anon;
revoke all on function public.enforce_teacher_student_binding_roles() from authenticated;

drop trigger if exists teacher_student_bindings_enforce_roles on public.teacher_student_bindings;
create trigger teacher_student_bindings_enforce_roles
before insert or update of teacher_id, student_id, domain on public.teacher_student_bindings
for each row execute function public.enforce_teacher_student_binding_roles();

-- Admin configures bindings only through the protected service-role API.
-- Direct anon/authenticated access is denied by RLS with no client policies.
alter table public.teacher_student_bindings enable row level security;