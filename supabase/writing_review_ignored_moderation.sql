-- ============================================================================
-- Teacher Writing Review moderation: 已忽略 review state + 退回/忽略 batch RPC
--
-- Run this file manually in the Supabase SQL Editor BEFORE the application
-- code that calls moderate_teacher_writing_attempts is deployed. It is
-- idempotent and only touches the writing review moderation domain.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. writing_reviews.status gains the 已忽略 ('ignored') lifecycle state.
--    ('ignored' rows keep published_at / published_* NULL exactly like
--    'reviewing' rows.)
-- ----------------------------------------------------------------------------
alter table public.writing_reviews
  drop constraint if exists writing_reviews_status_check;

alter table public.writing_reviews
  add constraint writing_reviews_status_check
  check (status = any (array['reviewing'::text, 'published'::text, 'ignored'::text]));

alter table public.writing_reviews
  drop constraint if exists writing_reviews_publish_state_check;

alter table public.writing_reviews
  add constraint writing_reviews_publish_state_check
  check (
    (status = 'reviewing' and published_at is null)
    or (
      status = 'published'
      and published_at is not null
      and published_language_edits is not null
      and published_scores is not null
      and published_content_feedback is not null
      and published_teacher_comment is not null
    )
    or (status = 'ignored' and published_at is null)
  );

-- ----------------------------------------------------------------------------
-- 2. The review write trigger locks the attempt row FOR SHARE, so a review can
--    never be created concurrently with a 退回/忽略 transaction that holds the
--    same attempt row FOR UPDATE (the moderation RPC below). Either the review
--    commits first and the moderation skips the attempt, or the moderation
--    commits first and the review write sees the new draft state and fails.
--    Only the locking clause of the existing trigger function changes.
-- ----------------------------------------------------------------------------
create or replace function public.validate_writing_review_attempt()
returns trigger
language plpgsql
as $$
declare
  attempt_status text;
  attempt_task_type text;
begin
  select
    status,
    task_type
  into
    attempt_status,
    attempt_task_type
  from public.writing_attempts
  where writing_attempts.attempt_id = new.attempt_id
  for share;

  if not found then
    raise exception
      'writing_attempt % does not exist',
      new.attempt_id;
  end if;

  if attempt_status <> 'submitted' then
    raise exception
      'writing_review can only be created for a submitted attempt. Current status: %',
      attempt_status;
  end if;

  if attempt_task_type <> new.task_type then
    raise exception
      'task_type mismatch. writing_attempts.task_type = %, writing_reviews.task_type = %',
      attempt_task_type,
      new.task_type;
  end if;

  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 3. One batch 退回/忽略 transaction.
--
--    Eligibility is re-validated per attempt under a row lock at request time
--    (待批改 = status 'submitted' and no writing_reviews row):
--      * 退回: submitted -> draft, submitted_at cleared. The student keeps the
--        full text and accumulated 正计时 (practice) elapsed_seconds; 倒计时
--        (exam) starts again from time_limit_seconds. It never creates a new
--        attempt, a submitted copy or a returned/rejected attempt status.
--      * 忽略: the attempt stays submitted; the review lifecycle row becomes
--        'ignored' (teacher side only).
--    Skipped attempts are answered with a reason instead of being mutated.
--    Service-role only: the Next.js route authenticates the teacher and
--    re-checks the teaching scope before calling this function.
-- ----------------------------------------------------------------------------
create or replace function public.moderate_teacher_writing_attempts(
  p_action text,
  p_attempt_ids uuid[]
)
returns table (attempt_id uuid, outcome text, reason text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_attempt public.writing_attempts%rowtype;
  v_review_exists boolean;
  v_conflicting_draft_exists boolean;
  v_mutated integer;
begin
  if p_action not in ('return', 'ignore') then
    raise exception 'UNSUPPORTED_WRITING_MODERATION_ACTION: %', p_action;
  end if;

  foreach v_id in array coalesce(p_attempt_ids, '{}'::uuid[]) loop
    attempt_id := v_id;
    outcome := 'skipped';
    reason := 'not_found';

    select *
      into v_attempt
      from public.writing_attempts wa
     where wa.attempt_id = v_id
       for update;

    if not found then
      return next;
      continue;
    end if;

    if v_attempt.status <> 'submitted' then
      reason := 'not_submitted';
      return next;
      continue;
    end if;

    select exists (
      select 1
        from public.writing_reviews r
       where r.attempt_id = v_id
    )
    into v_review_exists;

    if v_review_exists then
      reason := 'already_reviewed';
      return next;
      continue;
    end if;

    if p_action = 'return' then
      -- A draft already exists for the same question/assignment (the student
      -- used 重新作答 after the submission); the partial unique indexes
      -- (writing_attempts_one_assignment_draft /
      -- writing_attempts_one_draft_per_question) forbid a second draft.
      select exists (
        select 1
          from public.writing_attempts d
         where d.status = 'draft'
           and d.user_id = v_attempt.user_id
           and d.attempt_id <> v_id
           and (
             (
               v_attempt.assignment_id is not null
               and d.assignment_id = v_attempt.assignment_id
             )
             or (
               v_attempt.assignment_id is null
               and d.assignment_id is null
               and d.task_type = v_attempt.task_type
               and d.question_id = v_attempt.question_id
             )
           )
      )
      into v_conflicting_draft_exists;

      if v_conflicting_draft_exists then
        reason := 'draft_exists';
        return next;
        continue;
      end if;

      update public.writing_attempts wa
         set status = 'draft',
             submitted_at = null,
             remaining_seconds = case
               when wa.writing_mode = 'exam' then wa.time_limit_seconds
               else wa.remaining_seconds
             end
       where wa.attempt_id = v_id
         and wa.status = 'submitted';

      get diagnostics v_mutated = row_count;
      if v_mutated <> 1 then
        reason := 'not_submitted';
        return next;
        continue;
      end if;

      outcome := 'returned';
      reason := null;
      return next;
      continue;
    end if;

    -- 忽略: an empty review placeholder. The workspace loader normalizes it
    -- into a valid empty working draft, and AI 初批 / Save / Publish all
    -- update it normally (content_feedback already carries the empty items
    -- array the regeneration merge reads).
    insert into public.writing_reviews (
      attempt_id,
      task_type,
      status,
      ai_model,
      ai_generated_at,
      ai_review_raw,
      language_edits,
      scores,
      content_feedback,
      teacher_comment
    )
    values (
      v_id,
      v_attempt.task_type,
      'ignored',
      null,
      null,
      null,
      '[]'::jsonb,
      '{}'::jsonb,
      '{"items":[],"overall_feedback":""}'::jsonb,
      ''
    )
    -- ON CONSTRAINT instead of the column list: PL/pgSQL would otherwise
    -- substitute the OUT parameter attempt_id into the index expression and
    -- raise 'column reference "attempt_id" is ambiguous' at runtime.
    on conflict on constraint writing_reviews_attempt_unique do nothing;

    get diagnostics v_mutated = row_count;
    if v_mutated <> 1 then
      reason := 'already_reviewed';
      return next;
      continue;
    end if;

    outcome := 'ignored';
    reason := null;
    return next;
    continue;
  end loop;
end;
$$;

revoke all on function public.moderate_teacher_writing_attempts(text, uuid[])
  from public, anon, authenticated;
grant execute on function public.moderate_teacher_writing_attempts(text, uuid[])
  to service_role;
