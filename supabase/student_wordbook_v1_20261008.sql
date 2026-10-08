-- TPS Wordbook V1 / Phase A1. Run the WHOLE file manually in Supabase SQL Editor
-- only after reviewing student_wordbook_v1_preflight_20261008.sql results.
-- No API/RPC, canonical corpus mutation, enrichment copies or review/SRS tables.
-- One-shot migration: a second run fails atomically rather than hiding schema drift.
begin;
set local lock_timeout = '10s';
set local statement_timeout = '60s';

-- The base lexical DDL is not tracked in main. Fail closed on the dependencies
-- we actually need instead of silently guessing the deployed schema.
-- BEGIN_WORDBOOK_DEPENDENCY_ASSERTIONS
do $$
declare v record;
begin
  for v in select * from (values
    ('profiles', 'id', 'uuid'),
    ('lexical_entries', 'entry_id', 'uuid'),
    ('lexical_entries', 'canonical_expression', 'text'),
    ('lexical_entries', 'normalized_expression', 'text'),
    ('lexical_entries', 'expression_type', 'text'),
    ('lexical_entries', 'identity_variant', 'text'),
    ('lexical_entries', 'common_senses', 'jsonb'),
    ('lexical_entries', 'derived_words', 'jsonb'),
    ('lexical_entries', 'useful_patterns', 'jsonb'),
    ('lexical_entries', 'review_status', 'text'),
    ('lexical_entries', 'lemma', 'text'),
    ('lexical_entries', 'review_notes', 'text'),
    ('lexical_source_blocks', 'block_id', 'uuid'),
    ('lexical_source_blocks', 'source_type', 'text'),
    ('lexical_source_blocks', 'source_item_id', 'text'),
    ('lexical_source_blocks', 'content_block_id', 'text'),
    ('lexical_source_blocks', 'block_kind', 'text'),
    ('lexical_source_blocks', 'source_text_hash', 'text'),
    ('lexical_source_blocks', 'generation_status', 'text'),
    ('lexical_occurrences', 'occurrence_id', 'uuid'),
    ('lexical_occurrences', 'entry_id', 'uuid'),
    ('lexical_occurrences', 'source_type', 'text'),
    ('lexical_occurrences', 'source_item_id', 'text'),
    ('lexical_occurrences', 'content_block_id', 'text'),
    ('lexical_occurrences', 'sentence_id', 'text'),
    ('lexical_occurrences', 'source_anchor_id', 'text'),
    ('lexical_occurrences', 'surface_text', 'text'),
    ('lexical_occurrences', 'start_offset', 'integer'),
    ('lexical_occurrences', 'end_offset', 'integer'),
    ('lexical_occurrences', 'context_pos', 'text'),
    ('lexical_occurrences', 'context_meaning_zh', 'text'),
    ('lexical_occurrences', 'context_definition_en', 'text'),
    ('lexical_occurrences', 'context_text', 'text'),
    ('lexical_occurrences', 'review_status', 'text')
  ) as required(table_name, column_name, type_name) loop
    if not exists (
      select 1 from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid = a.attrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = v.table_name and c.relkind in ('r','p')
        and a.attname = v.column_name and a.attnum > 0 and not a.attisdropped
        and pg_catalog.format_type(a.atttypid, a.atttypmod) = v.type_name
    ) then raise exception 'WORDBOOK_SCHEMA_DEPENDENCY_MISMATCH: %.%', v.table_name, v.column_name;
    end if;
  end loop;
  if to_regprocedure('public.can_use_student_experience()') is null
    or not exists (select 1 from pg_catalog.pg_proc
      where oid = to_regprocedure('public.can_use_student_experience()') and prorettype = 'boolean'::regtype)
    or not has_function_privilege('authenticated','public.can_use_student_experience()','EXECUTE') then
    raise exception 'WORDBOOK_STUDENT_CAPABILITY_REQUIRED';
  end if;
  if not exists (select 1 from pg_catalog.pg_proc
    where oid = to_regprocedure('auth.uid()') and prorettype = 'uuid'::regtype)
    or not has_function_privilege('authenticated','auth.uid()','EXECUTE') then
    raise exception 'WORDBOOK_AUTH_UID_REQUIRED';
  end if;
  for v in select * from (values
    ('profiles', array['id']::text[], true),
    ('lexical_entries', array['entry_id']::text[], true),
    ('lexical_source_blocks', array['block_id']::text[], true),
    ('lexical_occurrences', array['occurrence_id']::text[], true),
    ('lexical_entries', array['normalized_expression','expression_type','identity_variant']::text[], false),
    ('lexical_source_blocks', array['source_type','source_item_id','content_block_id']::text[], false),
    ('lexical_occurrences', array['source_type','source_item_id','content_block_id','start_offset','end_offset']::text[], false)
  ) as required(table_name, columns, require_primary) loop
    if not exists (
      select 1 from pg_catalog.pg_index i
      where i.indrelid = to_regclass('public.' || v.table_name)
        and i.indisunique and i.indisvalid and i.indisready and i.indimmediate
        and (not v.require_primary or i.indisprimary)
        and i.indpred is null and i.indexprs is null and i.indnkeyatts = cardinality(v.columns)
        and (select array_agg(a.attname::text order by k.ordinality)
          from unnest(i.indkey::smallint[]) with ordinality k(attnum, ordinality)
          join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
          where k.ordinality <= i.indnkeyatts) = v.columns
    ) then raise exception 'WORDBOOK_DEPENDENCY_INDEX_REQUIRED: % %', v.table_name, v.columns; end if;
    if exists (
      select 1 from pg_catalog.pg_attribute a
      where a.attrelid = to_regclass('public.' || v.table_name)
        and a.attname::text = any(v.columns) and not a.attnotnull
    ) then raise exception 'WORDBOOK_DEPENDENCY_NOT_NULL_REQUIRED: % %', v.table_name, v.columns; end if;
  end loop;
  -- Verify the FK targets, not guessed constraint names or delete/update actions.
  -- Existing actions are inventoried by preflight; no occurrence FK is added here.
  for v in select * from (values
    ('public.profiles','id','auth.users','id'),
    ('public.lexical_occurrences','entry_id','public.lexical_entries','entry_id')
  ) as required(source_table, source_column, target_table, target_column) loop
    if not exists (
      select 1 from pg_catalog.pg_constraint co
      join pg_catalog.pg_attribute sa on sa.attrelid = co.conrelid and sa.attname = v.source_column
      join pg_catalog.pg_attribute ta on ta.attrelid = co.confrelid and ta.attname = v.target_column
      where co.contype = 'f' and co.convalidated
        and co.conrelid = to_regclass(v.source_table) and co.confrelid = to_regclass(v.target_table)
        and co.conkey = array[sa.attnum]::smallint[] and co.confkey = array[ta.attnum]::smallint[]
    ) then raise exception 'WORDBOOK_DEPENDENCY_FK_REQUIRED: % -> %', v.source_table, v.target_table; end if;
  end loop;
  if not has_schema_privilege('authenticated','public','USAGE')
    or not has_schema_privilege('authenticated','auth','USAGE')
    or not has_schema_privilege('service_role','public','USAGE')
    or not exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role' and (rolbypassrls or rolsuper)) then
    raise exception 'WORDBOOK_ROLE_SCHEMA_PRIVILEGES_REQUIRED';
  end if;
  -- RLS cannot protect against a client role with BYPASSRLS/superuser or the
  -- migration owner's privileges. Check effective membership, not only grants.
  for v in select unnest(array['anon','authenticated']) as role_name loop
    if not exists (select 1 from pg_catalog.pg_roles where rolname = v.role_name
      and not rolbypassrls and not rolsuper)
      or pg_has_role(v.role_name, current_user, 'USAGE') then
      raise exception 'WORDBOOK_CLIENT_ROLE_UNSAFE: %', v.role_name;
    end if;
  end loop;
  for v in select unnest(array['lexical_entries','lexical_occurrences','lexical_source_blocks']) as table_name loop
    if not exists (select 1 from pg_catalog.pg_class where oid = to_regclass('public.' || v.table_name) and relrowsecurity)
      or not has_table_privilege('service_role', 'public.' || v.table_name, 'SELECT')
      or has_table_privilege('anon', 'public.' || v.table_name, 'SELECT')
      or has_table_privilege('authenticated', 'public.' || v.table_name, 'SELECT') then
      raise exception 'WORDBOOK_CORPUS_PERMISSION_MISMATCH: %', v.table_name;
    end if;
  end loop;
  if exists (select 1 from public.lexical_entries
    where jsonb_typeof(common_senses) is distinct from 'array'
      or jsonb_typeof(derived_words) is distinct from 'array'
      or jsonb_typeof(useful_patterns) is distinct from 'array') then
    raise exception 'WORDBOOK_ENRICHMENT_ARRAYS_REQUIRED';
  end if;
