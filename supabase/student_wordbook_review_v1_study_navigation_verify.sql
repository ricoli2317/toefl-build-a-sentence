-- MANUAL, read-only. Checks capability/ACL/audit without moving any cursor.
begin transaction read only;
do $$
declare signature text; expected text; body text;
begin
  signature := to_regprocedure('public.wordbook_review_flow_state(uuid,uuid,text,uuid,jsonb)')::text;
  if signature is null then raise exception 'REVIEW_STUDY_NAV_REQUIRED'; end if;
  select coalesce(function_hashes->>signature,function_hashes->>('public.'||signature)) into expected
    from public.student_wordbook_review_installation where version='v1';
  select prosrc into body from pg_proc where oid=signature::regprocedure
    and not prosecdef and proconfig=array['search_path=pg_catalog']::text[];
  if expected is null or body is null or md5(btrim(replace(body,E'\r\n',E'\n'),E' \t\r\n'))<>expected
    or strpos(body,$actions$'read','study_previous','study_next','repeat','start_test','answer','advance'$actions$)=0
    or strpos(body,$branch$    if p_action='study_previous' and f.phase='study' then
      f.position:=greatest(1,f.position-1);
    elsif p_action='study_next' and f.phase='study' then$branch$)=0
    or has_function_privilege('anon',signature,'EXECUTE')
    or has_function_privilege('authenticated',signature,'EXECUTE')
    or not has_function_privilege('service_role',signature,'EXECUTE') then
    raise exception 'REVIEW_STUDY_NAV_FUNCTION_OR_ACL_DRIFT';
  end if;
end;
$$;
commit;
select 'WORDBOOK_REVIEW_STUDY_NAVIGATION_VERIFY_OK' as result;
