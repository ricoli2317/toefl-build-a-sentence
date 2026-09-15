-- TPS Reading Full Set: module-scoped navigation cursor persistence.
-- Run once after reading_full_set_preparing_load_lease_20260914.sql.
-- This migration does not modify answers, scoring, Reading content, or deadlines.

begin;

alter table public.reading_full_set_module_attempts
  add column if not exists current_occurrence_id text,
  add column if not exists current_question_index integer,
  add column if not exists cursor_revision bigint not null default 0;

alter table public.reading_full_set_module_attempts
  drop constraint if exists reading_full_set_module_cursor_shape,
  drop constraint if exists reading_full_set_module_cursor_revision_check;
alter table public.reading_full_set_module_attempts
  add constraint reading_full_set_module_cursor_shape check (
    (current_occurrence_id is null) = (current_question_index is null)
    and (current_question_index is null or current_question_index >= 0)
  ),
  add constraint reading_full_set_module_cursor_revision_check
    check (cursor_revision >= 0);

comment on column public.reading_full_set_module_attempts.current_occurrence_id is
  'Latest durable navigation occurrence for this Module attempt; never answer or scoring data.';
comment on column public.reading_full_set_module_attempts.current_question_index is
  'Zero-based workspace question position inside current_occurrence_id. CTW always uses zero.';
comment on column public.reading_full_set_module_attempts.cursor_revision is
  'Monotonic client cursor revision. A lower or equal revision can never replace a newer cursor.';

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

create or replace function public.update_reading_full_set_navigation_cursor(
  p_attempt_id uuid,
  p_module_number smallint,
  p_occurrence_id text,
  p_question_index integer,
  p_cursor_revision bigint
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
  v_occurrence public.reading_source_occurrences%rowtype;
  v_item public.reading_logical_items%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_module_number not in (1, 2)
    or nullif(btrim(p_occurrence_id), '') is null
    or p_question_index is null
    or p_question_index < 0
    or p_cursor_revision is null
    or p_cursor_revision < 1
  then
    raise exception using errcode = '22023', message = 'FULL_SET_INVALID_CURSOR';
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
  where attempt_id = p_attempt_id and module_number = p_module_number
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'FULL_SET_MODULE_NOT_FOUND';
  end if;

  if v_attempt.status <> 'in_progress' or v_module.status <> 'active'
  then
    return jsonb_build_object(
      'accepted', false,
      'reason', 'locked',
      'cursorRevision', v_module.cursor_revision
    );
  end if;
  if v_module.deadline_at is null or v_module.deadline_at <= v_now then
    return jsonb_build_object(
      'accepted', false,
      'reason', 'timed_out',
      'cursorRevision', v_module.cursor_revision
    );
  end if;

  select occurrence.* into v_occurrence
  from public.reading_source_occurrences occurrence
    where occurrence.occurrence_id = p_occurrence_id
      and public.reading_occurrence_full_set_id(
        occurrence.occurrence_date,
        occurrence.source_label
      ) = v_attempt.full_set_id
      and occurrence.source_module = case p_module_number when 1 then 'm1' else 'm2' end;
  if not found then
    raise exception using errcode = '22023', message = 'FULL_SET_INVALID_CURSOR_OCCURRENCE';
  end if;

  select * into v_item
  from public.reading_logical_items
  where logical_item_id = v_occurrence.logical_item_id;
  if not found
    or (v_item.module = 'ctw' and p_question_index <> 0)
    or (v_item.module <> 'ctw' and p_question_index >= v_item.question_count)
  then
    raise exception using errcode = '22023', message = 'FULL_SET_INVALID_CURSOR_QUESTION';
  end if;

  if p_cursor_revision <= v_module.cursor_revision then
    return jsonb_build_object(
      'accepted', false,
      'reason', 'stale_revision',
      'cursorRevision', v_module.cursor_revision
    );
  end if;

  update public.reading_full_set_module_attempts
  set current_occurrence_id = p_occurrence_id,
      current_question_index = p_question_index,
      cursor_revision = p_cursor_revision
  where module_attempt_id = v_module.module_attempt_id;

  return jsonb_build_object(
    'accepted', true,
    'cursorRevision', p_cursor_revision
  );
end;
$$;

revoke all on function public.update_reading_full_set_navigation_cursor(uuid, smallint, text, integer, bigint)
  from public, anon;
grant execute on function public.update_reading_full_set_navigation_cursor(uuid, smallint, text, integer, bigint)
  to authenticated;

commit;
