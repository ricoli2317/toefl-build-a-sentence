-- READ ONLY. Run before the incremental bugfix, not A1/A2/A3 again.
begin transaction read only;
do $$
declare r record; t text;
begin
  for r in select * from (values
    ('public.operate_student_wordbook_v1(uuid,uuid,text,jsonb)','8410d56364ef419a2a21f81159d391c7'),
    ('public.read_student_wordbook_v1(uuid,text,integer,integer,text,timestamptz,timestamptz)','08cd77dcb9ea8ae35f98fda856949b5d'),
    ('public.guard_student_wordbook_snapshot()','3212671fa54ba4ba38ff6d3a6b8c036e')
  ) v(signature,body_hash) loop
    if not exists(select 1 from pg_proc where oid=to_regprocedure(r.signature)
      and not prosecdef and proconfig=array['search_path=pg_catalog']::text[]
      and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))=r.body_hash)
      or has_function_privilege('anon',r.signature,'EXECUTE')
      or has_function_privilege('authenticated',r.signature,'EXECUTE')
      or not has_function_privilege('service_role',r.signature,'EXECUTE') then
      raise exception 'WORDBOOK_BUGFIX_A3_RPC_OR_ACL_DRIFT: %',r.signature;
    end if;
  end loop;
  foreach t in array array['student_wordbook_entries','student_wordbook_senses','student_wordbook_examples',
    'student_wordbook_example_senses','student_wordbook_canonical_links','student_wordbook_activities'] loop
    if not exists(select 1 from pg_class where oid=to_regclass('public.'||t) and relrowsecurity) then
      raise exception 'WORDBOOK_BUGFIX_TABLE_REQUIRED: %',t; end if;
    if t<>'student_wordbook_activities' and not exists(select 1 from pg_trigger
      where tgrelid=to_regclass('public.'||t) and tgname=t||'_snapshot_guard' and tgenabled='O'
        and tgfoid=to_regprocedure('public.guard_student_wordbook_snapshot()')) then
      raise exception 'WORDBOOK_BUGFIX_SNAPSHOT_GUARD_REQUIRED: %',t; end if;
  end loop;
  if not exists(select 1 from pg_trigger where tgrelid='public.student_wordbook_activities'::regclass
    and tgname='student_wordbook_activities_append_guard' and tgenabled='O'
    and tgfoid=to_regprocedure('public.guard_student_wordbook_activity()')) then
    raise exception 'WORDBOOK_BUGFIX_ACTIVITY_GUARD_REQUIRED'; end if;
  if exists(select 1 from pg_attribute where attrelid='public.student_wordbook_entries'::regclass
    and attname='source_types' and not attisdropped) then raise exception 'WORDBOOK_BUGFIX_ALREADY_INSTALLED'; end if;
end;
$$;
commit;
select 'WORDBOOK_BUGFIX_PREFLIGHT_OK' as result;
