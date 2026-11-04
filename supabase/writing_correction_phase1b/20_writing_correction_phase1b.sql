-- MANUAL ONLY. Review/run as a whole after Phase 1A. NOT executed by the agent.
-- Adds only three service-only lifecycle RPCs. Never changes/disables/bypasses
-- writing_attempts_correction_closed_gate. Writes still fail while it is closed.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog, public;
DO $preflight$
BEGIN
  IF current_user <> 'postgres' THEN RAISE EXCEPTION 'PHASE1B_RUN_AS_POSTGRES'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.writing_attempts'::regclass
    AND tgname='writing_attempts_correction_closed_gate' AND tgenabled='O'
    AND tgtype=31 AND tgfoid='public.block_writing_corrections_until_backend_ready()'::regprocedure) THEN
    RAISE EXCEPTION 'WRITING_CORRECTION_CLOSED_GATE_REQUIRED';
  END IF;
END;
$preflight$;

-- The API passes ONLY the authenticated account id, never a body-supplied user.
-- The database repeats owner/type/account checks under transaction locks.
CREATE FUNCTION public.create_or_resume_writing_correction(p_student uuid, p_original_attempt uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE
  a public.writing_attempts%rowtype;
  d public.writing_attempts%rowtype;
  r public.writing_reviews%rowtype;
  assignment public.writing_assignments%rowtype;
  question jsonb;
  question_source text := 'question_bank';
  snapshot jsonb;
  time_limit integer;
  conflict_name text;
BEGIN
  PERFORM 1 FROM public.profiles WHERE id=p_student AND role IN ('student','admin')
    AND is_active IS DISTINCT FROM false FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WRITING_CORRECTION_ACCOUNT_FORBIDDEN'; END IF;
  SELECT * INTO a FROM public.writing_attempts
    WHERE attempt_id=p_original_attempt AND user_id=p_student FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WRITING_CORRECTION_NOT_FOUND'; END IF;
  IF a.attempt_kind <> 'original' OR a.status <> 'submitted' OR a.submitted_at IS NULL
    OR a.task_type NOT IN ('email','academic_discussion') THEN
    RAISE EXCEPTION 'WRITING_CORRECTION_ORIGINAL_MISMATCH';
  END IF;
  -- Resume BEFORE accessing the current review or question. Never rebuild source.
  SELECT * INTO d FROM public.writing_attempts WHERE original_attempt_id=a.attempt_id
    AND user_id=p_student AND attempt_kind='correction' AND status='draft' FOR UPDATE;
  IF FOUND THEN RETURN jsonb_build_object('attempt',to_jsonb(d),'resumed',true); END IF;

  SELECT * INTO r FROM public.writing_reviews WHERE attempt_id=a.attempt_id
    AND status='published' AND published_at IS NOT NULL FOR SHARE;
  IF NOT FOUND OR r.published_language_edits IS NULL OR r.published_content_feedback IS NULL
    OR r.published_scores IS NULL OR r.published_teacher_comment IS NULL THEN
    RAISE EXCEPTION 'WRITING_CORRECTION_PUBLISHED_REVIEW_REQUIRED';
  END IF;
  IF a.assignment_id IS NOT NULL THEN
    SELECT * INTO assignment FROM public.writing_assignments WHERE assignment_id=a.assignment_id FOR SHARE;
    IF NOT FOUND OR assignment.task_type <> a.task_type THEN
      RAISE EXCEPTION 'WRITING_CORRECTION_QUESTION_REQUIRED';
    END IF;
    question := assignment.question_snapshot;
    question_source := assignment.question_source;
  ELSIF a.task_type='email' THEN
    -- Same public field projection as readWritingQuestion / writingReviewQuestionFields.
    SELECT to_jsonb(q) INTO question FROM (
      SELECT question_id,set_id,set_title,year_month,source_labels,scenario,task_instruction,
        requirement_1,requirement_2,requirement_3,closing_instruction,recipient,subject
      FROM public.email_questions WHERE question_id=a.question_id FOR SHARE
    ) q;
  ELSE
    SELECT to_jsonb(q) INTO question FROM (
      SELECT question_id,set_id,set_title,year_month,source_labels,professor_name,professor_prompt,
        student_1_name,student_1_response,student_2_name,student_2_response
      FROM public.academic_discussion_questions WHERE question_id=a.question_id FOR SHARE
    ) q;
  END IF;
  IF question IS NULL OR jsonb_typeof(question) <> 'object'
    OR question->>'question_id' IS DISTINCT FROM a.question_id
    OR question->>'set_id' IS DISTINCT FROM a.set_id THEN
    RAISE EXCEPTION 'WRITING_CORRECTION_QUESTION_REQUIRED';
  END IF;
  snapshot := jsonb_build_object('schema_version',1,'original_response_text',a.response_text,
    'original_context',jsonb_build_object(
      'task_type',a.task_type,'question_id',a.question_id,'set_id',a.set_id,'assignment_id',a.assignment_id,
      'word_count',a.word_count,'writing_mode',a.writing_mode,'elapsed_seconds',a.elapsed_seconds,
      'overtime_ranges',a.overtime_ranges,'time_limit_seconds',a.time_limit_seconds,
      'remaining_seconds',a.remaining_seconds,'submitted_at',a.submitted_at),
    'question_source',question_source,'question',question,
    'published_review',jsonb_build_object('review_id',r.review_id,'published_at',r.published_at,
      'language_edits',r.published_language_edits,'content_feedback',r.published_content_feedback,
      'scores',r.published_scores,'teacher_comment',r.published_teacher_comment));
  time_limit := CASE a.task_type WHEN 'email' THEN 420 ELSE 600 END;
  BEGIN
    INSERT INTO public.writing_attempts (
      attempt_kind,original_attempt_id,correction_source_snapshot,user_id,assignment_id,
      task_type,question_id,set_id,response_text,word_count,time_limit_seconds,
      remaining_seconds,writing_mode,elapsed_seconds,overtime_ranges
    ) VALUES ('correction',a.attempt_id,snapshot,p_student,a.assignment_id,
      a.task_type,a.question_id,a.set_id,a.response_text,a.word_count,time_limit,
      time_limit,NULL,0,'[]'::jsonb) RETURNING * INTO d;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS conflict_name=CONSTRAINT_NAME;
    IF conflict_name <> 'writing_attempts_one_correction_draft' THEN RAISE; END IF;
    -- A concurrent teacher return does not take the parent lock. The unique
    -- index serializes that race; return its existing draft rather than overwrite.
    SELECT * INTO d FROM public.writing_attempts WHERE original_attempt_id=a.attempt_id
      AND user_id=p_student AND attempt_kind='correction' AND status='draft' FOR UPDATE;
    IF NOT FOUND THEN RAISE; END IF;
    RETURN jsonb_build_object('attempt',to_jsonb(d),'resumed',true);
  END;
  RETURN jsonb_build_object('attempt',to_jsonb(d),'resumed',false);
END;
$function$;

CREATE FUNCTION public.save_writing_correction(
  p_student uuid, p_attempt uuid, p_expected_version bigint, p_response_text text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE d public.writing_attempts%rowtype; words integer;
BEGIN
  IF p_expected_version IS NULL OR p_expected_version < 0 OR p_response_text IS NULL THEN
    RAISE EXCEPTION 'WRITING_CORRECTION_INVALID_INPUT';
  END IF;
  PERFORM 1 FROM public.profiles WHERE id=p_student AND role IN ('student','admin')
    AND is_active IS DISTINCT FROM false FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WRITING_CORRECTION_ACCOUNT_FORBIDDEN'; END IF;
  SELECT * INTO d FROM public.writing_attempts WHERE attempt_id=p_attempt
    AND user_id=p_student AND attempt_kind='correction' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WRITING_CORRECTION_NOT_FOUND'; END IF;
  IF d.status <> 'draft' THEN RAISE EXCEPTION 'WRITING_CORRECTION_SUBMITTED_LOCKED'; END IF;
  IF d.draft_version <> p_expected_version THEN RAISE EXCEPTION 'WRITING_CORRECTION_VERSION_CONFLICT'; END IF;
  -- Equivalent token pattern to countEnglishWords; never accept client counts.
  SELECT count(*)::integer INTO words FROM regexp_matches(p_response_text,
    '[A-Za-z0-9]+(?:[''’\-][A-Za-z0-9]+)*','g');
  UPDATE public.writing_attempts SET response_text=p_response_text,word_count=words,saved_at=clock_timestamp()
    WHERE attempt_id=p_attempt AND user_id=p_student AND attempt_kind='correction'
      AND status='draft' AND draft_version=p_expected_version RETURNING * INTO d;
  IF NOT FOUND THEN RAISE EXCEPTION 'WRITING_CORRECTION_VERSION_CONFLICT'; END IF;
  -- Trigger owns version increment; never SET draft_version in these RPCs.
  RETURN jsonb_build_object('attempt',to_jsonb(d));
END;
$function$;

CREATE FUNCTION public.submit_writing_correction(p_student uuid, p_attempt uuid, p_expected_version bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE d public.writing_attempts%rowtype;
BEGIN
  IF p_expected_version IS NULL OR p_expected_version < 0 THEN
    RAISE EXCEPTION 'WRITING_CORRECTION_INVALID_INPUT';
  END IF;
  PERFORM 1 FROM public.profiles WHERE id=p_student AND role IN ('student','admin')
    AND is_active IS DISTINCT FROM false FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WRITING_CORRECTION_ACCOUNT_FORBIDDEN'; END IF;
  SELECT * INTO d FROM public.writing_attempts WHERE attempt_id=p_attempt
    AND user_id=p_student AND attempt_kind='correction' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WRITING_CORRECTION_NOT_FOUND'; END IF;
  -- A successful retry is a read, not another UPDATE/trigger/cache event.
  IF d.status='submitted' THEN
    RETURN jsonb_build_object('attempt',to_jsonb(d),'alreadySubmitted',true);
  END IF;
  IF d.draft_version <> p_expected_version THEN RAISE EXCEPTION 'WRITING_CORRECTION_VERSION_CONFLICT'; END IF;
  UPDATE public.writing_attempts SET status='submitted',submitted_at=clock_timestamp()
    WHERE attempt_id=p_attempt AND user_id=p_student AND attempt_kind='correction'
      AND status='draft' AND draft_version=p_expected_version RETURNING * INTO d;
  IF NOT FOUND THEN RAISE EXCEPTION 'WRITING_CORRECTION_VERSION_CONFLICT'; END IF;
  RETURN jsonb_build_object('attempt',to_jsonb(d),'alreadySubmitted',false);
END;
$function$;

REVOKE ALL ON FUNCTION public.create_or_resume_writing_correction(uuid,uuid),
  public.save_writing_correction(uuid,uuid,bigint,text),
  public.submit_writing_correction(uuid,uuid,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_or_resume_writing_correction(uuid,uuid),
  public.save_writing_correction(uuid,uuid,bigint,text),
  public.submit_writing_correction(uuid,uuid,bigint) TO service_role;
COMMIT;
