-- READ ONLY. Run the WHOLE file before A3; no mutation RPC calls.
begin transaction read only;
set local search_path = pg_catalog;
do $$
declare f record; t text;
begin
  select * into f from pg_proc where oid=to_regprocedure('public.operate_student_wordbook_v1(uuid,uuid,text,jsonb)');
  if not found or f.prorettype <> 'jsonb'::regtype or f.prosecdef
    or f.proargnames is distinct from array['p_student_id','p_occurrence_id','p_action','p_expected']::text[]
    or f.proconfig is distinct from array['search_path=pg_catalog']::text[]
    or md5(btrim(replace(f.prosrc,E'\r\n',E'\n'),E' \t\r\n')) <> '880a81f6de77b23fe0b2a44a177dbe90'
    or (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='operate_student_wordbook_v1') <> 1 then
    raise exception 'WORDBOOK_A3_A2_SIGNATURE_OR_BODY_DRIFT';
  end if;
  if has_function_privilege('anon',f.oid,'EXECUTE') or has_function_privilege('authenticated',f.oid,'EXECUTE')
    or not has_function_privilege('service_role',f.oid,'EXECUTE') then
    raise exception 'WORDBOOK_A3_A2_PERMISSION_DRIFT';
  end if;
  foreach t in array array['student_wordbook_entries','student_wordbook_senses','student_wordbook_examples'] loop
    if not exists(select 1 from pg_attribute where attrelid=to_regclass('public.'||t)
      and attname='first_saved_at' and atttypid='timestamptz'::regtype and attnotnull and not attisdropped) then
      raise exception 'WORDBOOK_A3_TIME_DEPENDENCY: %',t;
    end if;
    if not exists(select 1 from pg_trigger where tgrelid=to_regclass('public.'||t)
      and tgname=t||'_snapshot_guard' and tgenabled='O' and tgtype=19
      and tgfoid=to_regprocedure('public.guard_student_wordbook_snapshot()')) then
      raise exception 'WORDBOOK_A3_HISTORY_GUARD_REQUIRED: %',t; end if;
  end loop;
  if not exists(select 1 from pg_proc where oid=to_regprocedure('public.guard_student_wordbook_snapshot()')
    and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))='3212671fa54ba4ba38ff6d3a6b8c036e') then
    raise exception 'WORDBOOK_A3_HISTORY_GUARD_DRIFT'; end if;
  if to_regclass('public.student_wordbook_activities') is not null
    or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in ('read_student_wordbook_v1',
        'read_student_wordbook_activity_dates_v1','guard_student_wordbook_activity')) then
    raise exception 'WORDBOOK_A3_ALREADY_INSTALLED';
  end if;
end;
$$;
-- Real owner/ACL/dependencies and all five tables' time fields / triggers.
select p.oid::regprocedure as signature,pg_get_userbyid(p.proowner) as owner,p.proacl,pg_get_functiondef(p.oid) as definition
from pg_proc p where p.oid=to_regprocedure('public.operate_student_wordbook_v1(uuid,uuid,text,jsonb)');
select d.deptype,d.classid::regclass,d.objid,d.refclassid::regclass,d.refobjid
from pg_depend d where d.objid=to_regprocedure('public.operate_student_wordbook_v1(uuid,uuid,text,jsonb)');
select c.relname,a.attname,format_type(a.atttypid,a.atttypmod) as type,pg_get_expr(ad.adbin,ad.adrelid) as default_value
from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid
left join pg_attrdef ad on ad.adrelid=c.oid and ad.adnum=a.attnum
where n.nspname='public' and c.relname in ('student_wordbook_entries','student_wordbook_senses',
  'student_wordbook_examples','student_wordbook_example_senses','student_wordbook_canonical_links')
  and a.attnum>0 and not a.attisdropped order by c.relname,a.attnum;
select c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) as definition
from pg_trigger t join pg_class c on c.oid=t.tgrelid where not t.tgisinternal
and c.oid in (select oid from pg_class where relnamespace='public'::regnamespace and relname like 'student_wordbook_%');
select 'WORDBOOK_A3_PREFLIGHT_OK' as result;
commit;
