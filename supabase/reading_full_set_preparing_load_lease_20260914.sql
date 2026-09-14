-- TPS Reading Full Set: preparing lifecycle and renewable server load leases.
-- Run once after reading_full_set_loading_pause_hotfix_20260911.sql.
-- This migration intentionally does not modify Reading content or runtime assets.

begin;

alter table public.reading_full_set_module_attempts
  drop constraint if exists reading_full_set_module_deadline_shape;
alter table public.reading_full_set_module_attempts
  drop constraint if exists reading_full_set_module_status_shape;
alter table public.reading_full_set_module_attempts
  drop constraint if exists reading_full_set_module_attempts_status_check;
alter table public.reading_full_set_module_attempts
  alter column status set default 'preparing',
  alter column started_at drop not null,
  alter column deadline_at drop not null;
alter table public.reading_full_set_module_attempts
  add constraint reading_full_set_module_attempts_status_check
    check (status in ('preparing', 'active', 'submitted')),
  add constraint reading_full_set_module_deadline_shape check (
    (status = 'preparing' and started_at is null and deadline_at is null)
    or (
      status in ('active', 'submitted')
      and started_at is not null
      and deadline_at is not null
      and deadline_at >= started_at + make_interval(secs => time_limit_seconds)
    )
  ),
  add constraint reading_full_set_module_status_shape check (
    (status = 'preparing' and submitted_at is null and submission_reason is null and total_points = 0 and correct_points = 0)
    or (status = 'active' and submitted_at is null and submission_reason is null and total_points = 0 and correct_points = 0)
    or (status = 'submitted' and submitted_at is not null and submission_reason is not null and total_points in (15, 35))
  );

alter table public.reading_full_set_load_pauses
  drop constraint if exists reading_full_set_load_pause_time_shape;
alter table public.reading_full_set_load_pauses
  drop constraint if exists reading_full_set_load_pauses_compensated_milliseconds_check;
alter table public.reading_full_set_load_pauses
  alter column compensated_milliseconds type bigint
    using compensated_milliseconds::bigint,
  add column if not exists last_renewed_at timestamptz,
  add column if not exists renewal_count integer not null default 0,
  add column if not exists credited_milliseconds bigint not null default 0;
update public.reading_full_set_load_pauses
set last_renewed_at = started_at
where last_renewed_at is null;
update public.reading_full_set_load_pauses
set credited_milliseconds = coalesce(compensated_milliseconds, 0)
where finished_at is not null;
alter table public.reading_full_set_load_pauses
  alter column last_renewed_at set not null,
  add constraint reading_full_set_load_pauses_compensated_milliseconds_check
    check (compensated_milliseconds is null or compensated_milliseconds >= 0),
  add constraint reading_full_set_load_pause_time_shape check (
    last_renewed_at >= started_at
    and expires_at > last_renewed_at
    and expires_at <= last_renewed_at + interval '45 seconds'
    and (finished_at is null or finished_at >= started_at)
    and ((finished_at is null) = (compensated_milliseconds is null))
    and renewal_count >= 0
    and credited_milliseconds >= 0
  );

comment on column public.reading_full_set_load_pauses.expires_at is
  'Server-issued stale lease expiry. Renewals move this forward; 45 seconds is a heartbeat TTL, not a compensation cap.';
comment on column public.reading_full_set_load_pauses.compensated_milliseconds is
  'Observed lease-covered loading time. Values above 300000 are allowed and may be monitored, but never reduce student time.';
comment on column public.reading_full_set_load_pauses.credited_milliseconds is
  'Provisional lease coverage already reflected in deadline_at; unused TTL tail is removed atomically on early finish.';

