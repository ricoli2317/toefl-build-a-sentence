-- MANUAL ONLY: run this WHOLE function-only delta once as database owner after
-- the deployed context/coverage repair. No dictionary/collection/history/pool
-- data updates. Do NOT rerun the previous data-repair or initialization files.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
do $guard$
declare f record; audit jsonb;
begin
  select function_hashes into strict audit from public.student_wordbook_review_installation where version='v1' for update;
  for f in select * from (values
    ('public.wordbook_saved_contexts(uuid,text[])','f60aebcbd46f14296921c5de6b8d888f'),
    ('public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)','8c79990d59b1c7bdaacaf4b3c5434f32'),
    ('public.wordbook_review_create(uuid,jsonb,uuid,uuid)','82e5db6e0f010a217b34d3da8a90c9d6'),
    ('public.wordbook_review_flow_state(uuid,uuid,text,uuid,jsonb)','1c21d9a98d31ef43aa265aa7ac387cb5')
  ) expected(signature,hash) loop
    if not exists(select 1 from pg_proc where oid=to_regprocedure(f.signature) and not prosecdef
      and proconfig=array['search_path=pg_catalog']::text[]
      and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))=f.hash
      and f.hash=coalesce(audit->>to_regprocedure(f.signature)::text,audit->>replace(f.signature,'public.','')))
      or has_function_privilege('anon',f.signature,'EXECUTE') or has_function_privilege('authenticated',f.signature,'EXECUTE')
      or not has_function_privilege('service_role',f.signature,'EXECUTE') then
      raise exception 'REVIEW_CANONICAL_BASELINE_OR_ACL_DRIFT: %',f.signature; end if;
  end loop;
