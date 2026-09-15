-- Reading Full Set answer consistency: occurrence-scoped CAS, paused-save
-- durability, and an atomic final-submit answer barrier.
-- Apply manually after reading_full_set_module_timer_pause_20260915.sql.

begin;

create table if not exists public.reading_full_set_occurrence_revisions (
  module_attempt_id uuid not null references public.reading_full_set_module_attempts(module_attempt_id) on delete cascade,
  occurrence_id text not null,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (module_attempt_id, occurrence_id)
);

insert into public.reading_full_set_occurrence_revisions (module_attempt_id, occurrence_id, revision)
select answer.module_attempt_id, answer.occurrence_id, max(module_attempt.answer_revision)
from public.reading_full_set_answers answer
join public.reading_full_set_module_attempts module_attempt
  on module_attempt.module_attempt_id = answer.module_attempt_id
group by answer.module_attempt_id, answer.occurrence_id
on conflict (module_attempt_id, occurrence_id) do nothing;

alter table public.reading_full_set_occurrence_revisions enable row level security;
revoke all on table public.reading_full_set_occurrence_revisions from public, anon, authenticated;
grant select on table public.reading_full_set_occurrence_revisions to service_role;

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
  v_occurrence_revision bigint;
begin
  select * into v_attempt from public.reading_full_set_attempts
  where attempt_id = p_attempt_id and student_id = v_user_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'FULL_SET_ATTEMPT_NOT_FOUND';
  end if;
  select * into v_module from public.reading_full_set_module_attempts
  where attempt_id = p_attempt_id and module_number = p_module_number for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'FULL_SET_MODULE_NOT_FOUND';
  end if;
  if v_module.status not in ('active', 'paused') then
    return jsonb_build_object('accepted', false, 'reason', 'locked', 'attempt', public.reading_full_set_attempt_json(p_attempt_id));
  end if;
  if v_module.status = 'active' and v_module.deadline_at <= v_now then
    perform public.finalize_reading_full_set_module(v_module.module_attempt_id, 'timeout', v_now);
    return jsonb_build_object('accepted', false, 'reason', 'timed_out', 'attempt', public.reading_full_set_attempt_json(p_attempt_id));
  end if;
  if p_expected_revision <> v_module.answer_revision then
    return jsonb_build_object('accepted', false, 'reason', 'stale_revision', 'attempt', public.reading_full_set_attempt_json(p_attempt_id));
  end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'array' or jsonb_array_length(p_answers) > 50 then
    raise exception using errcode = '22023', message = 'FULL_SET_INVALID_ANSWERS';
  end if;

  select occurrence.* into v_occurrence from public.reading_source_occurrences occurrence
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
  select v_module.module_attempt_id, p_occurrence_id, v_occurrence.logical_item_id,
    entry ->> 'questionId', nullif(entry ->> 'slotId', ''), entry ->> 'kind',
    nullif(entry ->> 'studentAnswer', ''), null,
    case when jsonb_typeof(entry -> 'questionTimeSeconds') = 'number'
      then (entry ->> 'questionTimeSeconds')::integer else null end
  from jsonb_array_elements(p_answers) entry;
  update public.reading_full_set_module_attempts set answer_revision = answer_revision + 1
  where module_attempt_id = v_module.module_attempt_id;
  insert into public.reading_full_set_occurrence_revisions (module_attempt_id, occurrence_id, revision)
  values (v_module.module_attempt_id, p_occurrence_id, 1)
  on conflict (module_attempt_id, occurrence_id) do update
    set revision = reading_full_set_occurrence_revisions.revision + 1,
        updated_at = clock_timestamp()
  returning revision into v_occurrence_revision;
  return jsonb_build_object(
    'accepted', true,
    'answerRevision', v_module.answer_revision + 1,
    'occurrenceRevision', v_occurrence_revision,
    'attempt', public.reading_full_set_attempt_json(p_attempt_id)
  );
