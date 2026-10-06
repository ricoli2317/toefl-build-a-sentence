-- ============================================================================
-- Teacher Writing Review 范文 (sample essay):
--   latest instruction + current draft + published snapshot
--
-- Run this file manually in the Supabase SQL Editor BEFORE deploying the
-- application code that reads/writes the new columns. It is idempotent,
-- additive, and never touches existing review data.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. writing_reviews gains three nullable sample essay fields.
--    * sample_essay_instruction: latest teacher instruction used for the draft
--    * sample_essay_draft:       current teacher-only working draft (never
--                                returned to students)
--    * published_sample_essay:   last published snapshot (the only field the
--                                student API may read)
--    Historical rows stay NULL = "no sample essay". No backfill is needed and
--    existing published reviews remain valid without one. The draft and
--    published snapshot are separate fields, so regenerating a draft never
--    changes what students see until the existing Publish action runs.
-- ----------------------------------------------------------------------------
alter table public.writing_reviews
  add column if not exists sample_essay_instruction text,
  add column if not exists sample_essay_draft text,
  add column if not exists published_sample_essay text;

-- published_sample_essay is intentionally NOT referenced by
-- writing_reviews_publish_state_check: publishing a review never requires a
-- sample essay, and historical published rows must stay valid as-is.

-- ----------------------------------------------------------------------------
-- 2. The AI observability log accepts the new independent sample-essay
--    generation operation so it is not disguised as generate_ai /
--    full_regenerate / feedback_regenerate.
-- ----------------------------------------------------------------------------
alter table public.writing_review_ai_logs
  drop constraint if exists writing_review_ai_logs_operation_check;

alter table public.writing_review_ai_logs
  add constraint writing_review_ai_logs_operation_check
  check (operation = any (array[
    'generate_ai'::text,
    'full_regenerate'::text,
    'feedback_regenerate'::text,
    'sample_essay_generate'::text
  ]));

-- ----------------------------------------------------------------------------
-- 3. Verification (run after applying).
-- ----------------------------------------------------------------------------
-- select column_name, is_nullable, data_type
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name = 'writing_reviews'
--    and column_name like '%sample_essay%'
--  order by column_name;
--
-- select pg_get_constraintdef(oid) as def
--   from pg_constraint
--  where conname = 'writing_review_ai_logs_operation_check';
--
-- -- existing published rows are untouched (all three columns NULL):
-- select count(*) filter (where published_sample_essay is not null) as with_sample,
--        count(*) as total
--   from public.writing_reviews
--  where status = 'published';
