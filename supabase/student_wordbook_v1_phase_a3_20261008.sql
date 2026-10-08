-- ONE-SHOT A3: manually run the WHOLE file AFTER A3 preflight OK.
-- No canonical writes or enrichment copies. Failure rolls everything back.
begin;
set local lock_timeout = '10s';
set local statement_timeout = '60s';
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
      raise exception 'WORDBOOK_A3_TIME_DEPENDENCY: %',t; end if;
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
    raise exception 'WORDBOOK_A3_ALREADY_INSTALLED'; end if;
end;
$$;
-- Block old saves while reconstructing history/replacing RPC; student tables ONLY.
lock table public.student_wordbook_entries,public.student_wordbook_senses,public.student_wordbook_examples,
  public.student_wordbook_example_senses,public.student_wordbook_canonical_links in share row exclusive mode;
create table public.student_wordbook_activities (
  activity_id uuid primary key default gen_random_uuid(),
  wordbook_entry_id uuid not null,
  student_id uuid not null,
  domain text not null check (domain in ('reading','writing')),
  event_type text not null check (event_type in ('first_save','append','historical_created')),
  activity_at timestamptz not null default clock_timestamp(),
  foreign key (wordbook_entry_id,student_id,domain)
    references public.student_wordbook_entries(wordbook_entry_id,student_id,domain) on delete cascade
);
create index student_wordbook_activities_dates_idx on public.student_wordbook_activities(student_id,domain,activity_at,wordbook_entry_id);
create index student_wordbook_activities_entry_idx on public.student_wordbook_activities(student_id,domain,wordbook_entry_id,activity_at desc);
create function public.guard_student_wordbook_activity() returns trigger
language plpgsql security invoker set search_path=pg_catalog as $$
begin raise exception 'WORDBOOK_ACTIVITY_APPEND_ONLY'; end;
$$;
create trigger student_wordbook_activities_append_guard before update on public.student_wordbook_activities
  for each row execute function public.guard_student_wordbook_activity();
alter table public.student_wordbook_activities enable row level security;
revoke all on public.student_wordbook_activities from public,anon,authenticated,service_role;
-- No browser access or UPDATE/TRUNCATE. DELETE permits unfavourite FK cascade.
grant select,insert,delete on public.student_wordbook_activities to service_role;
revoke all on function public.guard_student_wordbook_activity() from public,anon,authenticated;
grant execute on function public.guard_student_wordbook_activity() to service_role;

-- CONDITION: intact A1/A2 first_saved_at/guards, A3 absent. ONLY real immutable
-- entry/sense/example creation timestamps; dedupe same-transaction times.
-- No invented source-append/M:N link dates (A1 has no times on those changes).
insert into public.student_wordbook_activities(wordbook_entry_id,student_id,domain,event_type,activity_at)
select w.wordbook_entry_id,w.student_id,w.domain,
  case when h.activity_at=w.first_saved_at then 'first_save' else 'historical_created' end,h.activity_at
from public.student_wordbook_entries w join (
  select wordbook_entry_id,first_saved_at as activity_at from public.student_wordbook_entries
  union select wordbook_entry_id,first_saved_at from public.student_wordbook_senses
  union select wordbook_entry_id,first_saved_at from public.student_wordbook_examples
) h using(wordbook_entry_id);

-- Exact A2 signature/return contract, invoker privilege and locking protocol.
create or replace function public.operate_student_wordbook_v1(
  p_student_id uuid, p_occurrence_id uuid, p_action text, p_expected jsonb
) returns jsonb language plpgsql security invoker set search_path = pg_catalog
as $$
declare
  o public.lexical_occurrences%rowtype;
  e public.lexical_entries%rowtype;
  b public.lexical_source_blocks%rowtype;
  w public.student_wordbook_entries%rowtype;
  s public.student_wordbook_senses%rowtype;
  x public.student_wordbook_examples%rowtype;
  l public.student_wordbook_canonical_links%rowtype;
  v_domain text; v_key bytea; v_current jsonb;
  v_first boolean := false; v_changed boolean := false; v_rows integer; v_sources text[];
