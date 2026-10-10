-- MANUAL, READ ONLY. Run after the incremental immersive migration.
begin transaction read only;
do $$
declare audit jsonb; f record;
begin
  select function_hashes into audit from public.student_wordbook_review_installation where version='v1';
  if audit is null then raise exception 'REVIEW_IMMERSIVE_AUDIT_MISSING'; end if;
  for f in select key signature,value #>> '{}' hash from jsonb_each(audit) loop
    if not exists(select 1 from pg_proc where oid=to_regprocedure(f.signature) and not prosecdef
      and proconfig=array['search_path=pg_catalog']::text[]
      and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))=f.hash)
      or has_function_privilege('anon',f.signature,'EXECUTE')
      or has_function_privilege('authenticated',f.signature,'EXECUTE')
      or not has_function_privilege('service_role',f.signature,'EXECUTE') then
      raise exception 'REVIEW_IMMERSIVE_FUNCTION_OR_ACL_DRIFT: %',f.signature; end if;
  end loop;
  if not exists(select 1 from pg_class where oid='public.student_wordbook_review_flow'::regclass and relrowsecurity)
    or has_table_privilege('anon','public.student_wordbook_review_flow','SELECT,INSERT,UPDATE,DELETE')
    or has_table_privilege('authenticated','public.student_wordbook_review_flow','SELECT,INSERT,UPDATE,DELETE')
    or not has_table_privilege('service_role','public.student_wordbook_review_flow','SELECT')
    or not has_table_privilege('service_role','public.student_wordbook_review_flow','INSERT')
    or not has_table_privilege('service_role','public.student_wordbook_review_flow','UPDATE')
    or has_table_privilege('service_role','public.student_wordbook_review_flow','DELETE') then
    raise exception 'REVIEW_IMMERSIVE_TABLE_ACL_DRIFT'; end if;
  if to_regprocedure('public.wordbook_review_flow_state(uuid,uuid,text,uuid,jsonb)') is null
    or not coalesce(audit ? to_regprocedure('public.wordbook_review_flow_state(uuid,uuid,text,uuid,jsonb)')::text,false)
    or not exists(select 1 from pg_proc where oid='public.wordbook_review_submit(uuid,uuid,uuid,jsonb)'::regprocedure
      and strpos(prosrc,'not between 0 and 300')>0 and strpos(prosrc,'sc:=public.wordbook_review_spelling')>0) then
    raise exception 'REVIEW_IMMERSIVE_CONTRACT_DRIFT'; end if;
  if exists(select 1 from public.student_wordbook_review_flow cursor_row
    join public.student_wordbook_review_sessions s using(session_id)
    where cursor_row.position>s.total or (cursor_row.phase='study' and s.answered>0)
      or (cursor_row.phase='result' and s.status<>'completed')) then
    raise exception 'REVIEW_IMMERSIVE_CURSOR_DRIFT'; end if;
end;
$$;
commit;
select 'WORDBOOK_REVIEW_IMMERSIVE_VERIFY_OK' as result;
