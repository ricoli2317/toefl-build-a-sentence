-- TPS Reading Full Set runtime hotfix: authoritative loading pauses and M2 state repair.
-- Run once after reading_full_set_attempts.sql. Do not rerun the full install migration.

begin;

alter table public.reading_full_set_module_attempts
  drop constraint if exists reading_full_set_module_deadline_shape;
alter table public.reading_full_set_module_attempts
  add constraint reading_full_set_module_deadline_shape check (
    deadline_at >= started_at + make_interval(secs => time_limit_seconds)
  );

create table if not exists public.reading_full_set_load_pauses (
  load_id uuid primary key,
  module_attempt_id uuid not null references public.reading_full_set_module_attempts(module_attempt_id) on delete cascade,
  occurrence_id text,
  started_at timestamptz not null,
  expires_at timestamptz not null,
  finished_at timestamptz,
  compensated_milliseconds integer check (compensated_milliseconds between 0 and 45000),
  created_at timestamptz not null default clock_timestamp(),
  constraint reading_full_set_load_pause_time_shape check (
    expires_at > started_at
    and expires_at <= started_at + interval '45 seconds'
    and (finished_at is null or finished_at >= started_at)
    and ((finished_at is null) = (compensated_milliseconds is null))
  )
);

create unique index if not exists reading_full_set_one_open_load_pause
  on public.reading_full_set_load_pauses(module_attempt_id)
  where finished_at is null;