create or replace function public.reading_full_set_attempt_json(p_attempt_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'attemptId', attempt.attempt_id,
    'fullSetId', attempt.full_set_id,
    'status', attempt.status,
    'currentModule', attempt.current_module,
    'startedAt', attempt.started_at,
    'completedAt', attempt.completed_at,
    'serverNow', clock_timestamp(),
    'module1', (
      select jsonb_build_object(
        'moduleAttemptId', module_attempt.module_attempt_id,
        'moduleNumber', module_attempt.module_number,
        'status', module_attempt.status,
        'timeLimitSeconds', module_attempt.time_limit_seconds,
        'startedAt', module_attempt.started_at,
        'deadlineAt', module_attempt.deadline_at,
        'submittedAt', module_attempt.submitted_at,
        'submissionReason', module_attempt.submission_reason,
        'answerRevision', module_attempt.answer_revision
      )
      from public.reading_full_set_module_attempts module_attempt
      where module_attempt.attempt_id = attempt.attempt_id and module_attempt.module_number = 1
    ),
    'module2', (
      select jsonb_build_object(
        'moduleAttemptId', module_attempt.module_attempt_id,
        'moduleNumber', module_attempt.module_number,
        'status', module_attempt.status,
        'timeLimitSeconds', module_attempt.time_limit_seconds,
        'startedAt', module_attempt.started_at,
        'deadlineAt', module_attempt.deadline_at,
        'submittedAt', module_attempt.submitted_at,
        'submissionReason', module_attempt.submission_reason,
        'answerRevision', module_attempt.answer_revision
      )
      from public.reading_full_set_module_attempts module_attempt
      where module_attempt.attempt_id = attempt.attempt_id and module_attempt.module_number = 2
    )
  )
  from public.reading_full_set_attempts attempt
  where attempt.attempt_id = p_attempt_id;
$$;

