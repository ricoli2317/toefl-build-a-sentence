-- MANUAL ONLY: after batch preflight OK, run the WHOLE file. New RPC only.
-- No table changes, existing RPC replacements, historical/canonical writes.
begin;
set local lock_timeout='10s';
set local statement_timeout='60s';
do $$
begin
  if not exists(select 1 from pg_proc where oid=to_regprocedure('public.operate_student_wordbook_v1(uuid,uuid,text,jsonb)')
    and not prosecdef and proconfig=array['search_path=pg_catalog']::text[]
    and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))='ae7b641ab11d258581b0665a23a230f9') then
    raise exception 'WORDBOOK_BATCH_EXISTING_LOCK_PROTOCOL_DRIFT'; end if;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='delete_student_wordbook_entries_v1') then
    raise exception 'WORDBOOK_BATCH_ALREADY_INSTALLED'; end if;
end;
$$;
create function public.delete_student_wordbook_entries_v1(p_student_id uuid,p_domain text,p_entry_ids uuid[])
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare v_count integer; v_deleted integer; v_lock bigint; v_locks bigint[]; v_id uuid;
begin
  if p_domain is null or p_domain not in ('reading','writing') or p_entry_ids is null
    or array_ndims(p_entry_ids) is distinct from 1 or cardinality(p_entry_ids) not between 1 and 50
    or array_position(p_entry_ids,null) is not null
    or (select count(distinct id) from unnest(p_entry_ids) as ids(id))<>cardinality(p_entry_ids) then
    raise exception 'WORDBOOK_BATCH_INVALID'; end if;
  if not exists(select 1 from public.profiles where id=p_student_id and is_active and role in ('student','teacher','admin')) then
    raise exception 'WORDBOOK_STUDENT_REQUIRED'; end if;
  -- Initial complete ownership validation, with no row locks yet. Reusing the
  -- single save/remove advisory protocol MUST precede every entry row lock.
  select count(*),array_agg(distinct hashtextextended(p_student_id::text||':'||p_domain||':'||encode(w.lexeme_key,'hex'),0)
    order by hashtextextended(p_student_id::text||':'||p_domain||':'||encode(w.lexeme_key,'hex'),0))
    into v_count,v_locks from public.student_wordbook_entries w
    where w.student_id=p_student_id and w.domain=p_domain and w.wordbook_entry_id=any(p_entry_ids);
  if v_count<>cardinality(p_entry_ids) then raise exception 'WORDBOOK_BATCH_NOT_FOUND'; end if;
  -- Sort the actual signed lock keys (including collisions) for all batches.
  foreach v_lock in array v_locks loop perform pg_advisory_xact_lock(v_lock); end loop;
  v_count:=0;
  for v_id in select w.wordbook_entry_id from public.student_wordbook_entries w
    where w.student_id=p_student_id and w.domain=p_domain and w.wordbook_entry_id=any(p_entry_ids)
    order by w.wordbook_entry_id for update loop v_count:=v_count+1; end loop;
  -- A concurrent cancel/re-save changes the ID; fail the WHOLE batch, not a subset.
  if v_count<>cardinality(p_entry_ids) then raise exception 'WORDBOOK_BATCH_NOT_FOUND'; end if;
  delete from public.student_wordbook_entries w where w.student_id=p_student_id
    and w.domain=p_domain and w.wordbook_entry_id=any(p_entry_ids);
  get diagnostics v_deleted=row_count;
  if v_deleted<>cardinality(p_entry_ids) then raise exception 'WORDBOOK_BATCH_NOT_FOUND'; end if;
  -- Exactly the existing unfavourite semantics: parent DELETE with owner-scoped
  -- FKs cascading senses/examples/M:N/canonical-links/activities. Corpus untouched.
  return jsonb_build_object('domain',p_domain,'deletedCount',v_deleted,'deletedEntryIds',to_jsonb(p_entry_ids));
end;
$$;
revoke all on function public.delete_student_wordbook_entries_v1(uuid,text,uuid[]) from public,anon,authenticated;
grant execute on function public.delete_student_wordbook_entries_v1(uuid,text,uuid[]) to service_role;
notify pgrst,'reload schema';
commit;
select 'WORDBOOK_BATCH_MIGRATION_OK' as result;
