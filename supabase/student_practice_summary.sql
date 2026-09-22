-- TPS student practice summary: O(1) aggregates for the teacher student list.
-- Apply manually after reading_attempts.sql, reading_wrongbook_corrections.sql,
-- writing_assignments.sql, and reading_full_set_attempts.sql.
--
-- This migration only adds a per-student summary table, its maintenance
-- functions/triggers, and a one-time backfill. It does not modify attempts,
-- answers, reviews, assignments, or any student practice business rule.
--
-- Aggregation contract (must stay identical to the current live list query):
--   reading_attempts            submitted + submitted_at IS NOT NULL
--   reading_wrongbook_attempts  submitted + submitted_at IS NOT NULL
--   attempts                    submitted_at IS NOT NULL (all set ids)
--   writing_attempts            submitted + submitted_at IS NOT NULL
--   reading_full_set_attempts   completed + completed_at IS NOT NULL
--                               (duration 0, timestamp only)
--
-- The whole file is transactional and safe to re-run: the table is created if
-- missing, functions are replaced, triggers are dropped and recreated, and the
-- backfill overwrites each student row with the true history result.

begin;

create table if not exists public.student_practice_summary (
  student_id uuid primary key references public.profiles(id) on delete cascade,
  total_practice_seconds bigint not null default 0 check (total_practice_seconds >= 0),
  latest_practice_at timestamptz,
  updated_at timestamptz not null default clock_timestamp()
);

-- Teachers read this table through the service-role API only. No client policy
-- is added: RLS stays enabled with zero policies.
alter table public.student_practice_summary enable row level security;

revoke all on table public.student_practice_summary from public, anon, authenticated;
grant select, insert, update, delete on table public.student_practice_summary to service_role;

