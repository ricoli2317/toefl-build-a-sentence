-- USER-MANUAL, READ ONLY. Metadata + constant/scalar evaluations only.
-- No production candidate creation, corpus census, or collection-empty checks.
begin transaction read only;
do $verify$
declare f record; audit jsonb; expected jsonb:=
  '[{"id":"noun","label":"n."},{"id":"verb","label":"v."},{"id":"adjective","label":"adj."},{"id":"adverb","label":"adv."},{"id":"preposition","label":"prep."},{"id":"conjunction","label":"conj."},{"id":"pronoun","label":"pron."}]';
begin
  select function_hashes into audit from public.student_wordbook_review_installation where version='v1';
  if audit is null then raise exception 'REVIEW_POS7_V1_INSTALLATION_REQUIRED'; end if;
  for f in select * from (values
    ('public.wordbook_review_pos_options()','d213c26e14018b2f07d08950ed1c34d6'),
    ('public.wordbook_review_teaching_pos(text)','5b16e016919fa57994e70f2c9d6326f9'),
    ('public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)','ba6a1c52ae0d6c2273953ee674804187'),
    ('public.wordbook_review_create(uuid,jsonb,uuid,uuid)','145d64fa605e851ac3f14dfce5072b55')
  ) expected_function(signature,hash) loop
    if not exists(select 1 from pg_proc where oid=to_regprocedure(f.signature)
      and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))=f.hash)
      or not coalesce(audit ? to_regprocedure(f.signature)::text,false) then
      raise exception 'REVIEW_POS7_PATCH_DEFINITION_DRIFT: %',f.signature; end if;
  end loop;
  if public.wordbook_review_pos_options() is distinct from expected then raise exception 'REVIEW_POS7_OPTIONS_DRIFT'; end if;
  if not exists(select 1 from pg_proc where oid=to_regprocedure('public.wordbook_review_pos_options()')
    and provolatile='i' and prorettype='jsonb'::regtype and not prosecdef
    and proconfig=array['search_path=pg_catalog']::text[]
    and prosrc !~* '(lexical_|jsonb_array_elements|union|observed)') then raise exception 'REVIEW_POS7_OPTIONS_NOT_CONSTANT'; end if;
  if not exists(select 1 from pg_proc where oid=to_regprocedure('public.wordbook_review_pos(text)')
    and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))='b5e62c55574e066010057109dfb8a940') then
    raise exception 'REVIEW_POS7_ORIGINAL_NORMALIZER_CHANGED'; end if;
  for f in select * from (values ('proper_noun','noun'),('n.','noun'),('phrasal verb','verb'),
    ('phr. v.','verb'),('auxiliary','verb'),('aux. v.','verb'),('modal','verb'),
    ('adj.','adjective'),('adv.','adverb'),('prep.','preposition'),('conj.','conjunction'),('pron.','pronoun'),
    ('particle',null),('determiner',null),('interjection',null),('numeral',null),('other',null),('unknown',null)) v(raw,wanted) loop
    if public.wordbook_review_teaching_pos(f.raw) is distinct from f.wanted then raise exception 'REVIEW_POS7_MAPPING_DRIFT: %',f.raw; end if;
  end loop;
  if not exists(select 1 from pg_proc where oid=to_regprocedure('public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)')
    and strpos(prosrc,'public.wordbook_review_teaching_pos(s.context_pos)')>0) then raise exception 'REVIEW_POS7_CANDIDATE_MAPPING_MISSING'; end if;
  if not exists(select 1 from pg_proc where oid=to_regprocedure('public.wordbook_review_create(uuid,jsonb,uuid,uuid)')
    and strpos(prosrc,'public.wordbook_review_teaching_pos(snap->>''standardPos'')')>0) then raise exception 'REVIEW_POS7_CREATE_MAPPING_MISSING'; end if;
  if not exists(select 1 from pg_proc where oid=to_regprocedure('public.wordbook_review_teaching_pos(text)')
    and prorettype='text'::regtype and provolatile='i')
    or not exists(select 1 from pg_proc where oid=to_regprocedure('public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)')
      and prorettype='record'::regtype and proretset and provolatile='s')
    or not exists(select 1 from pg_proc where oid=to_regprocedure('public.wordbook_review_create(uuid,jsonb,uuid,uuid)')
      and prorettype='jsonb'::regtype and provolatile='v') then raise exception 'REVIEW_POS7_FUNCTION_CONTRACT_DRIFT'; end if;
  for f in select key as signature,value #>> '{}' as hash from jsonb_each(audit) loop
    if not exists(select 1 from pg_proc where oid=to_regprocedure(f.signature) and not prosecdef
      and proconfig=array['search_path=pg_catalog']::text[]
      and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))=f.hash)
      or has_function_privilege('anon',f.signature,'EXECUTE')
      or has_function_privilege('authenticated',f.signature,'EXECUTE')
      or not has_function_privilege('service_role',f.signature,'EXECUTE') then
      raise exception 'REVIEW_POS7_DEPENDENCY_OR_ACL_DRIFT: %',f.signature; end if;
  end loop;
  for f in select unnest(array['public.wordbook_review_availability(uuid,jsonb)',
    'public.wordbook_review_submit(uuid,uuid,uuid,jsonb)',
    'public.wordbook_review_public_item(public.student_wordbook_review_items,public.student_wordbook_review_answers)',
    'public.wordbook_review_summary(uuid)']) as signature loop
    if to_regprocedure(f.signature) is null or not coalesce(audit ? to_regprocedure(f.signature)::text,false) then
      raise exception 'REVIEW_POS7_REQUIRED_DEPENDENCY_MISSING: %',f.signature; end if;
  end loop;
end;
$verify$;
select public.wordbook_review_pos_options() as fixed_review_pos_options;
select 'WORDBOOK_REVIEW_POS7_VERIFY_OK' as result;
commit;