end;
$$;
-- END_WORDBOOK_DEPENDENCY_ASSERTIONS

-- Text-only JSON encoding distinguishes NULL/empty strings and delimiter-like
-- text without a separator collision. Fixed 32-byte keys avoid oversized btree
-- index entries for long definitions/sentences. A2 MUST compare exact snapshots
-- on a hash conflict and abort on inequality (never silently merge a collision).
create function public.wordbook_snapshot_key(p_values text[])
returns bytea language sql immutable strict parallel safe
set search_path = pg_catalog
as $$ select sha256(convert_to(array_to_json(p_values)::text, 'UTF8')); $$;

-- Exactly one canonical, sorted, duplicate-free source set; lowercase runtime
-- vocabulary is preserved. WE/AD are labels for write_email/academic_discussion.
create function public.wordbook_source_types_valid(p_types text[], p_domain text)
returns boolean language sql immutable strict parallel safe
set search_path = pg_catalog
as $$
  select cardinality(p_types) > 0
    and array_ndims(p_types) = 1 and array_lower(p_types, 1) = 1
    and array_position(p_types, null) is null
    and p_types = array(select distinct t collate "C" from unnest(p_types) t order by t collate "C")
    and case p_domain
      when 'reading' then p_types <@ array['ctw','rdl','rap']::text[]
      when 'writing' then p_types <@ array['bas','write_email','academic_discussion']::text[]
      else false end;
