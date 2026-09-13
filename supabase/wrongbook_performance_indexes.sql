-- Run each statement in this order in Supabase SQL Editor before deploying the
-- application change. CONCURRENTLY keeps the live tables writable while each
-- index is built; do not wrap these statements in BEGIN/COMMIT.

create index concurrently if not exists attempt_answers_student_wrong_overview_idx
  on public.attempt_answers (student_id, attempt_answer_id)
  where is_correct = false;

create index concurrently if not exists reading_attempts_student_item_submitted_idx
  on public.reading_attempts (student_id, task_type, logical_item_id, attempt_id)
  where status = 'submitted';

create index concurrently if not exists reading_wrongbook_attempts_student_item_submitted_idx
  on public.reading_wrongbook_attempts (student_id, task_type, logical_item_id, attempt_id)
  where status = 'submitted' and task_type <> 'full_set';

create index concurrently if not exists reading_wrongbook_attempts_student_source_submitted_idx
  on public.reading_wrongbook_attempts (student_id, source_attempt_id, attempt_id)
  where status = 'submitted' and task_type = 'full_set';
