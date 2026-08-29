-- TPS Reading Batch 7A: student attempts and atomic server-side scoring.
-- Run after reading_data_layer.sql. This migration does not alter Reading content.

create extension if not exists pgcrypto;

create table if not exists public.reading_attempts (
  attempt_id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  logical_item_id text not null references public.reading_logical_items(logical_item_id) on delete restrict,
  task_type text not null check (task_type in ('ctw', 'rdl', 'rap')),
  status text not null default 'draft' check (status in ('draft', 'submitted')),
  elapsed_seconds integer not null default 0 check (elapsed_seconds >= 0),
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  total_points integer not null default 0 check (total_points >= 0),
  correct_points integer not null default 0 check (correct_points >= 0 and correct_points <= total_points),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reading_attempt_status_shape_check check (
    (status = 'draft' and submitted_at is null)
    or (status = 'submitted' and submitted_at is not null)
  )
);

create table if not exists public.reading_attempt_answers (
  attempt_answer_id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.reading_attempts(attempt_id) on delete cascade,
  logical_item_id text not null,
  question_id text not null,
  slot_id text,
  answer_kind text not null check (answer_kind in (
    'ctw_slot',
    'option',
    'insertion_anchor',
    'sentence_selection'
  )),
  student_answer text,
  is_correct boolean not null,
  question_time_seconds integer constraint reading_attempt_answers_question_time_check check (
    question_time_seconds is null or question_time_seconds between 0 and 604800
  ),
  created_at timestamptz not null default now(),
  foreign key (question_id, logical_item_id)
    references public.reading_questions(question_id, logical_item_id)
    on delete restrict,
  foreign key (question_id, slot_id)
    references public.reading_ctw_slots(question_id, slot_id)
    on delete restrict,
  constraint reading_attempt_answer_shape_check check (
    (answer_kind = 'ctw_slot' and slot_id is not null)
    or (answer_kind <> 'ctw_slot' and slot_id is null)
  )
);

create unique index if not exists reading_attempts_one_draft_per_item
  on public.reading_attempts(student_id, logical_item_id, task_type)
  where status = 'draft';
create index if not exists reading_attempts_student_item_idx
  on public.reading_attempts(student_id, logical_item_id, created_at desc);
create index if not exists reading_attempts_student_submitted_idx
  on public.reading_attempts(student_id, submitted_at desc)
  where status = 'submitted';
create unique index if not exists reading_attempt_answers_slot_identity
  on public.reading_attempt_answers(attempt_id, question_id, slot_id)
  where slot_id is not null;
create unique index if not exists reading_attempt_answers_question_identity
  on public.reading_attempt_answers(attempt_id, question_id)
  where slot_id is null;
create index if not exists reading_attempt_answers_attempt_idx
  on public.reading_attempt_answers(attempt_id);

drop trigger if exists reading_attempts_set_updated_at on public.reading_attempts;
create trigger reading_attempts_set_updated_at
before update on public.reading_attempts
for each row execute function public.set_updated_at();

alter table public.reading_attempts enable row level security;
alter table public.reading_attempt_answers enable row level security;

drop policy if exists "students_select_own_reading_attempts" on public.reading_attempts;
create policy "students_select_own_reading_attempts"
on public.reading_attempts for select to authenticated
using (auth.uid() = student_id);

drop policy if exists "students_select_own_reading_attempt_answers" on public.reading_attempt_answers;
create policy "students_select_own_reading_attempt_answers"
on public.reading_attempt_answers for select to authenticated
using (
  exists (
    select 1
    from public.reading_attempts attempt
    where attempt.attempt_id = reading_attempt_answers.attempt_id
      and attempt.student_id = auth.uid()
  )
);

create or replace function public.reading_attempt_result_json(p_attempt_id uuid)
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
    'status', attempt.status,
    'elapsedSeconds', attempt.elapsed_seconds,
    'startedAt', attempt.started_at,
    'submittedAt', attempt.submitted_at,
    'totalPoints', attempt.total_points,
    'correctPoints', attempt.correct_points,
    'incorrectPoints', coalesce(answer_counts.incorrect_points, 0),
    'unansweredPoints', coalesce(answer_counts.unanswered_points, 0)
  )
  from public.reading_attempts attempt
  left join lateral (
    select
      count(*) filter (
        where not answer.is_correct
          and nullif(btrim(coalesce(answer.student_answer, '')), '') is not null
      )::integer as incorrect_points,
      count(*) filter (
        where nullif(btrim(coalesce(answer.student_answer, '')), '') is null
      )::integer as unanswered_points
    from public.reading_attempt_answers answer
    where answer.attempt_id = attempt.attempt_id
  ) answer_counts on true
  where attempt.attempt_id = p_attempt_id;
