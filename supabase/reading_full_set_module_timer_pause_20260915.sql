-- TPS Reading Full Set: durable Module pause/resume and monotonic client timer snapshots.
-- Run once after reading_full_set_navigation_cursor_20260915.sql.
-- This migration does not modify Reading content, answers, scoring, or runtime assets.

begin;

alter table public.reading_full_set_module_attempts
  add column if not exists remaining_seconds integer,
  add column if not exists paused_at timestamptz,
  add column if not exists timer_revision bigint not null default 0;

update public.reading_full_set_module_attempts
set remaining_seconds = case
  when status = 'preparing' then time_limit_seconds
  when status = 'active' then least(
    time_limit_seconds,
    greatest(0, ceil(extract(epoch from (deadline_at - clock_timestamp())))::integer)
  )
  else 0
end
where remaining_seconds is null;

alter table public.reading_full_set_module_attempts
  alter column remaining_seconds set not null;

create or replace function public.initialize_reading_full_set_module_timer()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.remaining_seconds is null then
    new.remaining_seconds := new.time_limit_seconds;
  end if;
  return new;
end;
$$;

drop trigger if exists initialize_reading_full_set_module_timer
  on public.reading_full_set_module_attempts;
create trigger initialize_reading_full_set_module_timer
before insert on public.reading_full_set_module_attempts
for each row execute function public.initialize_reading_full_set_module_timer();

alter table public.reading_full_set_module_attempts
  drop constraint if exists reading_full_set_module_deadline_shape,
  drop constraint if exists reading_full_set_module_status_shape,
  drop constraint if exists reading_full_set_module_attempts_status_check,
  drop constraint if exists reading_full_set_module_remaining_seconds_check,
  drop constraint if exists reading_full_set_module_timer_revision_check;

alter table public.reading_full_set_module_attempts
  add constraint reading_full_set_module_attempts_status_check
    check (status in ('preparing', 'active', 'paused', 'submitted')),
  add constraint reading_full_set_module_deadline_shape check (
    (status = 'preparing' and started_at is null and deadline_at is null and paused_at is null)
    or (status = 'active' and started_at is not null and deadline_at is not null and paused_at is null)
    or (status = 'paused' and started_at is not null and deadline_at is null and paused_at is not null)
    or (status = 'submitted' and started_at is not null and deadline_at is not null and paused_at is null)
  ),
  add constraint reading_full_set_module_status_shape check (
    (status in ('preparing', 'active', 'paused') and submitted_at is null and submission_reason is null and total_points = 0 and correct_points = 0)
    or (status = 'submitted' and submitted_at is not null and submission_reason is not null and total_points in (15, 35))
  ),
  add constraint reading_full_set_module_remaining_seconds_check
    check (remaining_seconds between 0 and time_limit_seconds),
  add constraint reading_full_set_module_timer_revision_check
    check (timer_revision >= 0);

comment on column public.reading_full_set_module_attempts.remaining_seconds is
  'Authoritative frozen Module time while preparing/paused. Active JSON derives a current snapshot from deadline_at.';
comment on column public.reading_full_set_module_attempts.timer_revision is
  'Monotonic CAS revision for page-session resume and exit pause; stale lifecycle requests cannot replace newer timer state.';

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
        'remainingSeconds', case
          when module_attempt.status = 'active' then least(
            module_attempt.time_limit_seconds,
            greatest(0, ceil(extract(epoch from (module_attempt.deadline_at - clock_timestamp())))::integer)
          )
          when module_attempt.status = 'submitted' then 0
          else module_attempt.remaining_seconds
        end,
        'timerRevision', module_attempt.timer_revision,
        'submittedAt', module_attempt.submitted_at,
        'submissionReason', module_attempt.submission_reason,
        'answerRevision', module_attempt.answer_revision,
        'currentOccurrenceId', module_attempt.current_occurrence_id,
        'currentQuestionIndex', module_attempt.current_question_index,
        'cursorRevision', module_attempt.cursor_revision
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
        'remainingSeconds', case
          when module_attempt.status = 'active' then least(
            module_attempt.time_limit_seconds,
            greatest(0, ceil(extract(epoch from (module_attempt.deadline_at - clock_timestamp())))::integer)
          )
          when module_attempt.status = 'submitted' then 0
          else module_attempt.remaining_seconds
        end,
        'timerRevision', module_attempt.timer_revision,
        'submittedAt', module_attempt.submitted_at,
        'submissionReason', module_attempt.submission_reason,
        'answerRevision', module_attempt.answer_revision,
        'currentOccurrenceId', module_attempt.current_occurrence_id,
        'currentQuestionIndex', module_attempt.current_question_index,
        'cursorRevision', module_attempt.cursor_revision
      )
      from public.reading_full_set_module_attempts module_attempt
      where module_attempt.attempt_id = attempt.attempt_id and module_attempt.module_number = 2
    )
  )
  from public.reading_full_set_attempts attempt
  where attempt.attempt_id = p_attempt_id;
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
  if v_module.status = 'submitted' then
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

  v_activated_at := clock_timestamp();
  if v_module.status = 'active' then
    -- A new runner page session invalidates a delayed pagehide pause from the
    -- previous page without changing the active deadline.
    update public.reading_full_set_module_attempts
    set timer_revision = timer_revision + 1
    where module_attempt_id = v_module.module_attempt_id and status = 'active';
    return public.reading_full_set_attempt_json(p_attempt_id);
  end if;

  if v_module.status = 'paused' and v_module.remaining_seconds <= 0 then
    update public.reading_full_set_module_attempts
    set status = 'active',
        deadline_at = v_activated_at,
        paused_at = null,
        timer_revision = timer_revision + 1
    where module_attempt_id = v_module.module_attempt_id and status = 'paused';
    perform public.finalize_reading_full_set_module(v_module.module_attempt_id, 'timeout', v_activated_at);
    return public.reading_full_set_attempt_json(p_attempt_id);
  end if;

  if v_module.status not in ('preparing', 'paused') then
    raise exception using errcode = '55000', message = 'FULL_SET_MODULE_NOT_PREPARING';
  end if;
  update public.reading_full_set_module_attempts
  set status = 'active',
      started_at = coalesce(started_at, v_activated_at),
      deadline_at = v_activated_at + make_interval(secs => remaining_seconds),
      paused_at = null,
      timer_revision = timer_revision + 1
  where module_attempt_id = v_module.module_attempt_id
    and status in ('preparing', 'paused');
  return public.reading_full_set_attempt_json(p_attempt_id);
