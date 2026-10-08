-- MANUAL ONLY. After bugfix preflight OK, execute this WHOLE file.
-- Minimal delta against exact installed A3 bodies. No historical migration edits,
-- canonical writes, enrichment changes, fabricated examples or activity backfill.
begin;
set local lock_timeout='10s';
set local statement_timeout='60s';
do $$
declare r record; t text;
begin
  for r in select * from (values
    ('public.operate_student_wordbook_v1(uuid,uuid,text,jsonb)','8410d56364ef419a2a21f81159d391c7'),
    ('public.read_student_wordbook_v1(uuid,text,integer,integer,text,timestamptz,timestamptz)','08cd77dcb9ea8ae35f98fda856949b5d'),
    ('public.guard_student_wordbook_snapshot()','3212671fa54ba4ba38ff6d3a6b8c036e')
  ) v(signature,body_hash) loop
    if not exists(select 1 from pg_proc where oid=to_regprocedure(r.signature)
      and not prosecdef and proconfig=array['search_path=pg_catalog']::text[]
      and md5(btrim(replace(prosrc,E'\r\n',E'\n'),E' \t\r\n'))=r.body_hash)
      or has_function_privilege('anon',r.signature,'EXECUTE')
      or has_function_privilege('authenticated',r.signature,'EXECUTE')
      or not has_function_privilege('service_role',r.signature,'EXECUTE') then
      raise exception 'WORDBOOK_BUGFIX_A3_RPC_OR_ACL_DRIFT: %',r.signature;
    end if;
  end loop;
  foreach t in array array['student_wordbook_entries','student_wordbook_senses','student_wordbook_examples',
    'student_wordbook_example_senses','student_wordbook_canonical_links'] loop
    if not exists(select 1 from pg_class where oid=to_regclass('public.'||t) and relrowsecurity)
      or not exists(select 1 from pg_trigger where tgrelid=to_regclass('public.'||t)
        and tgname=t||'_snapshot_guard' and tgenabled='O'
        and tgfoid=to_regprocedure('public.guard_student_wordbook_snapshot()')) then
        raise exception 'WORDBOOK_BUGFIX_SCHEMA_GUARD_DRIFT: %',t; end if;
  end loop;
  if not exists(select 1 from pg_class where oid=to_regclass('public.student_wordbook_activities') and relrowsecurity)
    or not exists(select 1 from pg_trigger where tgrelid='public.student_wordbook_activities'::regclass
      and tgname='student_wordbook_activities_append_guard' and tgenabled='O'
      and tgfoid=to_regprocedure('public.guard_student_wordbook_activity()')) then
      raise exception 'WORDBOOK_BUGFIX_ACTIVITY_GUARD_REQUIRED'; end if;
end;
$$;
lock table public.student_wordbook_entries,public.student_wordbook_senses,public.student_wordbook_examples,
  public.student_wordbook_example_senses,public.student_wordbook_canonical_links,public.student_wordbook_activities
  in share row exclusive mode;
-- Persist source provenance independently of examples. Empty is permitted ONLY
-- for pre-existing rows without recoverable provenance, never invented from live corpus.
alter table public.student_wordbook_entries add column source_types text[] not null default '{}'
  constraint student_wordbook_entries_sources_valid check
    (source_types='{}'::text[] or public.wordbook_source_types_valid(source_types,domain));
