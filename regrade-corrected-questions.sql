begin;

-- Update only the seven answers whose regraded result differs from the stored result.
-- The original is_correct value is included as a stale-report guard.
do $$
declare
  updated_count integer;
begin
  update public.attempt_answers as answer
  set is_correct = changes.recalculated_is_correct
  from (values
    ('a23c5589-c88f-42d5-9697-8439c14c0480', '202603-0308-4-Q02', false, true),
    ('5a964f25-32f3-4c0c-9b76-8da80939fe73', '202603-0308-4-Q02', true, false),
    ('2d7de3a9-373e-4c65-a470-6a6b30c2aac7', '202603-0308-4-Q02', true, false),
    ('8a252598-06ce-4403-baaf-a8ea932813df', '202603-0308-4-Q02', false, true),
    ('56341ec1-5223-4905-a870-3bda56cdb3bc', '202603-0308-4-Q02', true, false),
    ('d86a87fc-4043-46c9-90a1-2efed5ad51cb', '202603-0308-4-Q02', false, true),
    ('efc1b9f0-32f9-4c8a-b5f5-f44978f9cb75', '202603-0308-4-Q02', true, false)
  ) as changes(attempt_id, question_id, original_is_correct, recalculated_is_correct)
  where answer.attempt_id::text = changes.attempt_id
    and answer.question_id = changes.question_id
    and answer.is_correct = changes.original_is_correct;

  get diagnostics updated_count = row_count;
  if updated_count <> 7 then
    raise exception 'Expected to update 7 attempt_answers, updated % instead. Transaction rolled back.', updated_count;
  end if;
end
$$;

-- Recalculate correct_count from all answer rows belonging to each of the nine attempts.
do $$
declare
  updated_count integer;
begin
  with affected_attempts(attempt_id) as (values
    ('a23c5589-c88f-42d5-9697-8439c14c0480'),
    ('5a964f25-32f3-4c0c-9b76-8da80939fe73'),
    ('2d7de3a9-373e-4c65-a470-6a6b30c2aac7'),
    ('8a252598-06ce-4403-baaf-a8ea932813df'),
    ('56341ec1-5223-4905-a870-3bda56cdb3bc'),
    ('d86a87fc-4043-46c9-90a1-2efed5ad51cb'),
    ('efc1b9f0-32f9-4c8a-b5f5-f44978f9cb75'),
    ('01811974-45f1-473e-9af3-ce673e84eca9'),
    ('7a26de98-a893-4af6-898e-f92c13353320')
  ),
  totals as (
    select
      affected.attempt_id,
      count(*) filter (where answer.is_correct)::integer as correct_count
    from affected_attempts as affected
    left join public.attempt_answers as answer
      on answer.attempt_id::text = affected.attempt_id
    group by affected.attempt_id
  )
  update public.attempts as attempt
  set correct_count = totals.correct_count
  from totals
  where attempt.attempt_id::text = totals.attempt_id;

  get diagnostics updated_count = row_count;
  if updated_count <> 9 then
    raise exception 'Expected to update 9 attempts, updated % instead. Transaction rolled back.', updated_count;
  end if;
end
$$;

commit;

-- Read-only verification: the nine affected answer records.
select
  attempt_answer_id,
  attempt_id,
  student_id,
  question_id,
  submitted_order_text,
  is_correct,
  question_time_seconds
from public.attempt_answers
where (attempt_id::text, question_id) in (values
  ('a23c5589-c88f-42d5-9697-8439c14c0480', '202603-0308-4-Q02'),
  ('5a964f25-32f3-4c0c-9b76-8da80939fe73', '202603-0308-4-Q02'),
  ('2d7de3a9-373e-4c65-a470-6a6b30c2aac7', '202603-0308-4-Q02'),
  ('8a252598-06ce-4403-baaf-a8ea932813df', '202603-0308-4-Q02'),
  ('56341ec1-5223-4905-a870-3bda56cdb3bc', '202603-0308-4-Q02'),
  ('d86a87fc-4043-46c9-90a1-2efed5ad51cb', '202603-0308-4-Q02'),
  ('efc1b9f0-32f9-4c8a-b5f5-f44978f9cb75', '202603-0308-4-Q02'),
  ('01811974-45f1-473e-9af3-ce673e84eca9', '202602-0202-2-Q05'),
  ('7a26de98-a893-4af6-898e-f92c13353320', '202602-0202-2-Q05')
)
order by attempt_id;

-- Read-only verification: the nine recalculated attempt summaries.
select
  attempt_id,
  student_id,
  set_id,
  correct_count,
  total_questions,
  total_count,
  score,
  accuracy,
  submitted_at
from public.attempts
where attempt_id::text in (
  'a23c5589-c88f-42d5-9697-8439c14c0480',
  '5a964f25-32f3-4c0c-9b76-8da80939fe73',
  '2d7de3a9-373e-4c65-a470-6a6b30c2aac7',
  '8a252598-06ce-4403-baaf-a8ea932813df',
  '56341ec1-5223-4905-a870-3bda56cdb3bc',
  'd86a87fc-4043-46c9-90a1-2efed5ad51cb',
  'efc1b9f0-32f9-4c8a-b5f5-f44978f9cb75',
  '01811974-45f1-473e-9af3-ce673e84eca9',
  '7a26de98-a893-4af6-898e-f92c13353320'
)
order by attempt_id;
