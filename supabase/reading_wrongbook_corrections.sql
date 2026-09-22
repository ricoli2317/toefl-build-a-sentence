-- Reading wrongbook correction attempts.
-- Run after reading_attempts.sql. This keeps correction attempts separate from
-- ordinary Reading catalog/history/result/statistics attempts.

create extension if not exists pgcrypto;

create table if not exists public.reading_wrongbook_attempts (
  attempt_id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  logical_item_id text not null references public.reading_logical_items(logical_item_id) on delete restrict,
  task_type text not null check (task_type in ('ctw', 'rdl', 'rap')),
  scope text not null check (scope in ('today', 'history')),
  status text not null default 'draft' check (status in ('draft', 'submitted')),
  targets jsonb not null check (jsonb_typeof(targets) = 'array' and jsonb_array_length(targets) between 1 and 500),
  elapsed_seconds integer not null default 0 check (elapsed_seconds between 0 and 604800),
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  total_points integer not null default 0 check (total_points >= 0),
  correct_points integer not null default 0 check (correct_points between 0 and total_points),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reading_wrongbook_attempt_status_shape_check check (
    (status = 'draft' and submitted_at is null)
    or (status = 'submitted' and submitted_at is not null)
  )
);

create table if not exists public.reading_wrongbook_attempt_answers (
  attempt_answer_id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.reading_wrongbook_attempts(attempt_id) on delete cascade,
  logical_item_id text not null,
  question_id text not null,
  slot_id text,
  answer_kind text not null check (answer_kind in ('ctw_slot', 'option', 'insertion_anchor', 'sentence_selection')),
  student_answer text,
  is_correct boolean not null,
  question_time_seconds integer not null check (question_time_seconds between 0 and 604800),
  created_at timestamptz not null default now(),
  foreign key (question_id, logical_item_id)
    references public.reading_questions(question_id, logical_item_id) on delete restrict,
  foreign key (question_id, slot_id)
    references public.reading_ctw_slots(question_id, slot_id) on delete restrict,
  constraint reading_wrongbook_answer_shape_check check (
    (answer_kind = 'ctw_slot' and slot_id is not null)
    or (answer_kind <> 'ctw_slot' and slot_id is null)
  )
);

create unique index if not exists reading_wrongbook_one_draft_per_scope_item
  on public.reading_wrongbook_attempts(student_id, logical_item_id, task_type, scope)
  where status = 'draft';
create index if not exists reading_wrongbook_attempts_student_submitted_idx
  on public.reading_wrongbook_attempts(student_id, submitted_at desc)
  where status = 'submitted';
create unique index if not exists reading_wrongbook_answers_slot_identity
  on public.reading_wrongbook_attempt_answers(attempt_id, question_id, slot_id)
  where slot_id is not null;
create unique index if not exists reading_wrongbook_answers_question_identity
  on public.reading_wrongbook_attempt_answers(attempt_id, question_id)
  where slot_id is null;

drop trigger if exists reading_wrongbook_attempts_set_updated_at on public.reading_wrongbook_attempts;
create trigger reading_wrongbook_attempts_set_updated_at
before update on public.reading_wrongbook_attempts
for each row execute function public.set_updated_at();

alter table public.reading_wrongbook_attempts enable row level security;
alter table public.reading_wrongbook_attempt_answers enable row level security;

drop policy if exists "students_select_own_reading_wrongbook_attempts" on public.reading_wrongbook_attempts;
create policy "students_select_own_reading_wrongbook_attempts"
on public.reading_wrongbook_attempts for select to authenticated
using (auth.uid() = student_id);

drop policy if exists "students_select_own_reading_wrongbook_answers" on public.reading_wrongbook_attempt_answers;
create policy "students_select_own_reading_wrongbook_answers"
on public.reading_wrongbook_attempt_answers for select to authenticated
using (
  exists (
    select 1 from public.reading_wrongbook_attempts attempt
    where attempt.attempt_id = reading_wrongbook_attempt_answers.attempt_id
      and attempt.student_id = auth.uid()
  )
);

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
      count(*) filter (
        where not answer.is_correct
          and nullif(btrim(coalesce(answer.student_answer, '')), '') is not null
      )::integer as incorrect_points,
      count(*) filter (
        where nullif(btrim(coalesce(answer.student_answer, '')), '') is null
      )::integer as unanswered_points
    from public.reading_wrongbook_attempt_answers answer
    where answer.attempt_id = attempt.attempt_id
  ) counts on true
  where attempt.attempt_id = p_attempt_id;
$$;

