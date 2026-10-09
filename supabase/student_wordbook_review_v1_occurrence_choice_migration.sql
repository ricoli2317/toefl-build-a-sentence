-- USER-MANUAL incremental patch AFTER the separate concurrent index is valid.
-- One candidate-function replacement + its audit fingerprint. No data cleanup.
begin;
set local lock_timeout='5s';
do $patch$
declare f record; audit jsonb; definition text; before_meta jsonb; after_meta jsonb;
  old_pool text:=$old$  select coalesce(jsonb_agg(jsonb_build_object('lexicalEntryId',q.entry_id,'meaning',q.meaning) order by q.meaning collate "C",q.entry_id),'[]') into pool from (
    select distinct e.entry_id,btrim(v.value->>'meaning_zh') as meaning from public.lexical_entries e
    cross join lateral jsonb_array_elements(e.common_senses) v(value)
    where e.review_status='generated' and jsonb_typeof(v.value)='object' and v.value->>'meaning_zh'~'[一-龥]'
      and length(v.value->>'meaning_zh') between 1 and 160
  ) q;
$old$;
begin
  select function_hashes into audit from public.student_wordbook_review_installation where version='v1' for update;
  if audit is null then raise exception 'REVIEW_OCCURRENCE_CHOICE_INSTALLATION_REQUIRED'; end if;
  for f in select * from (values
    ('public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)','ba6a1c52ae0d6c2273953ee674804187'),
    ('public.wordbook_review_meaning(text)','902c27242565b371d7926b0f93b3920d'),
    ('public.wordbook_review_meaning_conflict(text,text)','93685b2406739fa710c7b78f8a4fd382'),
    ('public.wordbook_review_pos_options()','d213c26e14018b2f07d08950ed1c34d6')
  ) expected(signature,hash) loop
    if not exists(select 1 from pg_proc where oid=to_regprocedure(f.signature)
      and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))=f.hash)
      or not coalesce(audit ? to_regprocedure(f.signature)::text,false) then
      raise exception 'REVIEW_OCCURRENCE_CHOICE_BASELINE_DRIFT: %',f.signature; end if;
  end loop;
  if not exists(select 1 from pg_proc where oid=to_regprocedure('public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)')
    and prorettype='record'::regtype and proretset and provolatile='s') then
    raise exception 'REVIEW_OCCURRENCE_CHOICE_FUNCTION_CONTRACT_DRIFT'; end if;
  for f in select key as signature,value #>> '{}' as hash from jsonb_each(audit) loop
    if not exists(select 1 from pg_proc where oid=to_regprocedure(f.signature) and not prosecdef
      and proconfig=array['search_path=pg_catalog']::text[]
      and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))=f.hash)
      or has_function_privilege('anon',f.signature,'EXECUTE')
      or has_function_privilege('authenticated',f.signature,'EXECUTE')
      or not has_function_privilege('service_role',f.signature,'EXECUTE') then
      raise exception 'REVIEW_OCCURRENCE_CHOICE_AUDIT_OR_ACL_DRIFT: %',f.signature; end if;
  end loop;
  if not exists(select 1 from pg_index i join pg_class c on c.oid=i.indexrelid join pg_am a on a.oid=c.relam
    where i.indexrelid=to_regclass('public.wordbook_review_occurrence_meaning_idx')
      and i.indrelid='public.lexical_occurrences'::regclass and i.indisvalid and i.indisready and a.amname='btree'
      and md5(pg_get_indexdef(i.indexrelid))='349512b4b05215449bfb91991f002907') then
    raise exception 'REVIEW_OCCURRENCE_CHOICE_VALID_INDEX_REQUIRED'; end if;
  if not has_table_privilege('service_role','public.lexical_occurrences','SELECT')
    or not has_table_privilege('service_role','public.lexical_entries','SELECT') then
    raise exception 'REVIEW_OCCURRENCE_CHOICE_CORPUS_PERMISSION_REQUIRED'; end if;
  select jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl) into before_meta
    from pg_proc where oid=to_regprocedure('public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)');
  definition:=pg_get_functiondef(to_regprocedure('public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)'));
  if strpos(definition,old_pool)=0 then raise exception 'REVIEW_OCCURRENCE_CHOICE_POOL_MARKER_DRIFT'; end if;
  definition:=replace(definition,old_pool,'');
  definition:=replace(definition,'pool jsonb;','pool_meaning text; pool_entry uuid;');
  definition:=replace(definition,$old$      options:='[]';$old$,$new$      options:='[]';pool_meaning:='';pool_entry:='00000000-0000-0000-0000-000000000000';$new$);
  definition:=replace(definition,$old$        for d in select v.value from jsonb_array_elements(pool) v(value) loop$old$,$new$        loop
          -- Indexed keyset read: no full pool JSON/aggregation. DISTINCT is on
          -- canonical entry + trimmed meaning; the cursor skips duplicate spans.
          select distinct o.entry_id,btrim(o.context_meaning_zh) collate "C" as meaning into d
          from public.lexical_occurrences o
          where o.review_status='generated' and o.context_meaning_zh~'[一-龥]'
            and length(o.context_meaning_zh) between 1 and 160
            and (btrim(o.context_meaning_zh) collate "C",o.entry_id)>(pool_meaning collate "C",pool_entry)
          order by meaning,o.entry_id limit 1;
          if not found then exit; end if;
          pool_meaning:=d.meaning;pool_entry:=d.entry_id;$new$);
  definition:=replace(definition,$old$          if exists(select 1 from public.lexical_entries e where e.entry_id=(d.value->>'lexicalEntryId')::uuid
            and e.normalized_expression=w.normalized_expression) then continue; end if;$old$,$new$          if not exists(select 1 from public.lexical_entries e where e.entry_id=d.entry_id
            and e.review_status='generated' and e.normalized_expression<>w.normalized_expression) then continue; end if;
          -- Once this meaning has a reliable non-target entry, every later
          -- identical meaning has the same conflict result. Seek past the entire
          -- meaning group, including when rejected; do not scan repeated senses.
          pool_entry:='ffffffff-ffff-ffff-ffff-ffffffffffff';$new$);
  definition:=replace(definition,$old$(d.value->>'lexicalEntryId')::uuid$old$,'d.entry_id');
  definition:=replace(definition,$old$d.value->>'meaning'$old$,'d.meaning');
  definition:=replace(definition,$old$d.value->>'lexicalEntryId'$old$,'d.entry_id');
  if strpos(definition,'jsonb_array_elements(pool)')>0 or strpos(definition,'d.value')>0 then
    raise exception 'REVIEW_OCCURRENCE_CHOICE_REPLACEMENT_INCOMPLETE'; end if;
  execute definition;
  if not exists(select 1 from pg_proc where oid=to_regprocedure('public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)')
    and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))='c5797eef7193daf7c9d9a15548f61f88') then
    raise exception 'REVIEW_OCCURRENCE_CHOICE_PATCH_DEFINITION_MISMATCH'; end if;
  select jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl) into after_meta
    from pg_proc where oid=to_regprocedure('public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)');
  if before_meta is distinct from after_meta then raise exception 'REVIEW_OCCURRENCE_CHOICE_OWNER_OR_ACL_CHANGED'; end if;
  update public.student_wordbook_review_installation set function_hashes=function_hashes||(
    select jsonb_build_object(oid::regprocedure::text,md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n')))
    from pg_proc where oid=to_regprocedure('public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)')
  ) where version='v1';
end;
$patch$;
commit;
select 'WORDBOOK_REVIEW_OCCURRENCE_CHOICE_MIGRATION_OK' as result;
