-- USER-MANUAL READ ONLY. Metadata only: no candidates, sessions or corpus scan.
begin transaction read only;
do $check$
declare f record; audit jsonb;
begin
  select function_hashes into audit from public.student_wordbook_review_installation where version='v1';
  if audit is null then raise exception 'REVIEW_LOCAL_POS_CHOICE_INSTALLATION_REQUIRED'; end if;
  for f in select * from (values
    ('public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)','380323524809f2f1578ca5b2b9f6161a'),
    ('public.wordbook_review_meaning_conflict(text,text)','556b46059d2e33322d35dbea5c39ff25'),
    ('public.wordbook_review_teaching_pos(text)','5b16e016919fa57994e70f2c9d6326f9'),
    ('public.wordbook_review_pos(text)','b5e62c55574e066010057109dfb8a940')
  ) expected(signature,hash) loop
    if not exists(select 1 from pg_proc where oid=to_regprocedure(f.signature)
      and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))=f.hash)
      or not coalesce(audit ? to_regprocedure(f.signature)::text,false) then
      raise exception 'REVIEW_LOCAL_POS_CHOICE_DEFINITION_DRIFT: %',f.signature; end if;
  end loop;
  for f in select key as signature,value #>> '{}' as hash from jsonb_each(audit) loop
    if not exists(select 1 from pg_proc where oid=to_regprocedure(f.signature) and not prosecdef
      and proconfig=array['search_path=pg_catalog']::text[]
      and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))=f.hash)
      or has_function_privilege('anon',f.signature,'EXECUTE')
      or has_function_privilege('authenticated',f.signature,'EXECUTE')
      or not has_function_privilege('service_role',f.signature,'EXECUTE') then
      raise exception 'REVIEW_LOCAL_POS_CHOICE_AUDIT_OR_ACL_DRIFT: %',f.signature; end if;
  end loop;
  if not exists(select 1 from pg_index i where i.indexrelid=to_regclass('public.wordbook_review_occurrence_pos_meaning_idx')
    and i.indrelid='public.lexical_occurrences'::regclass and i.indisvalid and i.indisready
    and md5(pg_get_indexdef(i.indexrelid))='d1cfac98bbd67a5efd4a864dff8c8677') then
    raise exception 'REVIEW_LOCAL_POS_CHOICE_VALID_INDEX_REQUIRED'; end if;
end;
$check$;
select 'WORDBOOK_REVIEW_LOCAL_POS_CHOICE_VERIFY_OK' as result;
commit;