end;
$$;

create or replace function public.save_reading_full_set_occurrence_answers_v2(
  p_attempt_id uuid,
  p_module_number smallint,
  p_occurrence_id text,
  p_expected_occurrence_revision bigint,
  p_answers jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_module public.reading_full_set_module_attempts%rowtype;
  v_occurrence_revision bigint;
  v_result jsonb;
begin
  -- Keep the canonical attempt -> module lock order used by the legacy RPC so
  -- concurrent save/submit calls cannot deadlock while this wrapper delegates.
  perform 1
  from public.reading_full_set_attempts
  where attempt_id = p_attempt_id and student_id = v_user_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'FULL_SET_MODULE_NOT_FOUND';
  end if;
  select * into v_module
  from public.reading_full_set_module_attempts
  where attempt_id = p_attempt_id and module_number = p_module_number
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'FULL_SET_MODULE_NOT_FOUND';
  end if;
  insert into public.reading_full_set_occurrence_revisions (module_attempt_id, occurrence_id, revision)
  values (v_module.module_attempt_id, p_occurrence_id, 0)
  on conflict (module_attempt_id, occurrence_id) do nothing;
  select revision into v_occurrence_revision
  from public.reading_full_set_occurrence_revisions
  where module_attempt_id = v_module.module_attempt_id and occurrence_id = p_occurrence_id
  for update;
  if p_expected_occurrence_revision <> v_occurrence_revision then
    return jsonb_build_object(
      'accepted', false,
      'reason', 'stale_revision',
      'answerRevision', v_module.answer_revision,
      'occurrenceRevision', v_occurrence_revision,
      'attempt', public.reading_full_set_attempt_json(p_attempt_id)
    );
  end if;
  v_result := public.save_reading_full_set_occurrence_answers(
    p_attempt_id, p_module_number, p_occurrence_id, v_module.answer_revision, p_answers
  );
  return v_result;
end;
$$;

create or replace function public.submit_reading_full_set_module_v2(
  p_attempt_id uuid,
  p_module_number smallint,
  p_expected_answer_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_module public.reading_full_set_module_attempts%rowtype;
  v_attempt jsonb;
begin
  -- Match the attempt -> module lock order of save/submit legacy RPCs.
  perform 1
  from public.reading_full_set_attempts
  where attempt_id = p_attempt_id and student_id = v_user_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'FULL_SET_MODULE_NOT_FOUND';
  end if;
  select * into v_module
  from public.reading_full_set_module_attempts
  where attempt_id = p_attempt_id and module_number = p_module_number
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'FULL_SET_MODULE_NOT_FOUND';
  end if;
  if v_module.status = 'submitted' then
    return jsonb_build_object(
      'accepted', true,
      'answerRevision', v_module.answer_revision,
      'attempt', public.reading_full_set_attempt_json(p_attempt_id)
    );
  end if;
  if p_expected_answer_revision <> v_module.answer_revision then
    return jsonb_build_object(
      'accepted', false,
      'reason', 'stale_revision',
      'answerRevision', v_module.answer_revision,
      'attempt', public.reading_full_set_attempt_json(p_attempt_id)
    );
  end if;
  v_attempt := public.submit_reading_full_set_module(p_attempt_id, p_module_number);
  return jsonb_build_object(
    'accepted', true,
    'answerRevision', v_module.answer_revision,
    'attempt', v_attempt
  );
end;
$$;

revoke all on function public.save_reading_full_set_occurrence_answers_v2(uuid, smallint, text, bigint, jsonb) from public, anon;
revoke all on function public.submit_reading_full_set_module_v2(uuid, smallint, bigint) from public, anon;
grant execute on function public.save_reading_full_set_occurrence_answers_v2(uuid, smallint, text, bigint, jsonb) to authenticated;
grant execute on function public.submit_reading_full_set_module_v2(uuid, smallint, bigint) to authenticated;

commit;
