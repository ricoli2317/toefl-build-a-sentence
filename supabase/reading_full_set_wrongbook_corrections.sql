-- Minimal extension for one scoped correction attempt per submitted Reading Full Set.
-- Run after reading_wrongbook_corrections.sql and reading_full_set_attempts.sql.

alter table public.reading_wrongbook_attempts
  alter column logical_item_id drop not null;

alter table public.reading_wrongbook_attempts
  drop constraint if exists reading_wrongbook_attempts_task_type_check;
alter table public.reading_wrongbook_attempts
  add constraint reading_wrongbook_attempts_task_type_check
  check (task_type in ('ctw', 'rdl', 'rap', 'full_set'));

alter table public.reading_wrongbook_attempts
  add column if not exists source_full_set_id text,
  add column if not exists source_attempt_id uuid references public.reading_full_set_attempts(attempt_id) on delete restrict;

alter table public.reading_wrongbook_attempts
  drop constraint if exists reading_wrongbook_attempt_source_shape_check;
alter table public.reading_wrongbook_attempts
  add constraint reading_wrongbook_attempt_source_shape_check check (
    (task_type = 'full_set' and logical_item_id is null and source_full_set_id is not null and source_attempt_id is not null)
    or (task_type <> 'full_set' and logical_item_id is not null and source_full_set_id is null and source_attempt_id is null)
  );

alter table public.reading_wrongbook_attempt_answers
  add column if not exists source_occurrence_id text references public.reading_source_occurrences(occurrence_id) on delete restrict;

drop index if exists public.reading_wrongbook_answers_slot_identity;
drop index if exists public.reading_wrongbook_answers_question_identity;
create unique index reading_wrongbook_answers_slot_identity
  on public.reading_wrongbook_attempt_answers(attempt_id, question_id, slot_id)
  where slot_id is not null and source_occurrence_id is null;
create unique index reading_wrongbook_answers_question_identity
  on public.reading_wrongbook_attempt_answers(attempt_id, question_id)
  where slot_id is null and source_occurrence_id is null;
create unique index if not exists reading_full_set_wrongbook_answers_slot_identity
  on public.reading_wrongbook_attempt_answers(attempt_id, source_occurrence_id, question_id, slot_id)
  where slot_id is not null and source_occurrence_id is not null;
create unique index if not exists reading_full_set_wrongbook_answers_question_identity
  on public.reading_wrongbook_attempt_answers(attempt_id, source_occurrence_id, question_id)
  where slot_id is null and source_occurrence_id is not null;

create unique index if not exists reading_wrongbook_one_draft_per_full_set_attempt
  on public.reading_wrongbook_attempts(student_id, source_attempt_id, scope)
  where status = 'draft' and task_type = 'full_set';

create or replace function public.reading_wrongbook_attempt_result_json(p_attempt_id uuid)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'attemptId', attempt.attempt_id,
    'logicalItemId', attempt.logical_item_id,
    'taskType', attempt.task_type,
    'scope', attempt.scope,
    'sourceFullSetId', attempt.source_full_set_id,
    'sourceAttemptId', attempt.source_attempt_id,
    'status', attempt.status,
    'targets', attempt.targets,
    'elapsedSeconds', attempt.elapsed_seconds,
    'startedAt', attempt.started_at,
    'submittedAt', attempt.submitted_at,
    'totalPoints', attempt.total_points,
    'correctPoints', attempt.correct_points,
    'incorrectPoints', coalesce(counts.incorrect_points, 0),
    'unansweredPoints', coalesce(counts.unanswered_points, 0)
  )
  from public.reading_wrongbook_attempts attempt
  left join lateral (
    select
      count(*) filter (where not answer.is_correct and nullif(btrim(coalesce(answer.student_answer, '')), '') is not null)::integer incorrect_points,
      count(*) filter (where nullif(btrim(coalesce(answer.student_answer, '')), '') is null)::integer unanswered_points
    from public.reading_wrongbook_attempt_answers answer
    where answer.attempt_id = attempt.attempt_id
  ) counts on true
  where attempt.attempt_id = p_attempt_id;
