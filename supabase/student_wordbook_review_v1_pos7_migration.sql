-- USER-MANUAL incremental patch. No collection cleanup, corpus writes, new
-- tables/indexes/cache, or updates to immutable sessions/items/answers/evidence.
begin;
set local lock_timeout='5s';
do $patch$
declare f record; audit jsonb; before_meta jsonb; after_meta jsonb; definition text;
  marker text:='      pos_id:=public.wordbook_review_pos(s.context_pos);';
begin
  -- Serialize patch installers only; never lock student/corpus tables.
  select function_hashes into audit from public.student_wordbook_review_installation where version='v1' for update;
  if audit is null then raise exception 'REVIEW_POS7_V1_INSTALLATION_REQUIRED'; end if;
  if to_regprocedure('public.wordbook_review_teaching_pos(text)') is not null then raise exception 'REVIEW_POS7_ALREADY_PRESENT'; end if;
  for f in select * from (values
    ('public.wordbook_review_pos(text)','b5e62c55574e066010057109dfb8a940'),
    ('public.wordbook_review_pos_options()','935d88d46af380ce7e9a6a7bb7f95660'),
    ('public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)','c92a987caba650ba97f930a8bb564b41'),
    ('public.wordbook_review_create(uuid,jsonb,uuid,uuid)','d2ce1306146315adb838f6fad776fd1c')
  ) expected(signature,hash) loop
    if not exists(select 1 from pg_proc where oid=to_regprocedure(f.signature)
      and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))=f.hash)
      or not coalesce(audit ? to_regprocedure(f.signature)::text,false) then
      raise exception 'REVIEW_POS7_BASELINE_DRIFT: %',f.signature; end if;
  end loop;
  if not exists(select 1 from pg_proc where oid=to_regprocedure('public.wordbook_review_pos_options()')
    and prorettype='jsonb'::regtype and provolatile='s')
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
    'public.wordbook_review_create(uuid,jsonb,uuid,uuid)',
    'public.wordbook_review_submit(uuid,uuid,uuid,jsonb)',
    'public.wordbook_review_public_item(public.student_wordbook_review_items,public.student_wordbook_review_answers)',
    'public.wordbook_review_summary(uuid)']) as signature loop
    if to_regprocedure(f.signature) is null or not coalesce(audit ? to_regprocedure(f.signature)::text,false) then
      raise exception 'REVIEW_POS7_REQUIRED_DEPENDENCY_MISSING: %',f.signature; end if;
  end loop;
  select jsonb_object_agg(oid::text,jsonb_build_object('owner',proowner,'acl',proacl)) into before_meta
    from pg_proc where oid in (to_regprocedure('public.wordbook_review_pos_options()'),
      to_regprocedure('public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)'),
      to_regprocedure('public.wordbook_review_create(uuid,jsonb,uuid,uuid)'));
  execute $ddl$
create or replace function public.wordbook_review_pos_options() returns jsonb
language sql immutable set search_path=pg_catalog as $$
  select '[{"id":"noun","label":"n."},{"id":"verb","label":"v."},{"id":"adjective","label":"adj."},{"id":"adverb","label":"adv."},{"id":"preposition","label":"prep."},{"id":"conjunction","label":"conj."},{"id":"pronoun","label":"pron."}]'::jsonb;
$$;
$ddl$;
  execute $ddl$
create function public.wordbook_review_teaching_pos(p text) returns text
language sql immutable set search_path=pg_catalog as $$
  -- Keep original canonical/collection POS normalization unchanged.
  select case public.wordbook_review_pos(p)
    when 'noun' then 'noun' when 'proper_noun' then 'noun'
    when 'verb' then 'verb' when 'phrasal_verb' then 'verb'
    when 'auxiliary' then 'verb' when 'modal' then 'verb'
    when 'adjective' then 'adjective' when 'adverb' then 'adverb'
    when 'preposition' then 'preposition' when 'conjunction' then 'conjunction'
    when 'pronoun' then 'pronoun' else null end;
$$;
$ddl$;
  revoke all on function public.wordbook_review_teaching_pos(text) from public,anon,authenticated;
  grant execute on function public.wordbook_review_teaching_pos(text) to service_role;
  definition:=pg_get_functiondef(to_regprocedure('public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)'));
  if strpos(definition,marker)=0 or strpos(substr(definition,strpos(definition,marker)+length(marker)),marker)>0 then
    raise exception 'REVIEW_POS7_CANDIDATE_MARKER_DRIFT'; end if;
  execute replace(definition,marker,$replacement$      pos_id:=case when mode='spelling_pos' then public.wordbook_review_teaching_pos(s.context_pos)
        else public.wordbook_review_pos(s.context_pos) end;$replacement$);
  -- Every newly created spelling item, including a retry copied from a historical
  -- snapshot, follows POS7. Never rewrite or regrade an existing item/answer.
  definition:=pg_get_functiondef(to_regprocedure('public.wordbook_review_create(uuid,jsonb,uuid,uuid)'));
  marker:='    position:=position+1;snap:=c.v->''snapshot'';';
  if strpos(definition,marker)=0 or strpos(substr(definition,strpos(definition,marker)+length(marker)),marker)>0 then
    raise exception 'REVIEW_POS7_CREATE_MARKER_DRIFT'; end if;
  execute replace(definition,marker,$replacement$    position:=position+1;snap:=c.v->'snapshot';
    if c.v->>'kind'='spelling_pos' then
      if public.wordbook_review_teaching_pos(snap->>'standardPos') is null then
        raise exception 'REVIEW_INVALID_POS'; end if;
      snap:=snap||jsonb_build_object('pos',public.wordbook_review_teaching_pos(snap->>'standardPos'),
        'posOptions',public.wordbook_review_pos_options());
    end if;$replacement$);
  select jsonb_object_agg(oid::text,jsonb_build_object('owner',proowner,'acl',proacl)) into after_meta
    from pg_proc where oid in (to_regprocedure('public.wordbook_review_pos_options()'),
      to_regprocedure('public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)'),
      to_regprocedure('public.wordbook_review_create(uuid,jsonb,uuid,uuid)'));
  if before_meta is distinct from after_meta then raise exception 'REVIEW_POS7_OWNER_OR_ACL_CHANGED'; end if;
  if has_function_privilege('anon','public.wordbook_review_teaching_pos(text)','EXECUTE')
    or has_function_privilege('authenticated','public.wordbook_review_teaching_pos(text)','EXECUTE') then
    raise exception 'REVIEW_POS7_HELPER_ACL_UNSAFE'; end if;
  -- Preserve cleanup/protected-count/installation history; update only the
  -- fingerprints of changed helpers in the EXISTING installation audit row.
  update public.student_wordbook_review_installation set function_hashes=function_hashes||(
    select jsonb_object_agg(oid::regprocedure::text,md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n')))
    from pg_proc where oid in (to_regprocedure('public.wordbook_review_pos_options()'),
      to_regprocedure('public.wordbook_review_teaching_pos(text)'),
      to_regprocedure('public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)'),
      to_regprocedure('public.wordbook_review_create(uuid,jsonb,uuid,uuid)'))
  ) where version='v1';
end;
$patch$;
commit;
select 'WORDBOOK_REVIEW_POS7_MIGRATION_OK' as result;
