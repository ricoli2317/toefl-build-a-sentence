-- MANUAL ONLY, after the deployed choice-preference / immersive installation.
-- Exact Kelly source-data repair + context/source coverage delta. Execute this
-- WHOLE file once as database owner in SQL Editor. No import changes, fixed-pool
-- writes, history regrading or changes to existing review snapshots/answers.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
do $guard$
declare f record; audit jsonb;
begin
  select function_hashes into audit from public.student_wordbook_review_installation where version='v1' for update;
  if audit is null or to_regprocedure('public.wordbook_saved_contexts(uuid,text[])') is not null then
    raise exception 'REVIEW_CONTEXT_COVERAGE_BASELINE_REQUIRED_OR_ALREADY_INSTALLED'; end if;
  for f in select * from (values
    ('public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)'),
    ('public.wordbook_review_availability(uuid,jsonb)'),('public.wordbook_review_create(uuid,jsonb,uuid,uuid)')
  ) signatures(signature) loop
    if not exists(select 1 from pg_proc where oid=to_regprocedure(f.signature) and not prosecdef
      and proconfig=array['search_path=pg_catalog']::text[]
      and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))=coalesce(audit->>to_regprocedure(f.signature)::text,
        audit->>replace(f.signature,'public.','')))
      or has_function_privilege('anon',f.signature,'EXECUTE') or has_function_privilege('authenticated',f.signature,'EXECUTE')
      or not has_function_privilege('service_role',f.signature,'EXECUTE') then
      raise exception 'REVIEW_CONTEXT_COVERAGE_AUDIT_OR_ACL_DRIFT: %',f.signature; end if;
  end loop;
  if not exists(select 1 from pg_proc where oid=to_regprocedure('public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)')
    and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))='5c1eef05c08c227b7b2b1fcccba9a0cc') then
    raise exception 'REVIEW_CONTEXT_COVERAGE_CHOICE_PREFERENCE_REQUIRED'; end if;
  for f in select * from (values
    ('public.wordbook_review_create(uuid,jsonb,uuid,uuid)','145d64fa605e851ac3f14dfce5072b55'),
    ('public.wordbook_review_availability(uuid,jsonb)','cd3b73d522260daf3868b04d469fec1b'),
    ('public.read_student_wordbook_v1(uuid,text,integer,integer,text,timestamptz,timestamptz)','dec6074fd48dcba5d0f20aecc14b987d')
  ) expected(signature,hash) loop
    if not exists(select 1 from pg_proc where oid=to_regprocedure(f.signature) and not prosecdef
      and proconfig=array['search_path=pg_catalog']::text[] and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))=f.hash)
      or has_function_privilege('anon',f.signature,'EXECUTE') or has_function_privilege('authenticated',f.signature,'EXECUTE')
      or not has_function_privilege('service_role',f.signature,'EXECUTE') then
      raise exception 'REVIEW_CONTEXT_COVERAGE_BASELINE_DRIFT: %',f.signature; end if;
  end loop;
end;
$guard$;

-- One-time data repair, not a runtime exception or importer compatibility rule.
-- Source identity, span, full text, old sense and both canonical identities must
-- match the inspected baseline. Drift aborts the entire transaction.
-- Serialize collection writes during this short owner-only maintenance step.
lock table public.lexical_entries,public.lexical_occurrences,public.lexical_source_blocks,public.student_wordbook_entries,
  public.student_wordbook_senses,public.student_wordbook_source_evidence,
  public.student_wordbook_examples,public.student_wordbook_example_senses,
  public.student_wordbook_canonical_links,public.student_wordbook_activities
  in share row exclusive mode;
do $data_guard$
declare t text; o public.lexical_occurrences%rowtype;
begin
  select * into strict o from public.lexical_occurrences
    where occurrence_id='7d9149ee-c1b6-52a8-8da7-21094c9b4446' for update;
  if (o.entry_id,o.source_type,o.source_item_id,o.content_block_id,o.surface_text,
      o.start_offset,o.end_offset,o.context_pos,o.context_meaning_zh,o.context_definition_en,o.context_text)
    is distinct from ('2276d60e-63b6-505d-89b6-cc531c1a61d1'::uuid,'academic_discussion',
      '5971fd56-b771-4ab3-9b8c-443068c5fa1b','student-response:1','motivated',257,266,
      'verb','有动力的','Give reason to act.',
      'I do not think volunteers should receive any form of compensation because it can change the true meaning of volunteering. Volunteering should be about helping others, not earning rewards. Even small rewards may result in attracting people who are not truly motivated to help the cause.')
    or o.review_status='disabled' then raise exception 'KELLY_MOTIVATED_SOURCE_BASELINE_DRIFT'; end if;
  if not exists(select 1 from public.lexical_entries where entry_id=o.entry_id
      and (canonical_expression,normalized_expression,expression_type,identity_variant)=('motivate','motivate','word','')
      and review_status<>'disabled')
    or not exists(select 1 from public.lexical_entries where entry_id='3b34cff2-4169-5086-8708-d9987b118108'
      and (canonical_expression,normalized_expression,expression_type,identity_variant)=('motivated','motivated','word','')
      and review_status<>'disabled') then raise exception 'KELLY_MOTIVATED_CANONICAL_DRIFT'; end if;
  foreach t in array array['student_wordbook_entries','student_wordbook_senses','student_wordbook_source_evidence'] loop
    if not exists(select 1 from pg_trigger where tgrelid=to_regclass('public.'||t)
      and tgname=t||'_snapshot_guard' and tgenabled='O'
      and tgfoid=to_regprocedure('public.guard_student_wordbook_snapshot()')) then
      raise exception 'KELLY_MOTIVATED_SNAPSHOT_GUARD_DRIFT: %',t; end if;
  end loop;
  if not exists(select 1 from pg_trigger where tgrelid='public.student_wordbook_activities'::regclass
    and tgname='student_wordbook_activities_append_guard' and tgenabled='O'
    and tgfoid=to_regprocedure('public.guard_student_wordbook_activity()')) then
    raise exception 'KELLY_MOTIVATED_ACTIVITY_GUARD_DRIFT'; end if;