begin
  if p_action is null or p_action not in ('save','remove') or p_expected is null then
    raise exception 'WORDBOOK_INVALID_OPERATION';
  end if;
  if not exists(select 1 from public.profiles where id=p_student_id
    and is_active and role in ('student','teacher','admin')) then
    raise exception 'WORDBOOK_STUDENT_REQUIRED';
  end if;
  select * into o from public.lexical_occurrences where occurrence_id=p_occurrence_id;
  if not found or o.review_status='disabled' then raise exception 'WORDBOOK_CANONICAL_STALE'; end if;
  select * into e from public.lexical_entries where entry_id=o.entry_id;
  if not found or e.review_status='disabled' then raise exception 'WORDBOOK_CANONICAL_STALE'; end if;
  select * into b from public.lexical_source_blocks where source_type=o.source_type
    and source_item_id=o.source_item_id and content_block_id=o.content_block_id;
  if not found or b.generation_status<>'generated' then raise exception 'WORDBOOK_CANONICAL_STALE'; end if;
  v_current := jsonb_build_object(
    'entry_id',e.entry_id,'source_type',o.source_type,'source_item_id',o.source_item_id,'content_block_id',o.content_block_id,
    'start_offset',o.start_offset,'end_offset',o.end_offset,'surface_text',o.surface_text,
    'context_text',o.context_text,'sentence_id',o.sentence_id,
    'context_pos',o.context_pos,'context_meaning_zh',o.context_meaning_zh,'context_definition_en',o.context_definition_en,
    'canonical_expression',e.canonical_expression,'normalized_expression',e.normalized_expression,
    'expression_type',e.expression_type,'identity_variant',e.identity_variant,
    'source_text_hash',b.source_text_hash,'source_block_kind',b.block_kind);
  if v_current is distinct from (p_expected - array['example_text','context_kind','extraction_method']) then
    raise exception 'WORDBOOK_CANONICAL_STALE';
  end if;
  v_domain := case when o.source_type in ('ctw','rdl','rap') then 'reading'
    when o.source_type in ('bas','write_email','academic_discussion') then 'writing' else null end;
  if v_domain is null then raise exception 'WORDBOOK_INVALID_SOURCE'; end if;
  v_key := public.wordbook_snapshot_key(array[e.normalized_expression,e.expression_type,e.identity_variant]);
  perform pg_advisory_xact_lock(hashtextextended(p_student_id::text || ':' || v_domain || ':' || encode(v_key,'hex'),0));
  select * into w from public.student_wordbook_entries
    where student_id=p_student_id and domain=v_domain and lexeme_key=v_key for update;
  if found and row(w.normalized_expression,w.expression_type,w.identity_variant)
    is distinct from row(e.normalized_expression,e.expression_type,e.identity_variant) then
    raise exception 'WORDBOOK_IDENTITY_HASH_COLLISION';
  end if;
  if p_action='remove' then
    delete from public.student_wordbook_entries where student_id=p_student_id and domain=v_domain
      and wordbook_entry_id=w.wordbook_entry_id;
    return jsonb_build_object('saved',false,'domain',v_domain,'wordbookEntryId',null);
  end if;
  if coalesce(btrim(p_expected->>'example_text'),'')=''
    or strpos(o.context_text,p_expected->>'example_text')=0
    or p_expected->>'context_kind' is null
    or p_expected->>'context_kind' not in ('sentence','fragment')
    or p_expected->>'extraction_method' is null then raise exception 'WORDBOOK_INVALID_CONTEXT'; end if;
  if w.wordbook_entry_id is null then
    insert into public.student_wordbook_entries(student_id,domain,expression,normalized_expression,expression_type,identity_variant)
      values(p_student_id,v_domain,e.canonical_expression,e.normalized_expression,e.expression_type,e.identity_variant)
      on conflict(student_id,domain,lexeme_key) do nothing;
    get diagnostics v_rows = row_count;
    v_first := v_rows > 0;
    select * into strict w from public.student_wordbook_entries
      where student_id=p_student_id and domain=v_domain and lexeme_key=v_key for update;
    if row(w.normalized_expression,w.expression_type,w.identity_variant)
      is distinct from row(e.normalized_expression,e.expression_type,e.identity_variant) then
      raise exception 'WORDBOOK_IDENTITY_HASH_COLLISION';
    end if;
  end if;
  insert into public.student_wordbook_canonical_links(wordbook_entry_id,student_id,domain,lexical_entry_id,
    canonical_normalized_expression,canonical_expression_type,canonical_identity_variant,association_kind)
    values(w.wordbook_entry_id,p_student_id,v_domain,e.entry_id,e.normalized_expression,e.expression_type,e.identity_variant,'exact_identity')
    on conflict(wordbook_entry_id,lexical_entry_id) do nothing;
  select * into strict l from public.student_wordbook_canonical_links
    where student_id=p_student_id and domain=v_domain and lexical_entry_id=e.entry_id;
  if row(l.wordbook_entry_id,l.canonical_normalized_expression,l.canonical_expression_type,l.canonical_identity_variant,l.association_kind)
    is distinct from row(w.wordbook_entry_id,e.normalized_expression,e.expression_type,e.identity_variant,'exact_identity'::text) then
    raise exception 'WORDBOOK_CANONICAL_IDENTITY_MISMATCH';
  end if;
  insert into public.student_wordbook_senses(wordbook_entry_id,student_id,domain,context_pos,context_meaning_zh,context_definition_en)
    values(w.wordbook_entry_id,p_student_id,v_domain,o.context_pos,o.context_meaning_zh,o.context_definition_en)
    on conflict(wordbook_entry_id,snapshot_key) do nothing;
  get diagnostics v_rows = row_count;
  v_changed := v_rows > 0;
  select * into strict s from public.student_wordbook_senses where wordbook_entry_id=w.wordbook_entry_id
    and snapshot_key=public.wordbook_snapshot_key(array[o.context_pos,o.context_meaning_zh,o.context_definition_en]);
  if row(s.context_pos,s.context_meaning_zh,s.context_definition_en)
    is distinct from row(o.context_pos,o.context_meaning_zh,o.context_definition_en) then
    raise exception 'WORDBOOK_SENSE_HASH_COLLISION';
  end if;
  -- Sanctioned callers share entry/advisory locks; target-side union below
  -- additionally prevents lost updates. No client replacement of source sets.
  select source_types into v_sources from public.student_wordbook_examples
    where wordbook_entry_id=w.wordbook_entry_id
    and snapshot_key=public.wordbook_snapshot_key(array[p_expected->>'example_text']) for update;
  insert into public.student_wordbook_examples as target
    (wordbook_entry_id,student_id,domain,example_text,context_kind,source_block_kind,extraction_method,source_types)
    values(w.wordbook_entry_id,p_student_id,v_domain,p_expected->>'example_text',p_expected->>'context_kind',b.block_kind,
      p_expected->>'extraction_method',array[o.source_type])
    on conflict(wordbook_entry_id,snapshot_key) do update set source_types=
      array(select distinct t collate "C" from unnest(target.source_types || excluded.source_types) t order by t collate "C")
    returning * into x;
  if x.example_text is distinct from p_expected->>'example_text' then raise exception 'WORDBOOK_EXAMPLE_HASH_COLLISION'; end if;
  v_changed := v_changed or v_sources is distinct from x.source_types;
  insert into public.student_wordbook_example_senses(example_id,sense_id,wordbook_entry_id,student_id,domain)
    values(x.example_id,s.sense_id,w.wordbook_entry_id,p_student_id,v_domain)
    on conflict(example_id,sense_id) do nothing;
  get diagnostics v_rows = row_count;
  v_changed := v_changed or v_rows > 0;
  if v_first or v_changed then
    insert into public.student_wordbook_activities(wordbook_entry_id,student_id,domain,event_type,activity_at)
      values(w.wordbook_entry_id,p_student_id,v_domain,case when v_first then 'first_save' else 'append' end,
        case when v_first then w.first_saved_at else clock_timestamp() end);
  end if;
  return jsonb_build_object('saved',true,'domain',v_domain,'wordbookEntryId',w.wordbook_entry_id);