end;
$$;

create or replace function public.pause_reading_full_set_module(
  p_attempt_id uuid,
  p_module_number smallint,
  p_module_attempt_id uuid,
  p_expected_timer_revision bigint,
  p_remaining_seconds integer
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
  v_open_load_id uuid;
  v_now timestamptz;
  v_server_remaining integer;
  v_remaining integer;
begin
  if p_module_number not in (1, 2)
    or p_expected_timer_revision is null or p_expected_timer_revision < 0
    or p_remaining_seconds is null or p_remaining_seconds < 0 then
    raise exception using errcode = '22023', message = 'FULL_SET_INVALID_TIMER_PAUSE';
  end if;

  select * into v_attempt
  from public.reading_full_set_attempts
  where attempt_id = p_attempt_id and student_id = v_user_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'FULL_SET_ATTEMPT_NOT_FOUND';
  end if;
  select * into v_module
  from public.reading_full_set_module_attempts
  where attempt_id = p_attempt_id
    and module_number = p_module_number
    and module_attempt_id = p_module_attempt_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'FULL_SET_MODULE_NOT_FOUND';
  end if;

  if v_module.status = 'paused' then
    return jsonb_build_object(
      'accepted', true,
      'attempt', public.reading_full_set_attempt_json(p_attempt_id)
    );
  end if;
  if v_attempt.status <> 'in_progress' or v_module.status <> 'active' then
    return jsonb_build_object(
      'accepted', false,
      'reason', 'locked',
      'attempt', public.reading_full_set_attempt_json(p_attempt_id)
    );
  end if;
  if v_module.timer_revision <> p_expected_timer_revision then
    return jsonb_build_object(
      'accepted', false,
      'reason', 'stale_revision',
      'attempt', public.reading_full_set_attempt_json(p_attempt_id)
    );
  end if;

  select load_id into v_open_load_id
  from public.reading_full_set_load_pauses
  where module_attempt_id = v_module.module_attempt_id and finished_at is null
  limit 1;
  if found then
    perform public.settle_reading_full_set_load_pause(v_open_load_id, clock_timestamp());
    select * into v_module
    from public.reading_full_set_module_attempts
    where module_attempt_id = p_module_attempt_id
    for update;
  end if;

  v_now := clock_timestamp();
  v_server_remaining := least(
    v_module.time_limit_seconds,
    greatest(0, ceil(extract(epoch from (v_module.deadline_at - v_now)))::integer)
  );
  v_remaining := least(v_server_remaining, p_remaining_seconds, v_module.time_limit_seconds);
  if v_remaining <= 0 then
    perform public.finalize_reading_full_set_module(v_module.module_attempt_id, 'timeout', v_now);
    return jsonb_build_object(
      'accepted', true,
      'attempt', public.reading_full_set_attempt_json(p_attempt_id)
    );
  end if;

  update public.reading_full_set_module_attempts
  set status = 'paused',
      remaining_seconds = v_remaining,
      deadline_at = null,
      paused_at = v_now,
      timer_revision = timer_revision + 1
  where module_attempt_id = v_module.module_attempt_id
    and status = 'active'
    and timer_revision = p_expected_timer_revision;
  if not found then
    return jsonb_build_object(
      'accepted', false,
      'reason', 'stale_revision',
      'attempt', public.reading_full_set_attempt_json(p_attempt_id)
    );
  end if;
  return jsonb_build_object(
    'accepted', true,
    'attempt', public.reading_full_set_attempt_json(p_attempt_id)
  );
end;
$$;

revoke all on function public.pause_reading_full_set_module(uuid, smallint, uuid, bigint, integer)
  from public, anon;
grant execute on function public.pause_reading_full_set_module(uuid, smallint, uuid, bigint, integer)
  to authenticated;

commit;
