-- TPS Reading Full Set: attempt, per-Module timer, autosaved answers, and atomic scoring.
-- Run after reading_attempts.sql and the Full Set source metadata migrations.
-- This migration does not copy or modify Reading content, occurrences, or assets.

create extension if not exists pgcrypto;

create table if not exists public.reading_full_set_attempts (
  attempt_id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  full_set_id text not null check (full_set_id ~ '^[0-9]{8}[A-Za-z]*$'),
  status text not null default 'in_progress' check (status in ('in_progress', 'completed')),
  current_module smallint not null default 1 check (current_module in (1, 2)),
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint reading_full_set_attempt_status_shape check (
    (status = 'in_progress' and completed_at is null)
    or (status = 'completed' and current_module = 2 and completed_at is not null)
  )
);

create table if not exists public.reading_full_set_module_attempts (
  module_attempt_id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.reading_full_set_attempts(attempt_id) on delete cascade,
  module_number smallint not null check (module_number in (1, 2)),
  status text not null default 'active' check (status in ('active', 'submitted')),
  time_limit_seconds integer not null check (time_limit_seconds in (540, 1110, 1230)),
  started_at timestamptz not null,
  deadline_at timestamptz not null,
  submitted_at timestamptz,
  submission_reason text check (submission_reason in ('manual', 'timeout')),
  answer_revision bigint not null default 0 check (answer_revision >= 0),
  total_points integer not null default 0 check (total_points in (0, 15, 35)),
  correct_points integer not null default 0 check (correct_points >= 0 and correct_points <= total_points),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (attempt_id, module_number),
  constraint reading_full_set_module_deadline_shape check (
    deadline_at = started_at + make_interval(secs => time_limit_seconds)
  ),
  constraint reading_full_set_module_status_shape check (
    (status = 'active' and submitted_at is null and submission_reason is null and total_points = 0 and correct_points = 0)
    or (status = 'submitted' and submitted_at is not null and submission_reason is not null and total_points in (15, 35))
  )
);

create table if not exists public.reading_full_set_answers (
  answer_id uuid primary key default gen_random_uuid(),
  module_attempt_id uuid not null references public.reading_full_set_module_attempts(module_attempt_id) on delete cascade,
  occurrence_id text not null,
  logical_item_id text not null,
  question_id text not null,
  slot_id text,
  answer_kind text not null check (answer_kind in (
    'ctw_slot', 'option', 'insertion_anchor', 'sentence_selection'
  )),
  student_answer text,
  is_correct boolean,
  question_time_seconds integer check (question_time_seconds between 0 and 604800),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (occurrence_id, logical_item_id)
    references public.reading_source_occurrences(occurrence_id, logical_item_id)
    on delete restrict,
  foreign key (question_id, logical_item_id)
    references public.reading_questions(question_id, logical_item_id)
    on delete restrict,
  foreign key (question_id, slot_id)
    references public.reading_ctw_slots(question_id, slot_id)
    on delete restrict,
  constraint reading_full_set_answer_shape check (
    (answer_kind = 'ctw_slot' and slot_id is not null)
    or (answer_kind <> 'ctw_slot' and slot_id is null)
  )
);

create unique index if not exists reading_full_set_one_active_attempt
  on public.reading_full_set_attempts(student_id, full_set_id)
  where status = 'in_progress';
create index if not exists reading_full_set_attempts_student_idx
  on public.reading_full_set_attempts(student_id, full_set_id, created_at desc);
create index if not exists reading_full_set_modules_attempt_idx
  on public.reading_full_set_module_attempts(attempt_id, module_number);
create unique index if not exists reading_full_set_answers_identity
  on public.reading_full_set_answers(module_attempt_id, question_id, coalesce(slot_id, ''));
create index if not exists reading_full_set_answers_module_idx
  on public.reading_full_set_answers(module_attempt_id, occurrence_id);

drop trigger if exists reading_full_set_attempts_set_updated_at on public.reading_full_set_attempts;
create trigger reading_full_set_attempts_set_updated_at
before update on public.reading_full_set_attempts
for each row execute function public.set_updated_at();

