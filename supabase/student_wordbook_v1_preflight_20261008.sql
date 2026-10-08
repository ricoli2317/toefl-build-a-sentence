-- READ ONLY. Run manually BEFORE approving/running the A1 migration.
-- Never executed automatically against production. Diagnostics alone are NOT
-- assertions. The dependency block raises on incompatibility; the final result
-- WORDBOOK_PREFLIGHT_OK is emitted only after ALL assertions have passed.
begin transaction read only;

-- Same read-only dependency assertions as the migration (kept equal by tests).
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

do $$
declare v_name text;
begin
  foreach v_name in array array['student_wordbook_entries','student_wordbook_canonical_links',
    'student_wordbook_senses','student_wordbook_examples','student_wordbook_example_senses'] loop
    if to_regclass('public.' || v_name) is not null then
      raise exception 'WORDBOOK_PREFLIGHT_EXISTING_OBJECT: %', v_name;
    end if;
  end loop;
  if exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('wordbook_snapshot_key','wordbook_source_types_valid',
      'guard_student_wordbook_snapshot','guard_student_wordbook_canonical_link')) then
    raise exception 'WORDBOOK_PREFLIGHT_EXISTING_FUNCTION';
  end if;
end;
$$;

-- Base lexical CREATE TABLE SQL is absent from tracked main; this is the
-- authoritative deployed type/nullability/default inventory, including user IDs.
select table_schema, table_name, column_name, data_type, udt_name, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name in (
  'profiles','lexical_entries','lexical_occurrences','lexical_source_blocks','reading_passage_sentences'
)
or (table_schema = 'auth' and table_name = 'users' and column_name = 'id')
order by table_name, ordinal_position;

-- The migration's explicit type prerequisites. An absent field is FALSE, not
-- an assumed default. Review nullable/default columns above as well.
with required(table_name, column_name, type_name) as (values
  ('profiles','id','uuid'),
  ('lexical_entries','entry_id','uuid'),
  ('lexical_entries','canonical_expression','text'),
  ('lexical_entries','normalized_expression','text'),
  ('lexical_entries','expression_type','text'),
  ('lexical_entries','identity_variant','text'),
  ('lexical_entries','common_senses','jsonb'),
  ('lexical_entries','derived_words','jsonb'),
  ('lexical_entries','useful_patterns','jsonb'),
  ('lexical_entries','review_status','text'),
  ('lexical_entries','lemma','text'),
  ('lexical_entries','review_notes','text'),
  ('lexical_source_blocks','block_id','uuid'),
  ('lexical_source_blocks','source_type','text'),
  ('lexical_source_blocks','source_item_id','text'),
  ('lexical_source_blocks','content_block_id','text'),
  ('lexical_source_blocks','block_kind','text'),
  ('lexical_source_blocks','source_text_hash','text'),
  ('lexical_source_blocks','generation_status','text'),
  ('lexical_occurrences','occurrence_id','uuid'),
  ('lexical_occurrences','entry_id','uuid'),
  ('lexical_occurrences','source_type','text'),
  ('lexical_occurrences','source_item_id','text'),
  ('lexical_occurrences','content_block_id','text'),
  ('lexical_occurrences','sentence_id','text'),
  ('lexical_occurrences','source_anchor_id','text'),
  ('lexical_occurrences','surface_text','text'),
  ('lexical_occurrences','start_offset','integer'),
  ('lexical_occurrences','end_offset','integer'),
  ('lexical_occurrences','context_pos','text'),
  ('lexical_occurrences','context_meaning_zh','text'),
  ('lexical_occurrences','context_definition_en','text'),
  ('lexical_occurrences','context_text','text'),
  ('lexical_occurrences','review_status','text')
)
select r.*, format_type(a.atttypid,a.atttypmod) as actual_type,
  a.attnotnull as actual_not_null,
  coalesce(format_type(a.atttypid,a.atttypmod) = r.type_name,false) as type_matches
from required r left join pg_namespace n on n.nspname = 'public'
left join pg_class c on c.relnamespace = n.oid and c.relname = r.table_name and c.relkind in ('r','p')
left join pg_attribute a on a.attrelid = c.oid and a.attname = r.column_name
  and a.attnum > 0 and not a.attisdropped
