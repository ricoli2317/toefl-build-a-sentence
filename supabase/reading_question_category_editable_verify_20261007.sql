-- MANUAL verification after reading_question_category_editable_20261007.sql.
-- Metadata + anonymous denial ONLY; no real content/user/session rows touched.
-- Full answer-edit/finalize behavior is tested by the local embedded PostgreSQL
-- fixture script, not by creating production sessions. Always rolls back.
begin;
do $$
declare v_submit text; v_draft text; v_rpc text;
begin
  if to_regprocedure('public.submit_reading_question_category_group(uuid,text,integer,jsonb)') is not null then
    raise exception 'Obsolete frozen-group RPC still available';
  end if;
  foreach v_rpc in array array[
    'submit_reading_question_category_group(uuid,text,integer,jsonb,boolean,bigint)',
    'save_reading_question_category_draft(uuid,text,jsonb)'
  ] loop
    if to_regprocedure('public.' || v_rpc) is null
      or not has_function_privilege('authenticated','public.' || v_rpc,'EXECUTE')
      or has_function_privilege('anon','public.' || v_rpc,'EXECUTE') then
      raise exception 'Invalid RPC / privileges: %',v_rpc;
    end if;
    if not exists (select 1 from pg_proc where oid = to_regprocedure('public.' || v_rpc)
      and prosecdef and proconfig @> array['search_path=public']) then
      raise exception 'Missing definer/search_path guard: %',v_rpc;
    end if;
  end loop;
  v_submit := pg_get_functiondef('public.submit_reading_question_category_group(uuid,text,integer,jsonb,boolean,bigint)'::regprocedure);
  v_draft := pg_get_functiondef('public.save_reading_question_category_draft(uuid,text,jsonb)'::regprocedure);
  if v_submit not like '%on conflict (session_id,question_id) do update%'
    or v_submit not like '%if p_finalize then%'
    or v_submit not like '%apply_student_wrong_question_events%'
    or v_submit not like '%Asia/Shanghai%'
    or v_submit not like '%elapsed_seconds = v_elapsed%'
    or v_draft not like '%workspaces%'
    or v_draft not like '%revision%' then raise exception 'Missing editable/finalize semantics'; end if;
  if has_function_privilege('authenticated','public.apply_student_wrong_question_events(uuid,date,jsonb)','EXECUTE') then
    raise exception 'General wrong-bank writer must stay privileged';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.reading_question_category_session_answers'::regclass
    and contype = 'u' and pg_get_constraintdef(oid) like '%session_id, question_id%') then
    raise exception 'Missing answer uniqueness';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.reading_question_category_sessions'::regclass
    and tgname = 'reading_category_summary_completed' and not tgisinternal and tgenabled <> 'D'
    and pg_get_triggerdef(oid) like '%old.status%active%new.status%completed%') then
    raise exception 'Missing one-transition summary trigger';
  end if;
end; $$;
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{}',true);
do $$
declare v_denied boolean;
begin
  v_denied := false;
  begin perform public.submit_reading_question_category_group(gen_random_uuid(),'no-real-item',0,'[]'::jsonb,true,1);
  exception when others then
    if sqlerrm not like '%READING_STUDENT_REQUIRED%' then raise; end if; v_denied := true;
  end;
  if not v_denied then raise exception 'Anonymous submit accepted'; end if;
  v_denied := false;
  begin perform public.save_reading_question_category_draft(gen_random_uuid(),'no-real-item','{}'::jsonb);
  exception when others then
    if sqlerrm not like '%READING_STUDENT_REQUIRED%' then raise; end if; v_denied := true;
  end;
  if not v_denied then raise exception 'Anonymous draft accepted'; end if;
end; $$;
select 'question_category_editable_verification_passed' as result;
rollback;