$$;

create table public.student_wordbook_entries (
  wordbook_entry_id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  domain text not null check (domain in ('reading','writing')),
  expression text not null check (btrim(expression) <> ''),
  normalized_expression text not null check (btrim(normalized_expression) <> ''),
  expression_type text not null check (expression_type in ('word','phrase','phrasal_verb','idiom','proper_noun')),
  identity_variant text not null,
  -- Stable reviewed lexeme anchor, independent of transport canonical UUIDs.
  -- Automatic identity uses the FULL tuple; cross-variant equivalence requires
  -- an approved deterministic anchor mapping, NOT a display/lemma heuristic.
  lexeme_key bytea generated always as (
    public.wordbook_snapshot_key(array[normalized_expression, expression_type, identity_variant])
  ) stored,
  first_saved_at timestamptz not null default now(),
  constraint student_wordbook_entries_lexeme_key unique (student_id, domain, lexeme_key),
  -- Composite ownership keys prevent cross-owner/domain children even with a
  -- service-role programming error.
  constraint student_wordbook_entries_owner_key unique (wordbook_entry_id, student_id, domain)
);
create index student_wordbook_entries_list_idx
  on public.student_wordbook_entries(student_id, domain, first_saved_at desc, wordbook_entry_id);

-- One wordbook lexeme may reference multiple explicitly reviewed canonical
-- identities. Preserve each full identity: no enrichment or navigation copies.
-- Current corpus UNIQUE allows only one live entry per exact triple; multiple
-- DIFFERENT variants require an external approved equivalence decision. This
-- migration does not approve any pairs or populate an equivalence mapping.
create table public.student_wordbook_canonical_links (
  wordbook_entry_id uuid not null,
  student_id uuid not null,
  domain text not null,
  lexical_entry_id uuid not null references public.lexical_entries(entry_id)
    on delete restrict on update cascade,
  canonical_normalized_expression text not null,
  canonical_expression_type text not null,
  canonical_identity_variant text not null,
  association_kind text not null check (association_kind in ('exact_identity','reviewed_equivalent')),
  identity_review_reference text,
  first_linked_at timestamptz not null default now(),
  primary key (wordbook_entry_id, lexical_entry_id),
  unique (student_id, domain, lexical_entry_id),
  foreign key (wordbook_entry_id, student_id, domain)
    references public.student_wordbook_entries(wordbook_entry_id, student_id, domain) on delete cascade,
  constraint student_wordbook_canonical_review_shape check (
    (association_kind = 'exact_identity' and identity_review_reference is null)
    or (association_kind = 'reviewed_equivalent' and identity_review_reference is not null
      and btrim(identity_review_reference) <> '')
  )
);
create index student_wordbook_canonical_links_lexical_idx
  on public.student_wordbook_canonical_links(lexical_entry_id);