end;
$$;
revoke all on function public.operate_student_wordbook_v1(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.operate_student_wordbook_v1(uuid,uuid,text,jsonb) to service_role;

-- Single SQL snapshot. Filter/dedupe/order/page BEFORE context/enrichment joins.
create function public.read_student_wordbook_v1(p_student_id uuid,p_domain text,p_page integer,p_page_size integer,
  p_sort text,p_start_at timestamptz,p_end_at timestamptz)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare result jsonb;
begin
  if p_domain is null or p_domain not in ('reading','writing') or p_sort is null or p_sort not in ('newest','oldest')
    or p_page is null or p_page not between 1 and 100000 or p_page_size is null or p_page_size not between 1 and 50
    or (p_start_at is null) <> (p_end_at is null) or p_end_at<=p_start_at then raise exception 'WORDBOOK_INVALID_QUERY'; end if;
  with activity as materialized (
    select a.wordbook_entry_id,max(a.activity_at) as sort_at
    from public.student_wordbook_activities a where a.student_id=p_student_id and a.domain=p_domain
      and (p_start_at is null or a.activity_at>=p_start_at and a.activity_at<p_end_at)
    group by a.wordbook_entry_id
  ), page as materialized (
    select w.*,a.sort_at from activity a join public.student_wordbook_entries w using(wordbook_entry_id)
    where w.student_id=p_student_id and w.domain=p_domain
    order by case when p_sort='newest' then a.sort_at end desc,
      case when p_sort='oldest' then a.sort_at end asc,w.wordbook_entry_id asc
    limit p_page_size offset ((p_page::bigint-1)*p_page_size)
  ), sources as materialized (
    select l.*,e.review_status,e.common_senses,e.derived_words,e.useful_patterns,
      row(l.canonical_normalized_expression,l.canonical_expression_type,l.canonical_identity_variant)
        = row(e.normalized_expression,e.expression_type,e.identity_variant) as identity_matches
    from page w join public.student_wordbook_canonical_links l using(wordbook_entry_id)
    join public.lexical_entries e on e.entry_id=l.lexical_entry_id
    where l.student_id=p_student_id and l.domain=p_domain
  ), items as (
    select s.wordbook_entry_id,s.lexical_entry_id,f.field,item.value from sources s
    cross join lateral (values ('common_senses',s.common_senses),('derived_words',s.derived_words),
      ('useful_patterns',s.useful_patterns)) f(field,contents)
    cross join lateral jsonb_array_elements(case when s.identity_matches then f.contents else '[]'::jsonb end) item(value)
  ), distinct_items as (
    select wordbook_entry_id,field,value,array_agg(distinct lexical_entry_id order by lexical_entry_id) as lexical_entry_ids
    from items group by wordbook_entry_id,field,value
  ), keyed as (
    select *,case
      when field='common_senses' and jsonb_typeof(value)='object' and value ?& array['pos','definition_en'] then jsonb_build_array(value->'pos',value->'definition_en')
      when field='derived_words' and jsonb_typeof(value)='object' and value ?& array['expression','relation'] then jsonb_build_array(value->'expression',value->'relation')
      when field='useful_patterns' and jsonb_typeof(value)='object' and value ? 'pattern' then jsonb_build_array(value->'pattern')
      else null end as conflict_key from distinct_items
  ), annotated as (
    select *,conflict_key is not null and count(*) over(partition by wordbook_entry_id,field,conflict_key)>1 as has_conflict from keyed
  ), assembled as (
    select w.wordbook_entry_id,w.sort_at,jsonb_build_object(
      'wordbookEntryId',w.wordbook_entry_id,'domain',w.domain,'expression',w.expression,
      'lexemeIdentity',jsonb_build_object('normalizedExpression',w.normalized_expression,'expressionType',w.expression_type,'identityVariant',w.identity_variant),
      'firstSavedAt',w.first_saved_at,'lastActivityAt',(select max(a.activity_at) from public.student_wordbook_activities a
        where a.student_id=p_student_id and a.domain=p_domain and a.wordbook_entry_id=w.wordbook_entry_id),
      'sortActivityAt',w.sort_at,
      'sourceTypes',coalesce((select jsonb_agg(t order by t collate "C") from (
        select distinct unnest(x.source_types) as t from public.student_wordbook_examples x where x.wordbook_entry_id=w.wordbook_entry_id) tags),'[]'::jsonb),
      'senses',coalesce((select jsonb_agg(jsonb_build_object('senseId',s.sense_id,'contextPos',s.context_pos,
        'contextMeaningZh',s.context_meaning_zh,'contextDefinitionEn',s.context_definition_en,
        'exampleIds',coalesce((select jsonb_agg(l.example_id order by x.first_saved_at,l.example_id)
          from public.student_wordbook_example_senses l join public.student_wordbook_examples x using(example_id)
          where l.sense_id=s.sense_id),'[]'::jsonb)) order by s.first_saved_at,s.sense_id)
        from public.student_wordbook_senses s where s.wordbook_entry_id=w.wordbook_entry_id),'[]'::jsonb),
      'examples',coalesce((select jsonb_agg(jsonb_build_object('exampleId',x.example_id,'text',x.example_text,
        'contextKind',x.context_kind,'sourceBlockKind',x.source_block_kind,'extractionMethod',x.extraction_method,'sourceTypes',x.source_types)
        order by x.first_saved_at,x.example_id) from public.student_wordbook_examples x where x.wordbook_entry_id=w.wordbook_entry_id),'[]'::jsonb),
      'enrichmentSources',coalesce((select jsonb_agg(jsonb_build_object('lexicalEntryId',s.lexical_entry_id,
        'associationKind',s.association_kind,'canonicalStatus',s.review_status,
        'enrichmentStatus',case when s.identity_matches then 'available' else 'identity_drift' end,
        'commonSenses',case when s.identity_matches then s.common_senses else null end,
        'derivedWords',case when s.identity_matches then s.derived_words else null end,
        'usefulPatterns',case when s.identity_matches then s.useful_patterns else null end) order by s.lexical_entry_id)
        from sources s where s.wordbook_entry_id=w.wordbook_entry_id),'[]'::jsonb),
      'enrichmentItems',coalesce((select jsonb_agg(jsonb_build_object('field',a.field,'value',a.value,
        'lexicalEntryIds',a.lexical_entry_ids,'hasConflict',a.has_conflict) order by a.field collate "C",a.value::text collate "C")
        from annotated a where a.wordbook_entry_id=w.wordbook_entry_id),'[]'::jsonb)
    ) as item from page w
  ) select jsonb_build_object('items',coalesce((select jsonb_agg(item order by
      case when p_sort='newest' then sort_at end desc,case when p_sort='oldest' then sort_at end asc,wordbook_entry_id asc)
      from assembled),'[]'::jsonb),'total',(select count(*) from activity),'page',p_page,'pageSize',p_page_size) into result;
  return result;
end;
$$;
-- Lightweight month-only indexed scan; IANA timezone and independent DST
-- midnight boundaries match practice history. One dot per distinct date.
create function public.read_student_wordbook_activity_dates_v1(p_student_id uuid,p_domain text,p_timezone text,p_month date)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as $$
declare result jsonb; v_start timestamptz; v_end timestamptz;
begin
  if p_domain is null or p_domain not in ('reading','writing') or p_month is null
    or extract(day from p_month)<>1 or p_timezone is null
    or not exists(select 1 from pg_timezone_names where name=p_timezone) then raise exception 'WORDBOOK_INVALID_QUERY'; end if;
  v_start := p_month::timestamp at time zone p_timezone;
  v_end := (p_month+interval '1 month')::timestamp at time zone p_timezone;
  select coalesce(jsonb_agg(day order by day),'[]'::jsonb) into result from (
    select distinct to_char(activity_at at time zone p_timezone,'YYYY-MM-DD') as day
    from public.student_wordbook_activities where student_id=p_student_id and domain=p_domain
      and activity_at>=v_start and activity_at<v_end
  ) d;
  return result;
end;
$$;
revoke all on function public.read_student_wordbook_v1(uuid,text,integer,integer,text,timestamptz,timestamptz),
  public.read_student_wordbook_activity_dates_v1(uuid,text,text,date) from public,anon,authenticated;
grant execute on function public.read_student_wordbook_v1(uuid,text,integer,integer,text,timestamptz,timestamptz),
  public.read_student_wordbook_activity_dates_v1(uuid,text,text,date) to service_role;
do $$
declare role_name text; signature text;
begin
  foreach role_name in array array['anon','authenticated'] loop
    if has_table_privilege(role_name,'public.student_wordbook_activities','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege(role_name,'public.student_wordbook_activities','SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception 'WORDBOOK_A3_EFFECTIVE_ACTIVITY_PERMISSION_UNSAFE'; end if;
    foreach signature in array array['public.operate_student_wordbook_v1(uuid,uuid,text,jsonb)',
      'public.read_student_wordbook_v1(uuid,text,integer,integer,text,timestamptz,timestamptz)',
      'public.read_student_wordbook_activity_dates_v1(uuid,text,text,date)','public.guard_student_wordbook_activity()'] loop
      if has_function_privilege(role_name,signature,'EXECUTE') then raise exception 'WORDBOOK_A3_FUNCTION_PERMISSION_UNSAFE'; end if;
    end loop;
  end loop;
end;
$$;
notify pgrst, 'reload schema';
commit;
select 'WORDBOOK_A3_MIGRATION_OK' as result;