order by r.table_name, r.column_name;

-- Actual PKs, UNIQUEs, CHECKs, FK actions (do not infer from test fixtures).
select c.relname as table_name, co.conname, co.contype, co.convalidated,
  co.condeferrable, co.confdeltype, co.confupdtype,
  pg_get_constraintdef(co.oid) as definition
from pg_constraint co join pg_class c on c.oid = co.conrelid
join pg_namespace n on n.oid = c.relnamespace
where (n.nspname = 'public' and c.relname in (
  'profiles','lexical_entries','lexical_occurrences','lexical_source_blocks'
)) or (n.nspname = 'auth' and c.relname = 'users')
order by c.relname, co.conname;
-- Inbound dependencies matter for later canonical ID migration too. Inventory
-- their real actions even when the referencing table is not in the audited set.
select co.conrelid::regclass as source_table, co.confrelid::regclass as target_table,
  co.conname, co.convalidated, co.confdeltype, co.confupdtype,
  pg_get_constraintdef(co.oid) as definition
from pg_constraint co where co.contype = 'f' and co.confrelid in (
  to_regclass('public.profiles'),to_regclass('public.lexical_entries'),
  to_regclass('public.lexical_source_blocks'),to_regclass('public.lexical_occurrences')
)
order by co.conrelid::regclass::text, co.conname;
with required(source_table, source_column, target_table, target_column) as (values
  ('public.profiles','id','auth.users','id'),
  ('public.lexical_occurrences','entry_id','public.lexical_entries','entry_id')
)
select r.*, exists (
  select 1 from pg_constraint co
  join pg_attribute sa on sa.attrelid = co.conrelid and sa.attname = r.source_column
  join pg_attribute ta on ta.attrelid = co.confrelid and ta.attname = r.target_column
  where co.contype = 'f' and co.convalidated
    and co.conrelid = to_regclass(r.source_table) and co.confrelid = to_regclass(r.target_table)
    and co.conkey = array[sa.attnum]::smallint[] and co.confkey = array[ta.attnum]::smallint[]
) as required_fk_present from required r;
select tablename, indexname, indexdef from pg_indexes
where schemaname = 'public' and tablename in (
  'lexical_entries','lexical_occurrences','lexical_source_blocks'
) order by tablename, indexname;

-- Every readiness row must be true for the stated dependency contract.
-- These inspect REAL metadata; no fixture is treated as deployment evidence.
with required(table_name, columns, require_primary) as (values
  ('profiles', array['id']::text[], true),
  ('lexical_entries', array['entry_id']::text[], true),
  ('lexical_source_blocks', array['block_id']::text[], true),
  ('lexical_occurrences', array['occurrence_id']::text[], true),
  ('lexical_entries', array['normalized_expression','expression_type','identity_variant']::text[], false),
  ('lexical_source_blocks', array['source_type','source_item_id','content_block_id']::text[], false),
  ('lexical_occurrences', array['source_type','source_item_id','content_block_id','start_offset','end_offset']::text[], false)
)
select r.*, exists (
  select 1 from pg_index i
  where i.indrelid = to_regclass('public.' || r.table_name)
    and i.indisunique and (not r.require_primary or i.indisprimary)
    and i.indisvalid and i.indisready and i.indimmediate and i.indpred is null and i.indexprs is null
    and i.indnkeyatts = cardinality(r.columns)
    and (select array_agg(a.attname::text order by k.ordinality)
      from unnest(i.indkey::smallint[]) with ordinality k(attnum, ordinality)
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
      where k.ordinality <= i.indnkeyatts) = r.columns
) as matching_index,
  not exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.' || r.table_name)
    and a.attname::text = any(r.columns) and not a.attnotnull) as key_columns_not_null
from required r;

select c.relname as table_name, c.relrowsecurity, c.relforcerowsecurity
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in (
  'lexical_entries','lexical_occurrences','lexical_source_blocks'
);
select tablename, policyname, roles, cmd, qual, with_check from pg_policies
where schemaname = 'public' and tablename in (
  'lexical_entries','lexical_occurrences','lexical_source_blocks'
);
select grantee, table_name, privilege_type from information_schema.table_privileges
where table_schema = 'public' and table_name in (
  'lexical_entries','lexical_occurrences','lexical_source_blocks'
) and grantee in ('PUBLIC','anon','authenticated','service_role')
order by table_name, grantee, privilege_type;
select r.rolname, r.rolbypassrls, r.rolsuper,
  has_schema_privilege(r.rolname,'public','USAGE') as public_schema_usage,
  has_schema_privilege(r.rolname,'auth','USAGE') as auth_schema_usage
