-- USER EXECUTES MANUALLY. Targeted data correction, not a vocabulary reimport.
-- Apply after Phase 3. Existing attempts/progress/memberships/snapshots untouched.
-- Keep source_sha256 as the provenance of the original imported attachment;
-- this explicitly reviewed delta is documented separately in the JSON manifest.
begin;
set local lock_timeout='10s';
set local statement_timeout='60s';
lock table public.ctw_vocabulary_entries in share row exclusive mode;
do $$
declare patch jsonb; old_forms jsonb; unchanged_before text;
begin
  select md5(coalesce(jsonb_agg(to_jsonb(e)-'irregular_forms' order by e.entry_id)::text,'')) into unchanged_before from public.ctw_vocabulary_entries e;
  for patch in select value from jsonb_array_elements('[
    {"word":"craftsperson","before":[{"form_type":"plural","answers":["craftspeople","craftspersons"]}],"after":[{"form_type":"plural","answers":["craftspeople"]}]},
    {"word":"millennium","before":[{"form_type":"plural","answers":["millennia","millenniums"]}],"after":[{"form_type":"plural","answers":["millennia"]}]},
    {"word":"leaf","before":[{"form_type":"plural","answers":["leaves"]}],"after":[]}
  ]'::jsonb) loop
    select e.irregular_forms into old_forms from public.ctw_vocabulary_entries e where e.word=patch->>'word';
    if not found or (old_forms<>patch->'before' and old_forms<>patch->'after') then
      raise exception 'CTW_SPELLING_REVIEW_DRIFT: %',patch->>'word';
    end if;
    update public.ctw_vocabulary_entries e set irregular_forms=patch->'after'
      where e.word=patch->>'word' and e.irregular_forms<>patch->'after';
  end loop;
  if unchanged_before<>(select md5(coalesce(jsonb_agg(to_jsonb(e)-'irregular_forms' order by e.entry_id)::text,'')) from public.ctw_vocabulary_entries e)
    then raise exception 'CTW_SPELLING_UNRELATED_DATA_CHANGED'; end if;
end $$;
commit;
