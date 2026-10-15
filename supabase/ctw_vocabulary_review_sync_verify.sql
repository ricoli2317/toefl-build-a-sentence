-- Read-only verification AFTER ctw_vocabulary_review_sync.sql.
begin;
set transaction read only;
do $$ begin
  if to_regclass('public.student_ctw_vocabulary_review_sessions') is null then raise exception 'CTW_REVIEW_SYNC_INSTALL_REQUIRED'; end if;
  if not (select relrowsecurity from pg_class where oid='public.student_ctw_vocabulary_review_sessions'::regclass)
    or has_table_privilege('authenticated','public.student_ctw_vocabulary_review_sessions','INSERT,UPDATE,DELETE')
    or has_table_privilege('anon','public.student_ctw_vocabulary_review_sessions','SELECT') then raise exception 'CTW_REVIEW_SYNC_ACL_INVALID'; end if;
  if has_function_privilege('authenticated','public.create_ctw_vocabulary_review_v1(uuid,uuid,jsonb,jsonb,uuid)','EXECUTE')
    or has_function_privilege('authenticated','public.sync_ctw_vocabulary_review_v1(uuid,uuid,integer,jsonb,jsonb,jsonb)','EXECUTE')
    or has_function_privilege('anon','public.read_ctw_vocabulary_review_history_v1(integer,integer)','EXECUTE') then raise exception 'CTW_REVIEW_SYNC_RPC_ACL_INVALID'; end if;
  if exists(select 1 from public.student_ctw_vocabulary_review_sessions s where s.answered>s.total or s.correct>s.answered
    or s.phase='result' and not exists(select 1 from public.student_ctw_vocabulary_attempts a where a.student_id=s.student_id and a.attempt_id=s.session_id))
    then raise exception 'CTW_REVIEW_SYNC_STATE_INVALID'; end if;
end $$;
select 'CTW_VOCAB_REVIEW_SYNC_VERIFY_OK' status;
commit;
