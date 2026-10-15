-- Read-only post-install checks. No import, grading or content mutation.
begin;
set transaction read only;
do $$ begin
  if exists(select 1 from pg_proc where oid='public.start_ctw_vocabulary_list_v1(text,text,integer)'::regprocedure
    and md5(prosrc)='563fe3b06d13955c6df3e8a5b9a46097') then
    raise exception 'CTW_VOCAB_PHASE3_START_OWNER_FIX_REQUIRED';
  end if;
  if (select count(*) from public.ctw_vocabulary_cefr_memberships)<>(select count(*) from public.ctw_vocabulary_entries)
    or exists(select 1 from public.ctw_vocabulary_cefr_memberships m join public.ctw_vocabulary_entries e using(entry_id)
      where m.cefr_group<>case when e.cefr in ('C1','C2') then 'C1-C2' else e.cefr end)
    or exists(select 1 from public.ctw_vocabulary_cefr_memberships group by cefr_group,list_number
      having count(*)>50 or min(list_position)<>1 or max(list_position)<>count(*)) then
    raise exception 'CTW_VOCAB_PHASE3_MEMBERSHIP_INVALID';
  end if;
  if exists(select 1 from pg_class where oid in ('public.ctw_vocabulary_cefr_memberships'::regclass,
    'public.student_ctw_vocabulary_list_progress'::regclass) and not relrowsecurity) then
    raise exception 'CTW_VOCAB_PHASE3_RLS_REQUIRED';
  end if;
  if has_table_privilege('authenticated','public.student_ctw_vocabulary_list_progress','INSERT,UPDATE,DELETE')
    or has_table_privilege('authenticated','public.ctw_vocabulary_cefr_memberships','INSERT,UPDATE,DELETE')
    or has_function_privilege('anon','public.start_ctw_vocabulary_list_v1(text,text,integer)','EXECUTE')
    or has_function_privilege('authenticated','ctw_vocab_private.record_list_result()','EXECUTE') then
    raise exception 'CTW_VOCAB_PHASE3_BROWSER_WRITE_PRIVILEGE';
  end if;
  if not exists(select 1 from pg_trigger where tgrelid='public.ctw_vocabulary_entries'::regclass
    and tgname='ctw_vocabulary_append_cefr' and tgenabled='O')
    or not exists(select 1 from pg_trigger where tgrelid='public.student_ctw_vocabulary_attempts'::regclass
      and tgname='ctw_vocabulary_record_list_result' and tgenabled='O') then
    raise exception 'CTW_VOCAB_PHASE3_TRIGGER_REQUIRED';
  end if;
end $$;
select cefr_group,list_number,count(*) word_count from public.ctw_vocabulary_cefr_memberships
group by cefr_group,list_number order by cefr_group,list_number;
select 'CTW_VOCAB_PHASE3_VERIFY_OK' status;
commit;
