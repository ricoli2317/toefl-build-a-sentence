-- USER-MANUAL schema/runtime ONLY. NO initial production pool data here.
-- Requires installed ASCII/local-POS patch. Empty pool correctly fails closed.
begin;
set local lock_timeout='5s';
do $guard$
declare f record; audit jsonb;
begin
  if to_regclass('public.wordbook_review_fixed_distractors') is not null then
    raise exception 'REVIEW_FIXED_POOL_ALREADY_PRESENT'; end if;
  select function_hashes into audit from public.student_wordbook_review_installation where version='v1';
  if audit is null then raise exception 'REVIEW_FIXED_POOL_INSTALLATION_REQUIRED'; end if;
  for f in select * from (values
    ('public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)','61214848add269f4ac535f8e9fd89682'),
    ('public.wordbook_review_meaning_conflict(text,text)','556b46059d2e33322d35dbea5c39ff25'),
    ('public.wordbook_review_teaching_pos(text)','5b16e016919fa57994e70f2c9d6326f9')
  ) expected(signature,hash) loop
    if not exists(select 1 from pg_proc where oid=to_regprocedure(f.signature)
      and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))=f.hash)
      or not coalesce(audit ? to_regprocedure(f.signature)::text,false) then
      raise exception 'REVIEW_FIXED_POOL_BASELINE_DRIFT: %',f.signature; end if;
  end loop;
  for f in select key as signature,value #>> '{}' as hash from jsonb_each(audit) loop
    if not exists(select 1 from pg_proc where oid=to_regprocedure(f.signature) and not prosecdef
      and proconfig=array['search_path=pg_catalog']::text[]
      and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))=f.hash)
      or has_function_privilege('anon',f.signature,'EXECUTE')
      or has_function_privilege('authenticated',f.signature,'EXECUTE')
      or not has_function_privilege('service_role',f.signature,'EXECUTE') then
      raise exception 'REVIEW_FIXED_POOL_AUDIT_OR_ACL_DRIFT: %',f.signature; end if;
  end loop;
end;
$guard$;

-- Standalone reviewed snapshots; provenance UUIDs deliberately have no corpus
-- FK/cascade: dictionary maintenance cannot silently rewrite this approved pool.
create table public.wordbook_review_fixed_distractors (
  pool_id uuid primary key default gen_random_uuid(),
  pos text not null check(pos in('noun','verb','adjective','adverb','preposition','conjunction','pronoun')),
  english text not null check(english~'^[A-Za-z]+$'),
  normalized_expression text not null check(normalized_expression=lower(english)),
  meaning text not null check(meaning~'^[一-龥]{1,12}$'),
  raw_pos text not null check(public.wordbook_review_teaching_pos(raw_pos) is not null
    and public.wordbook_review_teaching_pos(raw_pos)=pos
    and public.wordbook_review_pos(raw_pos)<>'proper_noun'),
  canonical_entry_id uuid not null,
  occurrence_id uuid not null,
  source_type text not null,
  source_item_id text not null,
  content_block_id text not null,
  definition_en text,
  revision text not null check(btrim(revision)<>''),
  approved boolean not null default false
);
create unique index wordbook_review_fixed_distractors_meaning_idx
  on public.wordbook_review_fixed_distractors(pos,public.wordbook_review_meaning(meaning));
create index wordbook_review_fixed_distractors_pos_idx
  on public.wordbook_review_fixed_distractors(pos,pool_id) where approved;
alter table public.wordbook_review_fixed_distractors enable row level security;
revoke all on public.wordbook_review_fixed_distractors from public,anon,authenticated,service_role;
grant select on public.wordbook_review_fixed_distractors to service_role;
-- No application writes, browser grants or RLS bypass; manual owner-managed data.

do $patch$
declare definition text; block_start integer; block_end integer; audit jsonb;
  before_meta jsonb; after_meta jsonb;
  signature text:='public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)';