$$;

create or replace function public.get_or_create_reading_attempt(p_logical_item_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_module text;
  v_attempt_id uuid;
  v_created boolean := false;
  v_result jsonb;
begin
  if v_user_id is null or not exists (
    select 1 from public.profiles profile
    where profile.id = v_user_id
      and profile.is_active
      and profile.role::text in ('student', 'admin')
  ) then
    raise exception using errcode = '42501', message = 'READING_STUDENT_REQUIRED';
  end if;

  select item.module into v_module
  from public.reading_logical_items item
  where item.logical_item_id = p_logical_item_id;
  if v_module is null then
    raise exception using errcode = 'P0002', message = 'READING_ITEM_NOT_FOUND';
  end if;

  select attempt.attempt_id into v_attempt_id
  from public.reading_attempts attempt
  where attempt.student_id = v_user_id
    and attempt.logical_item_id = p_logical_item_id
    and attempt.task_type = v_module
  order by (attempt.status = 'draft') desc, attempt.created_at desc
  limit 1;

  if v_attempt_id is null then
    insert into public.reading_attempts (
      student_id,
      logical_item_id,
      task_type,
      status
    ) values (
      v_user_id,
      p_logical_item_id,
      v_module,
      'draft'
    )
    on conflict (student_id, logical_item_id, task_type)
      where status = 'draft'
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
    end if;
  end if;

  select public.reading_attempt_result_json(v_attempt_id) into v_result;
  return v_result || jsonb_build_object('created', v_created, 'resumed', not v_created);
end;
$$;

create or replace function public.submit_reading_attempt(
  p_attempt_id uuid,
  p_logical_item_id text,
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
  v_attempt public.reading_attempts%rowtype;
  v_expected_points integer;
  v_persisted_points integer;
  v_correct_points integer;
  v_result jsonb;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'READING_STUDENT_REQUIRED';
  end if;
  if p_elapsed_seconds is null or p_elapsed_seconds < 0 or p_elapsed_seconds > 604800 then
    raise exception using errcode = '22023', message = 'READING_INVALID_ELAPSED_SECONDS';
  end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'array' or jsonb_array_length(p_answers) > 500 then
    raise exception using errcode = '22023', message = 'READING_INVALID_SUBMISSION';
  end if;

  select attempt.* into v_attempt
  from public.reading_attempts attempt
  where attempt.attempt_id = p_attempt_id
    and attempt.student_id = v_user_id
    and attempt.logical_item_id = p_logical_item_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'READING_ATTEMPT_NOT_FOUND';
  end if;

  if v_attempt.status = 'submitted' then
    return public.reading_attempt_result_json(v_attempt.attempt_id)
      || jsonb_build_object('alreadySubmitted', true);
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_answers) entry
    where jsonb_typeof(entry) <> 'object'
      or coalesce(entry ->> 'kind', '') not in (
        'ctw_slot', 'option', 'insertion_anchor', 'sentence_selection'
      )
      or nullif(entry ->> 'questionId', '') is null
      or (
        entry ? 'studentAnswer'
        and jsonb_typeof(entry -> 'studentAnswer') not in ('string', 'null')
      )
  ) then
    raise exception using errcode = '22023', message = 'READING_INVALID_SUBMISSION';
  end if;

  if exists (
    select 1
    from (
      select
        entry ->> 'kind' as kind,
        entry ->> 'questionId' as question_id,
        coalesce(entry ->> 'slotId', '') as slot_id,
        count(*)
      from jsonb_array_elements(p_answers) entry
      group by 1, 2, 3
      having count(*) > 1
    ) duplicate
  ) then
    raise exception using errcode = '22023', message = 'READING_DUPLICATE_ANSWER_ID';
  end if;

  if exists (
    with submitted as (
      select
        entry ->> 'kind' as kind,
        entry ->> 'questionId' as question_id,
        entry ->> 'slotId' as slot_id,
        nullif(entry ->> 'studentAnswer', '') as student_answer
      from jsonb_array_elements(p_answers) entry
    )
    select 1
    from submitted
    left join public.reading_questions question
      on question.question_id = submitted.question_id
      and question.logical_item_id = v_attempt.logical_item_id
    where question.question_id is null
      or (submitted.kind = 'ctw_slot' and (
        question.question_type <> 'ctw'
        or submitted.slot_id is null
        or not exists (
          select 1 from public.reading_ctw_slots slot
          where slot.question_id = question.question_id
            and slot.slot_id = submitted.slot_id
        )
      ))
      or (submitted.kind = 'option' and (
        question.question_type not in ('rdl', 'rap_multiple_choice')
        or (submitted.student_answer is not null and not exists (
          select 1 from public.reading_question_options option_row
          where option_row.question_id = question.question_id
            and option_row.option_id = submitted.student_answer
        ))
      ))
      or (submitted.kind = 'insertion_anchor' and (
        question.question_type <> 'rap_sentence_insertion'
        or (submitted.student_answer is not null and not exists (
          select 1 from public.reading_rap_insertion_anchors anchor
          where anchor.question_id = question.question_id
            and anchor.anchor_id = submitted.student_answer
        ))
      ))
      or (submitted.kind = 'sentence_selection' and (
        question.question_type <> 'rap_sentence_selection'
        or (submitted.student_answer is not null and not exists (
          select 1 from public.reading_passage_sentences sentence
          where sentence.passage_id = question.passage_id
            and sentence.paragraph_id = question.target_paragraph_id
            and sentence.sentence_id = submitted.student_answer
        ))
      ))
  ) then
    raise exception using errcode = '22023', message = 'READING_ANSWER_ID_NOT_IN_ITEM';
  end if;

  if v_attempt.task_type = 'ctw' then
    select count(*)::integer into v_expected_points
    from public.reading_questions question
    join public.reading_ctw_slots slot on slot.question_id = question.question_id
    where question.logical_item_id = v_attempt.logical_item_id;
  else
    select count(*)::integer into v_expected_points
    from public.reading_questions question
    where question.logical_item_id = v_attempt.logical_item_id;
  end if;

  if v_expected_points = 0 or v_expected_points <> (
    select item.scored_item_count
    from public.reading_logical_items item
    where item.logical_item_id = v_attempt.logical_item_id
      and item.module = v_attempt.task_type
  ) then
    raise exception using errcode = '23514', message = 'READING_SCORING_CONTRACT_MISMATCH';
  end if;

  if v_attempt.task_type = 'ctw' then
    insert into public.reading_attempt_answers (
      attempt_id, logical_item_id, question_id, slot_id,
      answer_kind, student_answer, is_correct
    )
    select
      v_attempt.attempt_id,
      v_attempt.logical_item_id,
      question.question_id,
      slot.slot_id,
      'ctw_slot',
      submitted.student_answer,
      coalesce(
        lower(btrim(submitted.student_answer)) = lower(slot.missing_text),
        false
      )
    from public.reading_questions question
    join public.reading_ctw_slots slot on slot.question_id = question.question_id
    left join lateral (
      select nullif(entry ->> 'studentAnswer', '') as student_answer
      from jsonb_array_elements(p_answers) entry
      where entry ->> 'kind' = 'ctw_slot'
        and entry ->> 'questionId' = question.question_id
        and entry ->> 'slotId' = slot.slot_id
      limit 1
    ) submitted on true
    where question.logical_item_id = v_attempt.logical_item_id;
  else
    insert into public.reading_attempt_answers (
      attempt_id, logical_item_id, question_id, slot_id,
      answer_kind, student_answer, is_correct
    )
    select
      v_attempt.attempt_id,
      v_attempt.logical_item_id,
      question.question_id,
      null,
      case question.question_type
        when 'rap_sentence_insertion' then 'insertion_anchor'
        when 'rap_sentence_selection' then 'sentence_selection'
        else 'option'
      end,
      submitted.student_answer,
      case question.question_type
        when 'rdl' then coalesce(submitted.student_answer = question.correct_option_id, false)
        when 'rap_multiple_choice' then coalesce(submitted.student_answer = question.correct_option_id, false)
        when 'rap_sentence_insertion' then coalesce(submitted.student_answer = question.correct_anchor_id, false)
        when 'rap_sentence_selection' then coalesce(submitted.student_answer = question.correct_sentence_id, false)
        else false
      end
    from public.reading_questions question
    left join lateral (
      select nullif(entry ->> 'studentAnswer', '') as student_answer
      from jsonb_array_elements(p_answers) entry
      where entry ->> 'questionId' = question.question_id
        and entry ->> 'kind' = case question.question_type
          when 'rap_sentence_insertion' then 'insertion_anchor'
          when 'rap_sentence_selection' then 'sentence_selection'
          else 'option'
        end
      limit 1
    ) submitted on true
    where question.logical_item_id = v_attempt.logical_item_id;
  end if;

  select count(*)::integer, count(*) filter (where answer.is_correct)::integer
  into v_persisted_points, v_correct_points
  from public.reading_attempt_answers answer
  where answer.attempt_id = v_attempt.attempt_id;

  if v_persisted_points <> v_expected_points then
    raise exception using errcode = '23514', message = 'READING_ATOMIC_PERSISTENCE_MISMATCH';
  end if;

  update public.reading_attempts
  set status = 'submitted',
      elapsed_seconds = greatest(elapsed_seconds, p_elapsed_seconds),
      submitted_at = now(),
      total_points = v_expected_points,
      correct_points = v_correct_points
  where attempt_id = v_attempt.attempt_id
    and status = 'draft';

  select public.reading_attempt_result_json(v_attempt.attempt_id) into v_result;
  return v_result || jsonb_build_object('alreadySubmitted', false);
