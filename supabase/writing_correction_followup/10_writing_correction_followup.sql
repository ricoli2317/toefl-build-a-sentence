-- MANUAL ONLY: run once as postgres, after the existing Phase 1–4 migrations.
-- No historical data updates; no changes to writing_reviews, attempts or gates.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog, public;

-- Published rows KEEP status=published while working overrides are saved.
-- The existing publish-state constraint is preserved for both review states;
-- only the new correction-only ignored state is added (no published snapshot).
ALTER TABLE public.writing_correction_reviews DROP CONSTRAINT writing_correction_reviews_status_check;
ALTER TABLE public.writing_correction_reviews ADD CONSTRAINT writing_correction_reviews_status_check
  CHECK (status IN ('reviewing', 'published', 'ignored'));
ALTER TABLE public.writing_correction_reviews DROP CONSTRAINT writing_correction_reviews_publish_state;
ALTER TABLE public.writing_correction_reviews ADD CONSTRAINT writing_correction_reviews_publish_state CHECK (
  (status IN ('reviewing', 'ignored') AND published_review IS NULL AND published_at IS NULL)
  OR (status = 'published' AND published_review IS NOT NULL AND published_at IS NOT NULL)
);

-- Same safe log contract/projection as ordinary Writing, physically isolated.
-- LIKE copies column defaults/checks/indexes, NOT data, ACLs, policies or triggers.
CREATE TABLE public.writing_correction_ai_logs (
  LIKE public.writing_review_ai_logs INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES
);
ALTER TABLE public.writing_correction_ai_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.writing_correction_ai_logs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.writing_correction_ai_logs TO service_role;

-- Service-only RPC; teacher scope is checked by the existing moderation API.
-- Exactly the ordinary ignore rule: only submissions with NO review row.
CREATE FUNCTION public.ignore_teacher_writing_corrections(p_attempt_ids uuid[])
RETURNS TABLE(attempt_id uuid, outcome text, reason text)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $function$
DECLARE
  v_id uuid;
  v_attempt public.writing_attempts%ROWTYPE;
  v_mutated integer;
BEGIN
  -- Stable lock ordering for overlapping batch operations.
  FOR v_id IN SELECT DISTINCT unnest(p_attempt_ids) ORDER BY 1 LOOP
    attempt_id := v_id; outcome := 'skipped'; reason := 'not_found';
    SELECT * INTO v_attempt FROM public.writing_attempts a
      WHERE a.attempt_id = v_id AND a.attempt_kind = 'correction' FOR UPDATE;
    IF NOT FOUND THEN RETURN NEXT; CONTINUE; END IF;
    IF v_attempt.status <> 'submitted' THEN reason := 'not_submitted'; RETURN NEXT; CONTINUE; END IF;
    INSERT INTO public.writing_correction_reviews(attempt_id, task_type, status, prompt_version, schema_version)
      VALUES (v_id, v_attempt.task_type, 'ignored', 'not_generated', 'not_generated')
      ON CONFLICT ON CONSTRAINT writing_correction_reviews_attempt_id_key DO NOTHING;
    GET DIAGNOSTICS v_mutated = ROW_COUNT;
    IF v_mutated = 0 THEN reason := 'already_reviewed';
    ELSE outcome := 'ignored'; reason := NULL; END IF;
    RETURN NEXT;
  END LOOP;
END;
$function$;
REVOKE ALL ON FUNCTION public.ignore_teacher_writing_corrections(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ignore_teacher_writing_corrections(uuid[]) TO service_role;
COMMIT;
