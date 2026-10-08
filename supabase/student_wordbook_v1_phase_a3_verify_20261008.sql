-- READ ONLY. Installation integrity, ACL and historical coverage; NOT a
-- substitute for real post-install student save/date-filter acceptance.
begin transaction read only;
set local search_path=pg_catalog;
do $$
declare f record; expected record; role_name text;
begin
  if not exists(select 1 from pg_class where oid=to_regclass('public.student_wordbook_activities') and relrowsecurity) then
    raise exception 'WORDBOOK_A3_ACTIVITY_RLS_REQUIRED'; end if;
  if (select count(*) from pg_attribute where attrelid='public.student_wordbook_activities'::regclass and attnum>0 and not attisdropped)<>6 then
    raise exception 'WORDBOOK_A3_ACTIVITY_COLUMN_DRIFT'; end if;
  for expected in select * from (values
    ('activity_id','uuid'),('wordbook_entry_id','uuid'),('student_id','uuid'),('domain','text'),('event_type','text'),('activity_at','timestamp with time zone')
  ) v(name,type) loop
    if not exists(select 1 from pg_attribute where attrelid='public.student_wordbook_activities'::regclass
      and attname=expected.name and format_type(atttypid,atttypmod)=expected.type and attnotnull) then
      raise exception 'WORDBOOK_A3_ACTIVITY_COLUMN_DRIFT: %',expected.name; end if;
  end loop;
  if not exists(select 1 from pg_constraint where conrelid='public.student_wordbook_activities'::regclass
    and contype='f' and confrelid='public.student_wordbook_entries'::regclass and confdeltype='c' and convalidated
    and conkey=array[2,3,4]::smallint[] and confkey=array[1,2,3]::smallint[]) then
    raise exception 'WORDBOOK_A3_OWNER_CASCADE_FK_REQUIRED'; end if;
  if not exists(select 1 from pg_constraint where conrelid='public.student_wordbook_activities'::regclass
    and contype='p' and conkey=array[1]::smallint[]) then raise exception 'WORDBOOK_A3_ACTIVITY_PK_REQUIRED'; end if;
  if (select md5(string_agg(regexp_replace(pg_get_expr(conbin,conrelid),'\s',' ','g'),'|' order by pg_get_expr(conbin,conrelid)))
    from pg_constraint where conrelid='public.student_wordbook_activities'::regclass and contype='c')
    is distinct from '0923c03da7c46f76489645083f456983' then raise exception 'WORDBOOK_A3_ACTIVITY_CHECK_DRIFT'; end if;
  if not exists(select 1 from pg_trigger where tgrelid='public.student_wordbook_activities'::regclass
    and tgname='student_wordbook_activities_append_guard' and tgenabled='O' and tgtype=19
    and tgfoid=to_regprocedure('public.guard_student_wordbook_activity()')) then
    raise exception 'WORDBOOK_A3_APPEND_GUARD_REQUIRED'; end if;
  for expected in select * from (values
    ('student_wordbook_activities_dates_idx',array['student_id','domain','activity_at','wordbook_entry_id']::text[]),
    ('student_wordbook_activities_entry_idx',array['student_id','domain','wordbook_entry_id','activity_at']::text[])
  ) v(name,columns) loop
    if not exists(select 1 from pg_index i where i.indexrelid=to_regclass('public.'||expected.name)
      and i.indrelid='public.student_wordbook_activities'::regclass and i.indisvalid and i.indisready
      and i.indpred is null and i.indexprs is null and i.indnkeyatts=4
      and (select array_agg(a.attname::text order by k.ordinality) from unnest(i.indkey::smallint[]) with ordinality k(attnum,ordinality)
        join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum)=expected.columns) then
      raise exception 'WORDBOOK_A3_ACTIVITY_INDEX_REQUIRED: %',expected.name; end if;
  end loop;
  for expected in select * from (values
    ('public.operate_student_wordbook_v1(uuid,uuid,text,jsonb)','8410d56364ef419a2a21f81159d391c7'),
    ('public.read_student_wordbook_v1(uuid,text,integer,integer,text,timestamptz,timestamptz)','08cd77dcb9ea8ae35f98fda856949b5d'),
    ('public.read_student_wordbook_activity_dates_v1(uuid,text,text,date)','e27636992ac48333caf6930a25d7ed03'),
    ('public.guard_student_wordbook_activity()','ee08f6b4e23396f047665a3bc82b5bd5')
  ) v(signature,body_hash) loop
    select * into f from pg_proc where oid=to_regprocedure(expected.signature);
    if not found or f.prosecdef or f.proconfig is distinct from array['search_path=pg_catalog']::text[]
      or md5(btrim(replace(f.prosrc,E'\r\n',E'\n'),E' \t\r\n'))<>expected.body_hash
      or (f.proname='guard_student_wordbook_activity' and f.prorettype<>'trigger'::regtype)
      or (f.proname<>'guard_student_wordbook_activity' and f.prorettype<>'jsonb'::regtype)
      or (select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname=f.proname)<>1
      or not has_function_privilege('service_role',f.oid,'EXECUTE') then
      raise exception 'WORDBOOK_A3_FUNCTION_DRIFT: %',expected.signature; end if;
    foreach role_name in array array['anon','authenticated'] loop
      if has_function_privilege(role_name,f.oid,'EXECUTE') then raise exception 'WORDBOOK_A3_FUNCTION_EXPOSED'; end if;
    end loop;
  end loop;
  foreach role_name in array array['anon','authenticated'] loop
    if has_table_privilege(role_name,'public.student_wordbook_activities','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(role_name,'public.student_wordbook_activities','SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception 'WORDBOOK_A3_ACTIVITY_EXPOSED'; end if;
  end loop;
  if not has_table_privilege('service_role','public.student_wordbook_activities','SELECT')
    or not has_table_privilege('service_role','public.student_wordbook_activities','INSERT')
    or not has_table_privilege('service_role','public.student_wordbook_activities','DELETE')
    or has_table_privilege('service_role','public.student_wordbook_activities','UPDATE,TRUNCATE') then
    raise exception 'WORDBOOK_A3_SERVICE_ACTIVITY_PERMISSION_DRIFT'; end if;
  if exists(select 1 from public.student_wordbook_entries w where not exists(
    select 1 from public.student_wordbook_activities a where a.wordbook_entry_id=w.wordbook_entry_id
      and a.student_id=w.student_id and a.domain=w.domain and a.activity_at=w.first_saved_at and a.event_type='first_save')) then
    raise exception 'WORDBOOK_A3_FIRST_SAVE_HISTORY_MISSING'; end if;
  if exists(select 1 from (
    select wordbook_entry_id,first_saved_at from public.student_wordbook_senses
    union select wordbook_entry_id,first_saved_at from public.student_wordbook_examples
  ) h join public.student_wordbook_entries w using(wordbook_entry_id)
    where not exists(select 1 from public.student_wordbook_activities a where a.wordbook_entry_id=w.wordbook_entry_id
      and a.activity_at>=h.first_saved_at)) then raise exception 'WORDBOOK_A3_CHILD_HISTORY_MISSING'; end if;
end;
$$;
select domain,event_type,count(*) as events,min(activity_at),max(activity_at) from public.student_wordbook_activities group by domain,event_type order by domain,event_type;
select 'WORDBOOK_A3_VERIFY_OK' as result;
commit;
