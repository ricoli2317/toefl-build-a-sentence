-- MANUAL ONLY. Review and run as a whole in the Supabase SQL Editor.
-- Phase 4 adds ONE correction-only table. It does not alter writing_reviews,
-- writing_attempts, the ordinary prompt, or the closed correction gate.
--
-- Why a separate table instead of reusing writing_reviews:
--   * writing_reviews is language-edit/dimension-score shaped with CHECKs and
--     normalization used by every ordinary read path.
--   * A correction review has no language edits of its own; its contract is
--     per-issue resolution states, new problems, and one holistic score.
--   * Writing it into writing_reviews would force placeholder rows that the
--     ordinary queue, practice summaries and student published review would
--     have to learn to ignore.
-- The table below is therefore the correction review store, not a second
-- ordinary review system: the ordinary lifecycle, prompt and schema are
-- untouched.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog, public;

DO $preflight$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'PHASE4_RUN_AS_POSTGRES';
  END IF;
  -- Phase 1A must already be applied; this migration never creates it.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'writing_attempts'
      AND column_name = 'attempt_kind'
  ) THEN
    RAISE EXCEPTION 'PHASE1A_REQUIRED';
  END IF;
  -- The correction gate must still exist and stay enabled.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.writing_attempts'::regclass
      AND tgname = 'writing_attempts_correction_closed_gate'
      AND tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'WRITING_CORRECTION_CLOSED_GATE_REQUIRED';
  END IF;
END;
$preflight$;

CREATE TABLE IF NOT EXISTS public.writing_correction_reviews (
  review_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL UNIQUE
    REFERENCES public.writing_attempts(attempt_id) ON DELETE CASCADE,
  task_type text NOT NULL
    CHECK (task_type IN ('email', 'academic_discussion')),
  status text NOT NULL DEFAULT 'reviewing'
    CHECK (status IN ('reviewing', 'published')),
  prompt_version text NOT NULL,
  schema_version text NOT NULL,
  ai_model text,
  ai_generated_at timestamptz,
  ai_review jsonb,
  teacher_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_review jsonb,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT writing_correction_reviews_publish_state CHECK (
    (status = 'reviewing' AND published_review IS NULL AND published_at IS NULL)
    OR (status = 'published' AND published_review IS NOT NULL AND published_at IS NOT NULL)
  ),
  CONSTRAINT writing_correction_reviews_ai_shape CHECK (
    ai_review IS NULL OR jsonb_typeof(ai_review) = 'object'
  ),
  CONSTRAINT writing_correction_reviews_overrides_shape CHECK (
    jsonb_typeof(teacher_overrides) = 'object'
  ),
  CONSTRAINT writing_correction_reviews_published_shape CHECK (
    published_review IS NULL OR jsonb_typeof(published_review) = 'object'
  )
);

CREATE INDEX IF NOT EXISTS writing_correction_reviews_status_idx
  ON public.writing_correction_reviews(status, updated_at DESC);

CREATE OR REPLACE FUNCTION public.touch_writing_correction_reviews()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS writing_correction_reviews_touch ON public.writing_correction_reviews;
CREATE TRIGGER writing_correction_reviews_touch
  BEFORE UPDATE ON public.writing_correction_reviews
  FOR EACH ROW EXECUTE FUNCTION public.touch_writing_correction_reviews();

-- Server-only access: RLS on with NO policy. The service role bypasses RLS;
-- anon/authenticated get nothing even if they guess the table name.
ALTER TABLE public.writing_correction_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.writing_correction_reviews FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.writing_correction_reviews TO service_role;
REVOKE ALL ON FUNCTION public.touch_writing_correction_reviews()
  FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.writing_correction_reviews IS
  'Phase 4 correction-only review store. Ordinary writing_reviews is untouched.';

COMMIT;