create table public.student_wordbook_senses (
  sense_id uuid primary key default gen_random_uuid(),
  wordbook_entry_id uuid not null,
  student_id uuid not null,
  domain text not null,
  context_pos text check (context_pos is null or btrim(context_pos) <> ''),
  context_meaning_zh text not null check (btrim(context_meaning_zh) <> ''),
  context_definition_en text check (context_definition_en is null or btrim(context_definition_en) <> ''),
  snapshot_key bytea generated always as (
    public.wordbook_snapshot_key(array[context_pos, context_meaning_zh, context_definition_en])
  ) stored,
  first_saved_at timestamptz not null default now(),
  foreign key (wordbook_entry_id, student_id, domain)
    references public.student_wordbook_entries(wordbook_entry_id, student_id, domain) on delete cascade,
  constraint student_wordbook_senses_snapshot_key unique (wordbook_entry_id, snapshot_key),
  constraint student_wordbook_senses_owner_key unique (sense_id, wordbook_entry_id, student_id, domain)
);
create index student_wordbook_senses_owner_idx
  on public.student_wordbook_senses(student_id, domain, wordbook_entry_id);

create table public.student_wordbook_examples (
  example_id uuid primary key default gen_random_uuid(),
  wordbook_entry_id uuid not null,
  student_id uuid not null,
  domain text not null,
  -- Exact verified sentence OR honest fragment (title/subject/option/natural
  -- source block); never AI-written, completed, or a fixed-length truncation.
  example_text text not null check (btrim(example_text) <> ''),
  context_kind text not null check (context_kind in ('sentence','fragment')),
  source_block_kind text not null check (btrim(source_block_kind) <> ''),
  extraction_method text not null,
  constraint student_wordbook_example_extraction_shape check (
    (context_kind = 'sentence' and extraction_method in (
      'canonical_sentence', 'verified_sentence_span', 'whole_sentence_block'
    )) or (context_kind = 'fragment' and extraction_method in (
      'whole_fragment_block', 'verified_fragment_span', 'whole_block_fallback'
    ))
  ),
  snapshot_key bytea generated always as (public.wordbook_snapshot_key(array[example_text])) stored,
  source_types text[] not null check (public.wordbook_source_types_valid(source_types, domain)),
  first_saved_at timestamptz not null default now(),
  foreign key (wordbook_entry_id, student_id, domain)
    references public.student_wordbook_entries(wordbook_entry_id, student_id, domain) on delete cascade,
  constraint student_wordbook_examples_snapshot_key unique (wordbook_entry_id, snapshot_key),
  constraint student_wordbook_examples_owner_key unique (example_id, wordbook_entry_id, student_id, domain)
);
create index student_wordbook_examples_owner_idx
  on public.student_wordbook_examples(student_id, domain, wordbook_entry_id);
create index student_wordbook_examples_sources_idx
  on public.student_wordbook_examples using gin(source_types);

-- Required M:N edge, not a review table: one sentence can illustrate multiple
-- saved senses while retaining ONE example row and its complete source set.
create table public.student_wordbook_example_senses (
  example_id uuid not null,
  sense_id uuid not null,
  wordbook_entry_id uuid not null,
  student_id uuid not null,
  domain text not null,
  primary key (example_id, sense_id),
  foreign key (example_id, wordbook_entry_id, student_id, domain)
    references public.student_wordbook_examples(example_id, wordbook_entry_id, student_id, domain) on delete cascade,
  foreign key (sense_id, wordbook_entry_id, student_id, domain)
    references public.student_wordbook_senses(sense_id, wordbook_entry_id, student_id, domain) on delete cascade
);
create index student_wordbook_example_senses_sense_idx
  on public.student_wordbook_example_senses(sense_id, wordbook_entry_id, student_id, domain);
create index student_wordbook_example_senses_owner_idx
  on public.student_wordbook_example_senses(student_id, domain, wordbook_entry_id);