create or replace function public.settle_reading_full_set_load_pause(
  p_load_id uuid,
  p_finished_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_module_attempt_id uuid;
  v_pause public.reading_full_set_load_pauses%rowtype;
  v_module public.reading_full_set_module_attempts%rowtype;
  v_compensated bigint;
  v_deadline_delta bigint;
begin
  select module_attempt_id into v_module_attempt_id
  from public.reading_full_set_load_pauses
  where load_id = p_load_id;
  if not found then return; end if;

  select * into v_module
  from public.reading_full_set_module_attempts
  where module_attempt_id = v_module_attempt_id
  for update;
  select * into v_pause
  from public.reading_full_set_load_pauses
  where load_id = p_load_id
  for update;
  if v_pause.finished_at is not null then return; end if;

  v_compensated := greatest(0, floor(extract(epoch from (
    least(greatest(p_finished_at, v_pause.started_at), v_pause.expires_at) - v_pause.started_at
  )) * 1000)::bigint);
  v_deadline_delta := v_compensated - v_pause.credited_milliseconds;

  if v_module.status = 'active' and v_module.deadline_at is not null then
    update public.reading_full_set_module_attempts
    set deadline_at = deadline_at + make_interval(secs => v_deadline_delta / 1000.0)
    where module_attempt_id = v_module.module_attempt_id;
  else
    v_compensated := 0;
  end if;
  update public.reading_full_set_load_pauses
  set finished_at = greatest(p_finished_at, started_at),
      compensated_milliseconds = v_compensated,
      credited_milliseconds = v_compensated
  where load_id = p_load_id;
end;
$$;

create or replace function public.reconcile_reading_full_set_attempt(p_attempt_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt_id uuid;
  v_module record;
  v_open_pause record;
  v_now timestamptz;
begin
  select attempt_id into v_attempt_id
  from public.reading_full_set_attempts
  where attempt_id = p_attempt_id
  for update;
  if not found then return; end if;

  select module_attempt_id, deadline_at into v_module
  from public.reading_full_set_module_attempts
  where attempt_id = p_attempt_id and status = 'active'
  order by module_number desc
  limit 1
  for update;
  if not found then return; end if;

  v_now := clock_timestamp();

  select load_id, expires_at into v_open_pause
  from public.reading_full_set_load_pauses
  where module_attempt_id = v_module.module_attempt_id and finished_at is null
  limit 1;
  if found then
    if v_open_pause.expires_at > v_now then return; end if;
    perform public.settle_reading_full_set_load_pause(v_open_pause.load_id, v_open_pause.expires_at);
    select module_attempt_id, deadline_at into v_module
    from public.reading_full_set_module_attempts
    where module_attempt_id = v_module.module_attempt_id;
  end if;
  if v_module.deadline_at is not null and v_module.deadline_at <= v_now then
    perform public.finalize_reading_full_set_module(v_module.module_attempt_id, 'timeout', v_now);
  end if;
end;
$$;

create or replace function public.begin_reading_full_set_load_pause(
  p_attempt_id uuid,
  p_load_id uuid,
  p_occurrence_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_attempt public.reading_full_set_attempts%rowtype;
  v_module public.reading_full_set_module_attempts%rowtype;
  v_existing public.reading_full_set_load_pauses%rowtype;
  v_now timestamptz;
  v_new_expires_at timestamptz;
  v_new_credit bigint;
  v_credit_delta bigint;
begin
  select * into v_attempt
  from public.reading_full_set_attempts
  where attempt_id = p_attempt_id and student_id = v_user_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'FULL_SET_ATTEMPT_NOT_FOUND';
  end if;
  perform public.reconcile_reading_full_set_attempt(p_attempt_id);
  select * into v_module
  from public.reading_full_set_module_attempts
  where attempt_id = p_attempt_id and status = 'active'
  order by module_number desc
  limit 1
  for update;
  if not found then
    return jsonb_build_object(
      'started', false,
      'reason', 'no_active_module',
      'attempt', public.reading_full_set_attempt_json(p_attempt_id)
    );
  end if;

  if p_occurrence_id is not null and not exists (
    select 1
    from public.reading_source_occurrences occurrence
    where occurrence.occurrence_id = p_occurrence_id
      and public.reading_occurrence_full_set_id(occurrence.occurrence_date, occurrence.source_label) = v_attempt.full_set_id
      and occurrence.source_module = case v_module.module_number when 1 then 'm1' else 'm2' end
  ) then
    raise exception using errcode = '22023', message = 'FULL_SET_INVALID_OCCURRENCE';
  end if;

  select * into v_existing
  from public.reading_full_set_load_pauses
  where load_id = p_load_id;
  if found then
    if v_existing.module_attempt_id <> v_module.module_attempt_id then
      raise exception using errcode = '22023', message = 'FULL_SET_INVALID_LOAD_PAUSE';
    end if;
    v_now := clock_timestamp();
    if v_existing.finished_at is null
      and v_existing.expires_at > v_now
      and v_existing.last_renewed_at <= v_now - interval '5 seconds' then
      v_new_expires_at := v_now + interval '45 seconds';
      v_new_credit := floor(extract(epoch from (v_new_expires_at - v_existing.started_at)) * 1000)::bigint;
      v_credit_delta := v_new_credit - v_existing.credited_milliseconds;
      update public.reading_full_set_module_attempts
      set deadline_at = deadline_at + make_interval(secs => v_credit_delta / 1000.0)
      where module_attempt_id = v_module.module_attempt_id and status = 'active';
      update public.reading_full_set_load_pauses
      set last_renewed_at = v_now,
          expires_at = v_new_expires_at,
          renewal_count = renewal_count + 1,
          credited_milliseconds = v_new_credit
      where load_id = v_existing.load_id
      returning * into v_existing;
    end if;
    return jsonb_build_object(
      'started', v_existing.finished_at is null,
      'reason', case when v_existing.finished_at is null then null else 'already_finished' end,
      'loadId', v_existing.load_id,
      'expiresAt', v_existing.expires_at,
      'attempt', public.reading_full_set_attempt_json(p_attempt_id)
    );
  end if;

  select * into v_existing
  from public.reading_full_set_load_pauses
  where module_attempt_id = v_module.module_attempt_id and finished_at is null
  limit 1
  for update;
  if found then
    v_now := clock_timestamp();
    if v_existing.expires_at > v_now
      and v_existing.last_renewed_at <= v_now - interval '5 seconds' then
      v_new_expires_at := v_now + interval '45 seconds';
      v_new_credit := floor(extract(epoch from (v_new_expires_at - v_existing.started_at)) * 1000)::bigint;
      v_credit_delta := v_new_credit - v_existing.credited_milliseconds;
      update public.reading_full_set_module_attempts
      set deadline_at = deadline_at + make_interval(secs => v_credit_delta / 1000.0)
      where module_attempt_id = v_module.module_attempt_id and status = 'active';
      update public.reading_full_set_load_pauses
      set last_renewed_at = v_now,
          expires_at = v_new_expires_at,
          renewal_count = renewal_count + 1,
          credited_milliseconds = v_new_credit
      where load_id = v_existing.load_id
      returning * into v_existing;
    end if;
    return jsonb_build_object(
      'started', true,
      'loadId', v_existing.load_id,
      'expiresAt', v_existing.expires_at,
      'attempt', public.reading_full_set_attempt_json(p_attempt_id)
    );
  end if;

  v_now := clock_timestamp();
  insert into public.reading_full_set_load_pauses(
    load_id, module_attempt_id, occurrence_id, started_at, last_renewed_at, expires_at,
    credited_milliseconds
  ) values (
    p_load_id, v_module.module_attempt_id, p_occurrence_id, v_now, v_now, v_now + interval '45 seconds',
    45000
  );
  update public.reading_full_set_module_attempts
  set deadline_at = deadline_at + interval '45 seconds'
  where module_attempt_id = v_module.module_attempt_id and status = 'active';
  return jsonb_build_object(
    'started', true,
    'loadId', p_load_id,
    'expiresAt', v_now + interval '45 seconds',
    'attempt', public.reading_full_set_attempt_json(p_attempt_id)
  );
end;
$$;

create or replace function public.renew_reading_full_set_load_pause(
  p_attempt_id uuid,
  p_load_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_module_attempt_id uuid;
  v_attempt_id uuid;
  v_module public.reading_full_set_module_attempts%rowtype;
  v_pause public.reading_full_set_load_pauses%rowtype;
  v_now timestamptz;
  v_new_expires_at timestamptz;
  v_new_credit bigint;
  v_credit_delta bigint;
begin
  select module_attempt.module_attempt_id, attempt.attempt_id
  into v_module_attempt_id, v_attempt_id
  from public.reading_full_set_load_pauses pause
  join public.reading_full_set_module_attempts module_attempt
    on module_attempt.module_attempt_id = pause.module_attempt_id
  join public.reading_full_set_attempts attempt
    on attempt.attempt_id = module_attempt.attempt_id
  where pause.load_id = p_load_id
    and attempt.attempt_id = p_attempt_id
    and attempt.student_id = v_user_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'FULL_SET_LOAD_PAUSE_NOT_FOUND';
  end if;

  perform 1 from public.reading_full_set_attempts
  where attempt_id = v_attempt_id for update;
  select * into v_module from public.reading_full_set_module_attempts
  where module_attempt_id = v_module_attempt_id for update;
  select * into v_pause from public.reading_full_set_load_pauses
  where load_id = p_load_id for update;

  if v_pause.finished_at is not null then
    return jsonb_build_object(
      'renewed', false,
      'reason', 'already_finished',
      'attempt', public.reading_full_set_attempt_json(p_attempt_id)
    );
  end if;
  if v_module.status <> 'active' then
    perform public.settle_reading_full_set_load_pause(p_load_id, clock_timestamp());
    return jsonb_build_object(
      'renewed', false,
      'reason', 'no_active_module',
      'attempt', public.reading_full_set_attempt_json(p_attempt_id)
    );
  end if;

  v_now := clock_timestamp();
  if v_pause.expires_at <= v_now then
    perform public.settle_reading_full_set_load_pause(p_load_id, v_pause.expires_at);
    perform public.reconcile_reading_full_set_attempt(p_attempt_id);
    return jsonb_build_object(
      'renewed', false,
      'reason', 'expired',
      'attempt', public.reading_full_set_attempt_json(p_attempt_id)
    );
  end if;

  -- Calls faster than five seconds are idempotent and do not move the lease.
  if v_pause.last_renewed_at > v_now - interval '5 seconds' then
    return jsonb_build_object(
      'renewed', true,
      'loadId', v_pause.load_id,
      'expiresAt', v_pause.expires_at,
      'attempt', public.reading_full_set_attempt_json(p_attempt_id)
    );
  end if;

  v_new_expires_at := v_now + interval '45 seconds';
  v_new_credit := floor(extract(epoch from (v_new_expires_at - v_pause.started_at)) * 1000)::bigint;
  v_credit_delta := v_new_credit - v_pause.credited_milliseconds;
  update public.reading_full_set_module_attempts
  set deadline_at = deadline_at + make_interval(secs => v_credit_delta / 1000.0)
  where module_attempt_id = v_module.module_attempt_id and status = 'active';
  update public.reading_full_set_load_pauses
  set last_renewed_at = v_now,
      expires_at = v_new_expires_at,
      renewal_count = renewal_count + 1,
      credited_milliseconds = v_new_credit
  where load_id = p_load_id
  returning * into v_pause;
  return jsonb_build_object(
    'renewed', true,
    'loadId', v_pause.load_id,
    'expiresAt', v_pause.expires_at,
    'attempt', public.reading_full_set_attempt_json(p_attempt_id)
  );
end;
$$;

create or replace function public.finish_reading_full_set_load_pause(
  p_attempt_id uuid,
  p_load_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_attempt_id uuid;
begin
  select attempt.attempt_id into v_attempt_id
  from public.reading_full_set_load_pauses pause
  join public.reading_full_set_module_attempts module_attempt
    on module_attempt.module_attempt_id = pause.module_attempt_id
  join public.reading_full_set_attempts attempt
    on attempt.attempt_id = module_attempt.attempt_id
  where pause.load_id = p_load_id
    and attempt.attempt_id = p_attempt_id
    and attempt.student_id = v_user_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'FULL_SET_LOAD_PAUSE_NOT_FOUND';
  end if;
  perform 1 from public.reading_full_set_attempts
  where attempt_id = v_attempt_id for update;
  perform public.settle_reading_full_set_load_pause(p_load_id, clock_timestamp());
  perform public.reconcile_reading_full_set_attempt(p_attempt_id);
  return jsonb_build_object(
    'finished', true,
    'attempt', public.reading_full_set_attempt_json(p_attempt_id)
  );
end;
$$;

create or replace function public.activate_reading_full_set_module(
  p_attempt_id uuid,
  p_module_number smallint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_attempt public.reading_full_set_attempts%rowtype;
  v_module public.reading_full_set_module_attempts%rowtype;
  v_module_1_status text;
  v_activated_at timestamptz;
begin
  select * into v_attempt
  from public.reading_full_set_attempts
  where attempt_id = p_attempt_id and student_id = v_user_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'FULL_SET_ATTEMPT_NOT_FOUND';
  end if;
  if v_attempt.status <> 'in_progress' or p_module_number not in (1, 2) then
    raise exception using errcode = '55000', message = 'FULL_SET_MODULE_NOT_PREPARING';
  end if;
  select * into v_module
  from public.reading_full_set_module_attempts
  where attempt_id = p_attempt_id and module_number = p_module_number
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'FULL_SET_MODULE_NOT_FOUND';
  end if;
  if v_module.status = 'active' then
    return public.reading_full_set_attempt_json(p_attempt_id);
  end if;
  if v_module.status <> 'preparing' then
    raise exception using errcode = '55000', message = 'FULL_SET_MODULE_NOT_PREPARING';
  end if;
  if p_module_number = 2 then
    select status into v_module_1_status
    from public.reading_full_set_module_attempts
    where attempt_id = p_attempt_id and module_number = 1;
    if v_module_1_status <> 'submitted' then
      raise exception using errcode = '55000', message = 'FULL_SET_MODULE_1_NOT_SUBMITTED';
    end if;
  end if;

  -- Take server time only after ownership, lifecycle validation, and row locks.
  v_activated_at := clock_timestamp();
  update public.reading_full_set_module_attempts
  set status = 'active',
      started_at = v_activated_at,
      deadline_at = v_activated_at + make_interval(secs => time_limit_seconds)
  where module_attempt_id = v_module.module_attempt_id and status = 'preparing';
  return public.reading_full_set_attempt_json(p_attempt_id);
end;
$$;

create or replace function public.get_or_create_reading_full_set_attempt(p_full_set_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_attempt_id uuid;
  v_time_limit integer;
  v_created boolean := false;
begin
  if v_user_id is null or not exists (
    select 1 from public.profiles profile
    where profile.id = v_user_id and profile.is_active
      and profile.role::text in ('student', 'admin')
  ) then
    raise exception using errcode = '42501', message = 'FULL_SET_STUDENT_REQUIRED';
  end if;
  v_time_limit := public.reading_full_set_module_time_limit(p_full_set_id, 1::smallint);
  if v_time_limit is null or public.reading_full_set_module_time_limit(p_full_set_id, 2::smallint) <> 540 then
    raise exception using errcode = 'P0002', message = 'FULL_SET_NOT_FOUND';
  end if;

  select attempt_id into v_attempt_id
  from public.reading_full_set_attempts
  where student_id = v_user_id and full_set_id = p_full_set_id and status = 'in_progress'
  order by created_at desc limit 1;
  if v_attempt_id is null then
    insert into public.reading_full_set_attempts(student_id, full_set_id, status, current_module)
    values (v_user_id, p_full_set_id, 'in_progress', 1)
    on conflict (student_id, full_set_id) where status = 'in_progress' do nothing
    returning attempt_id into v_attempt_id;
    if v_attempt_id is not null then
      v_created := true;
      insert into public.reading_full_set_module_attempts(
        attempt_id, module_number, status, time_limit_seconds, started_at, deadline_at
      ) values (
        v_attempt_id, 1, 'preparing', v_time_limit, null, null
      );
    else
      select attempt_id into v_attempt_id
      from public.reading_full_set_attempts
      where student_id = v_user_id and full_set_id = p_full_set_id and status = 'in_progress'
      order by created_at desc limit 1;
    end if;
  end if;
  perform public.reconcile_reading_full_set_attempt(v_attempt_id);
  return public.reading_full_set_attempt_json(v_attempt_id)
    || jsonb_build_object('created', v_created);
end;
$$;

create or replace function public.prepare_reading_full_set_module_2(p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_attempt public.reading_full_set_attempts%rowtype;
  v_module_1_status text;
  v_time_limit integer;
begin
  select * into v_attempt
  from public.reading_full_set_attempts
  where attempt_id = p_attempt_id and student_id = v_user_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'FULL_SET_ATTEMPT_NOT_FOUND';
  end if;
  perform public.reconcile_reading_full_set_attempt(p_attempt_id);
  select * into v_attempt
  from public.reading_full_set_attempts
  where attempt_id = p_attempt_id
  for update;
  if v_attempt.status = 'completed' then
    return public.reading_full_set_attempt_json(p_attempt_id);
  end if;
  select status into v_module_1_status
  from public.reading_full_set_module_attempts
  where attempt_id = p_attempt_id and module_number = 1;
  if v_module_1_status <> 'submitted' then
    raise exception using errcode = '55000', message = 'FULL_SET_MODULE_1_NOT_SUBMITTED';
  end if;
  v_time_limit := public.reading_full_set_module_time_limit(v_attempt.full_set_id, 2::smallint);
  if v_time_limit <> 540 then
    raise exception using errcode = '23514', message = 'FULL_SET_INVALID_MODULE_2';
  end if;
  insert into public.reading_full_set_module_attempts(
    attempt_id, module_number, status, time_limit_seconds, started_at, deadline_at
  ) values (
    p_attempt_id, 2, 'preparing', v_time_limit, null, null
  ) on conflict (attempt_id, module_number) do nothing;
  update public.reading_full_set_attempts
  set current_module = 2
  where attempt_id = p_attempt_id and status = 'in_progress';
  return public.reading_full_set_attempt_json(p_attempt_id);
end;
$$;

create or replace function public.start_reading_full_set_module_2(p_attempt_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.prepare_reading_full_set_module_2(p_attempt_id);
$$;

create or replace function public.submit_reading_full_set_module(
  p_attempt_id uuid,
  p_module_number smallint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_module public.reading_full_set_module_attempts%rowtype;
  v_open_load_id uuid;
  v_now timestamptz;
begin
  perform 1 from public.reading_full_set_attempts
  where attempt_id = p_attempt_id and student_id = v_user_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'FULL_SET_ATTEMPT_NOT_FOUND';
  end if;
  select * into v_module
  from public.reading_full_set_module_attempts
  where attempt_id = p_attempt_id and module_number = p_module_number
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'FULL_SET_MODULE_NOT_FOUND';
  end if;
  if v_module.status = 'submitted' then
    return public.reading_full_set_attempt_json(p_attempt_id) || jsonb_build_object('alreadySubmitted', true);
  end if;
  if v_module.status <> 'active' or v_module.deadline_at is null then
    raise exception using errcode = '55000', message = 'FULL_SET_MODULE_NOT_ACTIVE';
  end if;
  select load_id into v_open_load_id
  from public.reading_full_set_load_pauses
  where module_attempt_id = v_module.module_attempt_id and finished_at is null
  limit 1;
  if found then
    perform public.settle_reading_full_set_load_pause(v_open_load_id, clock_timestamp());
    select * into v_module
    from public.reading_full_set_module_attempts
    where module_attempt_id = v_module.module_attempt_id
    for update;
  end if;
  v_now := clock_timestamp();
  perform public.finalize_reading_full_set_module(
    v_module.module_attempt_id,
    case when v_module.deadline_at <= v_now then 'timeout' else 'manual' end,
    v_now
  );
  return public.reading_full_set_attempt_json(p_attempt_id);
end;
$$;

create or replace function public.timeout_reading_full_set_module(
  p_attempt_id uuid,
  p_module_number smallint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_module_status text;
begin
  perform 1 from public.reading_full_set_attempts
  where attempt_id = p_attempt_id and student_id = v_user_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'FULL_SET_ATTEMPT_NOT_FOUND';
  end if;
  select status into v_module_status
  from public.reading_full_set_module_attempts
  where attempt_id = p_attempt_id and module_number = p_module_number;
  if not found then
    raise exception using errcode = 'P0002', message = 'FULL_SET_MODULE_NOT_FOUND';
  end if;
  if v_module_status = 'preparing' then
    raise exception using errcode = '55000', message = 'FULL_SET_MODULE_NOT_ACTIVE';
  end if;

  -- A live load lease deliberately makes reconciliation return without timing
  -- out. This prevents a stale second tab from submitting at its old display
  -- deadline while another tab is still in server-protected loading.
  perform public.reconcile_reading_full_set_attempt(p_attempt_id);
  return public.reading_full_set_attempt_json(p_attempt_id);
end;
$$;

revoke all on function public.activate_reading_full_set_module(uuid, smallint) from public, anon;
revoke all on function public.renew_reading_full_set_load_pause(uuid, uuid) from public, anon;
revoke all on function public.prepare_reading_full_set_module_2(uuid) from public, anon;
revoke all on function public.start_reading_full_set_module_2(uuid) from public, anon;
revoke all on function public.submit_reading_full_set_module(uuid, smallint) from public, anon;
revoke all on function public.timeout_reading_full_set_module(uuid, smallint) from public, anon;

grant execute on function public.activate_reading_full_set_module(uuid, smallint) to authenticated;
grant execute on function public.renew_reading_full_set_load_pause(uuid, uuid) to authenticated;
grant execute on function public.prepare_reading_full_set_module_2(uuid) to authenticated;
grant execute on function public.start_reading_full_set_module_2(uuid) to authenticated;
grant execute on function public.submit_reading_full_set_module(uuid, smallint) to authenticated;
grant execute on function public.timeout_reading_full_set_module(uuid, smallint) to authenticated;

commit;