end;
$data_guard$;
-- Only these collection guards are suspended, inside this locked transaction.
-- FK, uniqueness, canonical identity, example and ALL review guards stay active.
-- Failure rolls back both the data and trigger state. No permanent bypass.
alter table public.student_wordbook_entries disable trigger student_wordbook_entries_snapshot_guard;
alter table public.student_wordbook_senses disable trigger student_wordbook_senses_snapshot_guard;
alter table public.student_wordbook_source_evidence disable trigger student_wordbook_source_evidence_snapshot_guard;
alter table public.student_wordbook_activities disable trigger student_wordbook_activities_append_guard;
do $repair$
declare
  o public.lexical_occurrences%rowtype; ev public.student_wordbook_source_evidence%rowtype;
  w public.student_wordbook_entries%rowtype; s public.student_wordbook_senses%rowtype;
  target public.student_wordbook_entries%rowtype; target_s public.student_wordbook_senses%rowtype;
  x public.student_wordbook_examples%rowtype; target_x uuid; old_examples uuid[];
  reuse_original boolean; new_target boolean; linked_at timestamptz;
begin
  select * into strict o from public.lexical_occurrences where occurrence_id='7d9149ee-c1b6-52a8-8da7-21094c9b4446';
  for ev in select * from public.student_wordbook_source_evidence where occurrence_id=o.occurrence_id
    order by student_id,evidence_id loop
    select * into strict w from public.student_wordbook_entries where wordbook_entry_id=ev.wordbook_entry_id;
    select * into strict s from public.student_wordbook_senses where sense_id=ev.sense_id;
    select first_linked_at into strict linked_at from public.student_wordbook_canonical_links
      where wordbook_entry_id=w.wordbook_entry_id and lexical_entry_id=o.entry_id
      and (canonical_normalized_expression,canonical_expression_type,canonical_identity_variant,association_kind)
        =('motivate','word','','exact_identity');
    if (ev.lexical_entry_id,ev.source_type,ev.source_item_id,ev.content_block_id,ev.start_offset,ev.end_offset)
        is distinct from (o.entry_id,o.source_type,o.source_item_id,o.content_block_id,o.start_offset,o.end_offset)
      or (ev.canonical_normalized_expression,ev.canonical_expression_type,ev.canonical_identity_variant)
        is distinct from ('motivate','word','')
      or (w.normalized_expression,w.expression_type,w.identity_variant,w.domain) is distinct from ('motivate','word','','writing')
      or (s.context_pos,s.context_meaning_zh,s.context_definition_en)
        is distinct from (o.context_pos,o.context_meaning_zh,o.context_definition_en)
      or not exists(select 1 from public.lexical_source_blocks b where
        (b.source_type,b.source_item_id,b.content_block_id,b.source_text_hash)=
        (ev.source_type,ev.source_item_id,ev.content_block_id,ev.source_text_hash) and b.generation_status='generated')
      then raise exception 'KELLY_MOTIVATED_SAVED_ASSOCIATION_DRIFT: %',ev.evidence_id; end if;
    select * into target from public.student_wordbook_entries where student_id=w.student_id and domain=w.domain
      and (normalized_expression,expression_type,identity_variant)=('motivated','word','');
    reuse_original:=target.wordbook_entry_id is null
      and not exists(select 1 from public.student_wordbook_senses where wordbook_entry_id=w.wordbook_entry_id and sense_id<>s.sense_id)
      and not exists(select 1 from public.student_wordbook_source_evidence where wordbook_entry_id=w.wordbook_entry_id and evidence_id<>ev.evidence_id)
      and not exists(select 1 from public.student_wordbook_canonical_links where wordbook_entry_id=w.wordbook_entry_id and lexical_entry_id<>o.entry_id);
    if reuse_original then
      -- Current production shape: retain collection/sense/example/evidence IDs,
      -- original dates and activities, changing only their incorrect identity.
      update public.student_wordbook_entries set expression='motivated',normalized_expression='motivated'
        where wordbook_entry_id=w.wordbook_entry_id returning * into target;
      update public.student_wordbook_senses set context_pos='adjective',context_definition_en='Eager to help the cause.'
        where sense_id=s.sense_id returning * into target_s;
      delete from public.student_wordbook_canonical_links where wordbook_entry_id=w.wordbook_entry_id and lexical_entry_id=o.entry_id;
    else
      -- A shared motivate collection keeps ALL other senses. If motivated was
      -- already saved, reuse it; otherwise split out just this source/sense.
      new_target:=target.wordbook_entry_id is null;
      if new_target then
        insert into public.student_wordbook_entries(student_id,domain,expression,normalized_expression,
          expression_type,identity_variant,first_saved_at,source_types)
        values(w.student_id,w.domain,'motivated','motivated','word','',s.first_saved_at,array[o.source_type]) returning * into target;
      else
        update public.student_wordbook_entries set source_types=array(select distinct t collate "C"
          from unnest(target.source_types||array[o.source_type]) t order by t collate "C")
          where wordbook_entry_id=target.wordbook_entry_id;
      end if;
      insert into public.student_wordbook_senses(wordbook_entry_id,student_id,domain,context_pos,context_meaning_zh,context_definition_en,first_saved_at)
        values(target.wordbook_entry_id,w.student_id,w.domain,'adjective','有动力的','Eager to help the cause.',s.first_saved_at)
        on conflict(wordbook_entry_id,snapshot_key) do nothing;
      select * into strict target_s from public.student_wordbook_senses where wordbook_entry_id=target.wordbook_entry_id
        and snapshot_key=public.wordbook_snapshot_key(array['adjective','有动力的','Eager to help the cause.']);
      select coalesce(array_agg(px.example_id),'{}') into old_examples from public.student_wordbook_examples px
        join public.student_wordbook_example_senses l using(example_id) where l.sense_id=s.sense_id
        and o.source_type=any(px.source_types) and strpos(o.context_text,px.example_text)>0;
      for x in select * from public.student_wordbook_examples where example_id=any(old_examples) loop
        insert into public.student_wordbook_examples as dest(wordbook_entry_id,student_id,domain,example_text,
          context_kind,source_block_kind,extraction_method,source_types,first_saved_at)
          values(target.wordbook_entry_id,w.student_id,w.domain,x.example_text,x.context_kind,x.source_block_kind,
            x.extraction_method,array[o.source_type],x.first_saved_at)
          on conflict(wordbook_entry_id,snapshot_key) do update set source_types=array(select distinct t collate "C"
            from unnest(dest.source_types||excluded.source_types) t order by t collate "C") returning example_id into target_x;
        insert into public.student_wordbook_example_senses(example_id,sense_id,wordbook_entry_id,student_id,domain)
          values(target_x,target_s.sense_id,target.wordbook_entry_id,w.student_id,w.domain) on conflict do nothing;
      end loop;
      if new_target then
        insert into public.student_wordbook_activities(wordbook_entry_id,student_id,domain,event_type,activity_at)
          values(target.wordbook_entry_id,w.student_id,w.domain,'first_save',s.first_saved_at);
      end if;
    end if;
    insert into public.student_wordbook_canonical_links(wordbook_entry_id,student_id,domain,lexical_entry_id,
      canonical_normalized_expression,canonical_expression_type,canonical_identity_variant,association_kind,first_linked_at)
      values(target.wordbook_entry_id,w.student_id,w.domain,'3b34cff2-4169-5086-8708-d9987b118108',
        'motivated','word','','exact_identity',linked_at) on conflict(wordbook_entry_id,lexical_entry_id) do nothing;
    update public.student_wordbook_source_evidence set wordbook_entry_id=target.wordbook_entry_id,sense_id=target_s.sense_id,
      lexical_entry_id='3b34cff2-4169-5086-8708-d9987b118108',canonical_normalized_expression='motivated'
      where evidence_id=ev.evidence_id;
    if not reuse_original then
      -- Remove only the erroneous source's abandoned edges. Shared correct
      -- senses/examples remain; review items have independent immutable IDs.
      if not exists(select 1 from public.student_wordbook_source_evidence where sense_id=s.sense_id) then
        if exists(select 1 from public.student_wordbook_example_senses where sense_id=s.sense_id
          and not(example_id=any(old_examples))) then raise exception 'KELLY_MOTIVATED_UNRESOLVED_EXAMPLE'; end if;
        delete from public.student_wordbook_senses where sense_id=s.sense_id;
        delete from public.student_wordbook_examples px where px.example_id=any(old_examples)
          and not exists(select 1 from public.student_wordbook_example_senses l where l.example_id=px.example_id);
      end if;
      if not exists(select 1 from public.student_wordbook_source_evidence where wordbook_entry_id=w.wordbook_entry_id and source_type=o.source_type)
        and not exists(select 1 from public.student_wordbook_examples where wordbook_entry_id=w.wordbook_entry_id and o.source_type=any(source_types)) then
        update public.student_wordbook_entries set source_types=array_remove(source_types,o.source_type)
          where wordbook_entry_id=w.wordbook_entry_id;
      end if;
      if not exists(select 1 from public.student_wordbook_senses where wordbook_entry_id=w.wordbook_entry_id)
        and not exists(select 1 from public.student_wordbook_examples where wordbook_entry_id=w.wordbook_entry_id) then
        -- Exact-identity merge: preserve every existing activity ID/date before
        -- deleting the empty losing shell (never the student's collection).
        if new_target then delete from public.student_wordbook_activities where wordbook_entry_id=target.wordbook_entry_id; end if;
        update public.student_wordbook_activities set wordbook_entry_id=target.wordbook_entry_id where wordbook_entry_id=w.wordbook_entry_id;
        update public.student_wordbook_entries set first_saved_at=least(first_saved_at,w.first_saved_at)
          where wordbook_entry_id=target.wordbook_entry_id;
        delete from public.student_wordbook_entries where wordbook_entry_id=w.wordbook_entry_id;
      end if;
    end if;
  end loop;
  update public.lexical_occurrences set entry_id='3b34cff2-4169-5086-8708-d9987b118108',
    context_pos='adjective',context_definition_en='Eager to help the cause.',updated_at=now()
    where occurrence_id=o.occurrence_id;
end;
$repair$;
alter table public.student_wordbook_entries enable trigger student_wordbook_entries_snapshot_guard;
alter table public.student_wordbook_senses enable trigger student_wordbook_senses_snapshot_guard;
alter table public.student_wordbook_source_evidence enable trigger student_wordbook_source_evidence_snapshot_guard;
alter table public.student_wordbook_activities enable trigger student_wordbook_activities_append_guard;
do $data_check$
begin
  if not exists(select 1 from public.lexical_occurrences where occurrence_id='7d9149ee-c1b6-52a8-8da7-21094c9b4446'
    and entry_id='3b34cff2-4169-5086-8708-d9987b118108' and context_pos='adjective'
    and context_meaning_zh='有动力的' and context_definition_en='Eager to help the cause.')
    or exists(select 1 from public.student_wordbook_source_evidence ev
      join public.student_wordbook_senses s using(sense_id)
      join public.student_wordbook_entries w on w.wordbook_entry_id=ev.wordbook_entry_id
      where ev.occurrence_id='7d9149ee-c1b6-52a8-8da7-21094c9b4446' and
        ((ev.lexical_entry_id,ev.canonical_normalized_expression,w.expression,w.normalized_expression,s.context_pos,
          s.context_meaning_zh,s.context_definition_en) is distinct from
          ('3b34cff2-4169-5086-8708-d9987b118108'::uuid,'motivated','motivated','motivated','adjective','有动力的','Eager to help the cause.')))
    then raise exception 'KELLY_MOTIVATED_REPAIR_POSTCHECK_FAILED'; end if;
end;
$data_check$;

-- Read only exact saved source evidence + its stored sense. A drifted or
-- missing occurrence is not permission to pair canonical spelling with another
-- sense. PK/indexed sense and occurrence probes; no whole-corpus scan.
create function public.wordbook_saved_contexts(p_sense uuid,p_sources text[]) returns setof jsonb
language sql stable security invoker set search_path=pg_catalog as $$
  select jsonb_build_object('expression',o.surface_text,'contextPos',o.context_pos,
    'contextMeaningZh',o.context_meaning_zh,'contextDefinitionEn',o.context_definition_en,
    'occurrenceId',o.occurrence_id,'sourceType',o.source_type,'contextText',o.context_text)
  from public.student_wordbook_senses s join public.student_wordbook_source_evidence ev
    on ev.sense_id=s.sense_id and (ev.wordbook_entry_id,ev.student_id,ev.domain)=(s.wordbook_entry_id,s.student_id,s.domain)
  join public.lexical_occurrences o on o.occurrence_id=ev.occurrence_id
    and (o.entry_id,o.source_type,o.source_item_id,o.content_block_id,o.start_offset,o.end_offset)=
        (ev.lexical_entry_id,ev.source_type,ev.source_item_id,ev.content_block_id,ev.start_offset,ev.end_offset)
    and (o.context_pos,o.context_meaning_zh,o.context_definition_en) is not distinct from
        (s.context_pos,s.context_meaning_zh,s.context_definition_en)
  where s.sense_id=p_sense and (p_sources is null or ev.source_type=any(p_sources))
    and coalesce(btrim(o.surface_text),'')<>''
    and substring(o.context_text from o.start_offset+1 for o.end_offset-o.start_offset)=o.surface_text
  order by ev.source_type collate "C",ev.occurrence_id;
$$;

-- At most three sources. Hall's subset test fails fast on overlapping lexemes;
-- recursion then finds a distinct representative without greedy starvation.
-- Input order is the original new/less-reviewed/random preference order.
create function public.wordbook_review_cover(candidates jsonb,sources text[]) returns jsonb
language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare n integer:=cardinality(sources); mask integer; subset text[]; c record; rest jsonb; covered jsonb;
begin
  if n=0 then return '[]'::jsonb; end if;
  if n>3 then raise exception 'REVIEW_INVALID_SETTINGS'; end if;
  for mask in 1..(power(2,n)::integer-1) loop
    subset:=array(select sources[i] from generate_series(1,n) i where (mask & (1<<(i-1)))<>0);
    if (select count(distinct v->>'entry_id') from jsonb_array_elements(candidates) v
      where v->'snapshot'->>'assignedSource'=any(subset))<cardinality(subset) then return null; end if;
  end loop;
  for c in select v from jsonb_array_elements(candidates) with ordinality a(v,rank)
    where v->'snapshot'->>'assignedSource'=sources[1] order by rank loop
    select coalesce(jsonb_agg(v order by rank),'[]') into rest
      from jsonb_array_elements(candidates) with ordinality a(v,rank) where v->>'entry_id'<>c.v->>'entry_id';
    covered:=public.wordbook_review_cover(rest,sources[2:n]);
    if covered is not null then return jsonb_build_array(c.v)||covered; end if;
  end loop;
  return null;
end;
$$;

create function public.wordbook_review_select(candidates jsonb,sources text[],k integer) returns jsonb
language plpgsql immutable security invoker set search_path=pg_catalog as $$
declare source text; covered jsonb; extra jsonb; available integer;
begin
  if k<cardinality(sources) then raise exception 'REVIEW_COVERAGE_COUNT:%',cardinality(sources); end if;
  foreach source in array sources loop
    if not exists(select 1 from jsonb_array_elements(candidates) v where v->'snapshot'->>'assignedSource'=source) then
      raise exception 'REVIEW_COVERAGE_MISSING:%',source; end if;
  end loop;
  covered:=public.wordbook_review_cover(candidates,sources);
  if covered is null then raise exception 'REVIEW_COVERAGE_OVERLAP'; end if;
  select count(distinct v->>'entry_id') into available from jsonb_array_elements(candidates) v;
  if available<k then raise exception 'REVIEW_INSUFFICIENT:%',available; end if;
  select coalesce(jsonb_agg(v order by rank),'[]') into extra from (select v,rank from (
    select v,rank,row_number() over(partition by v->>'entry_id' order by rank) variant
    from jsonb_array_elements(candidates) with ordinality a(v,rank)
    where not exists(select 1 from jsonb_array_elements(covered) r where r->>'entry_id'=v->>'entry_id')
  ) e where variant=1 order by rank limit k-cardinality(sources)) picked;
  return covered||extra;
end;
$$;

do $patch$
declare definition text; old text; replacement text; signature text;
  before_meta jsonb; after_meta jsonb;
begin
  select jsonb_object_agg(oid::text,jsonb_build_object('owner',proowner,'acl',proacl,'volatile',provolatile,'type',prorettype,'set',proretset)) into before_meta
    from pg_proc where oid in (to_regprocedure('public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)'),
      to_regprocedure('public.wordbook_review_create(uuid,jsonb,uuid,uuid)'),to_regprocedure('public.read_student_wordbook_v1(uuid,text,integer,integer,text,timestamptz,timestamptz)'));
  signature:='public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)';
  definition:=pg_get_functiondef(to_regprocedure(signature));
  old:=$old$    required_sources:=array(select t from unnest(hit) t where t in ('ctw','write_email','academic_discussion'));
    mode:=case when cardinality(required_sources)>0 then 'spelling_pos' else 'meaning_choice' end;
    if mode='meaning_choice' then required_sources:=hit; end if;$old$;
  replacement:=$new$    foreach requested_source in array hit loop
    required_sources:=array[requested_source];
    mode:=case when requested_source in ('ctw','write_email','academic_discussion') then 'spelling_pos' else 'meaning_choice' end;$new$;
  if strpos(definition,old)=0 then raise exception 'REVIEW_COVERAGE_CANDIDATE_MODE_DRIFT'; end if;
  definition:=replace(definition,'mode text;','requested_source text; mode text;');
  definition:=replace(definition,old,replacement);
  definition:=replace(definition,'for s in select ss.* from public.student_wordbook_senses ss where ss.wordbook_entry_id=w.wordbook_entry_id',
    'for s in select ss.*,ctx.value as context_form from public.student_wordbook_senses ss cross join lateral public.wordbook_saved_contexts(ss.sense_id,required_sources) ctx(value) where ss.wordbook_entry_id=w.wordbook_entry_id');
  definition:=replace(definition,'public.wordbook_review_teaching_pos(s.context_pos);','public.wordbook_review_teaching_pos(s.context_form->>''contextPos'');');
  definition:=replace(definition,$old$chosen:=jsonb_build_object('expression',w.expression,$old$,
    $new$chosen:=jsonb_build_object('expression',s.context_form->>'expression','canonicalExpression',w.expression,'assignedSource',requested_source,$new$);
  definition:=replace(definition,$old$'standardPos',s.context_pos,$old$,$new$'standardPos',s.context_form->>'contextPos',$new$);
  definition:=replace(definition,$old$'definitionEn',s.context_definition_en,$old$,$new$'definitionEn',s.context_form->>'contextDefinitionEn',$new$);
  definition:=replace(definition,'where ev.sense_id=s.sense_id and ev.source_type=any(required_sources))',
    'where ev.sense_id=s.sense_id and ev.source_type=any(required_sources) and ev.occurrence_id::text=s.context_form->>''occurrenceId'')');
  definition:=replace(definition,'ss.sense_id loop','ss.sense_id,ctx.value->>''occurrenceId'' loop');
  definition:=replace(definition,$old$where l.sense_id=s.sense_id),'[]'),$old$,
    $new$where l.sense_id=s.sense_id and x.source_types && required_sources and strpos(s.context_form->>'contextText',x.example_text)>0),'[]'),$new$);
  definition:=replace(definition,'return next;'||E'\n  end loop;', 'return next;'||E'\n    end loop; -- one source-specific variant per lexeme\n  end loop;');
  if strpos(definition,'ctx.value as context_form')=0 or strpos(definition,'one source-specific variant')=0
    or strpos(definition,'''assignedSource''')=0 then raise exception 'REVIEW_CONTEXT_CANDIDATE_PATCH_DRIFT'; end if;
  execute definition;

  -- Preserve the create lock/idempotency/retry/option generation/insert branches.
  signature:='public.wordbook_review_create(uuid,jsonb,uuid,uuid)';
  definition:=pg_get_functiondef(to_regprocedure(signature));
  old:=$old$    with candidates as materialized (select * from public.wordbook_review_candidates(p_student,q->>'domain',
      array(select jsonb_array_elements_text(q->'sources')),(q->>'startAt')::timestamptz,(q->>'endAt')::timestamptz)),
    counts as (select i.wordbook_entry_id,count(*) as n from public.student_wordbook_review_sessions rs
      join public.student_wordbook_review_items i using(session_id) where rs.student_id=p_student and rs.domain=q->>'domain'
        and rs.mode='random' and rs.started_at>=day_start and rs.started_at<day_end group by i.wordbook_entry_id),
    ranked as (select candidate.*,row_number() over(order by case when q->>'mode'='random' then coalesce(n,0) else 0 end,random()) as rank
      from candidates candidate left join counts h on h.wordbook_entry_id=candidate.entry_id where reason is null)
    select coalesce(jsonb_agg(jsonb_build_object('entry',entry_id,'kind',kind,'snapshot',snapshot) order by rank),'[]'),
      (select count(*) from candidates where reason is null) into selected,k from ranked
      where q->>'mode'<>'random' or rank<=(q->>'count')::integer;
    if q->>'mode'='random' and k<(q->>'count')::integer then raise exception 'REVIEW_INSUFFICIENT:%',k; end if;$old$;
  replacement:=$new$    with candidates as materialized (select * from public.wordbook_review_candidates(p_student,q->>'domain',
      array(select jsonb_array_elements_text(q->'sources')),(q->>'startAt')::timestamptz,(q->>'endAt')::timestamptz)),
    counts as (select i.wordbook_entry_id,count(*) as n from public.student_wordbook_review_sessions rs
      join public.student_wordbook_review_items i using(session_id) where rs.student_id=p_student and rs.domain=q->>'domain'
        and rs.mode='random' and rs.started_at>=day_start and rs.started_at<day_end group by i.wordbook_entry_id),
    ranked_lexemes as (select e.entry_id,row_number() over(order by case when q->>'mode'='random' then coalesce(n,0) else 0 end,random()) as rank
      from (select distinct entry_id from candidates where reason is null) e left join counts h on h.wordbook_entry_id=e.entry_id),
    ranked as (select candidate.*,rank from candidates candidate join ranked_lexemes using(entry_id) where reason is null)
    select coalesce(jsonb_agg(jsonb_build_object('entry',entry_id,'entry_id',entry_id,'kind',kind,'snapshot',snapshot)
      order by rank,case when kind='spelling_pos' then 0 else 1 end,snapshot->>'assignedSource'),'[]'),
      (select count(*) from ranked_lexemes) into selected,k from ranked;
    selected:=public.wordbook_review_select(selected,array(select jsonb_array_elements_text(q->'sources')),
      case when q->>'mode'='random' then (q->>'count')::integer else k end);$new$;
  if strpos(definition,old)=0 then raise exception 'REVIEW_COVERAGE_CREATE_SELECTION_DRIFT'; end if;
  definition:=replace(definition,old,replacement);
  -- A NEW spelling retry may use a corrected live source/saved sense. No word,
  -- occurrence ID or POS repair is hard-coded here. Require exact provenance,
  -- unchanged meaning, and an actual canonical + POS correction in stored data.
  -- Unchanged/deleted/unverifiable sources keep the historical retry contract.
  old:=$old$    select coalesce(jsonb_agg(jsonb_build_object('entry',i.wordbook_entry_id,'kind',i.kind,'snapshot',i.snapshot) order by i.position),'[]') into selected
      from public.student_wordbook_review_items i join public.student_wordbook_review_answers a using(item_id)
      where i.session_id=p_parent and not a.item_correct;$old$;
  replacement:=$new$    with retry as (
      select i.position as retry_position,jsonb_build_object('entry',coalesce(current_form.entry_id,i.wordbook_entry_id),
        'kind',i.kind,'snapshot',i.snapshot||coalesce(current_form.fields,'{}'::jsonb)) v
      from public.student_wordbook_review_items i join public.student_wordbook_review_answers a using(item_id)
      left join lateral (
        select ev.wordbook_entry_id entry_id,jsonb_build_object('expression',o.surface_text,
          'canonicalExpression',w.expression,'senseId',ss.sense_id,'standardPos',ss.context_pos,
          'pos',public.wordbook_review_teaching_pos(ss.context_pos),'definitionEn',ss.context_definition_en,
          'evidence',jsonb_build_array(to_jsonb(ev))) fields
        from jsonb_array_elements(coalesce(i.snapshot->'evidence','[]')) previous
        join public.student_wordbook_source_evidence ev on ev.occurrence_id::text=previous->>'occurrence_id'
          and ev.student_id=p_student and ev.domain=i.domain
          and ev.source_type=previous->>'source_type' and ev.source_item_id=previous->>'source_item_id'
          and ev.content_block_id=previous->>'content_block_id' and ev.start_offset=(previous->>'start_offset')::integer
          and ev.end_offset=(previous->>'end_offset')::integer and ev.source_text_hash=previous->>'source_text_hash'
        join public.student_wordbook_senses ss on (ss.sense_id,ss.wordbook_entry_id,ss.student_id,ss.domain)=
          (ev.sense_id,ev.wordbook_entry_id,ev.student_id,ev.domain)
        join public.student_wordbook_entries w on w.wordbook_entry_id=ev.wordbook_entry_id
        join public.lexical_occurrences o on o.occurrence_id=ev.occurrence_id and
          (o.entry_id,o.source_type,o.source_item_id,o.content_block_id,o.start_offset,o.end_offset)=
          (ev.lexical_entry_id,ev.source_type,ev.source_item_id,ev.content_block_id,ev.start_offset,ev.end_offset)
        join public.lexical_entries le on le.entry_id=o.entry_id and le.review_status<>'disabled'
          and (le.normalized_expression,le.expression_type,le.identity_variant)=
            (ev.canonical_normalized_expression,ev.canonical_expression_type,ev.canonical_identity_variant)
          and (w.normalized_expression,w.expression_type,w.identity_variant)=
            (le.normalized_expression,le.expression_type,le.identity_variant)
        join public.lexical_source_blocks b on (b.source_type,b.source_item_id,b.content_block_id,b.source_text_hash)=
          (ev.source_type,ev.source_item_id,ev.content_block_id,ev.source_text_hash) and b.generation_status='generated'
        where i.kind='spelling_pos' and o.entry_id::text is distinct from previous->>'lexical_entry_id'
          and o.context_pos is distinct from i.snapshot->>'standardPos'
          and o.context_meaning_zh=i.snapshot->>'meaning' and o.review_status<>'disabled'
          and (o.context_pos,o.context_meaning_zh,o.context_definition_en) is not distinct from
            (ss.context_pos,ss.context_meaning_zh,ss.context_definition_en)
          and public.wordbook_review_teaching_pos(ss.context_pos) is not null
          and substring(o.context_text from o.start_offset+1 for o.end_offset-o.start_offset)=o.surface_text
        order by ev.occurrence_id limit 1
      ) current_form on true where i.session_id=p_parent and not a.item_correct
    ), unique_retry as (
      select distinct on(r.v->>'entry') r.v,r.retry_position from retry r order by r.v->>'entry',r.retry_position
    ) select coalesce(jsonb_agg(r.v order by r.retry_position),'[]') into selected from unique_retry r;$new$;
  if strpos(definition,old)=0 then raise exception 'REVIEW_CONTEXT_RETRY_SELECTION_DRIFT'; end if;
  definition:=replace(definition,old,replacement);
  execute definition;

  -- Bounded-page list projection of the stored source forms and senses.
  signature:='public.read_student_wordbook_v1(uuid,text,integer,integer,text,timestamptz,timestamptz)';
  definition:=pg_get_functiondef(to_regprocedure(signature));
  old:=$old$'contextMeaningZh',s.context_meaning_zh,'contextDefinitionEn',s.context_definition_en,$old$;
  replacement:=$new$'contextMeaningZh',s.context_meaning_zh,'contextDefinitionEn',s.context_definition_en,
        'contextForms',coalesce((select jsonb_agg((ctx.value-'contextText')||jsonb_build_object('exampleIds',coalesce((
          select jsonb_agg(x.example_id order by x.example_id) from public.student_wordbook_example_senses sl
          join public.student_wordbook_examples x using(example_id) where sl.sense_id=s.sense_id
            and ctx.value->>'sourceType'=any(x.source_types) and strpos(ctx.value->>'contextText',x.example_text)>0
        ),'[]'))) from public.wordbook_saved_contexts(s.sense_id,null) ctx(value)),'[]'),$new$;
  if strpos(definition,old)=0 then raise exception 'REVIEW_CONTEXT_LIST_PROJECTION_DRIFT'; end if;
  execute replace(definition,old,replacement);
  select jsonb_object_agg(oid::text,jsonb_build_object('owner',proowner,'acl',proacl,'volatile',provolatile,'type',prorettype,'set',proretset)) into after_meta
    from pg_proc where oid in (to_regprocedure('public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)'),
      to_regprocedure('public.wordbook_review_create(uuid,jsonb,uuid,uuid)'),to_regprocedure('public.read_student_wordbook_v1(uuid,text,integer,integer,text,timestamptz,timestamptz)'));
  if before_meta is distinct from after_meta then raise exception 'REVIEW_CONTEXT_COVERAGE_CONTRACT_CHANGED'; end if;
