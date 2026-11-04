-- MANUAL REVIEW / EXECUTION ONLY. Prepared from user-supplied SQL 1/2 results.
-- Run the WHOLE file as one SQL Editor request, after saving 80_... output.
-- Additive, one-time migration. Deliberately NOT idempotent: reruns fail safely.
-- Correction creation stays CLOSED. No lifecycle RPC, UI or AI is enabled.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '90s';
SET LOCAL search_path = pg_catalog, public;

-- Prevent attempts/reviews changing during the structural change and assertions.
-- Short lock timeout: abandon and retry in a quiet window, never force a lock.
LOCK TABLE public.writing_attempts IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.writing_reviews IN SHARE MODE;

-- Fail closed if the reviewed production baseline drifted. Source hashes ignore
-- SQL whitespace and line comments only; they are drift checks, not signatures.
DO $baseline$
DECLARE r record; p record; actual_hash text;
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'PHASE1A_RUN_AS_POSTGRES';
  END IF;
  IF NOT (SELECT relrowsecurity AND NOT relforcerowsecurity
          FROM pg_class WHERE oid = 'public.writing_attempts'::regclass) THEN
    RAISE EXCEPTION 'PHASE1A_RLS_BASELINE_CHANGED';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.writing_attempts'::regclass AND NOT attisdropped
      AND attname IN ('attempt_kind','original_attempt_id','correction_source_snapshot','draft_version')) THEN
    RAISE EXCEPTION 'PHASE1A_ALREADY_APPLIED_OR_PARTIAL_SCHEMA';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='writing_attempts') <> 3
    OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='writing_attempts'
      AND policyname='students can create own writing attempts' AND cmd='INSERT'
      AND permissive='PERMISSIVE' AND roles=ARRAY['authenticated']::name[]
      AND regexp_replace(with_check,'[[:space:]]','','g')='(auth.uid()=user_id)')
    OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='writing_attempts'
      AND policyname='students can read own writing attempts' AND cmd='SELECT'
      AND permissive='PERMISSIVE' AND roles=ARRAY['authenticated']::name[]
      AND regexp_replace(qual,'[[:space:]]','','g')='(auth.uid()=user_id)')
    OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='writing_attempts'
      AND policyname='students can update own draft writing attempts' AND cmd='UPDATE'
      AND permissive='PERMISSIVE' AND roles=ARRAY['authenticated']::name[]
      AND regexp_replace(qual,'[[:space:]]','','g')='((auth.uid()=user_id)AND(status=''draft''::text))'
      AND regexp_replace(with_check,'[[:space:]]','','g')='(auth.uid()=user_id)') THEN
    RAISE EXCEPTION 'PHASE1A_POLICIES_BASELINE_CHANGED';
  END IF;
  FOR r IN SELECT * FROM (VALUES
    ('public.rebuild_student_practice_item_state_writing(uuid,text,uuid)','8b5b52256851e690b49a72fd4e0c4f31',true,'v','search_path=public'),
    ('public.rebuild_student_practice_item_state_for_item(uuid)','2be58d15f19885f10b62c66ab805d8e7',true,'v','search_path=public'),
    ('public.sync_student_practice_item_state_writing()','42d7ab56fc108fc92440c03acb0e20a1',true,'v','search_path=public'),
    ('public.rebuild_student_practice_summary(uuid)','eb583685b5857df56c6464c68353acc7',true,'v','search_path=public'),
    ('public.sync_student_practice_summary_writing()','7f67d7788f6dd150297e1a418d6d1113',true,'v','search_path=public'),
    ('public.read_practice_activity_dates_v1(uuid,date,text,text[],boolean)','7a28be615aa6f6b3bd70b74afcf09563',false,'s','search_path=pg_catalog'),
    ('public.moderate_teacher_writing_attempts(text,uuid[])','ec1be350a6b477069b9242ddd1eec24b',true,'v','search_path=public'),
    ('public.validate_writing_review_attempt()','7a9323ec14f81a46453672f904511eb6',false,'v',NULL),
    ('public.enforce_student_writing_mode_policy()','6442016dbb0a22fdb941ccb3913ae5cf',false,'v','search_path=public'),
    ('public.enforce_active_writing_assignment_attempt()','d6256096162d81d633e35dc1f04140f5',true,'v','search_path=public')
  ) AS expected(signature, source_hash, definer, volatility, configuration) LOOP
    SELECT f.*, l.lanname INTO p FROM pg_proc f JOIN pg_language l ON l.oid=f.prolang
      WHERE f.oid=to_regprocedure(r.signature);
    IF NOT FOUND THEN RAISE EXCEPTION 'PHASE1A_FUNCTION_MISSING: %', r.signature; END IF;
    actual_hash := md5(regexp_replace(regexp_replace(p.prosrc,'--[^\n]*','','g'),'[[:space:]]','','g'));
    IF actual_hash <> r.source_hash OR p.prosecdef <> r.definer
      OR p.provolatile::text <> r.volatility OR p.lanname <> 'plpgsql'
      OR pg_get_userbyid(p.proowner) <> 'postgres'
      OR p.proconfig IS DISTINCT FROM CASE WHEN r.configuration IS NULL
        THEN NULL::text[] ELSE ARRAY[r.configuration] END THEN
      RAISE EXCEPTION 'PHASE1A_FUNCTION_BASELINE_CHANGED: %', r.signature;
    END IF;
    IF r.signature NOT IN ('public.validate_writing_review_attempt()', 'public.enforce_student_writing_mode_policy()')
      AND (has_function_privilege('anon',p.oid,'EXECUTE')
        OR has_function_privilege('authenticated',p.oid,'EXECUTE')
        OR NOT has_function_privilege('service_role',p.oid,'EXECUTE')) THEN
      RAISE EXCEPTION 'PHASE1A_FUNCTION_ACL_CHANGED: %', r.signature;
    END IF;
  END LOOP;
  FOR r IN SELECT * FROM (VALUES
    ('writing_attempts_one_draft_per_question',
     'CREATE UNIQUE INDEX writing_attempts_one_draft_per_question ON public.writing_attempts USING btree (user_id, task_type, question_id) WHERE ((status = ''draft''::text) AND (assignment_id IS NULL))'),
    ('writing_attempts_one_assignment_draft',
     'CREATE UNIQUE INDEX writing_attempts_one_assignment_draft ON public.writing_attempts USING btree (user_id, assignment_id) WHERE ((status = ''draft''::text) AND (assignment_id IS NOT NULL))')
  ) expected(name, definition) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_index i
      WHERE i.indexrelid=to_regclass('public.'||r.name) AND i.indrelid='public.writing_attempts'::regclass
        AND i.indisunique AND i.indisvalid AND i.indisready
        AND pg_get_indexdef(i.indexrelid)=r.definition) THEN
      RAISE EXCEPTION 'PHASE1A_INDEX_BASELINE_CHANGED: %', r.name;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.writing_attempts'::regclass AND NOT tgisinternal) <> 5
    OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.writing_reviews'::regclass AND NOT tgisinternal) <> 2 THEN
    RAISE EXCEPTION 'PHASE1A_TRIGGER_BASELINE_CHANGED';
  END IF;
  FOR r IN SELECT * FROM (VALUES
    ('public.writing_attempts','set_writing_attempts_updated_at','public.set_updated_at()',19,''),
    ('public.writing_attempts','trg_writing_attempts_student_practice_item_state','public.sync_student_practice_item_state_writing()',29,''),
    ('public.writing_attempts','trg_writing_attempts_student_practice_summary','public.sync_student_practice_summary_writing()',17,''),
    ('public.writing_attempts','writing_attempts_require_active_assignment','public.enforce_active_writing_assignment_attempt()',23,''),
    ('public.writing_attempts','writing_attempts_require_allowed_mode','public.enforce_student_writing_mode_policy()',23,''),
    ('public.writing_reviews','writing_reviews_set_updated_at','public.set_writing_reviews_updated_at()',19,''),
    ('public.writing_reviews','writing_reviews_validate_attempt','public.validate_writing_review_attempt()',23,'2 3')
  ) expected(relation, name, signature, type_bits, attributes) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass(r.relation)
      AND t.tgname=r.name AND NOT t.tgisinternal AND t.tgenabled='O'
      AND t.tgfoid=to_regprocedure(r.signature) AND t.tgtype=r.type_bits
      AND t.tgattr::text=r.attributes
      AND (CASE WHEN r.name='trg_writing_attempts_student_practice_summary' THEN
        regexp_replace(pg_get_triggerdef(t.oid,true),'[[:space:]()]','','g')
          LIKE '%WHENold.status=''draft''::textANDnew.status=''submitted''::textANDnew.submitted_atISNOTNULL%'
        ELSE t.tgqual IS NULL END)) THEN
      RAISE EXCEPTION 'PHASE1A_TRIGGER_DEFINITION_CHANGED: %', r.name;
    END IF;
  END LOOP;
