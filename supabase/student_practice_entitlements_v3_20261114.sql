-- TPS student practice entitlements V3 (phase 3: Reading Full Set).
--
-- MANUAL, additive migration. Execute after the phase-1 and phase-2 migrations.
--
-- Scope:
--   * when enforcement is ON, a Student can create a new Full Set attempt only
--     from a validated teacher Assignment, or as a Retake of an attempt that
--     already exists for that Student + Full Set;
--   * an existing in-progress attempt always resumes without a new check;
--   * when the authoritative Full Set attempt becomes completed, the trigger
--     unlocks every actual CTW/RDL/RAP logical item in that Full Set, with no
--     quota spend and no duplicate rows;
--   * the switch remains OFF. Historical completed Full Sets are handled by
--     the separate manual backfill, which can be rerun before phase 6.
--
-- Full Set content is resolved from the persisted full_set_id plus
-- reading_source_occurrences / reading_logical_items. It never infers content
-- from answers only and never treats all same-date Reading items as one set.
--
-- This migration does not modify the existing Full Set timer, loading, answer,
-- scoring, result or review engine.

begin;

-- ---------------------------------------------------------------------------
-- 0. Required phase-1/2 and Full Set shapes
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.practice_entitlement_enforcement_enabled()') is null
     or to_regprocedure('public.practice_entitlement_assignment_grants(uuid,uuid,text,text,text)') is null
     or to_regprocedure('public.practice_entitlement_current_remaining(uuid,text)') is null then
    raise exception 'TPS_ENTITLEMENTS_V3_PHASE2_FUNCTION_MISSING';
  end if;
  if to_regclass('public.student_practice_unlocks') is null
     or to_regclass('public.student_practice_entitlement_events') is null
     or to_regclass('public.practice_entitlement_runtime_config') is null then
    raise exception 'TPS_ENTITLEMENTS_V3_PHASE1_TABLE_MISSING';
  end if;
  if to_regclass('public.reading_full_set_attempts') is null
     or to_regclass('public.reading_full_set_module_attempts') is null
     or to_regclass('public.reading_source_occurrences') is null
     or to_regclass('public.reading_logical_items') is null
     or to_regclass('public.writing_assignments') is null
     or to_regclass('public.writing_assignment_students') is null then
    raise exception 'TPS_ENTITLEMENTS_V3_FULL_SET_TABLE_MISSING';
  end if;
  if to_regprocedure('public.reading_occurrence_full_set_id(date,text)') is null
     or to_regprocedure('public.reading_full_set_module_time_limit(text,smallint)') is null
     or to_regprocedure('public.reading_full_set_attempt_json(uuid)') is null
     or to_regprocedure('public.reconcile_reading_full_set_attempt(uuid)') is null then
    raise exception 'TPS_ENTITLEMENTS_V3_FULL_SET_FUNCTION_MISSING';
  end if;

  if exists (
    select 1
    from (values
      ('reading_full_set_attempts', 'attempt_id'),
      ('reading_full_set_attempts', 'student_id'),
      ('reading_full_set_attempts', 'full_set_id'),
      ('reading_full_set_attempts', 'status'),
      ('reading_full_set_attempts', 'current_module'),
      ('reading_full_set_attempts', 'completed_at'),
      ('reading_full_set_module_attempts', 'module_attempt_id'),
      ('reading_full_set_module_attempts', 'attempt_id'),
      ('reading_full_set_module_attempts', 'module_number'),
      ('reading_full_set_module_attempts', 'status'),
      ('reading_full_set_module_attempts', 'time_limit_seconds'),
      ('reading_source_occurrences', 'occurrence_id'),
      ('reading_source_occurrences', 'logical_item_id'),
      ('reading_source_occurrences', 'source_label'),
      ('reading_source_occurrences', 'occurrence_date'),
      ('reading_source_occurrences', 'source_module'),
      ('reading_logical_items', 'logical_item_id'),
      ('reading_logical_items', 'module'),
      ('writing_assignments', 'assignment_id'),
      ('writing_assignments', 'task_type'),
      ('writing_assignments', 'question_source'),
      ('writing_assignments', 'question_id'),
      ('writing_assignments', 'question_snapshot'),
      ('writing_assignments', 'status'),
      ('writing_assignments', 'deleted_at'),
      ('writing_assignment_students', 'assignment_id'),
      ('writing_assignment_students', 'student_id'),
      ('profiles', 'id'),
      ('profiles', 'role'),
      ('profiles', 'is_active')
    ) required(table_name, column_name)
    where not exists (
      select 1
      from information_schema.columns columns
      where columns.table_schema = 'public'
        and columns.table_name = required.table_name
        and columns.column_name = required.column_name
    )
  ) then
    raise exception 'TPS_ENTITLEMENTS_V3_REQUIRED_COLUMN_MISSING';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Internal Full Set item unlock helper