-- O(1) UPDATE guard; no canonical sync trigger, no corpus scan. Merges must
-- insert/copy deduped children and then delete the loser in an explicit audited
-- transaction, not rewrite snapshots. Deletes are permitted for unfavourite.
create function public.guard_student_wordbook_snapshot()
returns trigger language plpgsql set search_path = pg_catalog
as $$
begin
  if tg_table_name = 'student_wordbook_canonical_links' then
    if (to_jsonb(new) - 'lexical_entry_id') is distinct from (to_jsonb(old) - 'lexical_entry_id') then
      raise exception 'WORDBOOK_CANONICAL_LINK_IMMUTABLE';
    end if;
  elsif tg_table_name = 'student_wordbook_entries' then
    if (to_jsonb(new) - 'lexeme_key') is distinct from (to_jsonb(old) - 'lexeme_key') then
      raise exception 'WORDBOOK_ENTRY_SNAPSHOT_IMMUTABLE';
    end if;
  elsif tg_table_name = 'student_wordbook_examples' then
    -- BEFORE triggers cannot read NEW generated columns; compare base fields.
    if (to_jsonb(new) - array['source_types','snapshot_key'])
      is distinct from (to_jsonb(old) - array['source_types','snapshot_key'])
      or not (old.source_types <@ new.source_types) then
      raise exception 'WORDBOOK_EXAMPLE_SNAPSHOT_IMMUTABLE';
    end if;
  else
    if (to_jsonb(new) - 'snapshot_key') is distinct from (to_jsonb(old) - 'snapshot_key') then
      raise exception 'WORDBOOK_SENSE_OR_LINK_SNAPSHOT_IMMUTABLE';
    end if;
  end if;
  return new;
end;
$$;
-- Two indexed row reads on link insertion/ID migration, never a corpus scan or
-- sync trigger. A review reference is an audit pointer, NOT proof by itself:
-- only the trusted server/operator may use an approved identity mapping.
create function public.guard_student_wordbook_canonical_link()
returns trigger language plpgsql set search_path = pg_catalog
as $$
declare v_entry public.lexical_entries%rowtype; v_wordbook public.student_wordbook_entries%rowtype;
begin
  select * into v_entry from public.lexical_entries where entry_id = new.lexical_entry_id;
  if not found then raise exception 'WORDBOOK_CANONICAL_ENTRY_REQUIRED'; end if;
  select * into v_wordbook from public.student_wordbook_entries
    where wordbook_entry_id = new.wordbook_entry_id and student_id = new.student_id and domain = new.domain;
  if not found then raise exception 'WORDBOOK_CANONICAL_OWNER_MISMATCH'; end if;
  if row(new.canonical_normalized_expression, new.canonical_expression_type, new.canonical_identity_variant)
    is distinct from row(v_entry.normalized_expression, v_entry.expression_type, v_entry.identity_variant)
    or new.canonical_normalized_expression is distinct from v_wordbook.normalized_expression
    or new.canonical_expression_type is distinct from v_wordbook.expression_type then
    raise exception 'WORDBOOK_CANONICAL_IDENTITY_MISMATCH';
  end if;
  if (new.association_kind = 'exact_identity' and new.canonical_identity_variant is distinct from v_wordbook.identity_variant)
    or (new.association_kind = 'reviewed_equivalent' and new.canonical_identity_variant is not distinct from v_wordbook.identity_variant) then
    raise exception 'WORDBOOK_CANONICAL_EQUIVALENCE_REVIEW_REQUIRED';
  end if;
  return new;
end;
$$;
create trigger student_wordbook_entries_snapshot_guard before update on public.student_wordbook_entries
  for each row execute function public.guard_student_wordbook_snapshot();
create trigger student_wordbook_senses_snapshot_guard before update on public.student_wordbook_senses
  for each row execute function public.guard_student_wordbook_snapshot();
create trigger student_wordbook_examples_snapshot_guard before update on public.student_wordbook_examples
  for each row execute function public.guard_student_wordbook_snapshot();
create trigger student_wordbook_example_senses_snapshot_guard before update on public.student_wordbook_example_senses
  for each row execute function public.guard_student_wordbook_snapshot();
create trigger student_wordbook_canonical_links_snapshot_guard before update on public.student_wordbook_canonical_links
  for each row execute function public.guard_student_wordbook_snapshot();