END;
$baseline$;

-- Temporary evidence only, removed on COMMIT; never stores essay/review text.
CREATE TEMP TABLE writing_correction_1a_before ON COMMIT DROP AS
SELECT 'attempts'::text AS object_name, count(*) AS row_count,
  md5(coalesce(string_agg(md5(to_jsonb(a)::text),'' ORDER BY a.attempt_id),'')) AS fingerprint
FROM public.writing_attempts a
UNION ALL
SELECT 'reviews', count(*),
  md5(coalesce(string_agg(md5(to_jsonb(r)::text),'' ORDER BY r.review_id),''))
FROM public.writing_reviews r;
CREATE TEMP TABLE writing_correction_1a_function_acl ON COMMIT DROP AS
SELECT oid, proowner, proacl, prosecdef, proconfig, provolatile
FROM pg_proc WHERE oid IN (
  'public.rebuild_student_practice_item_state_writing(uuid,text,uuid)'::regprocedure,
  'public.rebuild_student_practice_item_state_for_item(uuid)'::regprocedure,
  'public.sync_student_practice_item_state_writing()'::regprocedure,
  'public.rebuild_student_practice_summary(uuid)'::regprocedure,
  'public.sync_student_practice_summary_writing()'::regprocedure,
  'public.read_practice_activity_dates_v1(uuid,date,text,text[],boolean)'::regprocedure,
  'public.moderate_teacher_writing_attempts(text,uuid[])'::regprocedure
);

