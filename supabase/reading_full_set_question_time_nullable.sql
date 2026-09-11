-- TPS Reading Full Set result timing hotfix.
-- Run after reading_full_set_attempts.sql and its 2026-08-30 overload hotfix.
-- Existing zero values were written by the original runner without measuring a
-- question, so they are converted to NULL rather than presented as real time.

begin;

alter table public.reading_full_set_answers
  alter column question_time_seconds drop not null,
  alter column question_time_seconds drop default;

update public.reading_full_set_answers
set question_time_seconds = null
where question_time_seconds = 0;

create or replace function public.finalize_reading_full_set_module(
  p_module_attempt_id uuid,
  p_submission_reason text,
  p_submitted_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_module public.reading_full_set_module_attempts%rowtype;
  v_attempt public.reading_full_set_attempts%rowtype;
  v_attempt_id uuid;
  v_expected_points integer;
  v_persisted_points integer;
  v_correct_points integer;
begin
  if p_submission_reason not in ('manual', 'timeout') then
    raise exception using errcode = '22023', message = 'FULL_SET_INVALID_SUBMISSION_REASON';
  end if;

  select attempt_id into v_attempt_id
  from public.reading_full_set_module_attempts
  where module_attempt_id = p_module_attempt_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'FULL_SET_MODULE_NOT_FOUND';
  end if;

  select * into v_attempt
  from public.reading_full_set_attempts
  where attempt_id = v_attempt_id
  for update;

  select * into v_module
  from public.reading_full_set_module_attempts
  where module_attempt_id = p_module_attempt_id
  for update;
  if v_module.status = 'submitted' then return; end if;

  v_expected_points := case v_module.module_number when 1 then 35 else 15 end;

  insert into public.reading_full_set_answers (
    module_attempt_id, occurrence_id, logical_item_id, question_id, slot_id,
    answer_kind, student_answer, is_correct, question_time_seconds
  )
  select
    v_module.module_attempt_id,
    occurrence.occurrence_id,
    occurrence.logical_item_id,
    question.question_id,
    slot.slot_id,
    'ctw_slot',
    null,
    false,
    null
  from public.reading_source_occurrences occurrence
  join public.reading_logical_items item
    on item.logical_item_id = occurrence.logical_item_id and item.module = 'ctw'
  join public.reading_questions question
    on question.logical_item_id = occurrence.logical_item_id and question.question_type = 'ctw'
  join public.reading_ctw_slots slot on slot.question_id = question.question_id
  where public.reading_occurrence_full_set_id(occurrence.occurrence_date, occurrence.source_label) = v_attempt.full_set_id
    and occurrence.source_module = case v_module.module_number when 1 then 'm1' else 'm2' end
    and not exists (
      select 1 from public.reading_full_set_answers answer
      where answer.module_attempt_id = v_module.module_attempt_id
        and answer.question_id = question.question_id
        and answer.slot_id = slot.slot_id
    );

  insert into public.reading_full_set_answers (
    module_attempt_id, occurrence_id, logical_item_id, question_id, slot_id,
    answer_kind, student_answer, is_correct, question_time_seconds
  )
  select
    v_module.module_attempt_id,
    occurrence.occurrence_id,
    occurrence.logical_item_id,
    question.question_id,
    null,
    case question.question_type
      when 'rap_sentence_insertion' then 'insertion_anchor'
      when 'rap_sentence_selection' then 'sentence_selection'
      else 'option'
    end,
    null,
    false,
    null
  from public.reading_source_occurrences occurrence
  join public.reading_logical_items item
    on item.logical_item_id = occurrence.logical_item_id and item.module in ('rdl', 'rap')
  join public.reading_questions question on question.logical_item_id = occurrence.logical_item_id
  where public.reading_occurrence_full_set_id(occurrence.occurrence_date, occurrence.source_label) = v_attempt.full_set_id
    and occurrence.source_module = case v_module.module_number when 1 then 'm1' else 'm2' end
    and not exists (
      select 1 from public.reading_full_set_answers answer
      where answer.module_attempt_id = v_module.module_attempt_id
        and answer.question_id = question.question_id
        and answer.slot_id is null
    );

  update public.reading_full_set_answers answer
  set is_correct = case
    when answer.answer_kind = 'ctw_slot' then coalesce(
      lower(btrim(answer.student_answer)) = lower((
        select slot.missing_text
        from public.reading_ctw_slots slot
        where slot.question_id = answer.question_id and slot.slot_id = answer.slot_id
      )), false
    )
    when question.question_type in ('rdl', 'rap_multiple_choice') then coalesce(
      answer.student_answer = question.correct_option_id, false
    )
    when question.question_type = 'rap_sentence_insertion' then coalesce(
      answer.student_answer = question.correct_anchor_id, false
    )
    when question.question_type = 'rap_sentence_selection' then coalesce(
      answer.student_answer = question.correct_sentence_id, false
    )
    else false
  end
  from public.reading_questions question
  where answer.module_attempt_id = v_module.module_attempt_id
    and question.question_id = answer.question_id
    and question.logical_item_id = answer.logical_item_id;

  select count(*)::integer, count(*) filter (where is_correct)::integer
  into v_persisted_points, v_correct_points
  from public.reading_full_set_answers
  where module_attempt_id = v_module.module_attempt_id;
  if v_persisted_points <> v_expected_points then
    raise exception using errcode = '23514', message = 'FULL_SET_SCORING_CONTRACT_MISMATCH';
  end if;

  update public.reading_full_set_module_attempts
  set status = 'submitted',
      submitted_at = p_submitted_at,
      submission_reason = p_submission_reason,
      total_points = v_expected_points,
      correct_points = v_correct_points
  where module_attempt_id = v_module.module_attempt_id and status = 'active';

  if v_module.module_number = 1 then
    update public.reading_full_set_attempts
    set current_module = 2
    where attempt_id = v_attempt.attempt_id and status = 'in_progress';
  else
    update public.reading_full_set_attempts
    set status = 'completed', current_module = 2, completed_at = p_submitted_at
    where attempt_id = v_attempt.attempt_id and status = 'in_progress';
  end if;
end;
$$;

revoke all on function public.finalize_reading_full_set_module(uuid, text, timestamptz)
from public, anon, authenticated;

commit;