-- Single-record O(1) increment. Called by triggers only; deliberately revoked
-- from clients so nobody can mutate the summary through PostgREST RPC.
create or replace function public.apply_student_practice_summary_increment(
  p_student_id uuid,
  p_duration_seconds bigint,
  p_completed_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_duration bigint := greatest(coalesce(p_duration_seconds, 0), 0);
begin
  if p_student_id is null then
    return;
  end if;

  insert into public.student_practice_summary as summary (
    student_id,
    total_practice_seconds,
    latest_practice_at,
    updated_at
  )
  values (
    p_student_id,
    v_duration,
    p_completed_at,
    clock_timestamp()
  )
  on conflict (student_id) do update
  set total_practice_seconds = summary.total_practice_seconds + v_duration,
      latest_practice_at = case
        when p_completed_at is null then summary.latest_practice_at
        when summary.latest_practice_at is null then p_completed_at
        else greatest(summary.latest_practice_at, p_completed_at)
      end,
      updated_at = clock_timestamp();
end;
$$;

revoke all on function public.apply_student_practice_summary_increment(uuid, bigint, timestamptz) from public, anon, authenticated;
grant execute on function public.apply_student_practice_summary_increment(uuid, bigint, timestamptz) to service_role;

-- Full per-student rebuild from the five source tables. Used for the rare
-- attempts DELETE cleanup path and for manual repair. Overwrites, never adds.
create or replace function public.rebuild_student_practice_summary(p_student_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total bigint;
  v_latest timestamptz;
begin
  if p_student_id is null then
    return;
  end if;

  select coalesce(sum(part.duration_seconds), 0), max(part.completed_at)
  into v_total, v_latest
  from (
    select greatest(coalesce(elapsed_seconds, 0), 0)::bigint as duration_seconds,
           submitted_at as completed_at
    from public.reading_attempts
    where student_id = p_student_id
      and status = 'submitted'
      and submitted_at is not null
    union all
    select greatest(coalesce(elapsed_seconds, 0), 0)::bigint, submitted_at
    from public.reading_wrongbook_attempts
    where student_id = p_student_id
      and status = 'submitted'
      and submitted_at is not null
    union all
    select greatest(coalesce(time_spent_seconds, 0), 0)::bigint, submitted_at
    from public.attempts
    where student_id = p_student_id
      and submitted_at is not null
    union all
    select greatest(coalesce(elapsed_seconds, 0), 0)::bigint, submitted_at
    from public.writing_attempts
    where user_id = p_student_id
      and status = 'submitted'
      and submitted_at is not null
    union all
    select 0::bigint, completed_at
    from public.reading_full_set_attempts
    where student_id = p_student_id
      and status = 'completed'
      and completed_at is not null
  ) part;

  if coalesce(v_total, 0) = 0 and v_latest is null then
    delete from public.student_practice_summary where student_id = p_student_id;
    return;
  end if;

  insert into public.student_practice_summary as summary (
    student_id,
    total_practice_seconds,
    latest_practice_at,
    updated_at
  )
  values (p_student_id, coalesce(v_total, 0), v_latest, clock_timestamp())
  on conflict (student_id) do update
  set total_practice_seconds = excluded.total_practice_seconds,
      latest_practice_at = excluded.latest_practice_at,
      updated_at = clock_timestamp();
end;
$$;

revoke all on function public.rebuild_student_practice_summary(uuid) from public, anon, authenticated;
grant execute on function public.rebuild_student_practice_summary(uuid) to service_role;

-- READING (reading_attempts + reading_wrongbook_attempts): draft -> submitted.
create or replace function public.sync_student_practice_summary_reading()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.apply_student_practice_summary_increment(
    new.student_id,
    greatest(coalesce(new.elapsed_seconds, 0), 0)::bigint,
    new.submitted_at
  );
  return null;
end;
$$;

revoke all on function public.sync_student_practice_summary_reading() from public, anon, authenticated;

-- BAS/grammar attempts: inserts are already completed records.
create or replace function public.sync_student_practice_summary_attempts_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.apply_student_practice_summary_increment(
    new.student_id,
    greatest(coalesce(new.time_spent_seconds, 0), 0)::bigint,
    new.submitted_at
  );
  return null;
end;
$$;

revoke all on function public.sync_student_practice_summary_attempts_insert() from public, anon, authenticated;

-- attempts DELETE is the rare answer-write cleanup path. Rebuild the single
-- student from source tables instead of subtracting, so drift is impossible.
create or replace function public.sync_student_practice_summary_attempts_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.rebuild_student_practice_summary(old.student_id);
  return null;
end;
$$;

revoke all on function public.sync_student_practice_summary_attempts_delete() from public, anon, authenticated;

-- WRITING (email / academic discussion): draft -> submitted.
create or replace function public.sync_student_practice_summary_writing()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.apply_student_practice_summary_increment(
    new.user_id,
    greatest(coalesce(new.elapsed_seconds, 0), 0)::bigint,
    new.submitted_at
  );
  return null;
end;
$$;

revoke all on function public.sync_student_practice_summary_writing() from public, anon, authenticated;

-- READING FULL SET: completion contributes the timestamp only (duration 0).
create or replace function public.sync_student_practice_summary_full_set()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.apply_student_practice_summary_increment(
    new.student_id,
    0,
    new.completed_at
  );
  return null;
end;
$$;

revoke all on function public.sync_student_practice_summary_full_set() from public, anon, authenticated;

-- Atomic initialization window. SHARE ROW EXCLUSIVE is the smallest lock that
-- blocks every INSERT/UPDATE/DELETE (ROW EXCLUSIVE) on the source tables while
-- still allowing plain SELECT. It is taken before the backfill snapshot and is
-- held until this transaction commits, so no practice write can slip between
-- the snapshot and the trigger installation.
lock table public.reading_attempts,
           public.reading_wrongbook_attempts,
           public.attempts,
           public.writing_attempts,
           public.reading_full_set_attempts
  in share row exclusive mode;

-- Backfill: overwrite each student row with the true history aggregate.
insert into public.student_practice_summary as summary (
  student_id,
  total_practice_seconds,
  latest_practice_at,
  updated_at
)
select part.student_id,
       coalesce(sum(part.duration_seconds), 0),
       max(part.completed_at),
       clock_timestamp()
from (
  select student_id,
         greatest(coalesce(elapsed_seconds, 0), 0)::bigint as duration_seconds,
         submitted_at as completed_at
  from public.reading_attempts
  where status = 'submitted'
    and submitted_at is not null
  union all
  select student_id,
         greatest(coalesce(elapsed_seconds, 0), 0)::bigint,
         submitted_at
  from public.reading_wrongbook_attempts
  where status = 'submitted'
    and submitted_at is not null
  union all
  select student_id,
         greatest(coalesce(time_spent_seconds, 0), 0)::bigint,
         submitted_at
  from public.attempts
  where submitted_at is not null
  union all
  select user_id,
         greatest(coalesce(elapsed_seconds, 0), 0)::bigint,
         submitted_at
  from public.writing_attempts
  where status = 'submitted'
    and submitted_at is not null
  union all
  select student_id,
         0::bigint,
         completed_at
  from public.reading_full_set_attempts
  where status = 'completed'
    and completed_at is not null
) part
group by part.student_id
on conflict (student_id) do update
set total_practice_seconds = excluded.total_practice_seconds,
    latest_practice_at = excluded.latest_practice_at,
    updated_at = clock_timestamp();

-- Enable incremental maintenance only after the snapshot is complete.
drop trigger if exists trg_reading_attempts_student_practice_summary on public.reading_attempts;
create trigger trg_reading_attempts_student_practice_summary
after update on public.reading_attempts
for each row
when (
  old.status = 'draft'
  and new.status = 'submitted'
  and new.submitted_at is not null
)
execute function public.sync_student_practice_summary_reading();

drop trigger if exists trg_reading_wrongbook_student_practice_summary on public.reading_wrongbook_attempts;
create trigger trg_reading_wrongbook_student_practice_summary
after update on public.reading_wrongbook_attempts
for each row
when (
  old.status = 'draft'
  and new.status = 'submitted'
  and new.submitted_at is not null
)
execute function public.sync_student_practice_summary_reading();

drop trigger if exists trg_attempts_student_practice_summary_insert on public.attempts;
create trigger trg_attempts_student_practice_summary_insert
after insert on public.attempts
for each row
when (new.submitted_at is not null)
execute function public.sync_student_practice_summary_attempts_insert();

drop trigger if exists trg_attempts_student_practice_summary_delete on public.attempts;
create trigger trg_attempts_student_practice_summary_delete
after delete on public.attempts
for each row
when (old.submitted_at is not null)
execute function public.sync_student_practice_summary_attempts_delete();

drop trigger if exists trg_writing_attempts_student_practice_summary on public.writing_attempts;
create trigger trg_writing_attempts_student_practice_summary
after update on public.writing_attempts
for each row
when (
  old.status = 'draft'
  and new.status = 'submitted'
  and new.submitted_at is not null
)
execute function public.sync_student_practice_summary_writing();

drop trigger if exists trg_reading_full_set_student_practice_summary on public.reading_full_set_attempts;
create trigger trg_reading_full_set_student_practice_summary
after update on public.reading_full_set_attempts
for each row
when (
  old.status is distinct from 'completed'
  and new.status = 'completed'
  and new.completed_at is not null
)
execute function public.sync_student_practice_summary_full_set();

-- Sanity check: the stored summary must equal a fresh full recomputation and
-- must not contain rows without any source record. Aborts the migration
-- (rolling back table, functions, triggers, and backfill) on any mismatch.
do $$
declare
  v_mismatch integer;
begin
  with expected as (
    select part.student_id,
           coalesce(sum(part.duration_seconds), 0) as total_practice_seconds,
           max(part.completed_at) as latest_practice_at
    from (
      select student_id,
             greatest(coalesce(elapsed_seconds, 0), 0)::bigint as duration_seconds,
             submitted_at as completed_at
      from public.reading_attempts
      where status = 'submitted'
        and submitted_at is not null
      union all
      select student_id,
             greatest(coalesce(elapsed_seconds, 0), 0)::bigint,
             submitted_at
      from public.reading_wrongbook_attempts
      where status = 'submitted'
        and submitted_at is not null
      union all
      select student_id,
             greatest(coalesce(time_spent_seconds, 0), 0)::bigint,
             submitted_at
      from public.attempts
      where submitted_at is not null
      union all
      select user_id,
             greatest(coalesce(elapsed_seconds, 0), 0)::bigint,
             submitted_at
      from public.writing_attempts
      where status = 'submitted'
        and submitted_at is not null
      union all
      select student_id,
             0::bigint,
             completed_at
      from public.reading_full_set_attempts
      where status = 'completed'
        and completed_at is not null
    ) part
    group by part.student_id
  )
  select count(*)
  into v_mismatch
  from expected
  full join public.student_practice_summary summary
    on summary.student_id = expected.student_id
  where coalesce(expected.total_practice_seconds, 0)
          is distinct from coalesce(summary.total_practice_seconds, 0)
     or expected.latest_practice_at is distinct from summary.latest_practice_at
     or expected.student_id is null;

  if v_mismatch > 0 then
    raise exception 'student_practice_summary initialization mismatch: % row(s)', v_mismatch;
  end if;
end;
$$;

commit;
