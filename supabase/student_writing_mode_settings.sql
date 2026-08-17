create table if not exists public.student_writing_mode_settings (
  student_id uuid primary key references public.profiles(id) on delete cascade,
  practice_mode_enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid null references public.profiles(id) on delete set null
);

drop trigger if exists student_writing_mode_settings_set_updated_at
  on public.student_writing_mode_settings;
create trigger student_writing_mode_settings_set_updated_at
before update on public.student_writing_mode_settings
for each row execute function public.set_updated_at();

alter table public.student_writing_mode_settings enable row level security;

drop policy if exists "Students can read own writing mode settings"
  on public.student_writing_mode_settings;
create policy "Students can read own writing mode settings"
on public.student_writing_mode_settings for select
to authenticated
using (student_id = auth.uid());

drop policy if exists "Teachers can read writing mode settings"
  on public.student_writing_mode_settings;
create policy "Teachers can read writing mode settings"
on public.student_writing_mode_settings for select
to authenticated
using (public.is_teacher());

drop policy if exists "Teachers can create writing mode settings"
  on public.student_writing_mode_settings;
create policy "Teachers can create writing mode settings"
on public.student_writing_mode_settings for insert
to authenticated
with check (
  public.is_teacher()
  and exists (
    select 1 from public.profiles
    where id = student_writing_mode_settings.student_id
      and role = 'student'
  )
);

drop policy if exists "Teachers can update writing mode settings"
  on public.student_writing_mode_settings;
create policy "Teachers can update writing mode settings"
on public.student_writing_mode_settings for update
to authenticated
using (public.is_teacher())
with check (
  public.is_teacher()
  and exists (
    select 1 from public.profiles
    where id = student_writing_mode_settings.student_id
      and role = 'student'
  )
);

grant select, insert, update on public.student_writing_mode_settings
  to authenticated;

create or replace function public.enforce_student_writing_mode_policy()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.writing_mode = 'practice'
    and (
      tg_op = 'INSERT'
      or (tg_op = 'UPDATE' and old.status = 'draft')
    )
    and exists (
      select 1
      from public.student_writing_mode_settings setting
      where setting.student_id = new.user_id
        and setting.practice_mode_enabled = false
    )
  then
    raise exception 'WRITING_MODE_NOT_ALLOWED';
  end if;
  return new;
end;
$$;

drop trigger if exists writing_attempts_require_allowed_mode
  on public.writing_attempts;
create trigger writing_attempts_require_allowed_mode
before insert or update on public.writing_attempts
for each row execute function public.enforce_student_writing_mode_policy();