end;
$$;

create or replace function public.submit_reading_attempt_with_times(
  p_attempt_id uuid,
  p_logical_item_id text,
  p_elapsed_seconds integer,
  p_answers jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_updated integer;
begin
  if p_answers is null or jsonb_typeof(p_answers) <> 'array' then
    raise exception using errcode = '22023', message = 'READING_INVALID_SUBMISSION';
  end if;

  v_result := public.submit_reading_attempt(
    p_attempt_id,
    p_logical_item_id,
    p_elapsed_seconds,
    p_answers
  );

  if coalesce((v_result ->> 'alreadySubmitted')::boolean, false) then
    return v_result;
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_answers) entry
    where not case
      when coalesce(entry ->> 'questionTimeSeconds', '') ~ '^[0-9]{1,6}$'
        then (entry ->> 'questionTimeSeconds')::integer between 0 and 604800
      else false
    end
  ) then
    raise exception using errcode = '22023', message = 'READING_INVALID_QUESTION_TIME';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_answers) entry
    group by entry ->> 'questionId'
    having count(distinct entry ->> 'questionTimeSeconds') > 1
  ) then
    raise exception using errcode = '22023', message = 'READING_INCONSISTENT_QUESTION_TIME';
  end if;

  with submitted as (
    select
      entry ->> 'questionId' as question_id,
      nullif(entry ->> 'slotId', '') as slot_id,
      (entry ->> 'questionTimeSeconds')::integer as question_time_seconds
    from jsonb_array_elements(p_answers) entry
  )
  update public.reading_attempt_answers answer
  set question_time_seconds = submitted.question_time_seconds
  from submitted
  where answer.attempt_id = p_attempt_id
    and answer.question_id = submitted.question_id
    and answer.slot_id is not distinct from submitted.slot_id;

  get diagnostics v_updated = row_count;
  if v_updated <> coalesce((v_result ->> 'totalPoints')::integer, -1) then
    raise exception using errcode = '23514', message = 'READING_QUESTION_TIME_PERSISTENCE_MISMATCH';
  end if;

  return v_result;
end;
$$;

revoke all on function public.reading_attempt_result_json(uuid) from public, anon, authenticated;
revoke all on function public.get_or_create_reading_attempt(text) from public, anon;
revoke all on function public.submit_reading_attempt(uuid, text, integer, jsonb) from public, anon, authenticated;
revoke all on function public.submit_reading_attempt_with_times(uuid, text, integer, jsonb) from public, anon;
grant execute on function public.get_or_create_reading_attempt(text) to authenticated;
grant execute on function public.submit_reading_attempt_with_times(uuid, text, integer, jsonb) to authenticated;