drop trigger if exists reading_full_set_modules_set_updated_at on public.reading_full_set_module_attempts;
create trigger reading_full_set_modules_set_updated_at
before update on public.reading_full_set_module_attempts
for each row execute function public.set_updated_at();

drop trigger if exists reading_full_set_answers_set_updated_at on public.reading_full_set_answers;
create trigger reading_full_set_answers_set_updated_at
before update on public.reading_full_set_answers
for each row execute function public.set_updated_at();

alter table public.reading_full_set_attempts enable row level security;
alter table public.reading_full_set_module_attempts enable row level security;
alter table public.reading_full_set_answers enable row level security;

drop policy if exists "students_select_own_reading_full_set_attempts" on public.reading_full_set_attempts;
create policy "students_select_own_reading_full_set_attempts"
on public.reading_full_set_attempts for select to authenticated
using (student_id = auth.uid());

drop policy if exists "students_select_own_reading_full_set_modules" on public.reading_full_set_module_attempts;
create policy "students_select_own_reading_full_set_modules"
on public.reading_full_set_module_attempts for select to authenticated
using (exists (
  select 1 from public.reading_full_set_attempts attempt
  where attempt.attempt_id = reading_full_set_module_attempts.attempt_id
    and attempt.student_id = auth.uid()
));

drop policy if exists "students_select_own_reading_full_set_answers" on public.reading_full_set_answers;
create policy "students_select_own_reading_full_set_answers"
on public.reading_full_set_answers for select to authenticated
using (exists (
  select 1
  from public.reading_full_set_module_attempts module_attempt
  join public.reading_full_set_attempts attempt
    on attempt.attempt_id = module_attempt.attempt_id
  where module_attempt.module_attempt_id = reading_full_set_answers.module_attempt_id
    and attempt.student_id = auth.uid()
));

create or replace function public.reading_occurrence_full_set_id(
  p_occurrence_date date,
  p_source_label text
)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_match text[];
begin
  v_match := regexp_match(p_source_label, '^(\d{1,2})\.(\d{1,2})([A-Za-z]*)$');
  if v_match is null
    or v_match[1]::integer <> extract(month from p_occurrence_date)::integer
    or v_match[2]::integer <> extract(day from p_occurrence_date)::integer then
    return null;
  end if;
  return to_char(p_occurrence_date, 'YYYYMMDD') || v_match[3];
end;
$$;

create or replace function public.reading_full_set_module_time_limit(
  p_full_set_id text,
  p_module_number smallint
)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_occurrence_count integer;
  v_ctw_count integer;
  v_short_rdl_count integer;
  v_long_rdl_count integer;
  v_rap_count integer;
  v_scoring_points integer;
  v_range_points integer;
  v_min_question integer;
  v_max_question integer;
  v_distinct_orders integer;
  v_overlap boolean;
