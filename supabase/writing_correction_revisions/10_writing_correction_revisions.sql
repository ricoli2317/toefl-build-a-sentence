-- MANUAL ONLY. Not executed by the agent. Requires Phase 1A, 1B and 4.
-- Does NOT open/replace/disable the closed Gate or change any existing row.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog, public;
DO $preflight$
BEGIN
  IF current_user <> 'postgres' THEN RAISE EXCEPTION 'RUN_AS_POSTGRES'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.writing_attempts'::regclass
    AND tgname='writing_attempts_correction_closed_gate' AND tgenabled='O'
    AND tgfoid='public.block_writing_corrections_until_backend_ready()'::regprocedure) THEN
    RAISE EXCEPTION 'WRITING_CORRECTION_CLOSED_GATE_REQUIRED';
  END IF;
  PERFORM 'public.writing_correction_reviews'::regclass;
  PERFORM 'public.save_writing_correction(uuid,uuid,bigint,text)'::regprocedure;
END;
$preflight$;

-- JS and ProseMirror use UTF-16 units, NOT PostgreSQL character offsets.
CREATE FUNCTION public.writing_revision_utf16(p_text text) RETURNS integer[]
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $function$
DECLARE result integer[] := '{}'; c integer; i integer;
BEGIN
  FOR i IN 1..char_length(p_text) LOOP
    c := ascii(substr(p_text,i,1));
    IF c > 65535 THEN
      result := result || ARRAY[55296+(c-65536)/1024,56320+(c-65536)%1024];
    ELSE result := array_append(result,c); END IF;
  END LOOP;
  RETURN result;
END;
$function$;

