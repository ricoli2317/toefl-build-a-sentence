-- ============================================================================
-- Teacher Writing Review 退回: allow the trusted service-role moderation path
-- through the writing attempt entitlement guard
--
-- Run this file manually in the Supabase SQL Editor AFTER
-- writing_review_return_existing_draft_v1.sql and BEFORE testing 退回.
-- It is idempotent.
--
-- Root cause fixed here:
--   practice_entitlement_writing_attempt_guard() blocks every
--   submitted -> draft transition while entitlement enforcement is enabled:
--
--     if old.status = 'submitted' and new.status = 'draft' then
--       raise exception 'WRITING_ATTEMPT_STATUS_IMMUTABLE';
--     end if;
--
--   The teacher moderation RPC is a SECURITY DEFINER function called with the
--   service role key, so it hits that exception before it can either perform a
--   normal return or reach its newer-draft conflict branch. The result is a
--   generic 500 and the attempt stays 'submitted'.
--
--   The guard still blocks students (authenticated) and anon. Only the
--   service-role server path is allowed to move a submitted attempt back to
--   draft. No student-facing write path is relaxed.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. Same guard and same row identity/ownership checks; only the
--    submitted -> draft rule gains a service-role exception.
-- ----------------------------------------------------------------------------
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
    -- Both teacher return transitions (submitted -> draft / returned) are
    -- server-only.  RLS is not the sole protection against a student setting
    -- the terminal returned status directly.
    if old.status = 'submitted' and new.status in ('draft', 'returned')
       and coalesce(auth.role(), '') <> 'service_role' then
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

-- Keep the trigger attached to the replaced function (idempotent).
drop trigger if exists practice_entitlement_writing_attempt_guard on public.writing_attempts;
create trigger practice_entitlement_writing_attempt_guard
before insert or update on public.writing_attempts
for each row execute function public.practice_entitlement_writing_attempt_guard();

-- ----------------------------------------------------------------------------
-- 2. Keep the archived 'returned' row out of the current/latest state. It is
--    audit history only; the student's newer draft remains the resume target.
--    Everything else in the rebuild is unchanged.
-- ----------------------------------------------------------------------------
create or replace function public.rebuild_student_practice_item_state_writing(
  p_student_id uuid,
  p_task_type text,
  p_item_id uuid
)
returns void
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_count integer := 0;
  v_latest uuid;
  v_last_started_at timestamptz;
  v_last_completed_at timestamptz;
  v_resume uuid;
  v_resume_question_id text;
  v_completed uuid;
begin
  if p_student_id is null or p_item_id is null then return; end if;
  if p_task_type not in ('email', 'academic_discussion') then return; end if;
  if not public.practice_item_is_public(p_item_id, p_task_type) then
    delete from public.student_practice_item_state
    where student_id = p_student_id and task_type = p_task_type and item_id = p_item_id::text;
    return;
  end if;

  select count(*), max(coalesce(attempt.started_at, attempt.created_at)),
    max(attempt.submitted_at) filter (where attempt.status = 'submitted')
  into v_count, v_last_started_at, v_last_completed_at
  from public.writing_attempts attempt
  where attempt.user_id = p_student_id and attempt.task_type = p_task_type
    and attempt.assignment_id is null and attempt.attempt_kind = 'original'
    and public.writing_attempt_matches_item(attempt.question_id, p_item_id, p_task_type);
  if v_count = 0 then
    delete from public.student_practice_item_state
    where student_id = p_student_id and task_type = p_task_type and item_id = p_item_id::text;
    return;
  end if;

  select attempt.attempt_id, attempt.question_id into v_resume, v_resume_question_id
  from public.writing_attempts attempt
  where attempt.user_id = p_student_id and attempt.task_type = p_task_type
    and attempt.assignment_id is null and attempt.attempt_kind = 'original'
    and attempt.status = 'draft'
    and public.writing_attempt_matches_item(attempt.question_id, p_item_id, p_task_type)
  order by coalesce(attempt.updated_at, attempt.saved_at, attempt.created_at) desc,
    attempt.attempt_id desc limit 1;

  select attempt.attempt_id into v_completed
  from public.writing_attempts attempt
  where attempt.user_id = p_student_id and attempt.task_type = p_task_type
    and attempt.assignment_id is null and attempt.attempt_kind = 'original'
    and attempt.status = 'submitted'
    and public.writing_attempt_matches_item(attempt.question_id, p_item_id, p_task_type)
  order by attempt.submitted_at desc nulls last, attempt.attempt_id desc limit 1;

  select attempt.attempt_id into v_latest
  from public.writing_attempts attempt
  where attempt.user_id = p_student_id and attempt.task_type = p_task_type
    and attempt.assignment_id is null and attempt.attempt_kind = 'original'
    and attempt.status <> 'returned'
    and public.writing_attempt_matches_item(attempt.question_id, p_item_id, p_task_type)
  order by (case when attempt.status = 'submitted'
      then coalesce(attempt.submitted_at, attempt.updated_at, attempt.created_at)
      else coalesce(attempt.updated_at, attempt.saved_at, attempt.created_at)
    end) desc, attempt.attempt_id desc limit 1;

  -- Only archived returned attempts remain: retain the audit rows in
  -- writing_attempts but do not mark this item as completed with no active
  -- or completed attempt.
  if v_latest is null then
    delete from public.student_practice_item_state
    where student_id = p_student_id and task_type = p_task_type and item_id = p_item_id::text;
    return;
  end if;

  insert into public.student_practice_item_state (
    student_id, task_type, item_id, status, resume_attempt_id, resume_source_question_id,
    latest_attempt_id, latest_completed_attempt_id, attempt_count,
    last_started_at, last_completed_at, latest_result, updated_at
  ) values (
    p_student_id, p_task_type, p_item_id::text,
    case when v_resume is not null then 'in_progress' else 'completed' end,
    v_resume, case when v_resume is not null then v_resume_question_id else null end,
    v_latest, v_completed, v_count, v_last_started_at, v_last_completed_at, null, clock_timestamp()
  ) on conflict (student_id, task_type, item_id) do update
  set status = excluded.status,
    resume_attempt_id = excluded.resume_attempt_id,
    resume_source_question_id = excluded.resume_source_question_id,
    latest_attempt_id = excluded.latest_attempt_id,
    latest_completed_attempt_id = excluded.latest_completed_attempt_id,
    attempt_count = excluded.attempt_count,
    last_started_at = excluded.last_started_at,
    last_completed_at = excluded.last_completed_at,
    latest_result = excluded.latest_result, updated_at = excluded.updated_at;
end;
$$;

commit;