begin
  if p_module_number not in (1, 2) then return null; end if;

  with occurrences as (
    select occurrence.*, item.module, item.scored_item_count
    from public.reading_source_occurrences occurrence
    join public.reading_logical_items item
      on item.logical_item_id = occurrence.logical_item_id
    where public.reading_occurrence_full_set_id(
      occurrence.occurrence_date,
      occurrence.source_label
    ) = p_full_set_id
      and occurrence.source_module = case p_module_number when 1 then 'm1' else 'm2' end
  )
  select
    count(*)::integer,
    count(*) filter (where module = 'ctw')::integer,
    count(*) filter (where module = 'rdl' and scored_item_count = 2)::integer,
    count(*) filter (where module = 'rdl' and scored_item_count = 3)::integer,
    count(*) filter (where module = 'rap')::integer,
    coalesce(sum(scored_item_count), 0)::integer,
    coalesce(sum(source_question_end - source_question_start + 1), 0)::integer,
    min(source_question_start),
    max(source_question_end),
    count(distinct source_order)::integer
  into
    v_occurrence_count, v_ctw_count, v_short_rdl_count, v_long_rdl_count,
    v_rap_count, v_scoring_points, v_range_points, v_min_question,
    v_max_question, v_distinct_orders
  from occurrences;

  select exists (
    select 1
    from public.reading_source_occurrences left_occurrence
    join public.reading_source_occurrences right_occurrence
      on left_occurrence.occurrence_id < right_occurrence.occurrence_id
      and left_occurrence.source_question_start <= right_occurrence.source_question_end
      and right_occurrence.source_question_start <= left_occurrence.source_question_end
    where public.reading_occurrence_full_set_id(
      left_occurrence.occurrence_date,
      left_occurrence.source_label
    ) = p_full_set_id
      and public.reading_occurrence_full_set_id(
        right_occurrence.occurrence_date,
        right_occurrence.source_label
      ) = p_full_set_id
      and left_occurrence.source_module = case p_module_number when 1 then 'm1' else 'm2' end
      and right_occurrence.source_module = left_occurrence.source_module
  ) into v_overlap;

  if v_overlap
    or v_occurrence_count <> v_distinct_orders
    or v_scoring_points <> v_range_points
    or v_min_question <> 1 then
    return null;
  end if;

  if p_module_number = 2 then
    if v_occurrence_count = 2 and v_ctw_count = 1 and v_rap_count = 1
      and v_short_rdl_count = 0 and v_long_rdl_count = 0
      and v_scoring_points = 15 and v_max_question = 15 then
      return 540;
    end if;
    return null;
  end if;

  if v_scoring_points <> 35 or v_max_question <> 35 or v_ctw_count <> 2 then
    return null;
  end if;
  if v_occurrence_count = 6 and v_short_rdl_count = 1 and v_long_rdl_count = 1 and v_rap_count = 2 then
    return 1230;
  end if;
  if v_occurrence_count = 7 and v_short_rdl_count = 2 and v_long_rdl_count = 2 and v_rap_count = 1 then
    return 1110;
  end if;
  return null;
end;
$$;

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
        'answerRevision', module_attempt.answer_revision
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
        'answerRevision', module_attempt.answer_revision
      )
      from public.reading_full_set_module_attempts module_attempt
      where module_attempt.attempt_id = attempt.attempt_id and module_attempt.module_number = 2
    )
  )
  from public.reading_full_set_attempts attempt
  where attempt.attempt_id = p_attempt_id;
$$;

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

