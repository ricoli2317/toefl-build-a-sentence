-- READ ONLY. Run the WHOLE file before the independent batch-delete migration.
begin transaction read only;
do $$
declare r record;
begin
  if to_regprocedure('public.delete_student_wordbook_entries_v1(uuid,text,uuid[])') is not null then
    raise exception 'WORDBOOK_BATCH_ALREADY_INSTALLED'; end if;
  if not exists(select 1 from pg_proc where oid=to_regprocedure('public.operate_student_wordbook_v1(uuid,uuid,text,jsonb)')
    and not prosecdef and proconfig=array['search_path=pg_catalog']::text[]
    and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))='ae7b641ab11d258581b0665a23a230f9') then
    raise exception 'WORDBOOK_BATCH_EXISTING_LOCK_PROTOCOL_DRIFT'; end if;
  for r in select * from (values
    ('student_wordbook_senses','student_wordbook_entries'),
    ('student_wordbook_examples','student_wordbook_entries'),
    ('student_wordbook_canonical_links','student_wordbook_entries'),
    ('student_wordbook_activities','student_wordbook_entries'),
    ('student_wordbook_example_senses','student_wordbook_senses'),
    ('student_wordbook_example_senses','student_wordbook_examples')
  ) v(child,parent) loop
    if not exists(select 1 from pg_constraint c where c.conrelid=to_regclass('public.'||r.child)
      and c.confrelid=to_regclass('public.'||r.parent) and c.contype='f' and c.confdeltype='c' and c.convalidated
      and (select array_agg(a.attname::text) from pg_attribute a where a.attrelid=c.conrelid and a.attnum=any(c.conkey))
        @> array['wordbook_entry_id','student_id','domain']::text[]) then
      raise exception 'WORDBOOK_BATCH_OWNER_CASCADE_REQUIRED: %',r.child; end if;
    if not exists(select 1 from pg_class where oid=to_regclass('public.'||r.child) and relrowsecurity)
      or has_table_privilege('anon','public.'||r.child,'INSERT,UPDATE,DELETE,TRUNCATE')
      or has_table_privilege('authenticated','public.'||r.child,'INSERT,UPDATE,DELETE,TRUNCATE')
      or not has_table_privilege('service_role','public.'||r.child,'DELETE') then
      raise exception 'WORDBOOK_BATCH_TABLE_ACL_DRIFT: %',r.child; end if;
  end loop;
  if not exists(select 1 from pg_class where oid=to_regclass('public.student_wordbook_entries') and relrowsecurity)
    or has_table_privilege('anon','public.student_wordbook_entries','INSERT,UPDATE,DELETE,TRUNCATE')
    or has_table_privilege('authenticated','public.student_wordbook_entries','INSERT,UPDATE,DELETE,TRUNCATE')
    or not has_table_privilege('service_role','public.student_wordbook_entries','SELECT')
    or not has_table_privilege('service_role','public.student_wordbook_entries','DELETE') then
    raise exception 'WORDBOOK_BATCH_ENTRY_ACL_DRIFT'; end if;
end;
$$;
commit;
select 'WORDBOOK_BATCH_PREFLIGHT_OK' as result;
