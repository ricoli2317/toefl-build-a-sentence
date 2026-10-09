-- USER-MANUAL minimal incremental patch AFTER separate concurrent index build.
-- Requires installed occurrence-choice/POS7. Never rerun historical installers.
begin;
set local lock_timeout='5s';
do $patch$
declare f record; audit jsonb; definition text; before_meta jsonb; after_meta jsonb;
  candidate_signature text:='public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)';
  conflict_signature text:='public.wordbook_review_meaning_conflict(text,text)';
  block_start integer; block_end integer;
begin
  select function_hashes into audit from public.student_wordbook_review_installation where version='v1' for update;
  if audit is null then raise exception 'REVIEW_LOCAL_POS_CHOICE_INSTALLATION_REQUIRED'; end if;
  for f in select * from (values
    (candidate_signature,'c5797eef7193daf7c9d9a15548f61f88'),
    (conflict_signature,'93685b2406739fa710c7b78f8a4fd382'),
    ('public.wordbook_review_teaching_pos(text)','5b16e016919fa57994e70f2c9d6326f9'),
    ('public.wordbook_review_pos(text)','b5e62c55574e066010057109dfb8a940')
  ) expected(signature,hash) loop
    if not exists(select 1 from pg_proc where oid=to_regprocedure(f.signature)
      and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))=f.hash)
      or not coalesce(audit ? to_regprocedure(f.signature)::text,false) then
      raise exception 'REVIEW_LOCAL_POS_CHOICE_BASELINE_DRIFT: %',f.signature; end if;
  end loop;
  for f in select key as signature,value #>> '{}' as hash from jsonb_each(audit) loop
    if not exists(select 1 from pg_proc where oid=to_regprocedure(f.signature) and not prosecdef
      and proconfig=array['search_path=pg_catalog']::text[]
      and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))=f.hash)
      or has_function_privilege('anon',f.signature,'EXECUTE')
      or has_function_privilege('authenticated',f.signature,'EXECUTE')
      or not has_function_privilege('service_role',f.signature,'EXECUTE') then
      raise exception 'REVIEW_LOCAL_POS_CHOICE_AUDIT_OR_ACL_DRIFT: %',f.signature; end if;
  end loop;
  if not exists(select 1 from pg_index i where i.indexrelid=to_regclass('public.wordbook_review_occurrence_pos_meaning_idx')
    and i.indrelid='public.lexical_occurrences'::regclass and i.indisvalid and i.indisready
    and md5(pg_get_indexdef(i.indexrelid))='d1cfac98bbd67a5efd4a864dff8c8677') then
    raise exception 'REVIEW_LOCAL_POS_CHOICE_VALID_INDEX_REQUIRED'; end if;
  select jsonb_object_agg(oid::text,jsonb_build_object('owner',proowner,'acl',proacl,'stable',provolatile,'type',prorettype,'set',proretset)) into before_meta
    from pg_proc where oid in(to_regprocedure(candidate_signature),to_regprocedure(conflict_signature));

  -- Only remove the shared-character rule. Equality/containment, synonym groups
  -- (including existing negation/multiple-answer safeguards) remain intact.
  definition:=pg_get_functiondef(to_regprocedure(conflict_signature));
  definition:=replace(definition,$old$  -- Shared Chinese characters are rejected, including negation variants.
  if exists(select 1 from regexp_split_to_table(x,'') c where c~'[一-龥]' and strpos(y,c)>0) then return true; end if;
$old$,'');
  execute definition;
  if not exists(select 1 from pg_proc where oid=to_regprocedure(conflict_signature)
    and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))='556b46059d2e33322d35dbea5c39ff25') then
    raise exception 'REVIEW_LOCAL_POS_CHOICE_CONFLICT_PATCH_MISMATCH'; end if;

  definition:=pg_get_functiondef(to_regprocedure(candidate_signature));
  definition:=replace(definition,'pool_meaning text; pool_entry uuid;',
    'pool_meaning text; pool_entry uuid; local_pool jsonb; global_pools jsonb:=''{}''; global_pool jsonb; pool_row record; attempt integer; tier integer; target_links uuid[];');
  definition:=replace(definition,$old$      pos_id:=case when mode='spelling_pos' then public.wordbook_review_teaching_pos(s.context_pos)
        else public.wordbook_review_pos(s.context_pos) end;
      if mode='spelling_pos' and (pos_id is null or not exists(select 1 from jsonb_array_elements(pos_options) v where v->>'id'=pos_id)) then$old$,
    $new$      pos_id:=public.wordbook_review_teaching_pos(s.context_pos);
      if pos_id is null or not exists(select 1 from jsonb_array_elements(pos_options) v where v->>'id'=pos_id) then$new$);
  block_start:=strpos(definition,$marker$      options:='[]';pool_meaning:='';pool_entry:='00000000-0000-0000-0000-000000000000';$marker$);
  block_end:=strpos(definition,$marker$      chosen:=jsonb_build_object($marker$);
  if block_start=0 or block_end<=block_start then raise exception 'REVIEW_LOCAL_POS_CHOICE_MARKER_DRIFT'; end if;
  definition:=substr(definition,1,block_start-1)||$replacement$      options:='[]';
      if mode='meaning_choice' then
        -- All sources/date ranges within this student's current DOMAIN may
        -- supply distractors. Target correct sense/source selection is unchanged.
        if local_pool is null then
          select coalesce(jsonb_agg(to_jsonb(q) order by q.meaning collate "C",q.wordbook_id),'[]') into local_pool from (
            select distinct e.wordbook_entry_id as wordbook_id,e.normalized_expression,
              btrim(ss.context_meaning_zh) as meaning,public.wordbook_review_teaching_pos(ss.context_pos) as pos,
              array(select l.lexical_entry_id from public.student_wordbook_canonical_links l
                where l.wordbook_entry_id=e.wordbook_entry_id) as links
            from public.student_wordbook_entries e join public.student_wordbook_senses ss
              on ss.wordbook_entry_id=e.wordbook_entry_id and ss.student_id=e.student_id and ss.domain=e.domain
            where e.student_id=p_student and e.domain=p_domain
              and ss.context_meaning_zh~'[一-龥]' and length(ss.context_meaning_zh) between 1 and 160
              and public.wordbook_review_teaching_pos(ss.context_pos) is not null
              and exists(select 1 from public.student_wordbook_source_evidence ev where ev.sense_id=ss.sense_id)
          ) q;
        end if;
        target_links:=array(select l.lexical_entry_id from public.student_wordbook_canonical_links l
          where l.wordbook_entry_id=w.wordbook_entry_id);
        for tier in 1..2 loop
          if tier=1 then
            global_pool:=local_pool;
          else
            -- Lazily prepare at most ONCE PER POS per candidate-engine call.
            -- Each seek is index ordered, LIMIT 1; cursor skips duplicate spans.
            -- Hard cap counts even unreliable entries: never traverse unbounded
            -- rows trying to fill a quota of "good" candidates.
            if not (global_pools ? pos_id) then
              global_pool:='[]';pool_meaning:='';pool_entry:='00000000-0000-0000-0000-000000000000';
              for attempt in 1..128 loop
                select distinct o.entry_id,btrim(o.context_meaning_zh) collate "C" as meaning into pool_row
                from public.lexical_occurrences o
                where o.review_status='generated' and o.context_meaning_zh~'[一-龥]'
                  and length(o.context_meaning_zh) between 1 and 160
                  and public.wordbook_review_teaching_pos(o.context_pos) is not null
                  and public.wordbook_review_teaching_pos(o.context_pos)=pos_id
                  and (btrim(o.context_meaning_zh) collate "C",o.entry_id)>(pool_meaning collate "C",pool_entry)
                order by meaning,o.entry_id limit 1;
                if not found then exit; end if;
                pool_meaning:=pool_row.meaning;pool_entry:=pool_row.entry_id;
                select e.normalized_expression into d from public.lexical_entries e
                  where e.entry_id=pool_row.entry_id and e.review_status='generated';
                if not found then continue; end if;
                global_pool:=global_pool||jsonb_build_array(jsonb_build_object('meaning',pool_row.meaning,'pos',pos_id,
                  'normalized_expression',d.normalized_expression,'lexical_id',pool_row.entry_id));
              end loop;
              global_pools:=global_pools||jsonb_build_object(pos_id,global_pool);
            end if;
            global_pool:=global_pools->pos_id;
          end if;
          for d in select v.value from jsonb_array_elements(global_pool) v(value) loop
            if d.value->>'pos'<>pos_id or d.value->>'normalized_expression'=w.normalized_expression then continue; end if;
            if tier=1 then
              if (d.value->>'wordbook_id')::uuid=w.wordbook_entry_id
                or exists(select 1 from jsonb_array_elements_text(d.value->'links') l
                  where l::uuid=any(target_links)) then continue; end if;
            elsif (d.value->>'lexical_id')::uuid=any(target_links) then continue;
            end if;
            if exists(select 1 from unnest(excluded) m where public.wordbook_review_meaning_conflict(m,d.value->>'meaning'))
              or exists(select 1 from jsonb_array_elements(options) o where public.wordbook_review_meaning_conflict(o->>'text',d.value->>'meaning')) then continue; end if;
            options:=options||jsonb_build_array(case when tier=1 then
              jsonb_build_object('text',d.value->>'meaning','wordbookEntryId',d.value->>'wordbook_id') else
              jsonb_build_object('text',d.value->>'meaning','lexicalEntryId',d.value->>'lexical_id') end);
            exit when jsonb_array_length(options)=3;
          end loop;
          exit when jsonb_array_length(options)=3;
        end loop;
        if jsonb_array_length(options)<3 then miss:='insufficient_distractors'; continue; end if;
      end if;
$replacement$||substr(definition,block_end);
  execute definition;
  if not exists(select 1 from pg_proc where oid=to_regprocedure(candidate_signature)
    and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))='380323524809f2f1578ca5b2b9f6161a') then
    raise exception 'REVIEW_LOCAL_POS_CHOICE_CANDIDATE_PATCH_MISMATCH'; end if;
  select jsonb_object_agg(oid::text,jsonb_build_object('owner',proowner,'acl',proacl,'stable',provolatile,'type',prorettype,'set',proretset)) into after_meta
    from pg_proc where oid in(to_regprocedure(candidate_signature),to_regprocedure(conflict_signature));
  if before_meta is distinct from after_meta then raise exception 'REVIEW_LOCAL_POS_CHOICE_FUNCTION_CONTRACT_CHANGED'; end if;
  update public.student_wordbook_review_installation set function_hashes=function_hashes||(
    select jsonb_object_agg(oid::regprocedure::text,md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n')))
    from pg_proc where oid in(to_regprocedure(candidate_signature),to_regprocedure(conflict_signature))
  ) where version='v1';
end;
$patch$;
commit;
select 'WORDBOOK_REVIEW_LOCAL_POS_CHOICE_MIGRATION_OK' as result;
