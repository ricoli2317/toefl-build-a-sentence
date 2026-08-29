-- TPS Reading: persist per-question time on submitted answer rows.
-- Run after reading_attempts.sql. Existing submitted rows intentionally remain null.

alter table public.reading_attempt_answers
  add column if not exists question_time_seconds integer;

alter table public.reading_attempt_answers
  drop constraint if exists reading_attempt_answers_question_time_check;

alter table public.reading_attempt_answers
  add constraint reading_attempt_answers_question_time_check check (
    question_time_seconds is null or question_time_seconds between 0 and 604800
  );

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

revoke all on function public.submit_reading_attempt_with_times(uuid, text, integer, jsonb)
  from public, anon;
revoke all on function public.submit_reading_attempt(uuid, text, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.submit_reading_attempt_with_times(uuid, text, integer, jsonb)
  to authenticated;