end;
$patch$;

create or replace function public.wordbook_review_availability(p_student uuid,p_settings jsonb) returns jsonb
language plpgsql stable security invoker set search_path=pg_catalog as $$
declare q jsonb:=public.wordbook_review_validate(p_student,p_settings); result jsonb; candidates jsonb;
  sources text[]:=array(select jsonb_array_elements_text(q->'sources')); source_counts jsonb; missing text[]; coverage_error text;
begin
  with all_candidates as materialized (select * from public.wordbook_review_candidates(p_student,q->>'domain',sources,
    (q->>'startAt')::timestamptz,(q->>'endAt')::timestamptz))
  select coalesce(jsonb_agg(to_jsonb(c)) filter(where reason is null),'[]'),
    jsonb_build_object('total',count(distinct entry_id) filter(where reason is null),
      'spellingPos',count(distinct entry_id) filter(where reason is null and kind='spelling_pos'),
      'meaningChoice',count(distinct entry_id) filter(where reason is null and kind='meaning_choice'),
      'unavailable',count(distinct entry_id) filter(where reason is not null),
      'reasons',coalesce((select jsonb_object_agg(reason,n) from (select reason,count(*) n from all_candidates where reason is not null group by reason) r),'{}'),
      'posOptions',public.wordbook_review_pos_options()) into candidates,result from all_candidates c;
  select jsonb_object_agg(source,n),array_agg(source) filter(where n=0) into source_counts,missing from (
    select source,(select count(distinct v->>'entry_id') from jsonb_array_elements(candidates) v
      where v->'snapshot'->>'assignedSource'=source) n from unnest(sources) source) counts;
  if missing is not null then coverage_error:='REVIEW_COVERAGE_MISSING:'||array_to_string(missing,',');
  elsif q->>'mode'='random' and (q->>'count')::integer<cardinality(sources) then coverage_error:='REVIEW_COVERAGE_COUNT:'||cardinality(sources);
  elsif public.wordbook_review_cover(candidates,sources) is null then coverage_error:='REVIEW_COVERAGE_OVERLAP'; end if;
  return result||jsonb_build_object('sourceCounts',source_counts,'minimumCount',cardinality(sources),'coverageError',coverage_error);
end;
$$;

revoke all on function public.wordbook_saved_contexts(uuid,text[]),
  public.wordbook_review_cover(jsonb,text[]),public.wordbook_review_select(jsonb,text[],integer) from public,anon,authenticated;
grant execute on function public.wordbook_saved_contexts(uuid,text[]),
  public.wordbook_review_cover(jsonb,text[]),public.wordbook_review_select(jsonb,text[],integer) to service_role;
update public.student_wordbook_review_installation set function_hashes=function_hashes||(
  select jsonb_object_agg(oid::regprocedure::text,md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n')))
  from pg_proc where pronamespace='public'::regnamespace and proname in ('wordbook_review_candidates','wordbook_review_create',
    'wordbook_review_availability','wordbook_saved_contexts','wordbook_review_cover','wordbook_review_select')
) where version='v1';
notify pgrst,'reload schema';
commit;