create or replace function public.get_or_create_reading_wrongbook_attempt(
  p_logical_item_id text,
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
  v_module text;
  v_attempt_id uuid;
  v_created boolean := false;
  v_result jsonb;
begin
  if v_user_id is null or not exists (
    select 1 from public.profiles profile
    where profile.id = v_user_id and profile.is_active
      and profile.role::text in ('student', 'admin', 'teacher')
  ) then
    raise exception using errcode = '42501', message = 'READING_STUDENT_REQUIRED';
  end if;
  if p_scope is null or p_scope not in ('today', 'history')
    or p_targets is null
    or jsonb_typeof(p_targets) <> 'array'
    or jsonb_array_length(p_targets) not between 1 and 500
  then
    raise exception using errcode = '22023', message = 'READING_INVALID_WRONGBOOK_TARGETS';
  end if;

  select item.module into v_module
  from public.reading_logical_items item
  where item.logical_item_id = p_logical_item_id;
  if v_module is null then
    raise exception using errcode = 'P0002', message = 'READING_ITEM_NOT_FOUND';
  end if;

  if exists (
    with targets as (
      select entry ->> 'questionId' question_id, nullif(entry ->> 'slotId', '') slot_id
      from jsonb_array_elements(p_targets) entry
    )
    select 1 from targets target
    left join public.reading_questions question
      on question.question_id = target.question_id
      and question.logical_item_id = p_logical_item_id
    where question.question_id is null
      or (v_module = 'ctw' and (
        target.slot_id is null or not exists (
          select 1 from public.reading_ctw_slots slot
          where slot.question_id = target.question_id and slot.slot_id = target.slot_id
        )
      ))
      or (v_module <> 'ctw' and target.slot_id is not null)
  ) or exists (
    select 1
    from jsonb_array_elements(p_targets) entry
    group by entry ->> 'questionId', coalesce(entry ->> 'slotId', '')
    having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'READING_INVALID_WRONGBOOK_TARGETS';
  end if;

  select attempt.attempt_id into v_attempt_id
  from public.reading_wrongbook_attempts attempt
  where attempt.student_id = v_user_id
    and attempt.logical_item_id = p_logical_item_id
    and attempt.task_type = v_module
    and attempt.scope = p_scope
    and attempt.status = 'draft'
  order by attempt.created_at desc
  limit 1;

  if v_attempt_id is null then
    insert into public.reading_wrongbook_attempts (
      student_id, logical_item_id, task_type, scope, targets
    ) values (
      v_user_id, p_logical_item_id, v_module, p_scope, p_targets
    )
    on conflict (student_id, logical_item_id, task_type, scope)
      where status = 'draft'
    do nothing
    returning attempt_id into v_attempt_id;
    v_created := v_attempt_id is not null;
  end if;

  if v_attempt_id is null then
    select attempt.attempt_id into v_attempt_id
    from public.reading_wrongbook_attempts attempt
    where attempt.student_id = v_user_id
      and attempt.logical_item_id = p_logical_item_id
      and attempt.task_type = v_module
      and attempt.scope = p_scope
      and attempt.status = 'draft'
    order by attempt.created_at desc
      limit 1;
  end if;

  update public.reading_wrongbook_attempts
  set targets = p_targets
  where attempt_id = v_attempt_id and status = 'draft';

  select public.reading_wrongbook_attempt_result_json(v_attempt_id) into v_result;
  return v_result || jsonb_build_object('created', v_created, 'resumed', not v_created);
end;
$$;

create or replace function public.submit_reading_wrongbook_attempt(
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

  select attempt.* into v_attempt
  from public.reading_wrongbook_attempts attempt
  where attempt.attempt_id = p_attempt_id
    and attempt.student_id = v_user_id
    and attempt.logical_item_id = p_logical_item_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'READING_ATTEMPT_NOT_FOUND';
  end if;
  if v_attempt.status = 'submitted' then
    return public.reading_wrongbook_attempt_result_json(v_attempt.attempt_id)
      || jsonb_build_object('alreadySubmitted', true);
  end if;

  v_expected_points := jsonb_array_length(v_attempt.targets);
  if jsonb_array_length(p_answers) <> v_expected_points or exists (
    with targets as (
      select entry ->> 'questionId' question_id, nullif(entry ->> 'slotId', '') slot_id
      from jsonb_array_elements(v_attempt.targets) entry
    ), submitted as (
      select
        entry ->> 'questionId' question_id,
        nullif(entry ->> 'slotId', '') slot_id,
        entry ->> 'kind' kind,
        entry -> 'studentAnswer' student_answer,
        entry ->> 'questionTimeSeconds' question_time
      from jsonb_array_elements(p_answers) entry
    )
    select 1 from targets target
    left join submitted answer
      on answer.question_id = target.question_id
      and answer.slot_id is not distinct from target.slot_id
    left join public.reading_questions question
      on question.question_id = target.question_id
      and question.logical_item_id = v_attempt.logical_item_id
    where answer.question_id is null
      or answer.student_answer is null
      or jsonb_typeof(answer.student_answer) not in ('string', 'null')
      or answer.question_time is null
      or answer.question_time !~ '^[0-9]{1,6}$'
      or answer.question_time::integer not between 0 and 604800
      or answer.kind is null
      or answer.kind <> case question.question_type
        when 'ctw' then 'ctw_slot'
        when 'rap_sentence_insertion' then 'insertion_anchor'
        when 'rap_sentence_selection' then 'sentence_selection'
        else 'option'
      end
  ) or exists (
    select 1 from jsonb_array_elements(p_answers) entry
    group by entry ->> 'questionId', coalesce(entry ->> 'slotId', '')
    having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'READING_INVALID_SUBMISSION';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_answers) entry
    join public.reading_questions question
      on question.question_id = entry ->> 'questionId'
      and question.logical_item_id = v_attempt.logical_item_id
    where nullif(entry ->> 'studentAnswer', '') is not null
      and (
        (question.question_type in ('rdl', 'rap_multiple_choice') and not exists (
          select 1 from public.reading_question_options option_row
          where option_row.question_id = question.question_id
            and option_row.option_id = entry ->> 'studentAnswer'
        )) or (question.question_type = 'rap_sentence_insertion' and not exists (
          select 1 from public.reading_rap_insertion_anchors anchor
          where anchor.question_id = question.question_id
            and anchor.anchor_id = entry ->> 'studentAnswer'
        )) or (question.question_type = 'rap_sentence_selection' and not exists (
          select 1 from public.reading_passage_sentences sentence
          where sentence.passage_id = question.passage_id
            and sentence.paragraph_id = question.target_paragraph_id
            and sentence.sentence_id = entry ->> 'studentAnswer'
        ))
      )
  ) then
    raise exception using errcode = '22023', message = 'READING_ANSWER_ID_NOT_IN_ITEM';
  end if;

  insert into public.reading_wrongbook_attempt_answers (
    attempt_id, logical_item_id, question_id, slot_id, answer_kind,
    student_answer, is_correct, question_time_seconds
  )
  select
    v_attempt.attempt_id,
    v_attempt.logical_item_id,
    question.question_id,
    target.slot_id,
    submitted.kind,
    nullif(submitted.student_answer, ''),
    case question.question_type
      when 'ctw' then lower(btrim(coalesce(submitted.student_answer, ''))) = lower(slot.missing_text)
      when 'rdl' then submitted.student_answer = question.correct_option_id
      when 'rap_multiple_choice' then submitted.student_answer = question.correct_option_id
      when 'rap_sentence_insertion' then submitted.student_answer = question.correct_anchor_id
      when 'rap_sentence_selection' then submitted.student_answer = question.correct_sentence_id
      else false
    end,
    submitted.question_time_seconds
  from (
    select entry ->> 'questionId' question_id, nullif(entry ->> 'slotId', '') slot_id
    from jsonb_array_elements(v_attempt.targets) entry
  ) target
  join public.reading_questions question
    on question.question_id = target.question_id
    and question.logical_item_id = v_attempt.logical_item_id
  left join public.reading_ctw_slots slot
    on slot.question_id = target.question_id and slot.slot_id = target.slot_id
  join lateral (
    select
      entry ->> 'kind' kind,
      entry ->> 'studentAnswer' student_answer,
      (entry ->> 'questionTimeSeconds')::integer question_time_seconds
    from jsonb_array_elements(p_answers) entry
    where entry ->> 'questionId' = target.question_id
      and nullif(entry ->> 'slotId', '') is not distinct from target.slot_id
    limit 1
  ) submitted on true;

  select count(*) filter (where answer.is_correct)::integer into v_correct_points
  from public.reading_wrongbook_attempt_answers answer
  where answer.attempt_id = v_attempt.attempt_id;

  update public.reading_wrongbook_attempts
  set status = 'submitted', elapsed_seconds = p_elapsed_seconds,
      submitted_at = now(), total_points = v_expected_points,
      correct_points = v_correct_points
  where attempt_id = v_attempt.attempt_id and status = 'draft';

  select public.reading_wrongbook_attempt_result_json(v_attempt.attempt_id) into v_result;
  return v_result || jsonb_build_object('alreadySubmitted', false);
end;
$$;

revoke all on function public.reading_wrongbook_attempt_result_json(uuid) from public, anon, authenticated;
revoke all on function public.get_or_create_reading_wrongbook_attempt(text, text, jsonb) from public, anon;
revoke all on function public.submit_reading_wrongbook_attempt(uuid, text, integer, jsonb) from public, anon;
grant execute on function public.get_or_create_reading_wrongbook_attempt(text, text, jsonb) to authenticated;
grant execute on function public.submit_reading_wrongbook_attempt(uuid, text, integer, jsonb) to authenticated;
