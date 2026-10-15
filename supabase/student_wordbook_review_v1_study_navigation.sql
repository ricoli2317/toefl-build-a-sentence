-- MANUAL incremental patch AFTER the accepted immersive review migration.
-- No schema, vocabulary, session, answer, history or grading changes.
-- Adds study_previous to the existing service-only, owner-checked flow RPC.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $patch$
declare audit jsonb; signature text; expected text; definition text; body text;
  old_actions text := $old$'read','study_next','repeat','start_test','answer','advance'$old$;
  new_actions text := $new$'read','study_previous','study_next','repeat','start_test','answer','advance'$new$;
  old_branch text := $old$    if p_action='study_next' and f.phase='study' then$old$;
  new_branch text := $new$    if p_action='study_previous' and f.phase='study' then
      f.position:=greatest(1,f.position-1);
    elsif p_action='study_next' and f.phase='study' then$new$;
begin
  signature := to_regprocedure('public.wordbook_review_flow_state(uuid,uuid,text,uuid,jsonb)')::text;
  if signature is null then raise exception 'REVIEW_STUDY_NAV_IMMERSIVE_REQUIRED'; end if;
  select function_hashes into audit from public.student_wordbook_review_installation where version='v1' for update;
  expected := coalesce(audit->>signature,audit->>('public.'||signature));
  select prosrc,pg_get_functiondef(oid) into body,definition from pg_proc
    where oid=signature::regprocedure and not prosecdef and proconfig=array['search_path=pg_catalog']::text[];
  if expected is null or body is null or md5(btrim(replace(body,E'\r\n',E'\n'),E' \t\r\n'))<>expected
    or has_function_privilege('anon',signature,'EXECUTE')
    or has_function_privilege('authenticated',signature,'EXECUTE')
    or not has_function_privilege('service_role',signature,'EXECUTE') then
    raise exception 'REVIEW_STUDY_NAV_BASELINE_DRIFT';
  end if;
  -- Repeat-safe only when BOTH additions are present and match the audit.
  if strpos(body,new_actions)>0 and strpos(body,new_branch)>0 then return; end if;
  if (length(body)-length(replace(body,old_actions,'')))<>length(old_actions)
    or (length(body)-length(replace(body,old_branch,'')))<>length(old_branch)
    or strpos(body,'study_previous')>0 then raise exception 'REVIEW_STUDY_NAV_BODY_DRIFT'; end if;
  execute replace(replace(definition,old_actions,new_actions),old_branch,new_branch);
  update public.student_wordbook_review_installation set function_hashes=(function_hashes-
    array[signature,'public.'||signature])||jsonb_build_object(signature,(
      select md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n')) from pg_proc where oid=signature::regprocedure))
    where version='v1';
end;
$patch$;
notify pgrst,'reload schema';
commit;
select 'WORDBOOK_REVIEW_STUDY_NAVIGATION_OK' as result;
