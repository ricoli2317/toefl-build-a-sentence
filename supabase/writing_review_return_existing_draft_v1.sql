-- ============================================================================
-- Teacher Writing Review 退回 when the student already has a newer draft
--
-- Run this file manually in the Supabase SQL Editor BEFORE deploying the
-- matching application code. It is idempotent and only touches the writing
-- attempt/review moderation domain.
--
-- Existing semantics stay unchanged:
--   * A normal 退回 turns the submitted attempt back into the student's draft
--     (status 'submitted' -> 'draft', submitted_at cleared). No new attempt,
--     copy or history row is created, and the one-draft unique indexes still
--     decide the race.
--
-- The missing case:
--   * The student submitted, then clicked 重新练习 and already owns a newer
--     draft for the same question/assignment. The old submission cannot become
--     a second draft. Previously the RPC skipped it with 'draft_exists', so the
--     teacher could confirm 退回 forever while the row stayed in 待批改.
--   * Now the newer draft is kept untouched and the old submission is archived
--     as status 'returned'. Both rows stay in the database and the submitted
--     timestamp is preserved for audit/history; nothing is deleted and the
--     unique draft index is never bypassed.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. writing_attempts.status gains the terminal 'returned' state. It is only
--    used when a newer active draft already exists.
-- ----------------------------------------------------------------------------
alter table public.writing_attempts
  drop constraint if exists writing_attempts_status_check;

alter table public.writing_attempts
  add constraint writing_attempts_status_check
  check (status = any (array['draft'::text, 'submitted'::text, 'returned'::text]));

-- The existing writing_attempts_correction_shape_check is deliberately left
-- untouched: its original-attempt branch does not constrain status, so the new
-- 'returned' value passes there, while its correction branch still only allows
-- 'draft'/'submitted'. Corrections therefore keep the existing conflict skip.

-- ----------------------------------------------------------------------------
-- 2. Batch 退回/忽略 transaction.
--
--    Eligibility is still re-validated per attempt under a row lock at request
--    time (待批改 = status 'submitted' and no writing_reviews row).
--
--    退回:
--      * No newer draft: submitted -> draft, submitted_at cleared, exam timer
--        restarted. The student keeps the full text and accumulated practice
--        elapsed_seconds. No new attempt/copy is created.
--      * A newer draft already exists (or wins a concurrent race): submitted ->
--        returned. The newer draft is not modified or deleted, and the archived
--        row keeps its submitted_at. The one-draft unique indexes remain the
--        final concurrency authority; a competing student draft insert either
--        loses to the normal draft return or wins and triggers this archive.
--
--    忽略: unchanged (empty 'ignored' review placeholder).
--
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
  v_mutated integer;
  v_constraint text;
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
      begin
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
      exception when unique_violation then
        get stacked diagnostics v_constraint = constraint_name;

        -- A newer original draft already exists for the same question or
        -- assignment. Archive this older submission instead of deleting
        -- anything or touching the student's current draft.
        if v_attempt.attempt_kind = 'original'
          and v_constraint in (
            'writing_attempts_one_draft_per_question',
            'writing_attempts_one_assignment_draft'
          ) then
          begin
            update public.writing_attempts wa
               set status = 'returned'
             where wa.attempt_id = v_id
               and wa.status = 'submitted';

            get diagnostics v_mutated = row_count;
          exception when check_violation then
            -- Safety net for an application deploy that reaches this RPC
            -- before the status constraint migration: report the existing
            -- conflict explicitly instead of failing the whole batch.
            reason := 'draft_exists';
            return next;
            continue;
          end;

          if v_mutated = 1 then
            outcome := 'returned';
            reason := null;
          else
            reason := 'not_submitted';
          end if;
          return next;
          continue;
        end if;

        -- Correction drafts keep the existing explicit conflict result.
        if v_attempt.attempt_kind = 'correction'
          and v_constraint = 'writing_attempts_one_correction_draft' then
          reason := 'draft_exists';
          return next;
          continue;
        end if;

        raise;
      end;

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