$$;

create or replace function public.get_or_create_reading_full_set_wrongbook_attempt(
  p_source_attempt_id uuid,
  p_full_set_id text,
  p_scope text,
  p_targets jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_attempt_id uuid;
  v_created boolean := false;
  v_result jsonb;
begin
  if v_user_id is null or not exists (
    select 1 from public.profiles profile
    where profile.id = v_user_id and profile.is_active and profile.role::text in ('student', 'admin')
  ) then
    raise exception using errcode = '42501', message = 'READING_STUDENT_REQUIRED';
  end if;
  if p_scope is null or p_scope not in ('today', 'history') or p_targets is null
    or jsonb_typeof(p_targets) <> 'array' or jsonb_array_length(p_targets) not between 1 and 500
    or not exists (
      select 1 from public.reading_full_set_attempts source_attempt
      where source_attempt.attempt_id = p_source_attempt_id
        and source_attempt.student_id = v_user_id
        and source_attempt.full_set_id = p_full_set_id
        and source_attempt.status = 'completed'
    )
  then
    raise exception using errcode = '22023', message = 'READING_INVALID_FULL_SET_WRONGBOOK_SOURCE';
  end if;

  if exists (
    with targets as (
      select
        entry ->> 'occurrenceId' occurrence_id,
        entry ->> 'logicalItemId' logical_item_id,
        entry ->> 'questionId' question_id,
        nullif(entry ->> 'slotId', '') slot_id,
        entry ->> 'taskType' task_type
      from jsonb_array_elements(p_targets) entry
    )
    select 1 from targets target
    where not exists (
      select 1
      from public.reading_full_set_answers source_answer
      join public.reading_full_set_module_attempts module_attempt
        on module_attempt.module_attempt_id = source_answer.module_attempt_id
      join public.reading_source_occurrences occurrence
        on occurrence.occurrence_id = source_answer.occurrence_id
      join public.reading_logical_items item
        on item.logical_item_id = source_answer.logical_item_id
      where module_attempt.attempt_id = p_source_attempt_id
        and source_answer.occurrence_id = target.occurrence_id
        and source_answer.logical_item_id = target.logical_item_id
        and source_answer.question_id = target.question_id
        and source_answer.slot_id is not distinct from target.slot_id
        and source_answer.is_correct = false
        and item.module = target.task_type
    )
  ) or exists (
    select 1 from jsonb_array_elements(p_targets) entry
    group by entry ->> 'occurrenceId', entry ->> 'logicalItemId', entry ->> 'questionId', coalesce(entry ->> 'slotId', '')
    having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'READING_INVALID_WRONGBOOK_TARGETS';
  end if;

  select attempt.attempt_id into v_attempt_id
  from public.reading_wrongbook_attempts attempt
  where attempt.student_id = v_user_id and attempt.source_attempt_id = p_source_attempt_id
    and attempt.scope = p_scope and attempt.task_type = 'full_set' and attempt.status = 'draft'
  order by attempt.created_at desc limit 1;

  if v_attempt_id is null then
    insert into public.reading_wrongbook_attempts (
      student_id, logical_item_id, task_type, scope, targets, source_full_set_id, source_attempt_id
    ) values (
      v_user_id, null, 'full_set', p_scope, p_targets, p_full_set_id, p_source_attempt_id
    )
    on conflict (student_id, source_attempt_id, scope)
      where status = 'draft' and task_type = 'full_set'
    do nothing returning attempt_id into v_attempt_id;
    v_created := v_attempt_id is not null;
  end if;

  if v_attempt_id is null then
    select attempt.attempt_id into v_attempt_id
    from public.reading_wrongbook_attempts attempt
    where attempt.student_id = v_user_id and attempt.source_attempt_id = p_source_attempt_id
      and attempt.scope = p_scope and attempt.task_type = 'full_set' and attempt.status = 'draft'
    order by attempt.created_at desc limit 1;
  end if;

  update public.reading_wrongbook_attempts set targets = p_targets
  where attempt_id = v_attempt_id and status = 'draft';
  select public.reading_wrongbook_attempt_result_json(v_attempt_id) into v_result;
  return v_result || jsonb_build_object('created', v_created, 'resumed', not v_created);
end;
$$;

create or replace function public.submit_reading_full_set_wrongbook_attempt(
  p_attempt_id uuid,
  p_source_attempt_id uuid,
  p_full_set_id text,
  p_elapsed_seconds integer,
  p_answers jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_attempt public.reading_wrongbook_attempts%rowtype;
  v_expected_points integer;
  v_correct_points integer;
  v_result jsonb;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'READING_STUDENT_REQUIRED';
  end if;
  if p_elapsed_seconds is null or p_elapsed_seconds not between 0 and 604800
    or p_answers is null or jsonb_typeof(p_answers) <> 'array'
  then
    raise exception using errcode = '22023', message = 'READING_INVALID_SUBMISSION';
  end if;

  select attempt.* into v_attempt from public.reading_wrongbook_attempts attempt
  where attempt.attempt_id = p_attempt_id and attempt.student_id = v_user_id
    and attempt.task_type = 'full_set' and attempt.source_attempt_id = p_source_attempt_id
    and attempt.source_full_set_id = p_full_set_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'READING_ATTEMPT_NOT_FOUND';
  end if;
  if v_attempt.status = 'submitted' then
    return public.reading_wrongbook_attempt_result_json(v_attempt.attempt_id) || jsonb_build_object('alreadySubmitted', true);
  end if;

  v_expected_points := jsonb_array_length(v_attempt.targets);
  if jsonb_array_length(p_answers) <> v_expected_points or exists (
    with targets as (
      select entry ->> 'occurrenceId' occurrence_id, entry ->> 'logicalItemId' logical_item_id,
        entry ->> 'questionId' question_id, nullif(entry ->> 'slotId', '') slot_id
      from jsonb_array_elements(v_attempt.targets) entry
    ), submitted as (
      select entry ->> 'occurrenceId' occurrence_id, entry ->> 'logicalItemId' logical_item_id,
        entry ->> 'questionId' question_id, nullif(entry ->> 'slotId', '') slot_id,
        entry ->> 'kind' kind, entry -> 'studentAnswer' student_answer,
        entry ->> 'questionTimeSeconds' question_time
      from jsonb_array_elements(p_answers) entry
    )
    select 1 from targets target
    left join submitted answer on answer.occurrence_id = target.occurrence_id
      and answer.logical_item_id = target.logical_item_id and answer.question_id = target.question_id
      and answer.slot_id is not distinct from target.slot_id
    join public.reading_questions question on question.question_id = target.question_id
      and question.logical_item_id = target.logical_item_id
    where answer.question_id is null or answer.student_answer is null
      or jsonb_typeof(answer.student_answer) not in ('string', 'null')
      or answer.question_time is null or answer.question_time !~ '^[0-9]{1,6}$'
      or answer.question_time::integer not between 0 and 604800
      or answer.kind <> case question.question_type
        when 'ctw' then 'ctw_slot'
        when 'rap_sentence_insertion' then 'insertion_anchor'
        when 'rap_sentence_selection' then 'sentence_selection'
        else 'option'
      end
  ) or exists (
    select 1 from jsonb_array_elements(p_answers) entry
    group by entry ->> 'occurrenceId', entry ->> 'logicalItemId', entry ->> 'questionId', coalesce(entry ->> 'slotId', '')
    having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'READING_INVALID_SUBMISSION';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_answers) entry
    join public.reading_questions question on question.question_id = entry ->> 'questionId'
      and question.logical_item_id = entry ->> 'logicalItemId'
    where nullif(entry ->> 'studentAnswer', '') is not null and (
      (question.question_type in ('rdl', 'rap_multiple_choice') and not exists (
        select 1 from public.reading_question_options option_row
        where option_row.question_id = question.question_id and option_row.option_id = entry ->> 'studentAnswer'
      )) or (question.question_type = 'rap_sentence_insertion' and not exists (
        select 1 from public.reading_rap_insertion_anchors anchor
        where anchor.question_id = question.question_id and anchor.anchor_id = entry ->> 'studentAnswer'
      )) or (question.question_type = 'rap_sentence_selection' and not exists (
        select 1 from public.reading_passage_sentences sentence
        where sentence.passage_id = question.passage_id and sentence.paragraph_id = question.target_paragraph_id
          and sentence.sentence_id = entry ->> 'studentAnswer'
      ))
    )
  ) then
    raise exception using errcode = '22023', message = 'READING_ANSWER_ID_NOT_IN_ITEM';
  end if;

  insert into public.reading_wrongbook_attempt_answers (
    attempt_id, logical_item_id, question_id, slot_id, answer_kind, student_answer,
    is_correct, question_time_seconds, source_occurrence_id
  )
  select v_attempt.attempt_id, target.logical_item_id, question.question_id, target.slot_id,
    submitted.kind, nullif(submitted.student_answer, ''),
    case question.question_type
      when 'ctw' then lower(btrim(coalesce(submitted.student_answer, ''))) = lower(slot.missing_text)
      when 'rdl' then submitted.student_answer = question.correct_option_id
      when 'rap_multiple_choice' then submitted.student_answer = question.correct_option_id
      when 'rap_sentence_insertion' then submitted.student_answer = question.correct_anchor_id
      when 'rap_sentence_selection' then submitted.student_answer = question.correct_sentence_id
      else false
    end,
    submitted.question_time_seconds, target.occurrence_id
  from (
    select entry ->> 'occurrenceId' occurrence_id, entry ->> 'logicalItemId' logical_item_id,
      entry ->> 'questionId' question_id, nullif(entry ->> 'slotId', '') slot_id
    from jsonb_array_elements(v_attempt.targets) entry
  ) target
  join public.reading_questions question on question.question_id = target.question_id
    and question.logical_item_id = target.logical_item_id
  left join public.reading_ctw_slots slot on slot.question_id = target.question_id and slot.slot_id = target.slot_id
  join lateral (
    select entry ->> 'kind' kind, entry ->> 'studentAnswer' student_answer,
      (entry ->> 'questionTimeSeconds')::integer question_time_seconds
    from jsonb_array_elements(p_answers) entry
    where entry ->> 'occurrenceId' = target.occurrence_id
      and entry ->> 'logicalItemId' = target.logical_item_id
      and entry ->> 'questionId' = target.question_id
      and nullif(entry ->> 'slotId', '') is not distinct from target.slot_id
    limit 1
  ) submitted on true;

  select count(*) filter (where answer.is_correct)::integer into v_correct_points
  from public.reading_wrongbook_attempt_answers answer where answer.attempt_id = v_attempt.attempt_id;
  update public.reading_wrongbook_attempts
  set status = 'submitted', elapsed_seconds = p_elapsed_seconds, submitted_at = now(),
    total_points = v_expected_points, correct_points = v_correct_points
  where attempt_id = v_attempt.attempt_id and status = 'draft';
  select public.reading_wrongbook_attempt_result_json(v_attempt.attempt_id) into v_result;
  return v_result || jsonb_build_object('alreadySubmitted', false);
end;
$$;

revoke all on function public.get_or_create_reading_full_set_wrongbook_attempt(uuid, text, text, jsonb) from public, anon;
revoke all on function public.submit_reading_full_set_wrongbook_attempt(uuid, uuid, text, integer, jsonb) from public, anon;
grant execute on function public.get_or_create_reading_full_set_wrongbook_attempt(uuid, text, text, jsonb) to authenticated;
grant execute on function public.submit_reading_full_set_wrongbook_attempt(uuid, uuid, text, integer, jsonb) to authenticated;