alter table public.reading_full_set_load_pauses enable row level security;

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
  v_already_compensated integer;
  v_compensated integer;
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

  select coalesce(sum(compensated_milliseconds), 0)::integer
  into v_already_compensated
  from public.reading_full_set_load_pauses
  where module_attempt_id = v_module.module_attempt_id
    and finished_at is not null;
  v_compensated := greatest(0, floor(extract(epoch from (
    least(p_finished_at, v_pause.expires_at) - v_pause.started_at
  )) * 1000)::integer);
  v_compensated := least(v_compensated, greatest(0, 300000 - v_already_compensated));

  if v_module.status = 'active' and v_compensated > 0 then
    update public.reading_full_set_module_attempts
    set deadline_at = deadline_at + make_interval(secs => v_compensated / 1000.0)
    where module_attempt_id = v_module.module_attempt_id;
  else
    v_compensated := 0;
  end if;
  update public.reading_full_set_load_pauses
  set finished_at = greatest(p_finished_at, started_at),
      compensated_milliseconds = v_compensated
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
  v_now timestamptz := clock_timestamp();
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
  if v_module.deadline_at <= v_now then
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
  v_open_load_id uuid;
  v_compensated integer;
  v_now timestamptz := clock_timestamp();
  v_expires_at timestamptz := v_now + interval '45 seconds';
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

  if v_module.module_number = 2 and v_attempt.current_module <> 2 then
    update public.reading_full_set_attempts
    set current_module = 2
    where attempt_id = p_attempt_id and status = 'in_progress';
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
    return jsonb_build_object(
      'started', v_existing.finished_at is null,
      'reason', case when v_existing.finished_at is null then null else 'already_finished' end,
      'loadId', v_existing.load_id,
      'expiresAt', v_existing.expires_at,
      'attempt', public.reading_full_set_attempt_json(p_attempt_id)
    );
  end if;

  select load_id into v_open_load_id
  from public.reading_full_set_load_pauses
  where module_attempt_id = v_module.module_attempt_id and finished_at is null
  limit 1;
  if found then
    perform public.settle_reading_full_set_load_pause(v_open_load_id, v_now);
  end if;
  select coalesce(sum(compensated_milliseconds), 0)::integer into v_compensated
  from public.reading_full_set_load_pauses
  where module_attempt_id = v_module.module_attempt_id and finished_at is not null;
  if v_compensated >= 300000 then
    return jsonb_build_object(
      'started', false,
      'reason', 'pause_limit',
      'attempt', public.reading_full_set_attempt_json(p_attempt_id)
    );
  end if;
  v_expires_at := v_now + make_interval(
    secs => least(45000, 300000 - v_compensated) / 1000.0
  );

  insert into public.reading_full_set_load_pauses(
    load_id, module_attempt_id, occurrence_id, started_at, expires_at
  ) values (
    p_load_id, v_module.module_attempt_id, p_occurrence_id, v_now, v_expires_at
  );
  return jsonb_build_object(
    'started', true,
    'loadId', p_load_id,
    'expiresAt', v_expires_at,
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
  v_now timestamptz := clock_timestamp();
begin
  select attempt_id into v_attempt_id
  from public.reading_full_set_attempts
  where attempt_id = p_attempt_id and student_id = v_user_id
  for update;
  if not found or not exists (
    select 1
    from public.reading_full_set_load_pauses pause
    join public.reading_full_set_module_attempts module_attempt
      on module_attempt.module_attempt_id = pause.module_attempt_id
    join public.reading_full_set_attempts attempt
      on attempt.attempt_id = module_attempt.attempt_id
    where pause.load_id = p_load_id
      and attempt.attempt_id = p_attempt_id
      and attempt.student_id = v_user_id
  ) then
    raise exception using errcode = 'P0002', message = 'FULL_SET_LOAD_PAUSE_NOT_FOUND';
  end if;
  perform public.settle_reading_full_set_load_pause(p_load_id, v_now);
  perform public.reconcile_reading_full_set_attempt(p_attempt_id);
  return jsonb_build_object(
    'finished', true,
    'attempt', public.reading_full_set_attempt_json(p_attempt_id)
  );
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
  v_module_attempt_id uuid;
  v_time_limit integer;
  v_now timestamptz := clock_timestamp();
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
  where student_id = v_user_id
    and full_set_id = p_full_set_id
    and status = 'in_progress'
  order by created_at desc
  limit 1;

  if v_attempt_id is null then
    insert into public.reading_full_set_attempts(student_id, full_set_id, status, current_module, started_at)
    values (v_user_id, p_full_set_id, 'in_progress', 1, v_now)
    on conflict (student_id, full_set_id) where status = 'in_progress' do nothing
    returning attempt_id into v_attempt_id;
    if v_attempt_id is not null then
      v_created := true;
      insert into public.reading_full_set_module_attempts(
        attempt_id, module_number, status, time_limit_seconds, started_at, deadline_at
      ) values (
        v_attempt_id, 1, 'active', v_time_limit, v_now,
        v_now + make_interval(secs => v_time_limit)
      ) returning module_attempt_id into v_module_attempt_id;
      insert into public.reading_full_set_load_pauses(
        load_id, module_attempt_id, occurrence_id, started_at, expires_at
      ) values (
        gen_random_uuid(), v_module_attempt_id, null, v_now, v_now + interval '45 seconds'
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

create or replace function public.start_reading_full_set_module_2(p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_attempt public.reading_full_set_attempts%rowtype;
  v_module_2_attempt_id uuid;
  v_module_1_status text;
  v_time_limit integer;
  v_now timestamptz := clock_timestamp();
begin
  select * into v_attempt
  from public.reading_full_set_attempts
  where attempt_id = p_attempt_id and student_id = v_user_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'FULL_SET_ATTEMPT_NOT_FOUND';
  end if;
  perform public.reconcile_reading_full_set_attempt(p_attempt_id);
  select status into v_module_1_status
  from public.reading_full_set_module_attempts
  where attempt_id = p_attempt_id and module_number = 1;
  if v_attempt.status = 'completed' then return public.reading_full_set_attempt_json(p_attempt_id); end if;
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
    p_attempt_id, 2, 'active', v_time_limit, v_now,
    v_now + make_interval(secs => v_time_limit)
  ) on conflict (attempt_id, module_number) do nothing
  returning module_attempt_id into v_module_2_attempt_id;
  if v_module_2_attempt_id is not null then
    insert into public.reading_full_set_load_pauses(
      load_id, module_attempt_id, occurrence_id, started_at, expires_at
    ) values (
      gen_random_uuid(), v_module_2_attempt_id, null, v_now, v_now + interval '45 seconds'
    );
  end if;
  update public.reading_full_set_attempts
  set current_module = 2
  where attempt_id = p_attempt_id and status = 'in_progress';
  return public.reading_full_set_attempt_json(p_attempt_id);
end;
$$;

revoke all on table public.reading_full_set_load_pauses from public, anon, authenticated;
grant select on table public.reading_full_set_load_pauses to service_role;

revoke all on function public.settle_reading_full_set_load_pause(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.reconcile_reading_full_set_attempt(uuid) from public, anon, authenticated;
revoke all on function public.begin_reading_full_set_load_pause(uuid, uuid, text) from public, anon;
revoke all on function public.finish_reading_full_set_load_pause(uuid, uuid) from public, anon;
revoke all on function public.get_or_create_reading_full_set_attempt(text) from public, anon;
revoke all on function public.start_reading_full_set_module_2(uuid) from public, anon;

grant execute on function public.begin_reading_full_set_load_pause(uuid, uuid, text) to authenticated;
grant execute on function public.finish_reading_full_set_load_pause(uuid, uuid) to authenticated;
grant execute on function public.get_or_create_reading_full_set_attempt(text) to authenticated;
grant execute on function public.start_reading_full_set_module_2(uuid) to authenticated;

commit;
