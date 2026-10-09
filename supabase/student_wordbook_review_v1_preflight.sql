-- MANUAL ONLY / READ ONLY. This is the installation preflight, not the earlier audit.
-- If any approved account/count/ownership/dependency differs, STOP and ask the user.
begin transaction read only;
set local statement_timeout='60s';
-- BEGIN_REVIEW_INSTALL_ASSERTIONS
do $$
declare r record; t text; expected_count integer;
begin
  foreach t in array array['anon','authenticated'] loop
    if not exists(select 1 from pg_roles where rolname=t and not rolbypassrls and not rolsuper)
      or pg_has_role(t,current_user,'USAGE') then raise exception 'REVIEW_UNSAFE_CLIENT_ROLE: %',t; end if;
  end loop;
  if not exists(select 1 from pg_roles where rolname='service_role' and (rolbypassrls or rolsuper)) then raise exception 'REVIEW_SERVICE_ROLE_REQUIRED'; end if;
  for r in select * from (values
    ('bdd0bd35-e23d-4b59-934f-cbc9de875a93'::uuid,'like@bas.com',34,20),
    ('523be430-1f13-4660-8f11-1d263fc1438e'::uuid,'jiangzhuocheng2@bas.com',9,17),
    ('c05d7082-ae31-46a0-918c-ae3de880017a'::uuid,'zhangciwei0@bas.com',1,0)
  ) v(id,email,reading,writing) loop
    if not exists(select 1 from auth.users u join public.profiles p on p.id=u.id
      where u.id=r.id and lower(u.email)=r.email and p.role in ('student','teacher','admin')) then
      raise exception 'REVIEW_CLEANUP_ACCOUNT_DRIFT: %',r.id; end if;
    if (select count(*) from public.student_wordbook_entries where student_id=r.id and domain='reading')<>r.reading
      or (select count(*) from public.student_wordbook_entries where student_id=r.id and domain='writing')<>r.writing then
      raise exception 'REVIEW_CLEANUP_COUNT_DRIFT: %; STOP, do not edit counts without renewed approval',r.id;
    end if;
  end loop;
  -- No historical backfill: unexpected existing owners must not silently receive an empty evidence model.
  if exists(select 1 from public.student_wordbook_entries where student_id not in (
    'bdd0bd35-e23d-4b59-934f-cbc9de875a93','523be430-1f13-4660-8f11-1d263fc1438e','c05d7082-ae31-46a0-918c-ae3de880017a')) then
    raise exception 'REVIEW_UNAPPROVED_EXISTING_WORDBOOK_DATA'; end if;
  for r in select * from (values
    ('public.operate_student_wordbook_v1(uuid,uuid,text,jsonb)','ae7b641ab11d258581b0665a23a230f9'),
    ('public.read_student_wordbook_v1(uuid,text,integer,integer,text,timestamptz,timestamptz)','dec6074fd48dcba5d0f20aecc14b987d'),
    ('public.delete_student_wordbook_entries_v1(uuid,text,uuid[])','e51054f20e708846b746ae70e000850d')
  ) v(signature,body_hash) loop
    if not exists(select 1 from pg_proc where oid=to_regprocedure(r.signature) and not prosecdef
      and proconfig=array['search_path=pg_catalog']::text[]
      and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))=r.body_hash)
      or has_function_privilege('anon',r.signature,'EXECUTE')
      or has_function_privilege('authenticated',r.signature,'EXECUTE')
      or not has_function_privilege('service_role',r.signature,'EXECUTE') then
      raise exception 'REVIEW_EXISTING_RPC_DRIFT: %',r.signature; end if;
  end loop;
  for r in select * from (values
    ('student_wordbook_senses','student_wordbook_entries',array['wordbook_entry_id','student_id','domain']),
    ('student_wordbook_examples','student_wordbook_entries',array['wordbook_entry_id','student_id','domain']),
    ('student_wordbook_canonical_links','student_wordbook_entries',array['wordbook_entry_id','student_id','domain']),
    ('student_wordbook_activities','student_wordbook_entries',array['wordbook_entry_id','student_id','domain']),
    ('student_wordbook_example_senses','student_wordbook_examples',array['example_id','wordbook_entry_id','student_id','domain']),
    ('student_wordbook_example_senses','student_wordbook_senses',array['sense_id','wordbook_entry_id','student_id','domain'])
  ) v(child,parent,columns) loop
    if not exists(select 1 from pg_constraint c where c.conrelid=to_regclass('public.'||r.child)
      and c.confrelid=to_regclass('public.'||r.parent) and c.contype='f' and c.convalidated
      and c.confdeltype='c' and (select array_agg(a.attname::text order by k.n)
        from unnest(c.conkey) with ordinality k(attnum,n) join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum)=r.columns
      and (select array_agg(a.attname::text order by k.n)
        from unnest(c.confkey) with ordinality k(attnum,n) join pg_attribute a on a.attrelid=c.confrelid and a.attnum=k.attnum)=r.columns) then
      raise exception 'REVIEW_CLEANUP_CASCADE_DRIFT: %',r.child; end if;
  end loop;
  -- Any additional inbound dependency could cause deletion outside the approved scope.
  if exists(select 1 from pg_trigger where not tgisinternal and (tgtype::integer & 8)<>0 and tgrelid in (
    'public.student_wordbook_entries'::regclass,'public.student_wordbook_senses'::regclass,'public.student_wordbook_examples'::regclass,
    'public.student_wordbook_example_senses'::regclass,'public.student_wordbook_canonical_links'::regclass,
    'public.student_wordbook_activities'::regclass)) then raise exception 'REVIEW_UNEXPECTED_DELETE_TRIGGER'; end if;
  if exists(select 1 from pg_constraint c where c.contype='f' and c.confrelid in (
    'public.student_wordbook_entries'::regclass,'public.student_wordbook_senses'::regclass,
    'public.student_wordbook_examples'::regclass,'public.student_wordbook_example_senses'::regclass,
    'public.student_wordbook_canonical_links'::regclass,'public.student_wordbook_activities'::regclass)
    and c.conrelid not in ('public.student_wordbook_senses'::regclass,'public.student_wordbook_examples'::regclass,
      'public.student_wordbook_example_senses'::regclass,'public.student_wordbook_canonical_links'::regclass,
      'public.student_wordbook_activities'::regclass)) then raise exception 'REVIEW_UNKNOWN_INBOUND_FK'; end if;
  foreach t in array array['student_wordbook_senses','student_wordbook_examples','student_wordbook_example_senses',
    'student_wordbook_canonical_links','student_wordbook_activities'] loop
    execute format('select count(*) from public.%I c left join public.student_wordbook_entries w using(wordbook_entry_id)
      where w.wordbook_entry_id is null or (c.student_id,c.domain) is distinct from (w.student_id,w.domain)',t) into expected_count;
    if expected_count<>0 then raise exception 'REVIEW_CHILD_OWNERSHIP_DRIFT: %',t; end if;
  end loop;
  foreach t in array array['student_wordbook_source_evidence','student_wordbook_review_sessions',
    'student_wordbook_review_items','student_wordbook_review_answers','student_wordbook_review_installation'] loop
    if to_regclass('public.'||t) is not null then raise exception 'REVIEW_ALREADY_INSTALLED_OR_NAME_COLLISION: %',t; end if;
  end loop;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'wordbook_review_%') then raise exception 'REVIEW_FUNCTION_NAME_COLLISION'; end if;
end;
$$;
-- END_REVIEW_INSTALL_ASSERTIONS

select student_id,domain,count(*) as approved_cleanup_count from public.student_wordbook_entries
group by student_id,domain order by student_id,domain;
select p.id,u.email,p.role,p.is_active from public.profiles p join auth.users u on u.id=p.id
where p.id in ('bdd0bd35-e23d-4b59-934f-cbc9de875a93','523be430-1f13-4660-8f11-1d263fc1438e','c05d7082-ae31-46a0-918c-ae3de880017a');
select c.conrelid::regclass as child,c.confrelid::regclass as parent,pg_get_constraintdef(c.oid) as constraint_definition
from pg_constraint c where c.contype='f' and c.conrelid::regclass::text like '%student_wordbook_%';
-- Actual POS census, NOT a guessed decorative option set. Unknown/other remain ineligible.
select source_type,context_pos,count(*) as occurrence_count from public.lexical_occurrences
group by source_type,context_pos order by source_type,context_pos;
select v.value->>'pos' as common_sense_pos,count(*) from public.lexical_entries e
cross join lateral jsonb_array_elements(e.common_senses) v(value) group by v.value->>'pos' order by 1;
select 'WORDBOOK_REVIEW_PREFLIGHT_OK' as result;
commit;