create trigger student_wordbook_canonical_links_identity_guard before insert or update on public.student_wordbook_canonical_links
  for each row execute function public.guard_student_wordbook_canonical_link();

alter table public.student_wordbook_entries enable row level security;
alter table public.student_wordbook_senses enable row level security;
alter table public.student_wordbook_examples enable row level security;
alter table public.student_wordbook_example_senses enable row level security;
alter table public.student_wordbook_canonical_links enable row level security;
revoke all on public.student_wordbook_entries, public.student_wordbook_senses,
  public.student_wordbook_examples, public.student_wordbook_example_senses,
  public.student_wordbook_canonical_links from public, anon, authenticated;
grant select on public.student_wordbook_entries, public.student_wordbook_senses,
  public.student_wordbook_examples, public.student_wordbook_example_senses,
  public.student_wordbook_canonical_links to authenticated;
grant select, insert, update, delete on public.student_wordbook_entries, public.student_wordbook_senses,
  public.student_wordbook_examples, public.student_wordbook_example_senses,
  public.student_wordbook_canonical_links to service_role;
create policy students_select_own_wordbook_entries on public.student_wordbook_entries
  for select to authenticated using (student_id = (select auth.uid()) and (select public.can_use_student_experience()));
create policy students_select_own_wordbook_senses on public.student_wordbook_senses
  for select to authenticated using (student_id = (select auth.uid()) and (select public.can_use_student_experience()));
create policy students_select_own_wordbook_examples on public.student_wordbook_examples
  for select to authenticated using (student_id = (select auth.uid()) and (select public.can_use_student_experience()));
create policy students_select_own_wordbook_example_senses on public.student_wordbook_example_senses
  for select to authenticated using (student_id = (select auth.uid()) and (select public.can_use_student_experience()));
create policy students_select_own_wordbook_canonical_links on public.student_wordbook_canonical_links
  for select to authenticated using (student_id = (select auth.uid()) and (select public.can_use_student_experience()));

-- No browser write privileges / policies. A2 must authenticate the account and
-- authorize the exact lexical source BEFORE service-role reads/writes, scope
-- every operation to the verified student_id, and save all five layers in ONE
-- database transaction. Separate PostgREST writes are NOT an atomic save.
revoke all on function public.wordbook_snapshot_key(text[]) from public, anon, authenticated;
revoke all on function public.wordbook_source_types_valid(text[], text) from public, anon, authenticated;
revoke all on function public.guard_student_wordbook_snapshot() from public, anon, authenticated;
revoke all on function public.guard_student_wordbook_canonical_link() from public, anon, authenticated;
grant execute on function public.wordbook_snapshot_key(text[]),
  public.wordbook_source_types_valid(text[], text), public.guard_student_wordbook_snapshot(),
  public.guard_student_wordbook_canonical_link() to service_role;

-- Fail before COMMIT if inherited/default privileges defeated the direct
-- REVOKEs. Never repair unrelated role memberships or global default grants.
do $$
declare v_table text; v_role text; v_function text;
begin
  foreach v_table in array array['student_wordbook_entries','student_wordbook_canonical_links',
    'student_wordbook_senses','student_wordbook_examples','student_wordbook_example_senses'] loop
    foreach v_role in array array['anon','authenticated'] loop
      if has_table_privilege(v_role, 'public.' || v_table, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(v_role, 'public.' || v_table, 'INSERT,UPDATE,REFERENCES')
        or (v_role = 'anon' and has_any_column_privilege(v_role, 'public.' || v_table, 'SELECT')) then
        raise exception 'WORDBOOK_EFFECTIVE_TABLE_PRIVILEGE_UNSAFE: % %', v_table, v_role;
      end if;
    end loop;
  end loop;
  foreach v_function in array array['public.wordbook_snapshot_key(text[])',
    'public.wordbook_source_types_valid(text[],text)', 'public.guard_student_wordbook_snapshot()',
    'public.guard_student_wordbook_canonical_link()'] loop
    if has_function_privilege('anon',v_function,'EXECUTE')
      or has_function_privilege('authenticated',v_function,'EXECUTE') then
      raise exception 'WORDBOOK_EFFECTIVE_FUNCTION_PRIVILEGE_UNSAFE: %', v_function;
    end if;
  end loop;
end;
$$;
commit;
