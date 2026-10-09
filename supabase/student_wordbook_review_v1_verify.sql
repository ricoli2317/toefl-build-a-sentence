-- MANUAL ONLY / READ ONLY. Run immediately after migration, before recollecting.
begin transaction read only;
set local statement_timeout='60s';
do $$
declare t text; f record; installed public.student_wordbook_review_installation%rowtype;
begin
  select * into installed from public.student_wordbook_review_installation where version='v1';
  if not found then raise exception 'REVIEW_INSTALLATION_MISSING'; end if;
  if (select sum((v->>'entries')::integer) from jsonb_array_elements(installed.cleanup_counts) v)<>81 then raise exception 'REVIEW_CLEANUP_AUDIT_DRIFT'; end if;
  if exists(select 1 from public.student_wordbook_entries where student_id in (
    'bdd0bd35-e23d-4b59-934f-cbc9de875a93','523be430-1f13-4660-8f11-1d263fc1438e','c05d7082-ae31-46a0-918c-ae3de880017a')) then
    raise exception 'REVIEW_APPROVED_COLLECTIONS_NOT_EMPTY'; end if;
  foreach t in array array['student_wordbook_senses','student_wordbook_examples','student_wordbook_example_senses',
    'student_wordbook_canonical_links','student_wordbook_activities','student_wordbook_source_evidence'] loop
    if exists(select 1 from pg_constraint where conrelid=to_regclass('public.'||t) and contype='f' and not convalidated) then
      raise exception 'REVIEW_UNVALIDATED_CHILD_FK: %',t; end if;
    execute format('select exists(select 1 from public.%I c left join public.student_wordbook_entries w using(wordbook_entry_id)
      where w.wordbook_entry_id is null or (c.student_id,c.domain) is distinct from (w.student_id,w.domain))',t) into f;
    if f.exists then raise exception 'REVIEW_ORPHAN_OR_OWNER_DRIFT: %',t; end if;
  end loop;
  foreach t in array array['student_wordbook_source_evidence','student_wordbook_review_sessions','student_wordbook_review_items',
    'student_wordbook_review_answers','student_wordbook_review_installation'] loop
    if not exists(select 1 from pg_class where oid=to_regclass('public.'||t) and relrowsecurity) then raise exception 'REVIEW_RLS_MISSING: %',t; end if;
    if has_table_privilege('anon','public.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_table_privilege('authenticated','public.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege('anon','public.'||t,'SELECT,INSERT,UPDATE,REFERENCES')
      or has_any_column_privilege('authenticated','public.'||t,'SELECT,INSERT,UPDATE,REFERENCES') then raise exception 'REVIEW_CLIENT_ACL_UNSAFE: %',t; end if;
  end loop;
  if has_table_privilege('service_role','public.student_wordbook_review_items','UPDATE,DELETE')
    or has_table_privilege('service_role','public.student_wordbook_review_answers','UPDATE,DELETE') then raise exception 'REVIEW_SNAPSHOT_SERVICE_ACL_UNSAFE'; end if;
  for f in select key as signature,value #>> '{}' as body_hash from jsonb_each(installed.function_hashes) loop
    if not exists(select 1 from pg_proc where oid=to_regprocedure(f.signature) and not prosecdef
      and proconfig=array['search_path=pg_catalog']::text[]
      and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))=f.body_hash)
      or has_function_privilege('anon',f.signature,'EXECUTE') or has_function_privilege('authenticated',f.signature,'EXECUTE')
      or not has_function_privilege('service_role',f.signature,'EXECUTE') then raise exception 'REVIEW_RPC_OR_ACL_DRIFT: %',f.signature; end if;
  end loop;
  if not exists(select 1 from pg_proc where oid=to_regprocedure('public.operate_student_wordbook_v1(uuid,uuid,text,jsonb)')
    and strpos(prosrc,'insert into public.student_wordbook_source_evidence')>0) then raise exception 'REVIEW_SAVE_EVIDENCE_MISSING'; end if;
  for t in select unnest(array['student_wordbook_review_sessions_history_idx','student_wordbook_review_sessions_random_idx',
    'student_wordbook_review_sessions_parent_idx','student_wordbook_review_items_rotation_idx','student_wordbook_review_answers_session_idx',
    'student_wordbook_source_evidence_filter_idx','student_wordbook_source_evidence_canonical_idx']) loop
    if not exists(select 1 from pg_index where indexrelid=to_regclass('public.'||t) and indisvalid) then raise exception 'REVIEW_INDEX_MISSING: %',t; end if;
  end loop;
  if not exists(select 1 from pg_constraint where conrelid='public.student_wordbook_review_items'::regclass
    and contype='u' and pg_get_constraintdef(oid)='UNIQUE (session_id, wordbook_entry_id)') then raise exception 'REVIEW_ENTRY_UNIQUENESS_MISSING'; end if;
  if exists(select 1 from pg_constraint where conrelid='public.student_wordbook_review_items'::regclass
    and contype='f' and confrelid='public.student_wordbook_entries'::regclass) then raise exception 'REVIEW_HISTORY_MUST_SURVIVE_UNFAVOURITE'; end if;
  for f in select * from (values
    ('student_wordbook_review_items','review_items_immutable','public.wordbook_review_immutable()'),
    ('student_wordbook_review_answers','review_answers_immutable','public.wordbook_review_immutable()'),
    ('student_wordbook_review_sessions','review_session_guard','public.wordbook_review_session_guard()'),
    ('student_wordbook_source_evidence','student_wordbook_source_evidence_snapshot_guard','public.guard_student_wordbook_snapshot()')
  ) v(table_name,trigger_name,signature) loop
    if not exists(select 1 from pg_trigger where tgrelid=to_regclass('public.'||f.table_name) and tgname=f.trigger_name
      and tgenabled='O' and tgtype=19 and tgfoid=to_regprocedure(f.signature)) then raise exception 'REVIEW_IMMUTABLE_TRIGGER_MISSING: %',f.table_name; end if;
  end loop;
end;
$$;
-- Count comparisons are observations, not evidence against unrelated concurrent legitimate writes.
select i.protected_counts as before_counts,jsonb_build_object('users',(select count(*) from auth.users),
  'profiles',(select count(*) from public.profiles),'lexicalEntries',(select count(*) from public.lexical_entries),
  'lexicalOccurrences',(select count(*) from public.lexical_occurrences)) as after_counts
from public.student_wordbook_review_installation i where version='v1';
select public.wordbook_review_pos_options() as actual_stable_pos_options;
select 'WORDBOOK_REVIEW_VERIFY_OK' as result;
commit;