CREATE FUNCTION public.valid_writing_revision(p_state jsonb, p_original text, p_text text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $function$
DECLARE
  l jsonb := p_state->'ledger'; s jsonb; d jsonb; x jsonb;
  a integer[] := public.writing_revision_utf16(p_original);
  b integer[] := public.writing_revision_utf16(p_text);
  payload integer[]; seen boolean[] := array_fill(false,ARRAY[cardinality(a)]);
  positions integer[] := ARRAY[1]; event_positions integer[] := '{}'; event_sources integer[] := '{}';
  ids text[] := '{}'; i integer := 0; n integer; prev integer; pos integer := 1; at_offset integer;
  projection integer[];
BEGIN
  IF jsonb_typeof(p_state) <> 'object' OR p_state->'schema_version' IS DISTINCT FROM '1'::jsonb
    OR jsonb_typeof(l) IS DISTINCT FROM 'object'
    OR l->'original' IS DISTINCT FROM to_jsonb(p_original) OR l->'text' IS DISTINCT FROM to_jsonb(p_text)
    OR jsonb_typeof(l->'sources') IS DISTINCT FROM 'array'
    OR jsonb_typeof(l->'deletions') IS DISTINCT FROM 'array'
    OR jsonb_array_length(l->'sources') <> cardinality(b) THEN RETURN false; END IF;
  FOR i IN 1..cardinality(b) LOOP
    s := l->'sources'->(i-1);
    IF jsonb_typeof(s)='number' THEN
      n := (s::text)::integer;
      IF n < 0 OR n >= cardinality(a) OR seen[n+1] OR a[n+1] <> b[i] THEN RETURN false; END IF;
      seen[n+1] := true;
      event_positions := array_append(event_positions,(i-1)*2+1);
      event_sources := array_append(event_sources,n);
    ELSIF jsonb_typeof(s) <> 'string' OR length(s#>>'{}') NOT BETWEEN 1 AND 128 THEN RETURN false;
    END IF;
    pos := pos + CASE WHEN b[i]=10 THEN 2 ELSE 1 END;
    positions := array_append(positions,pos);
  END LOOP;
  FOR d IN SELECT value FROM jsonb_array_elements(l->'deletions') LOOP
    IF jsonb_typeof(d) <> 'object' OR jsonb_typeof(d->'id') IS DISTINCT FROM 'string'
      OR length(d->>'id') NOT BETWEEN 1 AND 128 OR (d->>'id')=ANY(ids)
      OR jsonb_typeof(d->'text') IS DISTINCT FROM 'string'
      OR jsonb_typeof(d->'sources') IS DISTINCT FROM 'array'
      OR jsonb_typeof(d->'position') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
    ids := array_append(ids,d->>'id'); payload := public.writing_revision_utf16(d->>'text');
    IF cardinality(payload)=0 OR cardinality(payload) <> jsonb_array_length(d->'sources') THEN RETURN false; END IF;
    at_offset := array_position(positions,(d->>'position')::integer)-1;
    IF at_offset IS NULL THEN RETURN false; END IF;
    i := 0; prev := NULL;
    FOR x IN SELECT value FROM jsonb_array_elements(d->'sources') LOOP
      IF jsonb_typeof(x) <> 'number' THEN RETURN false; END IF;
      n := (x::text)::integer; i := i+1;
      IF n < 0 OR n >= cardinality(a) OR seen[n+1] OR a[n+1] <> payload[i]
        OR (prev IS NOT NULL AND n <> prev+1) THEN RETURN false; END IF;
      seen[n+1] := true; prev := n;
      event_positions := array_append(event_positions,at_offset*2);
      event_sources := array_append(event_sources,n);
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(l->'sources') s(value)
    WHERE jsonb_typeof(value)='string' AND (value#>>'{}')=ANY(ids)) THEN RETURN false; END IF;
  IF array_position(seen,false) IS NOT NULL THEN RETURN false; END IF;
  SELECT coalesce(array_agg(src ORDER BY anchor,src),'{}'::integer[]) INTO projection
    FROM unnest(event_positions,event_sources) AS e(anchor,src);
  IF projection IS DISTINCT FROM ARRAY(SELECT generate_series(0,cardinality(a)-1)) THEN RETURN false; END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$function$;

CREATE TABLE public.writing_correction_revision_states (
  attempt_id uuid PRIMARY KEY REFERENCES public.writing_attempts(attempt_id) ON DELETE RESTRICT,
  saved_draft_version bigint NOT NULL CHECK (saved_draft_version >= 0),
  revision_state jsonb NOT NULL CHECK (jsonb_typeof(revision_state)='object'
    AND revision_state->'schema_version'='1'::jsonb),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.writing_correction_revision_states ENABLE ROW LEVEL SECURITY;
-- No browser policy. Authenticated APIs repeat owner/teacher scope before reads.
REVOKE ALL ON public.writing_correction_revision_states FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.writing_correction_revision_states TO service_role;

CREATE FUNCTION public.guard_writing_correction_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE a public.writing_attempts%rowtype;
BEGIN
  SELECT * INTO a FROM public.writing_attempts WHERE attempt_id=NEW.attempt_id FOR UPDATE;
  IF NOT FOUND OR a.attempt_kind <> 'correction' OR a.status <> 'draft'
    OR NEW.saved_draft_version <> a.draft_version
    OR (TG_OP='UPDATE' AND (NEW.attempt_id <> OLD.attempt_id OR NEW.saved_draft_version <= OLD.saved_draft_version))
    OR EXISTS (SELECT 1 FROM public.writing_correction_reviews WHERE attempt_id=a.attempt_id AND status='published')
    OR NOT public.valid_writing_revision(NEW.revision_state,a.correction_source_snapshot->>'original_response_text',a.response_text)
  THEN RAISE EXCEPTION 'WRITING_CORRECTION_REVISION_INVALID'; END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$function$;
CREATE TRIGGER writing_correction_revision_guard BEFORE INSERT OR UPDATE
  ON public.writing_correction_revision_states FOR EACH ROW EXECUTE FUNCTION public.guard_writing_correction_revision();

-- New corrections start with exactly one persisted baseline in the SAME create
-- transaction. Legacy drafts are NOT backfilled here: they need the one-time
-- exact Diff adapter to preserve their existing effective responseText.
CREATE FUNCTION public.initialize_writing_correction_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE sources jsonb;
BEGIN
  IF NEW.attempt_kind <> 'correction' THEN RETURN NEW; END IF;
  SELECT coalesce(jsonb_agg(n ORDER BY n),'[]'::jsonb) INTO sources
    FROM generate_series(0,cardinality(public.writing_revision_utf16(NEW.response_text))-1) AS n;
  INSERT INTO public.writing_correction_revision_states(attempt_id,saved_draft_version,revision_state)
    VALUES(NEW.attempt_id,NEW.draft_version,jsonb_build_object('schema_version',1,'ledger',
      jsonb_build_object('original',NEW.correction_source_snapshot->>'original_response_text',
        'text',NEW.response_text,'sources',sources,'deletions','[]'::jsonb)));
  RETURN NEW;
END;
$function$;
CREATE TRIGGER writing_correction_revision_initialization AFTER INSERT ON public.writing_attempts
  FOR EACH ROW EXECUTE FUNCTION public.initialize_writing_correction_revision();

-- Body+ledger in ONE transaction and under the SAME parent-row CAS lock.
-- Delegate the existing count/version/closed-Gate semantics, don't reproduce them.
CREATE FUNCTION public.save_writing_correction_revision(
  p_student uuid,p_attempt uuid,p_expected_version bigint,p_response_text text,p_revision_state jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE result jsonb; a public.writing_attempts%rowtype;
BEGIN
  IF p_expected_version IS NULL OR p_expected_version < 0 OR p_response_text IS NULL THEN
    RAISE EXCEPTION 'WRITING_CORRECTION_INVALID_INPUT';
  END IF;
  -- Keep Phase 1B's profile -> parent lock order and failure precedence.
  PERFORM 1 FROM public.profiles WHERE id=p_student AND role IN ('student','admin')
    AND is_active IS DISTINCT FROM false FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WRITING_CORRECTION_ACCOUNT_FORBIDDEN'; END IF;
  SELECT * INTO a FROM public.writing_attempts WHERE attempt_id=p_attempt
    AND user_id=p_student AND attempt_kind='correction' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WRITING_CORRECTION_NOT_FOUND'; END IF;
  IF a.status <> 'draft' THEN RAISE EXCEPTION 'WRITING_CORRECTION_SUBMITTED_LOCKED'; END IF;
  IF a.draft_version <> p_expected_version THEN RAISE EXCEPTION 'WRITING_CORRECTION_VERSION_CONFLICT'; END IF;
  IF p_revision_state IS NULL OR NOT public.valid_writing_revision(p_revision_state,
    a.correction_source_snapshot->>'original_response_text',p_response_text) THEN
    RAISE EXCEPTION 'WRITING_CORRECTION_REVISION_INVALID';
  END IF;
  result := public.save_writing_correction(p_student,p_attempt,p_expected_version,p_response_text);
  INSERT INTO public.writing_correction_revision_states(attempt_id,saved_draft_version,revision_state)
    VALUES(p_attempt,(result->'attempt'->>'draft_version')::bigint,p_revision_state)
    ON CONFLICT(attempt_id) DO UPDATE SET saved_draft_version=EXCLUDED.saved_draft_version,revision_state=EXCLUDED.revision_state;
  RETURN jsonb_set(result,'{attempt,revision_state}',p_revision_state);
END;
$function$;

-- Old text-only writes must not bypass the ledger contract. The new definer RPC
-- (owned by postgres) can still delegate to Phase 1B's unchanged implementation.
REVOKE EXECUTE ON FUNCTION public.save_writing_correction(uuid,uuid,bigint,text) FROM service_role;
REVOKE ALL ON FUNCTION public.save_writing_correction_revision(uuid,uuid,bigint,text,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_writing_correction_revision(uuid,uuid,bigint,text,jsonb) TO service_role;

-- Preserve submitted/frozen traces. Existing submit RPC and idempotent retry are
-- unchanged; legacy drafts must first save an initialized ledger through CAS.
CREATE FUNCTION public.require_writing_correction_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE r public.writing_correction_revision_states%rowtype;
BEGIN
  IF NEW.attempt_kind <> 'correction' THEN RETURN NEW; END IF;
  IF OLD.status='submitted' AND NEW.status='draft' AND EXISTS
    (SELECT 1 FROM public.writing_correction_reviews WHERE attempt_id=OLD.attempt_id) THEN
    RAISE EXCEPTION 'WRITING_CORRECTION_ALREADY_REVIEWED';
  END IF;
  IF OLD.status='draft' AND NEW.status='submitted' THEN
    SELECT * INTO r FROM public.writing_correction_revision_states WHERE attempt_id=NEW.attempt_id;
    IF NOT FOUND OR NOT public.valid_writing_revision(r.revision_state,
      NEW.correction_source_snapshot->>'original_response_text',NEW.response_text) THEN
      RAISE EXCEPTION 'WRITING_CORRECTION_REVISION_REQUIRED';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER writing_correction_revision_submission BEFORE UPDATE ON public.writing_attempts
  FOR EACH ROW EXECUTE FUNCTION public.require_writing_correction_revision();

-- Defense against accidental direct service-role text updates: the ledger must
-- agree at COMMIT, after the RPC has atomically saved both rows. Legacy rows
-- without a ledger remain readable; this migration performs NO data backfill.
CREATE FUNCTION public.check_writing_correction_revision_consistency() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE a public.writing_attempts%rowtype; r public.writing_correction_revision_states%rowtype;
BEGIN
  IF NEW.attempt_kind <> 'correction' THEN RETURN NULL; END IF;
  SELECT * INTO a FROM public.writing_attempts WHERE attempt_id=NEW.attempt_id;
  SELECT * INTO r FROM public.writing_correction_revision_states WHERE attempt_id=NEW.attempt_id;
  IF FOUND AND (r.saved_draft_version > a.draft_version OR NOT public.valid_writing_revision(r.revision_state,
    a.correction_source_snapshot->>'original_response_text',a.response_text)) THEN
    RAISE EXCEPTION 'WRITING_CORRECTION_REVISION_INVALID';
  END IF;
  RETURN NULL;
END;
$function$;
CREATE CONSTRAINT TRIGGER writing_correction_revision_consistency AFTER UPDATE ON public.writing_attempts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_writing_correction_revision_consistency();

REVOKE ALL ON FUNCTION public.writing_revision_utf16(text),public.valid_writing_revision(jsonb,text,text),
  public.guard_writing_correction_revision(),public.require_writing_correction_revision(),
  public.initialize_writing_correction_revision(),
  public.check_writing_correction_revision_consistency() FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON TABLE public.writing_correction_revision_states IS
  'Correction-only v1 transaction ledger. One row per adopted correction; final text is writing_attempts.response_text. No AI state.';
COMMIT;
