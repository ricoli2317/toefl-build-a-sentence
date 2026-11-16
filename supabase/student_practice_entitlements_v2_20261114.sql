-- TPS student practice entitlements V2 (phase 2: six ordinary task types).
--
-- MANUAL, additive migration. Execute in the Supabase SQL Editor after the
-- phase-1 migration (student_practice_entitlements_v1_20261114.sql).
--
-- Scope:
--   * server-side enforcement switch, default OFF
--   * atomic first-start spend + permanent unlock for the six ordinary types
--   * free assignment unlock on a validated Assignment start
--   * historical attempt / retake free unlock
--   * database guards against direct attempts / writing_attempts writes
--   * entitlement-aware ordinary Reading RPCs
--
-- It does NOT change Full Set, BAS Grammar Category, RAP Question Category or
-- Reading Wrongbook/Corection business logic. Historical backfill is a separate
-- manual operation file.

begin;

-- ---------------------------------------------------------------------------
-- 0. Required phase-1 and production shapes (fail early, roll back on mismatch)
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('auth.uid()') is null then
    raise exception 'TPS_ENTITLEMENTS_V2_AUTH_UID_MISSING';
  end if;
  if to_regclass('public.practice_entitlement_defaults') is null
     or to_regclass('public.student_practice_entitlements') is null
     or to_regclass('public.student_practice_unlocks') is null
     or to_regclass('public.student_practice_entitlement_events') is null then
    raise exception 'TPS_ENTITLEMENTS_V2_PHASE1_MISSING';
  end if;
  if to_regclass('public.practice_items') is null
     or to_regclass('public.practice_item_sources') is null
     or to_regclass('public.reading_logical_items') is null
     or to_regclass('public.reading_attempts') is null
     or to_regclass('public.attempts') is null
     or to_regclass('public.attempt_answers') is null
     or to_regclass('public.questions') is null
     or to_regclass('public.writing_attempts') is null
     or to_regclass('public.writing_assignments') is null
     or to_regclass('public.writing_assignment_students') is null then
    raise exception 'TPS_ENTITLEMENTS_V2_REQUIRED_TABLE_MISSING';
  end if;
  if exists (
    select 1
    from (values
      ('practice_items', 'item_id'),
      ('practice_items', 'task_type'),
      ('practice_item_sources', 'item_id'),
      ('practice_item_sources', 'task_type'),
      ('practice_item_sources', 'source_set_id'),
      ('practice_item_sources', 'source_question_id'),
      ('reading_logical_items', 'logical_item_id'),
      ('reading_logical_items', 'module'),
      ('reading_attempts', 'attempt_id'),
      ('reading_attempts', 'student_id'),
      ('reading_attempts', 'logical_item_id'),
      ('reading_attempts', 'task_type'),
      ('reading_attempts', 'status'),
      ('attempts', 'attempt_id'),
      ('attempts', 'student_id'),
      ('attempts', 'set_id'),
      ('attempt_answers', 'attempt_id'),
      ('attempt_answers', 'question_id'),
      ('attempt_answers', 'student_id'),
      ('attempt_answers', 'set_id'),
      ('questions', 'question_id'),
      ('questions', 'set_id'),
      ('writing_attempts', 'attempt_id'),
      ('writing_attempts', 'user_id'),
      ('writing_attempts', 'task_type'),
      ('writing_attempts', 'question_id'),
      ('writing_attempts', 'attempt_kind'),
      ('writing_attempts', 'assignment_id'),
      ('writing_attempts', 'status'),
      ('writing_attempts', 'started_at'),
      ('writing_assignments', 'assignment_id'),
      ('writing_assignments', 'task_type'),
      ('writing_assignments', 'question_source'),
      ('writing_assignments', 'question_id'),
      ('writing_assignments', 'question_snapshot'),
      ('writing_assignments', 'status'),
      ('writing_assignments', 'deleted_at'),
      ('writing_assignment_students', 'assignment_id'),
      ('writing_assignment_students', 'student_id')
    ) required(table_name, column_name)
    where not exists (
      select 1
      from information_schema.columns columns
      where columns.table_schema = 'public'
        and columns.table_name = required.table_name
        and columns.column_name = required.column_name
    )
  ) then
    raise exception 'TPS_ENTITLEMENTS_V2_REQUIRED_COLUMN_MISSING';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Server-side enforcement switch (default OFF)
-- ---------------------------------------------------------------------------
-- Keep this false through phases 2-5. Enabling is a phase-6 operation only,
-- after Full Set / BAS all-practice gating and the whole regression are ready.
create table if not exists public.practice_entitlement_runtime_config (
  singleton boolean primary key default true,
  enforcement_enabled boolean not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  updated_by uuid references public.profiles(id) on delete set null,
  constraint practice_entitlement_runtime_config_singleton_check check (singleton)
);

insert into public.practice_entitlement_runtime_config as config (
  singleton, enforcement_enabled
) values (true, false)
on conflict (singleton) do nothing;

alter table public.practice_entitlement_runtime_config enable row level security;
revoke all on table public.practice_entitlement_runtime_config from public, anon, authenticated;
grant select, insert, update on table public.practice_entitlement_runtime_config to service_role;

comment on table public.practice_entitlement_runtime_config is
  'Server-only phase-2 entitlement switch. Default false; clients have no table access.';

create or replace function public.practice_entitlement_enforcement_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select config.enforcement_enabled
    from public.practice_entitlement_runtime_config config
    where config.singleton = true
  ), false);
$$;

