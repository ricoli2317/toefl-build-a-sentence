-- Manual read-only verification after the INITIAL import; no answer/history writes.
do $$
begin
  if (select count(*) from public.ctw_vocabulary_entries) <> 1032
    or (select count(*) from public.ctw_vocabulary_entries where source_sha256='09480ce1a52a79906082df9cd0503396c4b334850587f8c95e8629ce63eb38c6') <> 1032
    or (select count(*) from public.ctw_vocabulary_entries where jsonb_array_length(irregular_forms)>0) <> 47
    or (select sum(jsonb_array_length(senses)) from public.ctw_vocabulary_entries) <> 1152
    or (select sum(jsonb_array_length(irregular_forms)) from public.ctw_vocabulary_entries) <> 91 then
    raise exception 'CTW_VOCAB_CONTENT_COUNTS_MISMATCH';
  end if;
  if (select count(distinct list_number) from public.ctw_vocabulary_entries) <> 21
    or exists(select 1 from public.ctw_vocabulary_entries group by list_number
      having min(list_position)<>1 or max(list_position)<>count(*)
      or count(*) <> case when list_number=21 then 32 else 50 end) then
    raise exception 'CTW_VOCAB_LIST_LAYOUT_MISMATCH';
  end if;
  if (select jsonb_object_agg(cefr,n) from (select cefr,count(*) n from public.ctw_vocabulary_entries group by cefr) g)
    <> '{"A1":242,"A2":184,"B1":153,"B2":305,"C1":145,"C2":3}'::jsonb then
    raise exception 'CTW_VOCAB_REVIEWED_CEFR_MISMATCH';
  end if;
  if not (select relrowsecurity from pg_class where oid='public.ctw_vocabulary_entries'::regclass)
    or not (select relrowsecurity from pg_class where oid='public.student_ctw_vocabulary_attempts'::regclass)
    or has_table_privilege('authenticated','public.student_ctw_vocabulary_attempts','INSERT,UPDATE,DELETE')
    or has_table_privilege('anon','public.student_ctw_vocabulary_attempts','SELECT,INSERT,UPDATE,DELETE')
    or has_table_privilege('authenticated','public.ctw_vocabulary_entries','INSERT,UPDATE,DELETE')
    or not has_table_privilege('service_role','public.student_ctw_vocabulary_attempts','INSERT')
    or has_table_privilege('service_role','public.student_ctw_vocabulary_attempts','UPDATE,DELETE')
    or has_function_privilege('anon','public.read_ctw_vocabulary_catalog_v1()','EXECUTE') then
    raise exception 'CTW_VOCAB_SECURITY_CONFIGURATION_MISMATCH';
  end if;
end;
$$;
select list_number,count(*) word_count from public.ctw_vocabulary_entries group by list_number order by list_number;
select cefr,count(*) word_count from public.ctw_vocabulary_entries group by cefr order by cefr;