from pg_roles r where r.rolname in ('anon','authenticated','service_role');
select t.table_name, has_table_privilege('service_role','public.' || t.table_name,'SELECT') as service_select,
  has_table_privilege('anon','public.' || t.table_name,'SELECT') as anon_select,
  has_table_privilege('authenticated','public.' || t.table_name,'SELECT') as authenticated_select
from (values ('lexical_entries'),('lexical_occurrences'),('lexical_source_blocks')) t(table_name);
select to_regprocedure('public.can_use_student_experience()') as required_capability,
  current_setting('server_version') as postgres_version;
select n.nspname, p.proname, pg_get_function_result(p.oid) as return_type,
  p.prosecdef, p.proacl, pg_get_functiondef(p.oid) as definition,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where p.oid in (to_regprocedure('public.can_use_student_experience()'), to_regprocedure('auth.uid()'));

-- Must all be NULL before a one-shot migration. A partial/previous installation
-- requires inspection, not DROP/recreate or IF NOT EXISTS.
select to_regclass('public.student_wordbook_entries') as entries,
  to_regclass('public.student_wordbook_senses') as senses,
  to_regclass('public.student_wordbook_examples') as examples,
  to_regclass('public.student_wordbook_example_senses') as example_senses,
  to_regclass('public.student_wordbook_canonical_links') as canonical_links,
  to_regprocedure('public.wordbook_snapshot_key(text[])') as snapshot_key,
  to_regprocedure('public.wordbook_source_types_valid(text[],text)') as source_validator,
  to_regprocedure('public.guard_student_wordbook_snapshot()') as snapshot_guard,
  to_regprocedure('public.guard_student_wordbook_canonical_link()') as canonical_guard;

-- Must be zero. Dynamic reads expect actual JSON arrays (not NULL/objects).
select count(*) as invalid_enrichment_arrays from public.lexical_entries
where jsonb_typeof(common_senses) is distinct from 'array'
  or jsonb_typeof(derived_words) is distinct from 'array'
  or jsonb_typeof(useful_patterns) is distinct from 'array';

-- REAL candidate groups requiring human identity review. Variant strings are
-- opaque review-target IDs, not POS/form labels. Do NOT ignore them to merge.
-- No data writes or approved equivalence decisions are produced by this query.
select normalized_expression, expression_type, count(*) as entries,
  jsonb_agg(jsonb_build_object('entry_id',entry_id,'expression',canonical_expression,
    'lemma',lemma,'identity_variant',identity_variant,'review_notes',review_notes)
    order by entry_id) as canonical_candidates
from public.lexical_entries
group by normalized_expression, expression_type having count(*) > 1
order by normalized_expression collate "C", expression_type collate "C" limit 20;

-- Small deployed-data spot check. Do not claim this proves all blocks have a
-- sentence. SQL length counts Unicode characters, NOT JS UTF-16 offsets.
select occurrence_id, entry_id, source_type, content_block_id, sentence_id,
  start_offset, end_offset, surface_text, context_pos, context_meaning_zh,
  context_definition_en, length(context_text) as context_character_count,
  context_text
from public.lexical_occurrences order by occurrence_id limit 12;

-- Same lemma can have distinct identities; reporting only, NEVER a merge plan.
select lemma, count(*) as entries,
  jsonb_agg(jsonb_build_object('entry_id',entry_id,'expression',canonical_expression,
    'type',expression_type,'variant',identity_variant) order by entry_id) as identities
from public.lexical_entries
where lemma is not null and btrim(lemma) <> ''
group by lemma having count(*) > 1 order by lemma limit 12;
-- SQL Editor may show only this last result. No candidate query is an approval
-- or a merge decision; this success marker follows the compulsory assertions.
select 'WORDBOOK_PREFLIGHT_OK'::text as status,
  'diagnostic identity candidates are NOT approved for merging'::text as note;
commit;
