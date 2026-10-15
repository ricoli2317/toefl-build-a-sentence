-- Manual hotfix AFTER the original Phase 3 installation.
-- Fix ONLY PL/pgSQL variable name collision with existing profiles.owner_id.
-- No table/content/progress/attempt writes. No grants, policies or ownership changes.
-- Guarded against function drift; safe to re-run after this exact fix.
begin;
set local lock_timeout = '10s';
set local statement_timeout = '30s';
do $migration$
declare v_function oid; v_hash text; v_definition text;
begin
  v_function := to_regprocedure('public.start_ctw_vocabulary_list_v1(text,text,integer)');
  if v_function is null then raise exception 'CTW_VOCAB_PHASE3_INSTALL_REQUIRED'; end if;
  select md5(p.prosrc),pg_get_functiondef(p.oid) into v_hash,v_definition
    from pg_proc p where p.oid=v_function;
  if v_hash='e47c0df6f29f52fbc302f34e04d8dcbc' then return; end if;
  if v_hash<>'563fe3b06d13955c6df3e8a5b9a46097' then
    raise exception 'CTW_VOCAB_START_FUNCTION_DRIFT';
  end if;
  -- The hash above fixes the exact reviewed function body: owner_id is ONLY
  -- the local variable here. CREATE OR REPLACE preserves signature/ACL/owner.
  execute replace(v_definition,'owner_id','v_student_id');
  if (select md5(p.prosrc) from pg_proc p where p.oid=v_function)
    <>'e47c0df6f29f52fbc302f34e04d8dcbc' then
    raise exception 'CTW_VOCAB_START_FIX_VERIFY_FAILED';
  end if;
end $migration$;
notify pgrst,'reload schema';
select 'CTW_VOCAB_PHASE3_START_OWNER_FIX_OK' as status;
commit;
