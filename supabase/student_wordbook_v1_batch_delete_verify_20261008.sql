-- READ ONLY. No production test deletions. Run the WHOLE file after installation.
begin transaction read only;
do $$
declare f record;
begin
  select * into f from pg_proc where oid=to_regprocedure('public.delete_student_wordbook_entries_v1(uuid,text,uuid[])');
  if not found or f.prosecdef or f.prorettype<>'jsonb'::regtype
    or f.proargnames is distinct from array['p_student_id','p_domain','p_entry_ids']::text[]
    or f.proconfig is distinct from array['search_path=pg_catalog']::text[]
    or md5(btrim(replace(f.prosrc,E'\r\n',E'\n'),E' \t\r\n'))<>'e51054f20e708846b746ae70e000850d'
    or (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='delete_student_wordbook_entries_v1')<>1 then
    raise exception 'WORDBOOK_BATCH_VERIFY_SIGNATURE_DRIFT'; end if;
  if has_function_privilege('anon',f.oid,'EXECUTE') or has_function_privilege('authenticated',f.oid,'EXECUTE')
    or exists(select 1 from aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE')
    or not has_function_privilege('service_role',f.oid,'EXECUTE') then
    raise exception 'WORDBOOK_BATCH_VERIFY_ACL_DRIFT'; end if;
  if not exists(select 1 from pg_proc where oid=to_regprocedure('public.operate_student_wordbook_v1(uuid,uuid,text,jsonb)')
    and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))='ae7b641ab11d258581b0665a23a230f9') then
    raise exception 'WORDBOOK_BATCH_VERIFY_EXISTING_RPC_CHANGED'; end if;
end;
$$;
commit;
select 'WORDBOOK_BATCH_VERIFY_OK' as result;
