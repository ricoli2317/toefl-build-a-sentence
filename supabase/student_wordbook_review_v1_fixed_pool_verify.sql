-- USER-MANUAL metadata-only read-only Verify. Does NOT approve/import pool data.
begin transaction read only;
do $check$
declare f record; audit jsonb;
begin
  select function_hashes into audit from public.student_wordbook_review_installation where version='v1';
  if audit is null then raise exception 'REVIEW_FIXED_POOL_INSTALLATION_REQUIRED'; end if;
  for f in select * from (values
    ('public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)','b210f1a05fbea67b249faf81b57d857e'),
    ('public.wordbook_review_meaning_conflict(text,text)','556b46059d2e33322d35dbea5c39ff25'),
    ('public.wordbook_review_teaching_pos(text)','5b16e016919fa57994e70f2c9d6326f9')
  ) expected(signature,hash) loop
    if not exists(select 1 from pg_proc where oid=to_regprocedure(f.signature)
      and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))=f.hash)
      or not coalesce(audit ? to_regprocedure(f.signature)::text,false) then
      raise exception 'REVIEW_FIXED_POOL_DEFINITION_DRIFT: %',f.signature; end if;
  end loop;
  for f in select key as signature,value #>> '{}' as hash from jsonb_each(audit) loop
    if not exists(select 1 from pg_proc where oid=to_regprocedure(f.signature) and not prosecdef
      and proconfig=array['search_path=pg_catalog']::text[]
      and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))=f.hash)
      or has_function_privilege('anon',f.signature,'EXECUTE')
      or has_function_privilege('authenticated',f.signature,'EXECUTE')
      or not has_function_privilege('service_role',f.signature,'EXECUTE') then
      raise exception 'REVIEW_FIXED_POOL_AUDIT_OR_ACL_DRIFT: %',f.signature; end if;
  end loop;
  if not exists(select 1 from pg_class where oid=to_regclass('public.wordbook_review_fixed_distractors') and relrowsecurity)
    or has_table_privilege('anon','public.wordbook_review_fixed_distractors','SELECT')
    or has_table_privilege('authenticated','public.wordbook_review_fixed_distractors','SELECT')
    or not has_table_privilege('service_role','public.wordbook_review_fixed_distractors','SELECT')
    or has_table_privilege('service_role','public.wordbook_review_fixed_distractors','INSERT')
    or has_table_privilege('service_role','public.wordbook_review_fixed_distractors','UPDATE')
    or has_table_privilege('service_role','public.wordbook_review_fixed_distractors','DELETE') then
    raise exception 'REVIEW_FIXED_POOL_TABLE_PERMISSION_DRIFT'; end if;
  if exists(select 1 from pg_proc where oid=to_regprocedure('public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)')
    and strpos(prosrc,'lexical_occurrences')>0) then raise exception 'REVIEW_FIXED_POOL_OCCURRENCE_PATH_REMAINS'; end if;
end;
$check$;
select 'WORDBOOK_REVIEW_FIXED_POOL_VERIFY_OK' as result;
commit;
