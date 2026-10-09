-- USER-MANUAL, read-only metadata Verify. No corpus scan or candidate RPC.
begin transaction read only;
do $check$
declare f record; audit jsonb;
begin
  select function_hashes into audit from public.student_wordbook_review_installation where version='v1';
  if audit is null then raise exception 'REVIEW_OCCURRENCE_CHOICE_INSTALLATION_REQUIRED'; end if;
  for f in select * from (values
    ('public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)','c5797eef7193daf7c9d9a15548f61f88'),
    ('public.wordbook_review_meaning(text)','902c27242565b371d7926b0f93b3920d'),
    ('public.wordbook_review_meaning_conflict(text,text)','93685b2406739fa710c7b78f8a4fd382'),
    ('public.wordbook_review_pos_options()','d213c26e14018b2f07d08950ed1c34d6')
  ) expected(signature,hash) loop
    if not exists(select 1 from pg_proc where oid=to_regprocedure(f.signature)
      and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))=f.hash)
      or not coalesce(audit ? to_regprocedure(f.signature)::text,false) then
      raise exception 'REVIEW_OCCURRENCE_CHOICE_DEFINITION_DRIFT: %',f.signature; end if;
  end loop;
  if not exists(select 1 from pg_proc where oid=to_regprocedure('public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)')
    and prorettype='record'::regtype and proretset and provolatile='s') then
    raise exception 'REVIEW_OCCURRENCE_CHOICE_FUNCTION_CONTRACT_DRIFT'; end if;
  if not exists(select 1 from pg_index i where i.indexrelid=to_regclass('public.wordbook_review_occurrence_meaning_idx')
    and i.indrelid='public.lexical_occurrences'::regclass and i.indisvalid and i.indisready
    and md5(pg_get_indexdef(i.indexrelid))='349512b4b05215449bfb91991f002907') then
    raise exception 'REVIEW_OCCURRENCE_CHOICE_VALID_INDEX_REQUIRED'; end if;
  for f in select key as signature,value #>> '{}' as hash from jsonb_each(audit) loop
    if not exists(select 1 from pg_proc where oid=to_regprocedure(f.signature) and not prosecdef
      and proconfig=array['search_path=pg_catalog']::text[]
      and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))=f.hash)
      or has_function_privilege('anon',f.signature,'EXECUTE')
      or has_function_privilege('authenticated',f.signature,'EXECUTE')
      or not has_function_privilege('service_role',f.signature,'EXECUTE') then
      raise exception 'REVIEW_OCCURRENCE_CHOICE_AUDIT_OR_ACL_DRIFT: %',f.signature; end if;
  end loop;
end;
$check$;
select 'WORDBOOK_REVIEW_OCCURRENCE_CHOICE_VERIFY_OK' as result;
commit;
