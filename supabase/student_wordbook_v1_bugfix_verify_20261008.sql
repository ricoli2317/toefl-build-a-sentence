-- READ ONLY. After incremental installation. No production fixture inserts.
begin transaction read only;
do $$
declare r record; t text;
begin
  for r in select * from (values
    ('public.operate_student_wordbook_v1(uuid,uuid,text,jsonb)','ae7b641ab11d258581b0665a23a230f9'),
    ('public.read_student_wordbook_v1(uuid,text,integer,integer,text,timestamptz,timestamptz)','dec6074fd48dcba5d0f20aecc14b987d'),
    ('public.guard_student_wordbook_snapshot()','191ca9347272bbf0e210c5baa45980d8')
  ) v(signature,body_hash) loop
    if not exists(select 1 from pg_proc where oid=to_regprocedure(r.signature)
      and not prosecdef and proconfig=array['search_path=pg_catalog']::text[]
      and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))=r.body_hash)
      or has_function_privilege('anon',r.signature,'EXECUTE')
      or has_function_privilege('authenticated',r.signature,'EXECUTE')
      or not has_function_privilege('service_role',r.signature,'EXECUTE') then
      raise exception 'WORDBOOK_BUGFIX_VERIFY_RPC_OR_ACL_DRIFT: %',r.signature;
    end if;
  end loop;
  if not exists(select 1 from pg_attribute where attrelid='public.student_wordbook_entries'::regclass
    and attname='source_types' and atttypid='text[]'::regtype and attnotnull and not attisdropped)
    or not exists(select 1 from pg_constraint where conrelid='public.student_wordbook_entries'::regclass
      and conname='student_wordbook_entries_sources_valid' and convalidated) then
      raise exception 'WORDBOOK_BUGFIX_VERIFY_PROVENANCE_REQUIRED'; end if;
  foreach t in array array['student_wordbook_entries','student_wordbook_senses','student_wordbook_examples',
    'student_wordbook_example_senses','student_wordbook_canonical_links','student_wordbook_activities'] loop
    if not exists(select 1 from pg_class where oid=to_regclass('public.'||t) and relrowsecurity) then
      raise exception 'WORDBOOK_BUGFIX_VERIFY_RLS: %',t; end if;
    if has_table_privilege('anon','public.'||t,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_table_privilege('authenticated','public.'||t,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege('authenticated','public.'||t,'INSERT,UPDATE,REFERENCES') then
      raise exception 'WORDBOOK_BUGFIX_VERIFY_BROWSER_WRITE_ACL: %',t; end if;
    if t<>'student_wordbook_activities' and not exists(select 1 from pg_trigger
      where tgrelid=to_regclass('public.'||t) and tgname=t||'_snapshot_guard' and tgenabled='O'
        and tgfoid=to_regprocedure('public.guard_student_wordbook_snapshot()')) then
        raise exception 'WORDBOOK_BUGFIX_VERIFY_SNAPSHOT_GUARD: %',t; end if;
  end loop;
  if not exists(select 1 from pg_trigger where tgrelid='public.student_wordbook_activities'::regclass
    and tgname='student_wordbook_activities_append_guard' and tgenabled='O'
    and tgfoid=to_regprocedure('public.guard_student_wordbook_activity()')) then
    raise exception 'WORDBOOK_BUGFIX_VERIFY_ACTIVITY_GUARD_REQUIRED'; end if;
  if exists(select 1 from public.student_wordbook_entries w where w.source_types<>'{}'::text[]
    and not public.wordbook_source_types_valid(w.source_types,w.domain))
    or exists(select 1 from public.student_wordbook_examples x join public.student_wordbook_entries w using(wordbook_entry_id)
      where not (x.source_types <@ w.source_types)) then raise exception 'WORDBOOK_BUGFIX_VERIFY_SOURCE_DRIFT'; end if;
  if exists(select 1 from public.student_wordbook_entries w where not exists(
    select 1 from public.student_wordbook_activities a where a.wordbook_entry_id=w.wordbook_entry_id)) then
      raise exception 'WORDBOOK_BUGFIX_VERIFY_ACTIVITY_MISSING'; end if;
end;
$$;
commit;
select 'WORDBOOK_BUGFIX_VERIFY_OK' as result;