create or replace function public.reconcile_reading_full_set_attempt(p_attempt_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt_id uuid;
  v_module record;
  v_now timestamptz := clock_timestamp();
begin
  select attempt_id into v_attempt_id
  from public.reading_full_set_attempts
  where attempt_id = p_attempt_id
  for update;
  if not found then return; end if;
  select module_attempt_id, deadline_at into v_module
  from public.reading_full_set_module_attempts
  where attempt_id = p_attempt_id and status = 'active'
  order by module_number desc
  limit 1
  for update;
  if found and v_module.deadline_at <= v_now then
    perform public.finalize_reading_full_set_module(v_module.module_attempt_id, 'timeout', v_now);
  end if;
end;
$$;

create or replace function public.get_or_create_reading_full_set_attempt(p_full_set_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_attempt_id uuid;
  v_time_limit integer;
  v_now timestamptz := clock_timestamp();
  v_created boolean := false;
begin
  if v_user_id is null or not exists (
    select 1 from public.profiles profile
    where profile.id = v_user_id and profile.is_active
      and profile.role::text in ('student', 'admin')
  ) then
    raise exception using errcode = '42501', message = 'FULL_SET_STUDENT_REQUIRED';
  end if;
  v_time_limit := public.reading_full_set_module_time_limit(p_full_set_id, 1::smallint);
  if v_time_limit is null or public.reading_full_set_module_time_limit(p_full_set_id, 2::smallint) <> 540 then
    raise exception using errcode = 'P0002', message = 'FULL_SET_NOT_FOUND';
  end if;

  select attempt_id into v_attempt_id
  from public.reading_full_set_attempts
  where student_id = v_user_id
    and full_set_id = p_full_set_id
    and status = 'in_progress'
  order by created_at desc
  limit 1;

  if v_attempt_id is null then
    insert into public.reading_full_set_attempts(student_id, full_set_id, status, current_module, started_at)
    values (v_user_id, p_full_set_id, 'in_progress', 1, v_now)
    on conflict (student_id, full_set_id) where status = 'in_progress' do nothing
    returning attempt_id into v_attempt_id;
    if v_attempt_id is not null then
      v_created := true;
      insert into public.reading_full_set_module_attempts(
        attempt_id, module_number, status, time_limit_seconds, started_at, deadline_at
      ) values (
        v_attempt_id, 1, 'active', v_time_limit, v_now,
        v_now + make_interval(secs => v_time_limit)
      );
    else
      select attempt_id into v_attempt_id
      from public.reading_full_set_attempts
      where student_id = v_user_id and full_set_id = p_full_set_id and status = 'in_progress'
      order by created_at desc limit 1;
    end if;
  end if;

  perform public.reconcile_reading_full_set_attempt(v_attempt_id);
  return public.reading_full_set_attempt_json(v_attempt_id)
    || jsonb_build_object('created', v_created);
end;
$$;

create or replace function public.get_reading_full_set_attempt(p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null or not exists (
    select 1 from public.reading_full_set_attempts
    where attempt_id = p_attempt_id and student_id = v_user_id
  ) then
    raise exception using errcode = 'P0002', message = 'FULL_SET_ATTEMPT_NOT_FOUND';
  end if;
  perform public.reconcile_reading_full_set_attempt(p_attempt_id);
  return public.reading_full_set_attempt_json(p_attempt_id);
end;
$$;

create or replace function public.get_reading_full_set_attempt_for_set(p_full_set_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_attempt_id uuid;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'FULL_SET_STUDENT_REQUIRED';
  end if;
  select attempt_id into v_attempt_id
  from public.reading_full_set_attempts
  where student_id = v_user_id and full_set_id = p_full_set_id
  order by (status = 'in_progress') desc, created_at desc
  limit 1;
  if v_attempt_id is null then return null; end if;
  perform public.reconcile_reading_full_set_attempt(v_attempt_id);
  return public.reading_full_set_attempt_json(v_attempt_id);
end;
$$;

create or replace function public.start_reading_full_set_module_2(p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_attempt public.reading_full_set_attempts%rowtype;
  v_module_1_status text;
  v_time_limit integer;
  v_now timestamptz := clock_timestamp();
begin
  select * into v_attempt
  from public.reading_full_set_attempts
  where attempt_id = p_attempt_id and student_id = v_user_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'FULL_SET_ATTEMPT_NOT_FOUND';
  end if;
  perform public.reconcile_reading_full_set_attempt(p_attempt_id);
  select status into v_module_1_status
  from public.reading_full_set_module_attempts
  where attempt_id = p_attempt_id and module_number = 1;
  if v_attempt.status = 'completed' then return public.reading_full_set_attempt_json(p_attempt_id); end if;
  if v_module_1_status <> 'submitted' then
    raise exception using errcode = '55000', message = 'FULL_SET_MODULE_1_NOT_SUBMITTED';
  end if;
  v_time_limit := public.reading_full_set_module_time_limit(v_attempt.full_set_id, 2::smallint);
  if v_time_limit <> 540 then
    raise exception using errcode = '23514', message = 'FULL_SET_INVALID_MODULE_2';
  end if;
  insert into public.reading_full_set_module_attempts(
    attempt_id, module_number, status, time_limit_seconds, started_at, deadline_at
  ) values (
    p_attempt_id, 2, 'active', v_time_limit, v_now,
    v_now + make_interval(secs => v_time_limit)
  ) on conflict (attempt_id, module_number) do nothing;
  return public.reading_full_set_attempt_json(p_attempt_id);
end;
$$;

create or replace function public.save_reading_full_set_occurrence_answers(
  p_attempt_id uuid,
  p_module_number smallint,
  p_occurrence_id text,
  p_expected_revision bigint,
  p_answers jsonb
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
  v_expected_points integer;
begin
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
  if v_module.status <> 'active' then
    return jsonb_build_object('accepted', false, 'reason', 'locked', 'attempt', public.reading_full_set_attempt_json(p_attempt_id));
  end if;
  if v_module.deadline_at <= v_now then
    perform public.finalize_reading_full_set_module(v_module.module_attempt_id, 'timeout', v_now);
    return jsonb_build_object('accepted', false, 'reason', 'timed_out', 'attempt', public.reading_full_set_attempt_json(p_attempt_id));
  end if;
  if p_expected_revision <> v_module.answer_revision then
    return jsonb_build_object('accepted', false, 'reason', 'stale_revision', 'attempt', public.reading_full_set_attempt_json(p_attempt_id));
  end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'array' or jsonb_array_length(p_answers) > 50 then
    raise exception using errcode = '22023', message = 'FULL_SET_INVALID_ANSWERS';
  end if;

  select occurrence.* into v_occurrence
  from public.reading_source_occurrences occurrence
  where occurrence.occurrence_id = p_occurrence_id
    and public.reading_occurrence_full_set_id(occurrence.occurrence_date, occurrence.source_label) = v_attempt.full_set_id
    and occurrence.source_module = case p_module_number when 1 then 'm1' else 'm2' end;
  if not found then
    raise exception using errcode = '22023', message = 'FULL_SET_INVALID_OCCURRENCE';
  end if;
  select * into v_item from public.reading_logical_items where logical_item_id = v_occurrence.logical_item_id;
  v_expected_points := v_item.scored_item_count;
  if jsonb_array_length(p_answers) <> v_expected_points then
    raise exception using errcode = '22023', message = 'FULL_SET_INVALID_ANSWER_COUNT';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_answers) entry
    where jsonb_typeof(entry) <> 'object'
      or coalesce(entry ->> 'kind', '') not in ('ctw_slot', 'option', 'insertion_anchor', 'sentence_selection')
      or nullif(entry ->> 'questionId', '') is null
      or case
        when not (entry ? 'questionTimeSeconds') or jsonb_typeof(entry -> 'questionTimeSeconds') = 'null' then false
        when coalesce((entry ->> 'questionTimeSeconds') ~ '^[0-9]+$', false)
          then (entry ->> 'questionTimeSeconds')::bigint > 604800
        else true
      end
      or (entry ? 'studentAnswer' and jsonb_typeof(entry -> 'studentAnswer') not in ('string', 'null'))
      or (entry ->> 'kind' = 'ctw_slot' and nullif(entry ->> 'slotId', '') is null)
      or (entry ->> 'kind' <> 'ctw_slot' and nullif(entry ->> 'slotId', '') is not null)
  ) then
    raise exception using errcode = '22023', message = 'FULL_SET_INVALID_ANSWERS';
  end if;
  if exists (
    select 1 from (
      select entry ->> 'questionId', coalesce(entry ->> 'slotId', ''), count(*)
      from jsonb_array_elements(p_answers) entry group by 1, 2 having count(*) > 1
    ) duplicate
  ) then
    raise exception using errcode = '22023', message = 'FULL_SET_DUPLICATE_ANSWER_ID';
  end if;
  if exists (
    with submitted as (
      select entry ->> 'kind' kind, entry ->> 'questionId' question_id,
        entry ->> 'slotId' slot_id, nullif(entry ->> 'studentAnswer', '') student_answer
      from jsonb_array_elements(p_answers) entry
    )
    select 1 from submitted
    left join public.reading_questions question
      on question.question_id = submitted.question_id and question.logical_item_id = v_occurrence.logical_item_id
    where question.question_id is null
      or (submitted.kind = 'ctw_slot' and (
        question.question_type <> 'ctw' or submitted.slot_id is null
        or not exists (select 1 from public.reading_ctw_slots slot where slot.question_id = question.question_id and slot.slot_id = submitted.slot_id)
      ))
      or (submitted.kind = 'option' and (
        question.question_type not in ('rdl', 'rap_multiple_choice')
        or (submitted.student_answer is not null and not exists (
          select 1 from public.reading_question_options option_row
          where option_row.question_id = question.question_id and option_row.option_id = submitted.student_answer
        ))
      ))
      or (submitted.kind = 'insertion_anchor' and (
        question.question_type <> 'rap_sentence_insertion'
        or (submitted.student_answer is not null and not exists (
          select 1 from public.reading_rap_insertion_anchors anchor
          where anchor.question_id = question.question_id and anchor.anchor_id = submitted.student_answer
        ))
      ))
      or (submitted.kind = 'sentence_selection' and (
        question.question_type <> 'rap_sentence_selection'
        or (submitted.student_answer is not null and submitted.student_answer <> question.correct_sentence_id
          and not exists (
            select 1 from public.reading_passage_sentences sentence
            where sentence.passage_id = question.passage_id
              and sentence.paragraph_id = question.target_paragraph_id
              and sentence.sentence_id = submitted.student_answer
          ))
      ))
  ) then
    raise exception using errcode = '22023', message = 'FULL_SET_ANSWER_ID_NOT_IN_OCCURRENCE';
  end if;

  delete from public.reading_full_set_answers
  where module_attempt_id = v_module.module_attempt_id and occurrence_id = p_occurrence_id;
  insert into public.reading_full_set_answers (
    module_attempt_id, occurrence_id, logical_item_id, question_id, slot_id,
    answer_kind, student_answer, is_correct, question_time_seconds
  )
  select
    v_module.module_attempt_id, p_occurrence_id, v_occurrence.logical_item_id,
    entry ->> 'questionId', nullif(entry ->> 'slotId', ''), entry ->> 'kind',
    nullif(entry ->> 'studentAnswer', ''), null,
    case when jsonb_typeof(entry -> 'questionTimeSeconds') = 'number'
      then (entry ->> 'questionTimeSeconds')::integer else null end
  from jsonb_array_elements(p_answers) entry;
  update public.reading_full_set_module_attempts
  set answer_revision = answer_revision + 1
  where module_attempt_id = v_module.module_attempt_id;
  return jsonb_build_object(
    'accepted', true,
    'answerRevision', v_module.answer_revision + 1,
    'attempt', public.reading_full_set_attempt_json(p_attempt_id)
  );
end;
$$;

create or replace function public.submit_reading_full_set_module(
  p_attempt_id uuid,
  p_module_number smallint
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
  v_now timestamptz := clock_timestamp();
begin
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
  if v_module.status = 'submitted' then
    return public.reading_full_set_attempt_json(p_attempt_id) || jsonb_build_object('alreadySubmitted', true);
  end if;
  perform public.finalize_reading_full_set_module(
    v_module.module_attempt_id,
    case when v_module.deadline_at <= v_now then 'timeout' else 'manual' end,
    v_now
  );
  return public.reading_full_set_attempt_json(p_attempt_id);
end;
$$;

revoke all on table public.reading_full_set_attempts from public, anon, authenticated;
revoke all on table public.reading_full_set_module_attempts from public, anon, authenticated;
revoke all on table public.reading_full_set_answers from public, anon, authenticated;
grant select on table public.reading_full_set_attempts to service_role;
grant select on table public.reading_full_set_module_attempts to service_role;
grant select on table public.reading_full_set_answers to service_role;

revoke all on function public.reading_occurrence_full_set_id(date, text) from public, anon, authenticated;
revoke all on function public.reading_full_set_module_time_limit(text, smallint) from public, anon, authenticated;
revoke all on function public.reading_full_set_attempt_json(uuid) from public, anon, authenticated;
revoke all on function public.finalize_reading_full_set_module(uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.reconcile_reading_full_set_attempt(uuid) from public, anon, authenticated;
revoke all on function public.get_or_create_reading_full_set_attempt(text) from public, anon;
revoke all on function public.get_reading_full_set_attempt(uuid) from public, anon;
revoke all on function public.get_reading_full_set_attempt_for_set(text) from public, anon;
revoke all on function public.start_reading_full_set_module_2(uuid) from public, anon;
revoke all on function public.save_reading_full_set_occurrence_answers(uuid, smallint, text, bigint, jsonb) from public, anon;
revoke all on function public.submit_reading_full_set_module(uuid, smallint) from public, anon;

grant execute on function public.get_or_create_reading_full_set_attempt(text) to authenticated;
grant execute on function public.get_reading_full_set_attempt(uuid) to authenticated;
grant execute on function public.get_reading_full_set_attempt_for_set(text) to authenticated;
grant execute on function public.start_reading_full_set_module_2(uuid) to authenticated;
grant execute on function public.save_reading_full_set_occurrence_answers(uuid, smallint, text, bigint, jsonb) to authenticated;
grant execute on function public.submit_reading_full_set_module(uuid, smallint) to authenticated;