revoke all on function public.practice_entitlement_enforcement_enabled() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Internal identity, remaining-value and unlock helpers
-- ---------------------------------------------------------------------------
create or replace function public.practice_entitlement_resolve_item(
  p_task_type text,
  p_source_set_id text default null,
  p_source_question_id text default null,
  p_logical_item_id text default null
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_item_id text;
begin
  if p_task_type = 'build_sentence' then
    select source.item_id::text into v_item_id
    from public.practice_item_sources source
    where source.task_type = 'build_sentence'
      and source.source_set_id = nullif(btrim(p_source_set_id), '')
    limit 1;
  elsif p_task_type in ('email', 'academic_discussion') then
    select source.item_id::text into v_item_id
    from public.practice_item_sources source
    where source.task_type = p_task_type
      and source.source_question_id = nullif(btrim(p_source_question_id), '')
    limit 1;
  elsif p_task_type in ('ctw', 'rdl', 'rap') then
    if exists (
      select 1 from public.reading_logical_items item
      where item.logical_item_id = p_logical_item_id
        and item.module = p_task_type
    ) then
      v_item_id := p_logical_item_id;
    end if;
  else
    raise exception 'INVALID_PRACTICE_TASK_TYPE';
  end if;
  return v_item_id;
end;
$$;

revoke all on function public.practice_entitlement_resolve_item(text, text, text, text)
  from public, anon, authenticated;

create or replace function public.practice_entitlement_current_remaining(
  p_student_id uuid,
  p_entitlement_kind text
)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(entitlements.remaining, defaults.default_remaining)::integer
  from public.practice_entitlement_defaults defaults
  left join public.student_practice_entitlements entitlements
    on entitlements.student_id = p_student_id
   and entitlements.entitlement_kind = defaults.entitlement_kind
  where defaults.entitlement_kind = p_entitlement_kind;
$$;

revoke all on function public.practice_entitlement_current_remaining(uuid, text)
  from public, anon, authenticated;

create or replace function public.practice_entitlement_has_prior_attempt(
  p_student_id uuid,
  p_task_type text,
  p_item_id text,
  p_source_question_id text default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_task_type = 'build_sentence' then
    return exists (
      select 1
      from public.attempts attempt
      join public.practice_item_sources source
        on source.task_type = 'build_sentence'
       and source.source_set_id = btrim(attempt.set_id::text)
      where attempt.student_id = p_student_id
        and source.item_id::text = p_item_id
    );
  elsif p_task_type in ('email', 'academic_discussion') then
    return exists (
      select 1
      from public.writing_attempts attempt
      join public.practice_item_sources source
        on source.task_type = attempt.task_type
       and source.source_question_id = attempt.question_id
      where attempt.user_id = p_student_id
        and attempt.attempt_kind = 'original'
        and source.item_id::text = p_item_id
        and (
          attempt.assignment_id is null
          or exists (
            select 1 from public.writing_assignments assignment
            where assignment.assignment_id = attempt.assignment_id
              and assignment.question_source = 'question_bank'
          )
        )
    );
  elsif p_task_type in ('ctw', 'rdl', 'rap') then
    return exists (
      select 1
      from public.reading_attempts attempt
      where attempt.student_id = p_student_id
        and attempt.logical_item_id = p_item_id
        and attempt.task_type = p_task_type
    );
  else
    raise exception 'INVALID_PRACTICE_TASK_TYPE';
  end if;
end;
$$;

revoke all on function public.practice_entitlement_has_prior_attempt(uuid, text, text, text)
  from public, anon, authenticated;

create or replace function public.practice_entitlement_assignment_grants(
  p_assignment_id uuid,
  p_student_id uuid,
  p_task_type text,
  p_item_id text,
  p_source_question_id text default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.writing_assignments assignment
    join public.writing_assignment_students membership
      on membership.assignment_id = assignment.assignment_id
    where assignment.assignment_id = p_assignment_id
      and assignment.status = 'active'
      and assignment.deleted_at is null
      and assignment.task_type = p_task_type
      and assignment.question_source = 'question_bank'
      and membership.student_id = p_student_id
      and (
        assignment.question_id = p_item_id
        or assignment.question_snapshot ->> 'item_id' = p_item_id
        or (
          p_source_question_id is not null
          and assignment.question_id = p_source_question_id
        )
      )
  );
$$;

revoke all on function public.practice_entitlement_assignment_grants(uuid, uuid, text, text, text)
  from public, anon, authenticated;

create or replace function public.practice_entitlement_ensure_unlock(
  p_student_id uuid,
  p_task_type text,
  p_item_id text,
  p_reason text,
  p_assignment_id uuid default null,
  p_request_id text default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_inserted integer := 0;
  v_remaining integer;
  v_reason text;
begin
  if p_student_id is null
     or nullif(btrim(p_item_id), '') is null
     or p_task_type not in (
       'build_sentence', 'email', 'academic_discussion', 'ctw', 'rdl', 'rap'
     ) then
    raise exception 'INVALID_PRACTICE_UNLOCK';
  end if;

  v_reason := left(coalesce(nullif(btrim(p_reason), ''), 'unlock'), 500);

  insert into public.student_practice_unlocks (
    student_id, task_type, item_id, source, source_ref
  ) values (
    p_student_id, p_task_type, p_item_id, v_reason, p_assignment_id::text
  )
  on conflict (student_id, task_type, item_id) do nothing;

  get diagnostics v_inserted = row_count;
  if v_inserted > 0 then
    v_remaining := public.practice_entitlement_current_remaining(p_student_id, p_task_type);
    insert into public.student_practice_entitlement_events (
      student_id, entitlement_kind, operation, reason,
      previous_remaining, new_remaining, actor_id,
      item_id, assignment_id, request_id
    ) values (
      p_student_id, p_task_type, 'unlock', v_reason,
      v_remaining, v_remaining, p_student_id,
      p_item_id, p_assignment_id, p_request_id
    );
  end if;

  return v_inserted > 0;
end;
$$;

revoke all on function public.practice_entitlement_ensure_unlock(uuid, text, text, text, uuid, text)
  from public, anon, authenticated;

create or replace function public.practice_entitlement_spend_and_unlock(
  p_student_id uuid,
  p_task_type text,
  p_item_id text,
  p_reason text default 'first_start',
  p_assignment_id uuid default null,
  p_request_id text default null
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_inserted integer := 0;
  v_remaining integer;
  v_new_remaining integer;
  v_reason text;
begin
  if p_student_id is null
     or nullif(btrim(p_item_id), '') is null
     or p_task_type not in (
       'build_sentence', 'email', 'academic_discussion', 'ctw', 'rdl', 'rap'
     ) then
    raise exception 'INVALID_PRACTICE_UNLOCK';
  end if;

  -- The same per-student lock used by the phase-1 Admin set RPC. No concurrent
  -- first start or Admin adjustment can overdraw or lose an update.
  perform pg_advisory_xact_lock(hashtextextended(p_student_id::text, 0));

  insert into public.student_practice_unlocks (
    student_id, task_type, item_id, source, source_ref
  ) values (
    p_student_id, p_task_type, p_item_id, 'entitlement', null
  )
  on conflict (student_id, task_type, item_id) do nothing;

  get diagnostics v_inserted = row_count;
  v_remaining := public.practice_entitlement_current_remaining(p_student_id, p_task_type);

  if v_inserted = 0 then
    return v_remaining;
  end if;
  if v_remaining is null then
    raise exception 'PRACTICE_ENTITLEMENT_DEFAULT_NOT_FOUND';
  end if;
  if v_remaining <= 0 then
    -- The unlock insert is rolled back by this exception.
    raise exception 'PRACTICE_ENTITLEMENT_EXHAUSTED';
  end if;

  v_new_remaining := v_remaining - 1;
  insert into public.student_practice_entitlements as entitlements (
    student_id, entitlement_kind, remaining, updated_at, updated_by
  ) values (
    p_student_id, p_task_type, v_new_remaining, clock_timestamp(), p_student_id
  )
  on conflict on constraint student_practice_entitlements_pkey do update
  set remaining = excluded.remaining,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by;

  v_reason := left(coalesce(nullif(btrim(p_reason), ''), 'first_start'), 500);
  insert into public.student_practice_entitlement_events (
    student_id, entitlement_kind, operation, reason,
    previous_remaining, new_remaining, actor_id,
    item_id, assignment_id, request_id
  ) values (
    p_student_id, p_task_type, 'spend', v_reason,
    v_remaining, v_new_remaining, p_student_id,
    p_item_id, p_assignment_id, p_request_id
  );

  return v_new_remaining;
end;
$$;

revoke all on function public.practice_entitlement_spend_and_unlock(uuid, text, text, text, uuid, text)
  from public, anon, authenticated;

-- Keep the phase-1 unlock identity trigger correct when practice_items.item_id
-- is uuid and the unlock table stores text.
create or replace function public.enforce_student_practice_unlock_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.student_id is null or not exists (
    select 1 from public.profiles
    where id = new.student_id and role = 'student'
  ) then
    raise exception 'STUDENT_NOT_FOUND';
  end if;

  if new.task_type in ('build_sentence', 'email', 'academic_discussion') then
    if not exists (
      select 1 from public.practice_items item
      where item.item_id::text = new.item_id
        and item.task_type = new.task_type
    ) then
      raise exception 'INVALID_PRACTICE_ITEM_IDENTITY';
    end if;
  else
    if not exists (
      select 1 from public.reading_logical_items item
      where item.logical_item_id = new.item_id
        and item.module = new.task_type
    ) then
      raise exception 'INVALID_READING_ITEM_IDENTITY';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_student_practice_unlock_identity()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. BAS explicit Start / Unlock RPC
-- ---------------------------------------------------------------------------
create or replace function public.student_start_build_sentence_practice(
  p_source_set_id text,
  p_assignment_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_enforcement boolean;
  v_set_id text := btrim(coalesce(p_source_set_id, ''));
  v_item_id text;
  v_remaining integer;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'STUDENT_REQUIRED';
  end if;
  select profile.role::text into v_role
  from public.profiles profile
  where profile.id = v_user_id and profile.is_active;
  if v_role is null then
    raise exception using errcode = '42501', message = 'STUDENT_REQUIRED';
  end if;
  if v_set_id = ''
     or lower(v_set_id) like 'grammar-%'
     or lower(v_set_id) like 'wrongbook-%' then
    raise exception 'INVALID_PRACTICE_SET';
  end if;

  v_enforcement := public.practice_entitlement_enforcement_enabled();
  v_item_id := public.practice_entitlement_resolve_item(
    'build_sentence', v_set_id, null, null
  );
  if v_item_id is null then
    if not v_enforcement then
      -- Preserve pre-enforcement behavior for any legacy set that has no
      -- canonical mapping yet. No quota/unlock side effect is introduced.
      return jsonb_build_object(
        'allowed', true,
        'unlocked', false,
        'charged', false,
        'free', false,
        'enforcementEnabled', false,
        'itemId', null,
        'taskType', 'build_sentence',
        'remaining', case
          when v_role = 'student'
            then public.practice_entitlement_current_remaining(v_user_id, 'build_sentence')
          else null
        end
      );
    end if;
    raise exception 'PRACTICE_ITEM_NOT_FOUND';
  end if;

  if v_role in ('teacher', 'admin') then
    return jsonb_build_object(
      'allowed', true,
      'unlocked', false,
      'charged', false,
      'free', false,
      'enforcementEnabled', v_enforcement,
      'itemId', v_item_id,
      'taskType', 'build_sentence',
      'remaining', null
    );
  end if;

  if not v_enforcement then
    -- The authenticated start RPC itself does not write a free unlock. The BAS
    -- API records a pre-enforcement start through the service-role-only
    -- record_pre_enable_build_sentence_start RPC below, so a Student cannot
    -- call this endpoint directly to farm free unlocks during the off period.
    return jsonb_build_object(
      'allowed', true,
      'unlocked', false,
      'charged', false,
      'free', false,
      'enforcementEnabled', false,
      'itemId', v_item_id,
      'taskType', 'build_sentence',
      'remaining', public.practice_entitlement_current_remaining(v_user_id, 'build_sentence')
    );
  end if;

  if not exists (
    select 1 from public.student_practice_unlocks unlock
    where unlock.student_id = v_user_id
      and unlock.task_type = 'build_sentence'
      and unlock.item_id = v_item_id
  ) then
    if public.practice_entitlement_has_prior_attempt(
      v_user_id, 'build_sentence', v_item_id, null
    ) then
      perform public.practice_entitlement_ensure_unlock(
        v_user_id, 'build_sentence', v_item_id,
        'historical_attempt', null, null
      );
      return jsonb_build_object(
        'allowed', true,
        'unlocked', true,
        'charged', false,
        'free', true,
        'enforcementEnabled', true,
        'itemId', v_item_id,
        'taskType', 'build_sentence',
        'remaining', public.practice_entitlement_current_remaining(v_user_id, 'build_sentence')
      );
    end if;

    if p_assignment_id is not null then
      if not public.practice_entitlement_assignment_grants(
        p_assignment_id, v_user_id, 'build_sentence', v_item_id, null
      ) then
        raise exception 'PRACTICE_ASSIGNMENT_NOT_AVAILABLE';
      end if;
      perform public.practice_entitlement_ensure_unlock(
        v_user_id, 'build_sentence', v_item_id,
        'assignment', p_assignment_id, null
      );
      return jsonb_build_object(
        'allowed', true,
        'unlocked', true,
        'charged', false,
        'free', true,
        'enforcementEnabled', true,
        'itemId', v_item_id,
        'taskType', 'build_sentence',
        'remaining', public.practice_entitlement_current_remaining(v_user_id, 'build_sentence')
      );
    end if;

    v_remaining := public.practice_entitlement_spend_and_unlock(
      v_user_id, 'build_sentence', v_item_id, 'first_start', null, null
    );
    return jsonb_build_object(
      'allowed', true,
      'unlocked', true,
      'charged', true,
      'free', false,
      'enforcementEnabled', true,
      'itemId', v_item_id,
      'taskType', 'build_sentence',
      'remaining', v_remaining
    );
  end if;

  return jsonb_build_object(
    'allowed', true,
    'unlocked', true,
    'charged', false,
    'free', false,
    'enforcementEnabled', true,
    'itemId', v_item_id,
    'taskType', 'build_sentence',
    'remaining', public.practice_entitlement_current_remaining(v_user_id, 'build_sentence')
  );
end;
$$;

revoke all on function public.student_start_build_sentence_practice(text, uuid)
  from public, anon, authenticated;
grant execute on function public.student_start_build_sentence_practice(text, uuid)
  to authenticated;

-- Service-role-only compatibility marker for a BAS start made while the switch
-- is still OFF. Only the authenticated Next.js start route calls this after it
-- has verified the caller. It writes a free permanent unlock (no quota) so that
-- the same started practice remains submittable after the later phase-6 enable.
create or replace function public.record_pre_enable_build_sentence_start(
  p_student_id uuid,
  p_source_set_id text,
  p_assignment_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_set_id text := btrim(coalesce(p_source_set_id, ''));
  v_item_id text;
  v_inserted boolean;
begin
  if public.practice_entitlement_enforcement_enabled() then
    return jsonb_build_object('recorded', false, 'enforcementEnabled', true);
  end if;
  if p_student_id is null then
    raise exception using errcode = '42501', message = 'STUDENT_REQUIRED';
  end if;

  select profile.role::text into v_role
  from public.profiles profile
  where profile.id = p_student_id and profile.is_active;
  if v_role is distinct from 'student' then
    return jsonb_build_object('recorded', false, 'enforcementEnabled', false);
  end if;
  if v_set_id = ''
     or lower(v_set_id) like 'grammar-%'
     or lower(v_set_id) like 'wrongbook-%' then
    return jsonb_build_object('recorded', false, 'enforcementEnabled', false);
  end if;

  v_item_id := public.practice_entitlement_resolve_item(
    'build_sentence', v_set_id, null, null
  );
  if v_item_id is null then
    return jsonb_build_object('recorded', false, 'enforcementEnabled', false);
  end if;

  v_inserted := public.practice_entitlement_ensure_unlock(
    p_student_id, 'build_sentence', v_item_id,
    'pre_enforcement_start', p_assignment_id, null
  );
  return jsonb_build_object(
    'recorded', true,
    'free', v_inserted,
    'enforcementEnabled', false,
    'itemId', v_item_id,
    'taskType', 'build_sentence'
  );
end;
$$;

revoke all on function public.record_pre_enable_build_sentence_start(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.record_pre_enable_build_sentence_start(uuid, text, uuid)
  to service_role;

create or replace function public.student_assert_bas_submission_authorized(
  p_set_id text,
  p_question_ids text[] default null
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_set_id text := btrim(coalesce(p_set_id, ''));
  v_item_id text;
begin
  if not public.practice_entitlement_enforcement_enabled() then
    return;
  end if;
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'STUDENT_REQUIRED';
  end if;
  select profile.role::text into v_role
  from public.profiles profile
  where profile.id = v_user_id and profile.is_active;
  if v_role in ('teacher', 'admin') then
    return;
  end if;
  if v_role is distinct from 'student' then
    raise exception using errcode = '42501', message = 'STUDENT_REQUIRED';
  end if;
  if v_set_id = ''
     or lower(v_set_id) like 'grammar-%'
     or lower(v_set_id) like 'wrongbook-%' then
    return;
  end if;

  v_item_id := public.practice_entitlement_resolve_item(
    'build_sentence', v_set_id, null, null
  );
  if v_item_id is null then
    raise exception 'PRACTICE_ITEM_NOT_FOUND';
  end if;
  if not exists (
    select 1 from public.student_practice_unlocks unlock
    where unlock.student_id = v_user_id
      and unlock.task_type = 'build_sentence'
      and unlock.item_id = v_item_id
  ) then
    raise exception 'PRACTICE_ENTITLEMENT_NOT_UNLOCKED';
  end if;

  if p_question_ids is not null and array_length(p_question_ids, 1) is not null then
    if exists (
      select 1
      from unnest(p_question_ids) as requested(question_id)
      where not exists (
        select 1 from public.questions question
        where question.question_id::text = requested.question_id
          and question.set_id::text = v_set_id
      )
    ) then
      raise exception 'PRACTICE_QUESTION_NOT_IN_SET';
    end if;
  end if;
end;
$$;

revoke all on function public.student_assert_bas_submission_authorized(text, text[])
  from public, anon, authenticated;
grant execute on function public.student_assert_bas_submission_authorized(text, text[])
  to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Ordinary Reading RPCs (CTW / RDL / RAP only)
-- ---------------------------------------------------------------------------
create or replace function public.get_or_create_reading_attempt_with_assignment(
  p_logical_item_id text,
  p_assignment_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_module text;
  v_attempt_id uuid;
  v_attempt_status text;
  v_created boolean := false;
  v_enforcement boolean;
  v_result jsonb;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'READING_STUDENT_REQUIRED';
  end if;
  select profile.role::text into v_role
  from public.profiles profile
  where profile.id = v_user_id and profile.is_active;
  if v_role is null or v_role not in ('student', 'teacher', 'admin') then
    raise exception using errcode = '42501', message = 'READING_STUDENT_REQUIRED';
  end if;

  select item.module into v_module
  from public.reading_logical_items item
  where item.logical_item_id = p_logical_item_id;
  if v_module is null then
    raise exception using errcode = 'P0002', message = 'READING_ITEM_NOT_FOUND';
  end if;
  if v_module not in ('ctw', 'rdl', 'rap') then
    raise exception 'INVALID_READING_TASK_TYPE';
  end if;

  v_enforcement := public.practice_entitlement_enforcement_enabled();

  select attempt.attempt_id, attempt.status
    into v_attempt_id, v_attempt_status
  from public.reading_attempts attempt
  where attempt.student_id = v_user_id
    and attempt.logical_item_id = p_logical_item_id
    and attempt.task_type = v_module
  order by (attempt.status = 'draft') desc, attempt.created_at desc
  limit 1;

  if v_attempt_id is not null then
    if v_enforcement and v_role = 'student' then
      perform public.practice_entitlement_ensure_unlock(
        v_user_id, v_module, p_logical_item_id,
        case when v_attempt_status = 'draft' then 'resume' else 'historical_attempt' end,
        p_assignment_id, v_attempt_id::text
      );
    end if;
    select public.reading_attempt_result_json(v_attempt_id) into v_result;
    return v_result || jsonb_build_object('created', false, 'resumed', true);
  end if;

  -- Create the draft before charging. Any later entitlement failure raises and
  -- rolls the draft back in this same transaction.
  insert into public.reading_attempts (
    student_id, logical_item_id, task_type, status
  ) values (
    v_user_id, p_logical_item_id, v_module, 'draft'
  )
  on conflict (student_id, logical_item_id, task_type) where status = 'draft'
  do nothing
  returning attempt_id into v_attempt_id;

  if v_attempt_id is not null then
    v_created := true;
  else
    select attempt.attempt_id into v_attempt_id
    from public.reading_attempts attempt
    where attempt.student_id = v_user_id
      and attempt.logical_item_id = p_logical_item_id
      and attempt.task_type = v_module
      and attempt.status = 'draft'
    order by attempt.created_at desc
    limit 1;
    if v_attempt_id is null then
      raise exception using errcode = 'P0002', message = 'READING_ATTEMPT_NOT_FOUND';
    end if;
    -- The concurrent creator of this draft owns the entitlement decision in
    -- its own transaction. Doing a free "resume" unlock here could race ahead
    -- of that creator's spend and make the first start free. A committed
    -- pre-existing draft is handled by the initial attempt lookup above.
    select public.reading_attempt_result_json(v_attempt_id) into v_result;
    return v_result || jsonb_build_object('created', false, 'resumed', true);
  end if;

  if v_enforcement and v_role = 'student' then
    if p_assignment_id is not null then
      if not public.practice_entitlement_assignment_grants(
        p_assignment_id, v_user_id, v_module, p_logical_item_id, null
      ) then
        raise exception 'PRACTICE_ASSIGNMENT_NOT_AVAILABLE';
      end if;
      perform public.practice_entitlement_ensure_unlock(
        v_user_id, v_module, p_logical_item_id,
        'assignment', p_assignment_id, v_attempt_id::text
      );
    else
      perform public.practice_entitlement_spend_and_unlock(
        v_user_id, v_module, p_logical_item_id, 'first_start', null, v_attempt_id::text
      );
    end if;
  end if;

  select public.reading_attempt_result_json(v_attempt_id) into v_result;
  return v_result || jsonb_build_object('created', true, 'resumed', false);
end;
$$;

revoke all on function public.get_or_create_reading_attempt_with_assignment(text, uuid)
  from public, anon, authenticated;
grant execute on function public.get_or_create_reading_attempt_with_assignment(text, uuid)
  to authenticated;

create or replace function public.get_or_create_reading_attempt(p_logical_item_id text)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select public.get_or_create_reading_attempt_with_assignment(p_logical_item_id, null);
$$;

revoke all on function public.get_or_create_reading_attempt(text) from public, anon, authenticated;
grant execute on function public.get_or_create_reading_attempt(text) to authenticated;

create or replace function public.retake_reading_attempt(p_submitted_attempt_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_source public.reading_attempts%rowtype;
  v_draft_id uuid;
  v_created boolean := false;
  v_enforcement boolean;
  v_result jsonb;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'READING_STUDENT_REQUIRED';
  end if;
  select profile.role::text into v_role
  from public.profiles profile
  where profile.id = v_user_id and profile.is_active;
  if v_role is null or v_role not in ('student', 'teacher', 'admin') then
    raise exception using errcode = '42501', message = 'READING_STUDENT_REQUIRED';
  end if;

  select attempt.* into v_source
  from public.reading_attempts attempt
  where attempt.attempt_id = p_submitted_attempt_id
    and attempt.student_id = v_user_id
    and attempt.status = 'submitted'
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'READING_SUBMITTED_ATTEMPT_NOT_FOUND';
  end if;

  v_enforcement := public.practice_entitlement_enforcement_enabled();
  if v_enforcement and v_role = 'student' then
    perform public.practice_entitlement_ensure_unlock(
      v_user_id, v_source.task_type, v_source.logical_item_id,
      'retake', null, v_source.attempt_id::text
    );
  end if;

  select attempt.attempt_id into v_draft_id
  from public.reading_attempts attempt
  where attempt.student_id = v_user_id
    and attempt.logical_item_id = v_source.logical_item_id
    and attempt.task_type = v_source.task_type
    and attempt.status = 'draft'
  order by attempt.created_at desc
  limit 1;

  if v_draft_id is null then
    insert into public.reading_attempts (
      student_id, logical_item_id, task_type, status
    ) values (
      v_user_id, v_source.logical_item_id, v_source.task_type, 'draft'
    )
    on conflict (student_id, logical_item_id, task_type) where status = 'draft'
    do nothing
    returning attempt_id into v_draft_id;

    if v_draft_id is not null then
      v_created := true;
    else
      select attempt.attempt_id into v_draft_id
      from public.reading_attempts attempt
      where attempt.student_id = v_user_id
        and attempt.logical_item_id = v_source.logical_item_id
        and attempt.task_type = v_source.task_type
        and attempt.status = 'draft'
      order by attempt.created_at desc
      limit 1;
    end if;
  end if;
  if v_draft_id is null then
    raise exception using errcode = 'P0002', message = 'READING_ATTEMPT_NOT_FOUND';
  end if;

  select public.reading_attempt_result_json(v_draft_id) into v_result;
  return v_result || jsonb_build_object(
    'created', v_created,
    'resumed', not v_created,
    'retakeOfAttemptId', v_source.attempt_id
  );
end;
$$;

revoke all on function public.retake_reading_attempt(uuid) from public, anon, authenticated;
grant execute on function public.retake_reading_attempt(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Writing draft resume/historical unlock helper
-- ---------------------------------------------------------------------------
create or replace function public.student_ensure_writing_practice_unlock(
  p_attempt_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_attempt public.writing_attempts%rowtype;
  v_assignment public.writing_assignments%rowtype;
  v_item_id text;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'STUDENT_REQUIRED';
  end if;
  select profile.role::text into v_role
  from public.profiles profile
  where profile.id = v_user_id and profile.is_active;
  if v_role is null or v_role not in ('student', 'teacher', 'admin') then
    raise exception using errcode = '42501', message = 'STUDENT_REQUIRED';
  end if;
  if not public.practice_entitlement_enforcement_enabled() then
    return jsonb_build_object('ensured', false, 'enforcementEnabled', false);
  end if;
  if v_role in ('teacher', 'admin') then
    return jsonb_build_object('ensured', false, 'enforcementEnabled', true);
  end if;

  select attempt.* into v_attempt
  from public.writing_attempts attempt
  where attempt.attempt_id = p_attempt_id
    and attempt.user_id = v_user_id
    and attempt.attempt_kind = 'original'
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'WRITING_ATTEMPT_NOT_FOUND';
  end if;

  if v_attempt.assignment_id is not null then
    select assignment.* into v_assignment
    from public.writing_assignments assignment
    where assignment.assignment_id = v_attempt.assignment_id;
    if not found then
      return jsonb_build_object('ensured', false, 'enforcementEnabled', true, 'assignmentAvailable', false);
    end if;
    if v_assignment.question_source = 'custom' then
      return jsonb_build_object('ensured', false, 'enforcementEnabled', true, 'custom', true);
    end if;
    if v_assignment.status <> 'active' or v_assignment.deleted_at is not null then
      return jsonb_build_object('ensured', false, 'enforcementEnabled', true, 'assignmentAvailable', false);
    end if;
  end if;

  v_item_id := public.practice_entitlement_resolve_item(
    v_attempt.task_type, null, v_attempt.question_id, null
  );
  if v_item_id is null then
    return jsonb_build_object(
      'ensured', false, 'enforcementEnabled', true,
      'itemId', null, 'taskType', v_attempt.task_type
    );
  end if;

  if v_attempt.assignment_id is not null then
    if not public.practice_entitlement_assignment_grants(
      v_attempt.assignment_id, v_user_id, v_attempt.task_type, v_item_id, v_attempt.question_id
    ) then
      return jsonb_build_object('ensured', false, 'enforcementEnabled', true, 'assignmentAvailable', false);
    end if;
    perform public.practice_entitlement_ensure_unlock(
      v_user_id, v_attempt.task_type, v_item_id,
      'assignment', v_attempt.assignment_id, v_attempt.attempt_id::text
    );
  else
    perform public.practice_entitlement_ensure_unlock(
      v_user_id, v_attempt.task_type, v_item_id,
      'resume', null, v_attempt.attempt_id::text
    );
  end if;

  return jsonb_build_object(
    'ensured', true,
    'enforcementEnabled', true,
    'itemId', v_item_id,
    'taskType', v_attempt.task_type
  );
end;
$$;

revoke all on function public.student_ensure_writing_practice_unlock(uuid)
  from public, anon, authenticated;
grant execute on function public.student_ensure_writing_practice_unlock(uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Database write guards
-- ---------------------------------------------------------------------------
create or replace function public.practice_entitlement_writing_attempt_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_enforcement boolean;
  v_assignment public.writing_assignments%rowtype;
  v_item_id text;
begin
  v_enforcement := public.practice_entitlement_enforcement_enabled();
  if not v_enforcement then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if old.attempt_kind <> 'original' then
      return new;
    end if;
    if auth.uid() is not null and old.user_id <> auth.uid() then
      raise exception using errcode = '42501', message = 'WRITING_ATTEMPT_ACTOR_MISMATCH';
    end if;
    if new.user_id is distinct from old.user_id
       or new.task_type is distinct from old.task_type
       or new.question_id is distinct from old.question_id
       or new.assignment_id is distinct from old.assignment_id
       or new.attempt_kind is distinct from old.attempt_kind then
      raise exception 'WRITING_ATTEMPT_IDENTITY_IMMUTABLE';
    end if;
    if old.status = 'submitted' and new.status = 'draft' then
      raise exception 'WRITING_ATTEMPT_STATUS_IMMUTABLE';
    end if;
    return new;
  end if;

  if new.attempt_kind <> 'original' then
    return new;
  end if;
  if auth.uid() is not null and new.user_id <> auth.uid() then
    raise exception using errcode = '42501', message = 'WRITING_ATTEMPT_ACTOR_MISMATCH';
  end if;
  select profile.role::text into v_role
  from public.profiles profile
  where profile.id = new.user_id and profile.is_active;
  if v_role is null then
    raise exception using errcode = '42501', message = 'STUDENT_REQUIRED';
  end if;
  if v_role in ('teacher', 'admin') then
    return new;
  end if;
  if v_role <> 'student' then
    raise exception using errcode = '42501', message = 'STUDENT_REQUIRED';
  end if;
  if new.task_type not in ('email', 'academic_discussion') then
    return new;
  end if;

  if new.assignment_id is not null then
    select assignment.* into v_assignment
    from public.writing_assignments assignment
    where assignment.assignment_id = new.assignment_id;
    if not found then
      raise exception 'WRITING_ASSIGNMENT_NOT_FOUND';
    end if;
    if v_assignment.status <> 'active' or v_assignment.deleted_at is not null then
      raise exception 'WRITING_ASSIGNMENT_NOT_ACTIVE';
    end if;
    if not exists (
      select 1 from public.writing_assignment_students membership
      where membership.assignment_id = new.assignment_id
        and membership.student_id = new.user_id
    ) then
      raise exception 'WRITING_ASSIGNMENT_NOT_ASSIGNED';
    end if;
    if v_assignment.task_type <> new.task_type then
      raise exception 'WRITING_ASSIGNMENT_IDENTITY_MISMATCH';
    end if;
    if v_assignment.question_source = 'custom' then
      return new;
    end if;
    if coalesce(
      v_assignment.question_id,
      v_assignment.question_snapshot ->> 'question_id'
    ) <> new.question_id then
      raise exception 'WRITING_ASSIGNMENT_IDENTITY_MISMATCH';
    end if;

    v_item_id := public.practice_entitlement_resolve_item(
      new.task_type, null, new.question_id, null
    );
    if v_item_id is null then
      raise exception 'PRACTICE_ITEM_NOT_FOUND';
    end if;
    if exists (
      select 1 from public.student_practice_unlocks unlock
      where unlock.student_id = new.user_id
        and unlock.task_type = new.task_type
        and unlock.item_id = v_item_id
    ) then
      return new;
    end if;
    if public.practice_entitlement_has_prior_attempt(
      new.user_id, new.task_type, v_item_id, new.question_id
    ) then
      perform public.practice_entitlement_ensure_unlock(
        new.user_id, new.task_type, v_item_id,
        'historical_attempt', new.assignment_id, null
      );
    else
      perform public.practice_entitlement_ensure_unlock(
        new.user_id, new.task_type, v_item_id,
        'assignment', new.assignment_id, null
      );
    end if;
    return new;
  end if;

  v_item_id := public.practice_entitlement_resolve_item(
    new.task_type, null, new.question_id, null
  );
  if v_item_id is null then
    raise exception 'PRACTICE_ITEM_NOT_FOUND';
  end if;
  if exists (
    select 1 from public.student_practice_unlocks unlock
    where unlock.student_id = new.user_id
      and unlock.task_type = new.task_type
      and unlock.item_id = v_item_id
  ) then
    return new;
  end if;
  if public.practice_entitlement_has_prior_attempt(
    new.user_id, new.task_type, v_item_id, new.question_id
  ) then
    perform public.practice_entitlement_ensure_unlock(
      new.user_id, new.task_type, v_item_id, 'retake', null, null
    );
  else
    perform public.practice_entitlement_spend_and_unlock(
      new.user_id, new.task_type, v_item_id, 'first_start', null, null
    );
  end if;
  return new;
end;
$$;

revoke all on function public.practice_entitlement_writing_attempt_guard()
  from public, anon, authenticated;

drop trigger if exists practice_entitlement_writing_attempt_guard on public.writing_attempts;
create trigger practice_entitlement_writing_attempt_guard
before insert or update on public.writing_attempts
for each row execute function public.practice_entitlement_writing_attempt_guard();

create or replace function public.practice_entitlement_attempt_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_set_id text;
  v_item_id text;
begin
  if not public.practice_entitlement_enforcement_enabled() then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.student_id is distinct from old.student_id
       or new.set_id is distinct from old.set_id then
      raise exception 'ATTEMPT_IDENTITY_IMMUTABLE';
    end if;
    return new;
  end if;

  if auth.uid() is not null and new.student_id <> auth.uid() then
    raise exception using errcode = '42501', message = 'ATTEMPT_ACTOR_MISMATCH';
  end if;
  select profile.role::text into v_role
  from public.profiles profile
  where profile.id = new.student_id and profile.is_active;
  if v_role is null then
    raise exception using errcode = '42501', message = 'STUDENT_REQUIRED';
  end if;
  if v_role in ('teacher', 'admin') then
    return new;
  end if;
  if v_role <> 'student' then
    raise exception using errcode = '42501', message = 'STUDENT_REQUIRED';
  end if;

  v_set_id := btrim(new.set_id::text);
  if lower(v_set_id) like 'grammar-%' or lower(v_set_id) like 'wrongbook-%' then
    return new;
  end if;
  v_item_id := public.practice_entitlement_resolve_item(
    'build_sentence', v_set_id, null, null
  );
  if v_item_id is null then
    raise exception 'PRACTICE_ITEM_NOT_FOUND';
  end if;
  if not exists (
    select 1 from public.student_practice_unlocks unlock
    where unlock.student_id = new.student_id
      and unlock.task_type = 'build_sentence'
      and unlock.item_id = v_item_id
  ) then
    raise exception 'PRACTICE_ENTITLEMENT_NOT_UNLOCKED';
  end if;
  return new;
end;
$$;

revoke all on function public.practice_entitlement_attempt_guard()
  from public, anon, authenticated;

drop trigger if exists practice_entitlement_attempt_guard on public.attempts;
create trigger practice_entitlement_attempt_guard
before insert or update on public.attempts
for each row execute function public.practice_entitlement_attempt_guard();

create or replace function public.practice_entitlement_attempt_answer_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt_set_id text;
  v_attempt_student_id uuid;
begin
  if not public.practice_entitlement_enforcement_enabled() then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.attempt_id is distinct from old.attempt_id
       or new.question_id is distinct from old.question_id
       or new.student_id is distinct from old.student_id
       or new.set_id is distinct from old.set_id then
      raise exception 'ATTEMPT_ANSWER_IDENTITY_IMMUTABLE';
    end if;
    return new;
  end if;

  select attempt.set_id::text, attempt.student_id
    into v_attempt_set_id, v_attempt_student_id
  from public.attempts attempt
  where attempt.attempt_id = new.attempt_id;
  if not found then
    raise exception 'ATTEMPT_NOT_FOUND';
  end if;
  if new.student_id is distinct from v_attempt_student_id then
    raise exception using errcode = '42501', message = 'ATTEMPT_ANSWER_ACTOR_MISMATCH';
  end if;
  if auth.uid() is not null and new.student_id <> auth.uid() then
    raise exception using errcode = '42501', message = 'ATTEMPT_ANSWER_ACTOR_MISMATCH';
  end if;

  v_attempt_set_id := btrim(v_attempt_set_id);
  if lower(v_attempt_set_id) like 'grammar-%' or lower(v_attempt_set_id) like 'wrongbook-%' then
    return new;
  end if;
  if btrim(new.set_id::text) <> v_attempt_set_id then
    raise exception 'ATTEMPT_ANSWER_SET_MISMATCH';
  end if;
  if not exists (
    select 1 from public.questions question
    where question.question_id::text = new.question_id::text
      and question.set_id::text = v_attempt_set_id
  ) then
    raise exception 'PRACTICE_QUESTION_NOT_IN_SET';
  end if;
  return new;
end;
$$;

revoke all on function public.practice_entitlement_attempt_answer_guard()
  from public, anon, authenticated;

drop trigger if exists practice_entitlement_attempt_answer_guard on public.attempt_answers;
create trigger practice_entitlement_attempt_answer_guard
before insert or update on public.attempt_answers
for each row execute function public.practice_entitlement_attempt_answer_guard();

-- No Full Set, BAS Grammar Category, RAP Question Category or Wrongbook change
-- is made by this migration.

commit;