begin
  select function_hashes into audit from public.student_wordbook_review_installation where version='v1' for update;
  select jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'stable',provolatile,'type',prorettype,'set',proretset)
    into before_meta from pg_proc where oid=to_regprocedure(signature);
  definition:=pg_get_functiondef(to_regprocedure(signature));
  definition:=replace(definition,'pool_meaning text; pool_entry uuid; local_pool jsonb; global_pools jsonb:=''{}''; global_pool jsonb; pool_row record; attempt integer; tier integer; target_links uuid[];',
    'local_pool jsonb; fixed_pool jsonb; global_pool jsonb; tier integer; target_links uuid[]; used_meanings jsonb:=''{}''; selected_meaning text;');
  block_start:=strpos(definition,'            -- Lazily prepare at most ONCE PER POS per candidate-engine call.');
  block_end:=strpos(definition,'          for d in select v.value from jsonb_array_elements(global_pool) v(value) loop');
  if block_start=0 or block_end<=block_start then raise exception 'REVIEW_FIXED_POOL_MARKER_DRIFT'; end if;
  definition:=substr(definition,1,block_start-1)||$replacement$            -- Read the small approved fixed table at most once for this call,
            -- and only AFTER local choices fail. Never read occurrences.
            if fixed_pool is null then
              select coalesce(jsonb_agg(jsonb_build_object('meaning',f.meaning,'pos',f.pos,
                'normalized_expression',f.normalized_expression,'lexical_id',f.canonical_entry_id,'pool_id',f.pool_id)
                order by f.pool_id),'[]') into fixed_pool
              from public.wordbook_review_fixed_distractors f where f.approved;
            end if;
            global_pool:=fixed_pool;
          end if;
$replacement$||substr(definition,block_end);
  definition:=replace(definition,'          for d in select v.value from jsonb_array_elements(global_pool) v(value) loop',
    $replacement$          -- Prefer meanings not yet used this round; allow reuse once
          -- needed rather than making otherwise valid questions unavailable.
          for d in select v.value from jsonb_array_elements(global_pool) v(value)
            order by coalesce((used_meanings->>public.wordbook_review_meaning(v.value->>'meaning'))::integer,0),
              v.value->>'meaning' collate "C",coalesce(v.value->>'wordbook_id',v.value->>'pool_id') loop$replacement$);
  definition:=replace(definition,$old$jsonb_build_object('text',d.value->>'meaning','lexicalEntryId',d.value->>'lexical_id') end);$old$,
    $new$jsonb_build_object('text',d.value->>'meaning','lexicalEntryId',d.value->>'lexical_id','fixedPoolId',d.value->>'pool_id') end);$new$);
  -- Count use only for a successfully chosen sense, not a failed attempt.
  definition:=replace(definition,$old$      chosen:=jsonb_build_object($old$,$new$      if mode='meaning_choice' then
        for selected_meaning in select public.wordbook_review_meaning(o->>'text') from jsonb_array_elements(options) o loop
          used_meanings:=used_meanings||jsonb_build_object(selected_meaning,coalesce((used_meanings->>selected_meaning)::integer,0)+1);
        end loop;
      end if;
      chosen:=jsonb_build_object($new$);
  if strpos(definition,'lexical_occurrences')>0 or strpos(definition,'global_pools')>0 or strpos(definition,'pool_row')>0 then
    raise exception 'REVIEW_FIXED_POOL_OCCURRENCE_PATH_REMAINS'; end if;
  execute definition;
  if not exists(select 1 from pg_proc where oid=to_regprocedure(signature)
    and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))='b210f1a05fbea67b249faf81b57d857e') then
    raise exception 'REVIEW_FIXED_POOL_PATCH_MISMATCH'; end if;
  select jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'stable',provolatile,'type',prorettype,'set',proretset)
    into after_meta from pg_proc where oid=to_regprocedure(signature);
  if before_meta is distinct from after_meta then raise exception 'REVIEW_FIXED_POOL_CONTRACT_CHANGED'; end if;
  update public.student_wordbook_review_installation set function_hashes=function_hashes||(
    select jsonb_build_object(oid::regprocedure::text,md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n')))
    from pg_proc where oid=to_regprocedure(signature)
  ) where version='v1';
end;
$patch$;
commit;
select 'WORDBOOK_REVIEW_FIXED_POOL_MIGRATION_OK' as result;