do $patch$
declare body text; old_fragment text; new_fragment text;
begin
  select prosrc into strict body from pg_proc where oid=to_regprocedure('public.guard_student_wordbook_snapshot()');
  body := replace(body,
    $old$if (to_jsonb(new) - 'lexeme_key') is distinct from (to_jsonb(old) - 'lexeme_key') then$old$,
    $new$if (to_jsonb(new) - array['lexeme_key','source_types']) is distinct from (to_jsonb(old) - array['lexeme_key','source_types'])
      or not (old.source_types <@ new.source_types) then$new$);
  execute 'create or replace function public.guard_student_wordbook_snapshot() returns trigger language plpgsql security invoker set search_path=pg_catalog as '||quote_literal(body);

  select prosrc into strict body from pg_proc where oid=to_regprocedure('public.operate_student_wordbook_v1(uuid,uuid,text,jsonb)');
  old_fragment := $old$if coalesce(btrim(p_expected->>'example_text'),'')=''
    or strpos(o.context_text,p_expected->>'example_text')=0
    or p_expected->>'context_kind' is null
    or p_expected->>'context_kind' not in ('sentence','fragment')
    or p_expected->>'extraction_method' is null then raise exception 'WORDBOOK_INVALID_CONTEXT'; end if;$old$;
  new_fragment := $new$-- Only explicit server-verified boundary failure allows no example.
  -- Identity/hash/sense checks above still run and extra client keys still reject.
  if not (p_expected @> '{"example_text":null,"context_kind":null,"extraction_method":"verified_no_example_boundary"}'::jsonb) then
    if coalesce(btrim(p_expected->>'example_text'),'')=''
      or strpos(o.context_text,p_expected->>'example_text')=0
      or p_expected->>'context_kind' is null
      or p_expected->>'context_kind' not in ('sentence','fragment')
      or coalesce(btrim(p_expected->>'extraction_method'),'')=''
      or p_expected->>'extraction_method'='verified_no_example_boundary' then raise exception 'WORDBOOK_INVALID_CONTEXT'; end if;
  end if;$new$;
  if strpos(body,old_fragment)=0 then raise exception 'WORDBOOK_BUGFIX_PATCH_CONTEXT_DRIFT'; end if;
  body := replace(body,old_fragment,new_fragment);
  body := replace(body,
    $old$  insert into public.student_wordbook_canonical_links($old$,
    $new$  -- Additive provenance under the same advisory/row lock as A3.
  v_sources := array(select distinct t collate "C" from unnest(w.source_types || array[o.source_type]) t order by t collate "C");
  v_changed := w.source_types is distinct from v_sources;
  if v_changed then update public.student_wordbook_entries set source_types=v_sources where wordbook_entry_id=w.wordbook_entry_id; end if;
  insert into public.student_wordbook_canonical_links($new$);
  body := replace(body,'v_changed := v_rows > 0;','v_changed := v_changed or v_rows > 0;');
  body := replace(body,'  -- Sanctioned callers share entry/advisory locks;',
    '  if p_expected->>''example_text'' is not null then'||E'\n'||'  -- Sanctioned callers share entry/advisory locks;');
  body := replace(body,'  if v_first or v_changed then',E'  end if; -- optional example and its sense association\n  if v_first or v_changed then');
  execute 'create or replace function public.operate_student_wordbook_v1(p_student_id uuid,p_occurrence_id uuid,p_action text,p_expected jsonb) returns jsonb language plpgsql security invoker set search_path=pg_catalog as '||quote_literal(body);

  select prosrc into strict body from pg_proc where oid=to_regprocedure('public.read_student_wordbook_v1(uuid,text,integer,integer,text,timestamptz,timestamptz)');
  body := replace(body,
    'select distinct unnest(x.source_types) as t from public.student_wordbook_examples x where x.wordbook_entry_id=w.wordbook_entry_id',
    'select unnest(w.source_types) as t union select unnest(x.source_types) as t from public.student_wordbook_examples x where x.wordbook_entry_id=w.wordbook_entry_id');
  execute 'create or replace function public.read_student_wordbook_v1(p_student_id uuid,p_domain text,p_page integer,p_page_size integer,p_sort text,p_start_at timestamptz,p_end_at timestamptz) returns jsonb language plpgsql stable security invoker set search_path=pg_catalog as '||quote_literal(body);
end;
$patch$;
-- Recover only already-saved source sets. No new dates, senses or examples.
update public.student_wordbook_entries w set source_types=array(
  select distinct t collate "C" from public.student_wordbook_examples x cross join lateral unnest(x.source_types) t
  where x.wordbook_entry_id=w.wordbook_entry_id order by t collate "C")
where exists(select 1 from public.student_wordbook_examples x where x.wordbook_entry_id=w.wordbook_entry_id);
-- CREATE OR REPLACE preserves ACLs; explicitly reinforce the service-only boundary.
revoke all on function public.operate_student_wordbook_v1(uuid,uuid,text,jsonb),
  public.read_student_wordbook_v1(uuid,text,integer,integer,text,timestamptz,timestamptz),
  public.guard_student_wordbook_snapshot() from public,anon,authenticated;
grant execute on function public.operate_student_wordbook_v1(uuid,uuid,text,jsonb),
  public.read_student_wordbook_v1(uuid,text,integer,integer,text,timestamptz,timestamptz),
  public.guard_student_wordbook_snapshot() to service_role;
notify pgrst,'reload schema';
commit;
select 'WORDBOOK_BUGFIX_MIGRATION_OK' as result;