end;
$guard$;
do $patch$
declare definition text; old text; replacement text; signature text; before_meta jsonb; after_meta jsonb;
begin
  select jsonb_object_agg(oid::text,jsonb_build_object('owner',proowner,'acl',proacl,'volatile',provolatile,'type',prorettype,'set',proretset)) into before_meta
    from pg_proc where oid in (to_regprocedure('public.wordbook_saved_contexts(uuid,text[])'),
      to_regprocedure('public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)'),
      to_regprocedure('public.wordbook_review_create(uuid,jsonb,uuid,uuid)'),to_regprocedure('public.wordbook_review_flow_state(uuid,uuid,text,uuid,jsonb)'));
  -- Canonical is already the reviewed lexeme (including proper case). The
  -- occurrence retains the source POS/sense/span and its untouched spelling.
  signature:='public.wordbook_saved_contexts(uuid,text[])';
  definition:=pg_get_functiondef(to_regprocedure(signature));
  old:=$old$'expression',o.surface_text,'contextPos'$old$;
  replacement:=$new$'expression',e.canonical_expression,'surfaceText',o.surface_text,'contextPos'$new$;
  if strpos(definition,old)=0 then raise exception 'REVIEW_CANONICAL_CONTEXT_MARKER_DRIFT'; end if;
  definition:=replace(definition,old,replacement);
  old:=$old$  where s.sense_id=p_sense$old$;
  replacement:=$new$  join public.lexical_entries e on e.entry_id=o.entry_id
    and (e.normalized_expression,e.expression_type,e.identity_variant)=
        (ev.canonical_normalized_expression,ev.canonical_expression_type,ev.canonical_identity_variant)
  where s.sense_id=p_sense$new$;
  if strpos(definition,old)=0 then raise exception 'REVIEW_CANONICAL_IDENTITY_MARKER_DRIFT'; end if;
  execute replace(definition,old,replacement);

  signature:='public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)';
  definition:=pg_get_functiondef(to_regprocedure(signature));
  old:=$old$'expression',s.context_form->>'expression','canonicalExpression',w.expression,$old$;
  replacement:=$new$'expression',w.expression,'canonicalExpression',w.expression,'surfaceForms',jsonb_build_array(s.context_form->>'surfaceText'),$new$;
  if strpos(definition,old)=0 then raise exception 'REVIEW_CANONICAL_SNAPSHOT_MARKER_DRIFT'; end if;
  -- Only the snapshot headword + decoration metadata change; source assignment,
  -- coverage, ranking and ALL fixed-pool/distractor generation stay byte-for-byte.
  execute replace(definition,old,replacement);

  signature:='public.wordbook_review_create(uuid,jsonb,uuid,uuid)';
  definition:=pg_get_functiondef(to_regprocedure(signature));
  old:=$old$'snapshot',i.snapshot||coalesce(current_form.fields,'{}'::jsonb)$old$;
  replacement:=$new$'snapshot',(i.snapshot||jsonb_build_object('expression',coalesce(i.snapshot->>'canonicalExpression',i.snapshot->>'expression')))||coalesce(current_form.fields,'{}'::jsonb)$new$;
  if strpos(definition,old)=0 then raise exception 'REVIEW_CANONICAL_RETRY_SNAPSHOT_DRIFT'; end if;
  definition:=replace(definition,old,replacement);
  old:=$old$jsonb_build_object('expression',o.surface_text,
          'canonicalExpression',w.expression,$old$;
  replacement:=$new$jsonb_build_object('expression',w.expression,'surfaceForms',jsonb_build_array(o.surface_text),
          'canonicalExpression',w.expression,$new$;
  if strpos(definition,old)=0 then raise exception 'REVIEW_CANONICAL_RETRY_FORM_DRIFT'; end if;
  definition:=replace(definition,old,replacement);
  old:=$old$where i.kind='spelling_pos' and o.entry_id::text is distinct from previous->>'lexical_entry_id'
          and o.context_pos is distinct from i.snapshot->>'standardPos'$old$;
  replacement:=$new$where ((i.kind='spelling_pos' and o.entry_id::text is distinct from previous->>'lexical_entry_id'
          and o.context_pos is distinct from i.snapshot->>'standardPos')
          or (w.expression is distinct from i.snapshot->>'expression' and o.context_pos is not distinct from i.snapshot->>'standardPos'
            and ss.sense_id::text=i.snapshot->>'senseId'))$new$;
  if strpos(definition,old)=0 then raise exception 'REVIEW_CANONICAL_RETRY_SOURCE_DRIFT'; end if;
  -- New retries normalize their OWN snapshots, not the completed parent. The
  -- existing verified source correction and distinct-lexeme merge are retained.
  execute replace(definition,old,replacement);

  signature:='public.wordbook_review_flow_state(uuid,uuid,text,uuid,jsonb)';
  definition:=pg_get_functiondef(to_regprocedure(signature));
  old:=$old$'meaning',i.snapshot->'meaning','examples',f.examples->i.item_id::text$old$;
  replacement:=$new$'meaning',i.snapshot->'meaning','surfaceForms',coalesce(i.snapshot->'surfaceForms','[]'::jsonb),'examples',f.examples->i.item_id::text$new$;
  if strpos(definition,old)=0 then raise exception 'REVIEW_CANONICAL_PRESENTATION_DRIFT'; end if;
  execute replace(definition,old,replacement);
  select jsonb_object_agg(oid::text,jsonb_build_object('owner',proowner,'acl',proacl,'volatile',provolatile,'type',prorettype,'set',proretset)) into after_meta
    from pg_proc where oid in (to_regprocedure('public.wordbook_saved_contexts(uuid,text[])'),
      to_regprocedure('public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)'),
      to_regprocedure('public.wordbook_review_create(uuid,jsonb,uuid,uuid)'),to_regprocedure('public.wordbook_review_flow_state(uuid,uuid,text,uuid,jsonb)'));
  if before_meta is distinct from after_meta then raise exception 'REVIEW_CANONICAL_CONTRACT_CHANGED'; end if;
end;
$patch$;
update public.student_wordbook_review_installation set function_hashes=function_hashes||(
  select jsonb_object_agg(oid::regprocedure::text,md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n')))
  from pg_proc where pronamespace='public'::regnamespace and proname in
    ('wordbook_saved_contexts','wordbook_review_candidates','wordbook_review_create','wordbook_review_flow_state')
) where version='v1';
notify pgrst,'reload schema';
commit;