-- ---------------------------------------------------------------------------
-- Called by the completion trigger with events, and by the manual historical
-- backfill with p_write_events=false. It is not executable by any client role.
create or replace function public.unlock_reading_full_set_items(
  p_attempt_id uuid,
  p_write_events boolean default true
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_attempt public.reading_full_set_attempts%rowtype;
  v_role text;
  v_item record;
  v_inserted integer;
  v_total integer := 0;
  v_remaining integer;
begin
  select attempt.* into v_attempt
  from public.reading_full_set_attempts attempt
  where attempt.attempt_id = p_attempt_id
  for update;
  if not found or v_attempt.status <> 'completed' then
    return 0;
  end if;

  select profile.role::text into v_role
  from public.profiles profile
  where profile.id = v_attempt.student_id and profile.is_active;
  if v_role is distinct from 'student' then
    return 0;
  end if;

  -- The full_set_id + source occurrence identity is the same authoritative
  -- content used by Full Set scoring/finalization. DISTINCT avoids duplicate
  -- logical items; occurrences from other dates/labels never match.
  for v_item in
    select distinct item.logical_item_id, item.module
    from public.reading_source_occurrences occurrence
    join public.reading_logical_items item
      on item.logical_item_id = occurrence.logical_item_id
    where public.reading_occurrence_full_set_id(
      occurrence.occurrence_date,
      occurrence.source_label
    ) = v_attempt.full_set_id
      and occurrence.source_module in ('m1', 'm2')
      and item.module in ('ctw', 'rdl', 'rap')
    order by item.module, item.logical_item_id
  loop
    insert into public.student_practice_unlocks (
      student_id, task_type, item_id, source, source_ref
    ) values (
      v_attempt.student_id,
      v_item.module,
      v_item.logical_item_id,
      'full_set_completion',
      v_attempt.attempt_id::text
    )
    on conflict (student_id, task_type, item_id) do nothing;

    get diagnostics v_inserted = row_count;
    if v_inserted > 0 then
      v_total := v_total + 1;
      if p_write_events then
        v_remaining := public.practice_entitlement_current_remaining(
          v_attempt.student_id,
          v_item.module
        );
        insert into public.student_practice_entitlement_events (
          student_id, entitlement_kind, operation, reason,
          previous_remaining, new_remaining, actor_id,
          item_id, request_id
        ) values (
          v_attempt.student_id,
          v_item.module,
          'unlock',
          'full_set_completion',
          v_remaining,
          v_remaining,
          v_attempt.student_id,
          v_item.logical_item_id,
          v_attempt.attempt_id::text
        );
      end if;
    end if;
  end loop;

  return v_total;
end;
$$;

revoke all on function public.unlock_reading_full_set_items(uuid, boolean)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Completion trigger
-- ---------------------------------------------------------------------------
create or replace function public.practice_entitlement_full_set_completion_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status <> 'completed' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'completed' then
    return new;
  end if;
  if not public.practice_entitlement_enforcement_enabled() then
    -- Phases 3-5 keep the switch OFF. Historical/off-period completions are
    -- covered by the separate, rerunnable backfill before phase 6.
    return new;
  end if;
  perform public.unlock_reading_full_set_items(new.attempt_id, true);
  return new;
end;
$$;

revoke all on function public.practice_entitlement_full_set_completion_guard()
  from public, anon, authenticated;

drop trigger if exists practice_entitlement_full_set_completion_guard
  on public.reading_full_set_attempts;
create trigger practice_entitlement_full_set_completion_guard
after insert or update on public.reading_full_set_attempts
for each row execute function public.practice_entitlement_full_set_completion_guard();

-- ---------------------------------------------------------------------------
-- 3. Full Set creation entry point
-- ---------------------------------------------------------------------------
-- Latest Full Set creation lifecycle (preparing module 1) plus assignment /
-- historical-retake authorization. Existing active attempts always resume.
create or replace function public.get_or_create_reading_full_set_attempt_with_assignment(
  p_full_set_id text,
  p_assignment_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_attempt_id uuid;
  v_time_limit integer;
  v_created boolean := false;
  v_enforcement boolean;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'FULL_SET_STUDENT_REQUIRED';
  end if;
  select profile.role::text into v_role
  from public.profiles profile
  where profile.id = v_user_id and profile.is_active;
  if v_role is null or v_role not in ('student', 'teacher', 'admin') then
    raise exception using errcode = '42501', message = 'FULL_SET_STUDENT_REQUIRED';
  end if;

  v_time_limit := public.reading_full_set_module_time_limit(p_full_set_id, 1::smallint);
  if v_time_limit is null
     or public.reading_full_set_module_time_limit(p_full_set_id, 2::smallint) <> 540 then
    raise exception using errcode = 'P0002', message = 'FULL_SET_NOT_FOUND';
  end if;

  select attempt.attempt_id into v_attempt_id
  from public.reading_full_set_attempts attempt
  where attempt.student_id = v_user_id
    and attempt.full_set_id = p_full_set_id
    and attempt.status = 'in_progress'
  order by attempt.created_at desc
  limit 1;

  if v_attempt_id is null then
    v_enforcement := public.practice_entitlement_enforcement_enabled();
    if v_role = 'student' and v_enforcement then
      -- A completed historical/assigned attempt is an authorized Retake. This
      -- preserves existing retake behavior even if its original Assignment is
      -- later withdrawn. A first-ever attempt requires a valid Assignment.
      if exists (
        select 1
        from public.reading_full_set_attempts prior
        where prior.student_id = v_user_id
          and prior.full_set_id = p_full_set_id
      ) then
        null;
      elsif p_assignment_id is not null then
        if not public.practice_entitlement_assignment_grants(
          p_assignment_id,
          v_user_id,
          'full_set',
          p_full_set_id,
          null
        ) then
          raise exception 'FULL_SET_ASSIGNMENT_NOT_AVAILABLE';
        end if;
      else
        raise exception 'FULL_SET_ASSIGNMENT_REQUIRED';
      end if;
    end if;

    insert into public.reading_full_set_attempts (
      student_id, full_set_id, status, current_module
    ) values (
      v_user_id, p_full_set_id, 'in_progress', 1
    )
    on conflict (student_id, full_set_id) where status = 'in_progress' do nothing
    returning attempt_id into v_attempt_id;

    if v_attempt_id is not null then
      v_created := true;
      insert into public.reading_full_set_module_attempts (
        attempt_id, module_number, status, time_limit_seconds, started_at, deadline_at
      ) values (
        v_attempt_id, 1, 'preparing', v_time_limit, null, null
      );
    else
      select attempt.attempt_id into v_attempt_id
      from public.reading_full_set_attempts attempt
      where attempt.student_id = v_user_id
        and attempt.full_set_id = p_full_set_id
        and attempt.status = 'in_progress'
      order by attempt.created_at desc
      limit 1;
    end if;
  end if;

  if v_attempt_id is null then
    raise exception using errcode = 'P0002', message = 'FULL_SET_ATTEMPT_NOT_FOUND';
  end if;
  perform public.reconcile_reading_full_set_attempt(v_attempt_id);
  return public.reading_full_set_attempt_json(v_attempt_id)
    || jsonb_build_object('created', v_created);
end;
$$;

revoke all on function public.get_or_create_reading_full_set_attempt_with_assignment(text, uuid)
  from public, anon, authenticated;
grant execute on function public.get_or_create_reading_full_set_attempt_with_assignment(text, uuid)
  to authenticated;

-- Keep the existing one-argument RPC as a compatibility wrapper. A Student
-- calling it directly while enforcement is ON gets the same assignment/retake
-- checks; it cannot bypass the new authoritative entry point.
create or replace function public.get_or_create_reading_full_set_attempt(
  p_full_set_id text
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.get_or_create_reading_full_set_attempt_with_assignment(
    p_full_set_id,
    null
  );
$$;

revoke all on function public.get_or_create_reading_full_set_attempt(text)
  from public, anon, authenticated;
grant execute on function public.get_or_create_reading_full_set_attempt(text)
  to authenticated;

-- No Full Set timer, answer, scoring, result, review or content change.
-- The switch remains OFF; do not enable it in phase 3.

commit;