-- One immutable inline snapshot per correction is smaller than a new snapshot
-- ownership/read system for these <=300-word essays. No separate source table.
ALTER TABLE public.writing_attempts
  ADD COLUMN attempt_kind text NOT NULL DEFAULT 'original',
  ADD COLUMN original_attempt_id uuid,
  ADD COLUMN correction_source_snapshot jsonb,
  ADD COLUMN draft_version bigint NOT NULL DEFAULT 0;

ALTER TABLE public.writing_attempts
  ADD CONSTRAINT writing_attempts_kind_check
    CHECK (attempt_kind IN ('original', 'correction')),
  ADD CONSTRAINT writing_attempts_draft_version_check
    CHECK (draft_version >= 0),
  ADD CONSTRAINT writing_attempts_correction_parent_fkey
    FOREIGN KEY (original_attempt_id) REFERENCES public.writing_attempts(attempt_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT writing_attempts_correction_shape_check CHECK ((
    (attempt_kind = 'original'
      AND original_attempt_id IS NULL
      AND correction_source_snapshot IS NULL AND draft_version = 0)
    OR
    (attempt_kind = 'correction'
      AND original_attempt_id IS NOT NULL
      AND original_attempt_id <> attempt_id
      AND task_type IN ('email', 'academic_discussion')
      AND jsonb_typeof(correction_source_snapshot) = 'object'
      AND correction_source_snapshot -> 'schema_version' = '1'::jsonb
      AND jsonb_typeof(correction_source_snapshot -> 'original_response_text') = 'string'
      AND jsonb_typeof(correction_source_snapshot -> 'original_context') = 'object'
      AND jsonb_typeof(correction_source_snapshot -> 'question') = 'object'
      AND correction_source_snapshot ->> 'question_source' IN ('question_bank', 'custom')
      AND jsonb_typeof(correction_source_snapshot -> 'published_review') = 'object'
      AND jsonb_typeof(correction_source_snapshot #> '{published_review,review_id}') = 'string'
      AND jsonb_typeof(correction_source_snapshot #> '{published_review,published_at}') = 'string'
      AND jsonb_typeof(correction_source_snapshot #> '{published_review,language_edits}') = 'array'
      AND jsonb_typeof(correction_source_snapshot #> '{published_review,content_feedback}') = 'object'
      AND jsonb_typeof(correction_source_snapshot #> '{published_review,content_feedback,items}') = 'array'
      AND jsonb_typeof(correction_source_snapshot #> '{published_review,scores}') = 'object'
      AND jsonb_typeof(correction_source_snapshot #> '{published_review,teacher_comment}') = 'string'
      AND ((status = 'draft' AND submitted_at IS NULL)
        OR (status = 'submitted' AND submitted_at IS NOT NULL))
    )
  ) IS TRUE),
  ADD CONSTRAINT writing_attempts_correction_untimed_check CHECK ((
    attempt_kind = 'original' OR (
      writing_mode IS NULL
      AND elapsed_seconds = 0
      AND overtime_ranges = '[]'::jsonb
      AND time_limit_seconds = CASE task_type
        WHEN 'email' THEN 420 WHEN 'academic_discussion' THEN 600 END
      AND remaining_seconds = time_limit_seconds
    )
  ) IS TRUE);

-- Both reviewed ordinary predicates are changed in this SAME transaction.
DROP INDEX public.writing_attempts_one_draft_per_question;
CREATE UNIQUE INDEX writing_attempts_one_draft_per_question
  ON public.writing_attempts(user_id, task_type, question_id)
  WHERE status = 'draft' AND assignment_id IS NULL AND attempt_kind = 'original';
DROP INDEX public.writing_attempts_one_assignment_draft;
CREATE UNIQUE INDEX writing_attempts_one_assignment_draft
  ON public.writing_attempts(user_id, assignment_id)
  WHERE status = 'draft' AND assignment_id IS NOT NULL AND attempt_kind = 'original';
CREATE UNIQUE INDEX writing_attempts_one_correction_draft
  ON public.writing_attempts(original_attempt_id)
  WHERE status = 'draft' AND attempt_kind = 'correction';
CREATE INDEX writing_attempts_correction_history_idx
  ON public.writing_attempts(original_attempt_id, submitted_at DESC, attempt_id DESC)
  WHERE attempt_kind = 'correction';

-- Students use authorized correction APIs, not
-- unrestricted direct PostgREST writes. Preserve every existing original-row
-- permissive policy; restrictive policy is an additional AND, not an OR.
CREATE POLICY writing_attempts_correction_api_only
  ON public.writing_attempts AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (attempt_kind = 'original') WITH CHECK (attempt_kind = 'original');

-- A separate closed gate remains after this migration.
-- No correction can enter ANY old read/aggregate path before 1B isolation.
CREATE FUNCTION public.block_writing_corrections_until_backend_ready()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.attempt_kind = 'correction' THEN
      RAISE EXCEPTION 'WRITING_CORRECTION_NOT_ENABLED';
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.attempt_kind = 'correction' OR NEW.attempt_kind = 'correction' THEN
      RAISE EXCEPTION 'WRITING_CORRECTION_NOT_ENABLED';
    END IF;
    RETURN NEW;
  ELSE
    IF OLD.attempt_kind = 'correction' THEN
      RAISE EXCEPTION 'WRITING_CORRECTION_NOT_ENABLED';
    END IF;
    RETURN OLD;
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.block_writing_corrections_until_backend_ready()
  FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER writing_attempts_correction_closed_gate
  BEFORE INSERT OR UPDATE OR DELETE ON public.writing_attempts
  FOR EACH ROW EXECUTE FUNCTION public.block_writing_corrections_until_backend_ready();

-- Permanent data guard. No public callable create/save/submit operation.
-- UPDATE NEVER re-reads latest review: old corrections keep the frozen source.
CREATE FUNCTION public.guard_writing_correction_record()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $function$
DECLARE
  source_attempt public.writing_attempts%rowtype;
  source_review public.writing_reviews%rowtype;
  expected_context jsonb;
  expected_review jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.attempt_kind IS DISTINCT FROM OLD.attempt_kind THEN
      RAISE EXCEPTION 'WRITING_ATTEMPT_KIND_IMMUTABLE';
    END IF;
  END IF;
  IF NEW.attempt_kind <> 'correction' THEN RETURN NEW; END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.submitted_at IS NOT NULL OR NEW.draft_version <> 0 THEN
      RAISE EXCEPTION 'WRITING_CORRECTION_MUST_START_AS_DRAFT';
    END IF;
    SELECT * INTO source_attempt FROM public.writing_attempts
      WHERE attempt_id=NEW.original_attempt_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'WRITING_CORRECTION_ORIGINAL_REQUIRED'; END IF;
    IF source_attempt.attempt_kind <> 'original' OR source_attempt.status <> 'submitted'
      OR source_attempt.submitted_at IS NULL
      OR source_attempt.user_id IS DISTINCT FROM NEW.user_id
      OR source_attempt.task_type IS DISTINCT FROM NEW.task_type
      OR source_attempt.question_id IS DISTINCT FROM NEW.question_id
      OR source_attempt.set_id IS DISTINCT FROM NEW.set_id
      OR source_attempt.assignment_id IS DISTINCT FROM NEW.assignment_id THEN
      RAISE EXCEPTION 'WRITING_CORRECTION_ORIGINAL_MISMATCH';
    END IF;
    -- writing_reviews_attempt_unique means exactly one current review row;
    -- its published_* columns, NOT working fields, are the latest publication.
    SELECT * INTO source_review FROM public.writing_reviews
      WHERE attempt_id=source_attempt.attempt_id AND status='published' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'WRITING_CORRECTION_PUBLISHED_REVIEW_REQUIRED'; END IF;
    expected_context := jsonb_build_object(
      'task_type',source_attempt.task_type,'question_id',source_attempt.question_id,
      'set_id',source_attempt.set_id,'assignment_id',source_attempt.assignment_id,
      'word_count',source_attempt.word_count,'writing_mode',source_attempt.writing_mode,
      'elapsed_seconds',source_attempt.elapsed_seconds,'overtime_ranges',source_attempt.overtime_ranges,
      'time_limit_seconds',source_attempt.time_limit_seconds,
      'remaining_seconds',source_attempt.remaining_seconds,'submitted_at',source_attempt.submitted_at);
    expected_review := jsonb_build_object(
      'review_id',source_review.review_id,'published_at',source_review.published_at,
      'language_edits',source_review.published_language_edits,
      'content_feedback',source_review.published_content_feedback,
      'scores',source_review.published_scores,'teacher_comment',source_review.published_teacher_comment);
    IF NEW.response_text IS DISTINCT FROM source_attempt.response_text
      OR NEW.word_count IS DISTINCT FROM source_attempt.word_count
      OR NEW.correction_source_snapshot ->> 'original_response_text' IS DISTINCT FROM source_attempt.response_text
      OR NEW.correction_source_snapshot -> 'original_context' IS DISTINCT FROM expected_context
      OR NEW.correction_source_snapshot -> 'published_review' IS DISTINCT FROM expected_review
      OR NEW.correction_source_snapshot #>> '{question,question_id}' IS DISTINCT FROM NEW.question_id
      OR NEW.correction_source_snapshot #>> '{question,set_id}' IS DISTINCT FROM NEW.set_id THEN
      RAISE EXCEPTION 'WRITING_CORRECTION_SNAPSHOT_MISMATCH';
    END IF;
    -- Full question contents must be built by the trusted 1B loader; clients
    -- cannot write correction rows. Assignment snapshots can also be compared
    -- to their existing canonical payload without depending on question DDL.
    IF NEW.assignment_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.writing_assignments a WHERE a.assignment_id=NEW.assignment_id
        AND a.question_source=NEW.correction_source_snapshot ->> 'question_source'
        AND a.question_snapshot=NEW.correction_source_snapshot -> 'question'
    ) THEN RAISE EXCEPTION 'WRITING_CORRECTION_QUESTION_MISMATCH'; END IF;
    RETURN NEW;
  END IF;

  -- Everything except these explicit draft/lifecycle fields is immutable.
  -- Includes attempt_id, parent, snapshot, owner, question, assignment, timers,
  -- created_at/started_at. Works for service-role ordinary UPDATE too.
  IF (to_jsonb(NEW)-ARRAY['response_text','word_count','saved_at','status','submitted_at','updated_at','draft_version'])
    IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['response_text','word_count','saved_at','status','submitted_at','updated_at','draft_version']) THEN
    RAISE EXCEPTION 'WRITING_CORRECTION_SOURCE_IMMUTABLE';
  END IF;
  IF NEW.draft_version IS DISTINCT FROM OLD.draft_version THEN
    RAISE EXCEPTION 'WRITING_CORRECTION_VERSION_SERVER_MANAGED';
  END IF;
  IF OLD.status='submitted' THEN
    IF NEW.status='draft' THEN
      -- Same eligibility as moderation. Existing review trigger takes FOR SHARE
      -- on this row, conflicting with UPDATE, so no review/return race.
      IF EXISTS (SELECT 1 FROM public.writing_reviews r WHERE r.attempt_id=OLD.attempt_id) THEN
        RAISE EXCEPTION 'WRITING_CORRECTION_ALREADY_REVIEWED';
      END IF;
      IF NEW.response_text IS DISTINCT FROM OLD.response_text
        OR NEW.word_count IS DISTINCT FROM OLD.word_count
        OR NEW.saved_at IS DISTINCT FROM OLD.saved_at OR NEW.submitted_at IS NOT NULL THEN
        RAISE EXCEPTION 'WRITING_CORRECTION_RETURN_MUST_PRESERVE_RESPONSE';
      END IF;
    ELSIF (to_jsonb(NEW)-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'updated_at') THEN
      RAISE EXCEPTION 'WRITING_CORRECTION_SUBMITTED_LOCKED';
    ELSE
      RETURN NEW;
    END IF;
  END IF;
  -- 1B CAS uses WHERE draft_version=expected AND status='draft'; it must NOT
  -- assign draft_version itself. Return and submit also invalidate old requests.
  NEW.draft_version := OLD.draft_version + 1;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.guard_writing_correction_record()
  FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER writing_attempts_correction_record_guard
  BEFORE INSERT OR UPDATE ON public.writing_attempts
  FOR EACH ROW EXECUTE FUNCTION public.guard_writing_correction_record();

-- Existing function replacements and transaction assertions follow below.

-- 1/7: all four ordinary item-state source queries, no backfill.
CREATE OR REPLACE FUNCTION public.rebuild_student_practice_item_state_writing(
  p_student_id uuid, p_task_type text, p_item_id uuid
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
declare
  v_count integer := 0;
  v_latest uuid;
  v_last_started_at timestamptz;
  v_last_completed_at timestamptz;
  v_resume uuid;
  v_resume_question_id text;
  v_completed uuid;
begin
  if p_student_id is null or p_item_id is null then return; end if;
  if p_task_type not in ('email', 'academic_discussion') then return; end if;
  if not public.practice_item_is_public(p_item_id, p_task_type) then
    delete from public.student_practice_item_state
    where student_id = p_student_id and task_type = p_task_type and item_id = p_item_id::text;
    return;
  end if;

  select count(*), max(coalesce(attempt.started_at, attempt.created_at)),
    max(attempt.submitted_at) filter (where attempt.status = 'submitted')
  into v_count, v_last_started_at, v_last_completed_at
  from public.writing_attempts attempt
  where attempt.user_id = p_student_id and attempt.task_type = p_task_type
    and attempt.assignment_id is null and attempt.attempt_kind = 'original'
    and public.writing_attempt_matches_item(attempt.question_id, p_item_id, p_task_type);
  if v_count = 0 then
    delete from public.student_practice_item_state
    where student_id = p_student_id and task_type = p_task_type and item_id = p_item_id::text;
    return;
  end if;

  select attempt.attempt_id, attempt.question_id into v_resume, v_resume_question_id
  from public.writing_attempts attempt
  where attempt.user_id = p_student_id and attempt.task_type = p_task_type
    and attempt.assignment_id is null and attempt.attempt_kind = 'original'
    and attempt.status = 'draft'
    and public.writing_attempt_matches_item(attempt.question_id, p_item_id, p_task_type)
  order by coalesce(attempt.updated_at, attempt.saved_at, attempt.created_at) desc,
    attempt.attempt_id desc limit 1;

  select attempt.attempt_id into v_completed
  from public.writing_attempts attempt
  where attempt.user_id = p_student_id and attempt.task_type = p_task_type
    and attempt.assignment_id is null and attempt.attempt_kind = 'original'
    and attempt.status = 'submitted'
    and public.writing_attempt_matches_item(attempt.question_id, p_item_id, p_task_type)
  order by attempt.submitted_at desc nulls last, attempt.attempt_id desc limit 1;

  select attempt.attempt_id into v_latest
  from public.writing_attempts attempt
  where attempt.user_id = p_student_id and attempt.task_type = p_task_type
    and attempt.assignment_id is null and attempt.attempt_kind = 'original'
    and public.writing_attempt_matches_item(attempt.question_id, p_item_id, p_task_type)
  order by (case when attempt.status = 'submitted'
      then coalesce(attempt.submitted_at, attempt.updated_at, attempt.created_at)
      else coalesce(attempt.updated_at, attempt.saved_at, attempt.created_at)
    end) desc, attempt.attempt_id desc limit 1;

  insert into public.student_practice_item_state (
    student_id, task_type, item_id, status, resume_attempt_id, resume_source_question_id,
    latest_attempt_id, latest_completed_attempt_id, attempt_count,
    last_started_at, last_completed_at, latest_result, updated_at
  ) values (
    p_student_id, p_task_type, p_item_id::text,
    case when v_resume is not null then 'in_progress' else 'completed' end,
    v_resume, case when v_resume is not null then v_resume_question_id else null end,
    v_latest, v_completed, v_count, v_last_started_at, v_last_completed_at, null, clock_timestamp()
  ) on conflict (student_id, task_type, item_id) do update
  set status = excluded.status,
    resume_attempt_id = excluded.resume_attempt_id,
    resume_source_question_id = excluded.resume_source_question_id,
    latest_attempt_id = excluded.latest_attempt_id,
    latest_completed_attempt_id = excluded.latest_completed_attempt_id,
    attempt_count = excluded.attempt_count,
    last_started_at = excluded.last_started_at,
    last_completed_at = excluded.last_completed_at,
    latest_result = excluded.latest_result, updated_at = excluded.updated_at;
end;
$function$;

-- 2/7: Writing student enumeration only; BAS branch stays unchanged.
CREATE OR REPLACE FUNCTION public.rebuild_student_practice_item_state_for_item(p_item_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
declare
  v_task_type text;
  v_student_id uuid;
begin
  if p_item_id is null then return; end if;
  select item.task_type into v_task_type from public.practice_items item where item.item_id = p_item_id;
  if v_task_type is null then return; end if;
  if v_task_type = 'build_sentence' then
    for v_student_id in
      select distinct attempt.student_id from public.attempts attempt
      join public.practice_item_sources source on source.item_id = p_item_id
        and source.task_type = 'build_sentence' and source.source_set_id = btrim(attempt.set_id)
    loop
      perform public.rebuild_student_practice_item_state_bas(v_student_id, p_item_id);
    end loop;
    return;
  end if;
  if v_task_type in ('email', 'academic_discussion') then
    for v_student_id in
      select distinct attempt.user_id from public.writing_attempts attempt
      join public.practice_item_sources source on source.item_id = p_item_id
        and source.task_type = v_task_type and source.source_question_id = attempt.question_id
      where attempt.task_type = v_task_type and attempt.assignment_id is null
        and attempt.attempt_kind = 'original'
    loop
      perform public.rebuild_student_practice_item_state_writing(v_student_id, v_task_type, p_item_id);
    end loop;
  end if;
end;
$function$;

-- 3/7: unchanged original routing, correction-only events do no ordinary work.
CREATE OR REPLACE FUNCTION public.sync_student_practice_item_state_writing()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
begin
  if tg_op <> 'INSERT' then
    if old.attempt_kind = 'original' and old.assignment_id is null then
      perform public.rebuild_student_practice_item_state_for_writing_question(
        old.user_id, old.task_type, old.question_id);
    end if;
  end if;
  if tg_op = 'INSERT' then
    if new.attempt_kind = 'original' and new.assignment_id is null then
      perform public.rebuild_student_practice_item_state_for_writing_question(
        new.user_id, new.task_type, new.question_id);
    end if;
  elsif tg_op = 'UPDATE' then
    if new.attempt_kind = 'original' and new.assignment_id is null
      and (old.user_id is distinct from new.user_id
        or old.task_type is distinct from new.task_type
        or old.question_id is distinct from new.question_id) then
      perform public.rebuild_student_practice_item_state_for_writing_question(
        new.user_id, new.task_type, new.question_id);
    end if;
  end if;
  return null;
end;
$function$;

-- 4/7: preserve ALL SIX currently live sources; filter only Writing.
CREATE OR REPLACE FUNCTION public.rebuild_student_practice_summary(p_student_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
declare v_total bigint; v_latest timestamptz;
begin
  if p_student_id is null then return; end if;
  select coalesce(sum(part.duration_seconds),0),max(part.completed_at) into v_total,v_latest from (
    select greatest(coalesce(elapsed_seconds,0),0)::bigint as duration_seconds,submitted_at as completed_at
      from public.reading_attempts where student_id = p_student_id and status = 'submitted' and submitted_at is not null
    union all select greatest(coalesce(elapsed_seconds,0),0)::bigint,submitted_at
      from public.reading_wrongbook_attempts where student_id = p_student_id and status = 'submitted' and submitted_at is not null
    union all select greatest(coalesce(time_spent_seconds,0),0)::bigint,submitted_at
      from public.attempts where student_id = p_student_id and submitted_at is not null
    union all select greatest(coalesce(elapsed_seconds,0),0)::bigint,submitted_at
      from public.writing_attempts where user_id = p_student_id and status = 'submitted' and submitted_at is not null
        and attempt_kind = 'original'
    union all select 0::bigint,completed_at from public.reading_full_set_attempts
      where student_id = p_student_id and status = 'completed' and completed_at is not null
    union all select elapsed_seconds::bigint,completed_at from public.reading_question_category_sessions
      where student_id = p_student_id and status = 'completed' and completed_at is not null
  ) part;
  if v_total = 0 and v_latest is null then
    delete from public.student_practice_summary where student_id = p_student_id; return;
  end if;
  insert into public.student_practice_summary(student_id,total_practice_seconds,latest_practice_at,updated_at)
    values(p_student_id,v_total,v_latest,clock_timestamp())
  on conflict(student_id) do update set total_practice_seconds = excluded.total_practice_seconds,
    latest_practice_at = excluded.latest_practice_at,updated_at = clock_timestamp();
end;
$function$;

-- 5/7: trigger remains draft->submitted; ordinary increment unchanged.
CREATE OR REPLACE FUNCTION public.sync_student_practice_summary_writing()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
begin
  if new.attempt_kind <> 'original' then return null; end if;
  perform public.apply_student_practice_summary_increment(
    new.user_id, greatest(coalesce(new.elapsed_seconds, 0), 0)::bigint, new.submitted_at);
  return null;
end;
$function$;

-- 6/7: exactly the existing calendar with ONE Writing predicate added.
CREATE OR REPLACE FUNCTION public.read_practice_activity_dates_v1(
  p_student uuid, p_month date, p_timezone text, p_tasks text[], p_teacher boolean DEFAULT false
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $function$
declare lo timestamptz; hi timestamptz; result jsonb;
begin
  if p_student is null or p_month is null or p_timezone is null or p_tasks is null or p_teacher is null
    or p_month <> date_trunc('month',p_month)::date or p_month < date '2026-07-01'
    or p_month > date_trunc('month',current_timestamp at time zone p_timezone)::date
    or not p_tasks <@ array['ctw','rdl','rap','full_set','build_sentence','email','academic_discussion']::text[] then
    raise exception 'INVALID_CALENDAR_QUERY';
  end if;
  lo := p_month::timestamp at time zone p_timezone;
  hi := (p_month + interval '1 month')::timestamp at time zone p_timezone;
  select coalesce(jsonb_agg(day order by day),'[]'::jsonb) into result from (
    select distinct to_char(at at time zone p_timezone,'YYYY-MM-DD') as day from (
      select a.submitted_at as at from public.reading_attempts a
        where a.student_id=p_student and a.status='submitted' and a.task_type=any(p_tasks)
          and a.submitted_at>=lo and a.submitted_at<hi
      union all
      select a.completed_at from public.reading_full_set_attempts a
        where 'full_set'=any(p_tasks) and a.student_id=p_student and a.status='completed'
          and a.completed_at>=lo and a.completed_at<hi
      union all
      select a.completed_at from public.reading_question_category_sessions a
        where 'rap'=any(p_tasks) and a.student_id=p_student and a.status='completed'
          and a.completed_at>=lo and a.completed_at<hi
      union all
      select a.submitted_at from public.attempts a
        where 'build_sentence'=any(p_tasks) and a.student_id=p_student
          and a.submitted_at>=lo and a.submitted_at<hi
          and (p_teacher or (lower(btrim(a.set_id)) not like 'wrongbook-%'
            and lower(btrim(a.set_id)) not like 'grammar-all-%'
            and lower(btrim(a.set_id)) not like 'grammar-random-%'))
      union all
      select a.submitted_at from public.writing_attempts a
        where a.user_id=p_student and a.status='submitted' and a.task_type=any(p_tasks)
          and a.attempt_kind='original'
          and a.submitted_at>=lo and a.submitted_at<hi
      union all
      -- Match teacher day history: unfinished frozen sessions are not records;
      -- a completed session's task overrides its constituent material task.
      select a.submitted_at from public.reading_wrongbook_attempts a
      left join lateral (
        select s.status,case when s.task_type in ('ctw','rdl','rap') then s.task_type else (
          -- Mixed-session day records inherit that day's earliest material,
          -- exactly like the existing teacher history grouping/filter rule.
          select w.task_type from public.reading_wrongbook_attempts w
          where w.student_id=p_student and w.status='submitted'
            and w.submitted_at>=date_trunc('day',a.submitted_at at time zone p_timezone) at time zone p_timezone
            and w.submitted_at<(date_trunc('day',a.submitted_at at time zone p_timezone)+interval '1 day') at time zone p_timezone
            and exists(select 1 from jsonb_each(s.progress) e where e.value->>'attemptId'=w.attempt_id::text)
          order by w.submitted_at,w.attempt_id limit 1
        ) end as task_type from public.student_wrong_question_sessions s
        where s.student_id=p_student and s.created_at<hi
          and (s.completed_at is null or s.completed_at>=lo)
          and exists(select 1 from jsonb_each(s.progress) e where e.value->>'attemptId'=a.attempt_id::text)
        limit 1
      ) session on true
      where p_teacher and a.student_id=p_student and a.status='submitted'
        and a.submitted_at>=lo and a.submitted_at<hi
        and (session.status is null or session.status='completed')
        and (case when session.task_type in ('ctw','rdl','rap') then session.task_type else a.task_type end)=any(p_tasks)
    ) activity where at<=current_timestamp
  ) days;
  return result;
end;
$function$;

-- 7/7: same result protocol, locking and review eligibility; independent draft
-- identities. The unique index is the authority when another transaction races.
CREATE OR REPLACE FUNCTION public.moderate_teacher_writing_attempts(p_action text, p_attempt_ids uuid[])
RETURNS TABLE(attempt_id uuid, outcome text, reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
declare
  v_id uuid;
  v_attempt public.writing_attempts%rowtype;
  v_review_exists boolean;
  v_conflicting_draft_exists boolean;
  v_mutated integer;
  v_constraint text;
begin
  if p_action not in ('return', 'ignore') then
    raise exception 'UNSUPPORTED_WRITING_MODERATION_ACTION: %', p_action;
  end if;
  foreach v_id in array coalesce(p_attempt_ids, '{}'::uuid[]) loop
    attempt_id := v_id;
    outcome := 'skipped';
    reason := 'not_found';
    select * into v_attempt from public.writing_attempts wa where wa.attempt_id = v_id for update;
    if not found then return next; continue; end if;
    if v_attempt.status <> 'submitted' then
      reason := 'not_submitted'; return next; continue;
    end if;
    select exists (select 1 from public.writing_reviews r where r.attempt_id = v_id)
      into v_review_exists;
    if v_review_exists then reason := 'already_reviewed'; return next; continue; end if;

    if p_action = 'return' then
      select exists (
        select 1 from public.writing_attempts d
        where d.status = 'draft' and d.user_id = v_attempt.user_id and d.attempt_id <> v_id
          and (
            (v_attempt.attempt_kind = 'correction' and d.attempt_kind = 'correction'
              and d.original_attempt_id = v_attempt.original_attempt_id)
            or
            (v_attempt.attempt_kind = 'original' and d.attempt_kind = 'original' and (
              (v_attempt.assignment_id is not null and d.assignment_id = v_attempt.assignment_id)
              or (v_attempt.assignment_id is null and d.assignment_id is null
                and d.task_type = v_attempt.task_type and d.question_id = v_attempt.question_id)
            ))
          )
      ) into v_conflicting_draft_exists;
      if v_conflicting_draft_exists then reason := 'draft_exists'; return next; continue; end if;

      begin
        update public.writing_attempts wa set status = 'draft', submitted_at = null,
          remaining_seconds = case when wa.attempt_kind = 'original' and wa.writing_mode = 'exam'
            then wa.time_limit_seconds else wa.remaining_seconds end
        where wa.attempt_id = v_id and wa.status = 'submitted';
        get diagnostics v_mutated = row_count;
      exception when unique_violation then
        get stacked diagnostics v_constraint = CONSTRAINT_NAME;
        if (v_attempt.attempt_kind = 'correction' and v_constraint = 'writing_attempts_one_correction_draft')
          or (v_attempt.attempt_kind = 'original' and v_constraint in (
            'writing_attempts_one_draft_per_question','writing_attempts_one_assignment_draft')) then
          reason := 'draft_exists'; return next; continue;
        end if;
        raise;
      end;
      if v_mutated <> 1 then reason := 'not_submitted'; return next; continue; end if;
      outcome := 'returned'; reason := null; return next; continue;
    end if;

    insert into public.writing_reviews (
      attempt_id, task_type, status, ai_model, ai_generated_at, ai_review_raw,
      language_edits, scores, content_feedback, teacher_comment
    ) values (
      v_id, v_attempt.task_type, 'ignored', null, null, null,
      '[]'::jsonb, '{}'::jsonb, '{"items":[],"overall_feedback":""}'::jsonb, ''
    ) on conflict on constraint writing_reviews_attempt_unique do nothing;
    get diagnostics v_mutated = row_count;
    if v_mutated <> 1 then reason := 'already_reviewed'; return next; continue; end if;
    outcome := 'ignored'; reason := null; return next; continue;
  end loop;
end;
$function$;

-- CREATE OR REPLACE preserves the reviewed owners/ACLs. Do not add EXECUTE to
-- authenticated or add auth.uid checks to a service-only RPC called by the
-- already-scoped teacher API. Fail if any replacement altered metadata.
DO $postconditions$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_temp.writing_correction_1a_function_acl b
    LEFT JOIN pg_proc p ON p.oid=b.oid
    WHERE p.oid IS NULL OR p.proowner IS DISTINCT FROM b.proowner
      OR p.proacl IS DISTINCT FROM b.proacl OR p.prosecdef IS DISTINCT FROM b.prosecdef
      OR p.proconfig IS DISTINCT FROM b.proconfig OR p.provolatile IS DISTINCT FROM b.provolatile
  ) THEN RAISE EXCEPTION 'PHASE1A_FUNCTION_SECURITY_METADATA_CHANGED'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_temp.writing_correction_1a_before b JOIN (
      SELECT 'attempts'::text AS object_name, count(*) AS row_count,
        md5(coalesce(string_agg(md5((to_jsonb(a)-ARRAY[
          'attempt_kind','original_attempt_id','correction_source_snapshot','draft_version'])::text),
          '' ORDER BY a.attempt_id),'')) AS fingerprint FROM public.writing_attempts a
      UNION ALL SELECT 'reviews', count(*),
        md5(coalesce(string_agg(md5(to_jsonb(r)::text),'' ORDER BY r.review_id),'')) FROM public.writing_reviews r
    ) after_data USING (object_name)
    WHERE b.row_count IS DISTINCT FROM after_data.row_count OR b.fingerprint IS DISTINCT FROM after_data.fingerprint
  ) THEN RAISE EXCEPTION 'PHASE1A_EXISTING_DATA_CHANGED'; END IF;
  IF EXISTS (SELECT 1 FROM public.writing_attempts WHERE attempt_kind <> 'original'
    OR original_attempt_id IS NOT NULL OR correction_source_snapshot IS NOT NULL OR draft_version <> 0) THEN
    RAISE EXCEPTION 'PHASE1A_UNEXPECTED_CORRECTION_DATA';
  END IF;
END;
$postconditions$;
COMMIT;
