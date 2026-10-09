-- USER-MANUAL incremental patch AFTER local-pos-choice. No index/table/data edit.
-- Only distractors are filtered; source-linked correct meanings remain unchanged.
begin;
set local lock_timeout='5s';
do $patch$
declare f record; audit jsonb; definition text; before_meta jsonb; after_meta jsonb;
  signature text:='public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)';
  marker text:=$marker$          for d in select v.value from jsonb_array_elements(global_pool) v(value) loop
$marker$;
begin
  select function_hashes into audit from public.student_wordbook_review_installation where version='v1' for update;
  if audit is null then raise exception 'REVIEW_ASCII_DISTRACTOR_INSTALLATION_REQUIRED'; end if;
  if not exists(select 1 from pg_proc where oid=to_regprocedure(signature)
    and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))='380323524809f2f1578ca5b2b9f6161a') then
    raise exception 'REVIEW_ASCII_DISTRACTOR_BASELINE_DRIFT'; end if;
  for f in select key as signature,value #>> '{}' as hash from jsonb_each(audit) loop
    if not exists(select 1 from pg_proc where oid=to_regprocedure(f.signature) and not prosecdef
      and proconfig=array['search_path=pg_catalog']::text[]
      and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))=f.hash)
      or has_function_privilege('anon',f.signature,'EXECUTE')
      or has_function_privilege('authenticated',f.signature,'EXECUTE')
      or not has_function_privilege('service_role',f.signature,'EXECUTE') then
      raise exception 'REVIEW_ASCII_DISTRACTOR_AUDIT_OR_ACL_DRIFT: %',f.signature; end if;
  end loop;
  if not coalesce(audit ? to_regprocedure(signature)::text,false) then
    raise exception 'REVIEW_ASCII_DISTRACTOR_AUDIT_REQUIRED'; end if;
  select jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'stable',provolatile,'type',prorettype,'set',proretset)
    into before_meta from pg_proc where oid=to_regprocedure(signature);
  definition:=pg_get_functiondef(to_regprocedure(signature));
  if strpos(definition,marker)=0 or strpos(substr(definition,strpos(definition,marker)+length(marker)),marker)>0 then
    raise exception 'REVIEW_ASCII_DISTRACTOR_MARKER_DRIFT'; end if;
  -- Shared selection loop covers BOTH local wordbook and global occurrence
  -- tiers. Keep filtering in memory: no SQL predicate added that could walk
  -- unbounded index rows to find a non-ASCII candidate. The 128-key cap stays.
  definition:=replace(definition,marker,marker||$filter$            if d.value->>'meaning'~'[A-Za-z]' then continue; end if;
$filter$);
  execute definition;
  if not exists(select 1 from pg_proc where oid=to_regprocedure(signature)
    and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))='61214848add269f4ac535f8e9fd89682') then
    raise exception 'REVIEW_ASCII_DISTRACTOR_PATCH_MISMATCH'; end if;
  select jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'stable',provolatile,'type',prorettype,'set',proretset)
    into after_meta from pg_proc where oid=to_regprocedure(signature);
  if before_meta is distinct from after_meta then raise exception 'REVIEW_ASCII_DISTRACTOR_CONTRACT_CHANGED'; end if;
  update public.student_wordbook_review_installation set function_hashes=function_hashes||(
    select jsonb_build_object(oid::regprocedure::text,md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n')))
    from pg_proc where oid=to_regprocedure(signature)
  ) where version='v1';
end;
$patch$;
commit;
select 'WORDBOOK_REVIEW_ASCII_DISTRACTOR_MIGRATION_OK' as result;
