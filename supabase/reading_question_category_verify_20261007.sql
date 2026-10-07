-- Run ONLY after reading_question_category_sessions_20261007.sql succeeds.
-- Metadata assertions and anonymous-rejection tests only. NO student/content
-- records are read or created. Everything in the test transaction is rolled back.
begin;
do $$
declare v_table text; v_function text; v_count integer; v_checks text;
begin
  foreach v_table in array array['reading_question_category_sessions','reading_question_category_session_answers'] loop
    if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = v_table and c.relrowsecurity) then
      raise exception 'Missing RLS table: %', v_table;
    end if;
    if not has_table_privilege('authenticated','public.'||v_table,'SELECT')
      or has_table_privilege('authenticated','public.'||v_table,'INSERT,UPDATE,DELETE,TRUNCATE')
      or has_table_privilege('anon','public.'||v_table,'SELECT,INSERT,UPDATE,DELETE')
      or exists (select 1 from unnest(array['SELECT','INSERT','UPDATE','DELETE']) privilege
        where not has_table_privilege('service_role','public.'||v_table,privilege)) then
      raise exception 'Incorrect table privileges: %', v_table;
    end if;
    select count(*) into v_count from pg_policies where schemaname = 'public' and tablename = v_table;
    if v_count <> 1 or exists (select 1 from pg_policies where schemaname = 'public' and tablename = v_table
      and (cmd <> 'SELECT' or qual not like '%uid()%')) then raise exception 'Incorrect owner SELECT policies: %', v_table; end if;
  end loop;
  foreach v_function in array array[
    'get_reading_question_category_session(uuid)',
    'reading_question_category_counts()',
    'save_reading_question_category_draft(uuid,text,jsonb)',
    'submit_reading_question_category_group(uuid,text,integer,jsonb)'
  ] loop
    if to_regprocedure('public.'||v_function) is null then raise exception 'Missing RPC: %',v_function; end if;
    if not has_function_privilege('authenticated','public.'||v_function,'EXECUTE')
      or has_function_privilege('anon','public.'||v_function,'EXECUTE') then raise exception 'Incorrect RPC ACL: %',v_function; end if;
    if not exists (select 1 from pg_proc where oid = to_regprocedure('public.'||v_function)
      and prosecdef and proconfig @> array['search_path=public']) then raise exception 'Missing definer/search_path guard: %',v_function; end if;
  end loop;
  if not exists (select 1 from pg_indexes where schemaname = 'public'
    and indexname = 'reading_questions_rap_category_pool_idx'
    and indexdef like '%question_category, logical_item_id, question_order, question_id%'
    and indexdef like '%WHERE%rap%') then raise exception 'Missing covering RAP pool index'; end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'reading_category_sessions_student_completed_idx') then
    raise exception 'Missing completed-session history index'; end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.reading_question_category_session_answers'::regclass
    and contype = 'f' and confrelid = 'public.reading_questions'::regclass
    and cardinality(conkey) = 2) then raise exception 'Missing question/item composite FK'; end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.reading_question_category_session_answers'::regclass
    and contype = 'u' and pg_get_constraintdef(oid) like '%session_id, question_id%') then raise exception 'Missing answer retry uniqueness'; end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.reading_question_category_sessions'::regclass
    and conname = 'reading_category_completion_shape') then raise exception 'Missing completion shape constraint'; end if;
  select string_agg(pg_get_constraintdef(oid),' ') into v_checks from pg_constraint
    where conrelid = 'public.reading_question_category_sessions'::regclass and contype = 'c';
  foreach v_function in array array['事实信息题','否定信息题','主旨题','词汇题','选句题','句子简化题','指代题','推断题','修辞目的题','句子插入题',
    'amount','active','completed','jsonb_typeof(manifest)','jsonb_typeof(progress)','elapsed_seconds','correct_points','total_points'] loop
    if position(v_function in v_checks) = 0 then raise exception 'Missing session CHECK: %',v_function; end if;
  end loop;
  select string_agg(pg_get_constraintdef(oid),' ') into v_checks from pg_constraint
    where conrelid = 'public.reading_question_category_session_answers'::regclass and contype = 'c';
  foreach v_function in array array['option','insertion_anchor','sentence_selection','question_time_seconds','604800'] loop
    if position(v_function in v_checks) = 0 then raise exception 'Missing answer CHECK: %',v_function; end if;
  end loop;
  foreach v_function in array array['reading_category_manifest_guard','reading_category_updated_at','reading_category_summary_completed'] loop
    if not exists (select 1 from pg_trigger where tgrelid = 'public.reading_question_category_sessions'::regclass
      and tgname = v_function and not tgisinternal and tgenabled <> 'D') then raise exception 'Missing enabled trigger: %',v_function; end if;
  end loop;
  if pg_get_functiondef('public.rebuild_student_practice_summary(uuid)'::regprocedure) not like '%reading_question_category_sessions%'
    then raise exception 'Summary rebuild omits category sessions'; end if;
  if exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'public.reading_question_category_sessions'::regclass and not t.tgisinternal
    and pg_get_functiondef(p.oid) like '%student_practice_item_state%') then raise exception 'Category must not write passage completion state'; end if;
end; $$;

-- Safe behavior checks: deliberately no identity, so RPCs reject BEFORE any
-- category lookup/mutation. No real user JWT, targets, profile or answers used.
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{}',true);
do $$
declare v_failed boolean;
begin
  v_failed := false;
  begin perform public.reading_question_category_counts();
  exception when others then
    if sqlerrm not like '%READING_STUDENT_REQUIRED%' then raise; end if; v_failed := true;
  end;
  if not v_failed then raise exception 'Anonymous counts unexpectedly accepted'; end if;
  v_failed := false;
  begin perform public.submit_reading_question_category_group(gen_random_uuid(),'no-real-item',0,'[]'::jsonb);
  exception when others then
    if sqlerrm not like '%READING_STUDENT_REQUIRED%' then raise; end if; v_failed := true;
  end;
  if not v_failed then raise exception 'Anonymous submit unexpectedly accepted'; end if;
end; $$;
select 'question_category_verification_passed' as result;
rollback;
