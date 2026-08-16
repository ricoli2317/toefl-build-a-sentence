alter table public.writing_attempts
  add column if not exists writing_mode text null,
  add column if not exists elapsed_seconds integer null,
  add column if not exists overtime_ranges jsonb null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'writing_attempts_writing_mode_check'
      and conrelid = 'public.writing_attempts'::regclass
  ) then
    alter table public.writing_attempts
      add constraint writing_attempts_writing_mode_check
      check (writing_mode is null or writing_mode in ('exam', 'practice'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'writing_attempts_elapsed_seconds_check'
      and conrelid = 'public.writing_attempts'::regclass
  ) then
    alter table public.writing_attempts
      add constraint writing_attempts_elapsed_seconds_check
      check (elapsed_seconds is null or elapsed_seconds >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'writing_attempts_overtime_ranges_check'
      and conrelid = 'public.writing_attempts'::regclass
  ) then
    alter table public.writing_attempts
      add constraint writing_attempts_overtime_ranges_check
      check (overtime_ranges is null or jsonb_typeof(overtime_ranges) = 'array');
  end if;
end $$;
