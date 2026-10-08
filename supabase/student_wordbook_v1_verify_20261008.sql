-- READ ONLY. Operator verification AFTER the approved migration.
-- No test data, JWT impersonation, writes, RPC calls or production auto-checks.
begin transaction read only;
set local search_path = pg_catalog;

-- Assert the APPROVED new-table installation, not a production dependency
-- fixture. No DDL/DML is executed by this block. Empty tables still permit
-- metadata/ACL assertions but do NOT prove real multi-user runtime behaviour.
do $$
declare v record; v_table text; v_role text; v_oid oid; v_actual text;
begin
  for v in select * from (values
    ('student_wordbook_entries',
      array['wordbook_entry_id','student_id','domain','expression','normalized_expression','expression_type','identity_variant','lexeme_key','first_saved_at']::text[],
      array['uuid','uuid','text','text','text','text','text','bytea','timestamp with time zone']::text[], array['lexeme_key']::text[]),
    ('student_wordbook_canonical_links',
      array['wordbook_entry_id','student_id','domain','lexical_entry_id','canonical_normalized_expression','canonical_expression_type','canonical_identity_variant','association_kind','identity_review_reference','first_linked_at']::text[],
      array['uuid','uuid','text','uuid','text','text','text','text','text','timestamp with time zone']::text[], array['identity_review_reference']::text[]),
    ('student_wordbook_senses',
      array['sense_id','wordbook_entry_id','student_id','domain','context_pos','context_meaning_zh','context_definition_en','snapshot_key','first_saved_at']::text[],
      array['uuid','uuid','uuid','text','text','text','text','bytea','timestamp with time zone']::text[], array['context_pos','context_definition_en','snapshot_key']::text[]),
    ('student_wordbook_examples',
      array['example_id','wordbook_entry_id','student_id','domain','example_text','context_kind','source_block_kind','extraction_method','snapshot_key','source_types','first_saved_at']::text[],
      array['uuid','uuid','uuid','text','text','text','text','text','bytea','text[]','timestamp with time zone']::text[], array['snapshot_key']::text[]),
    ('student_wordbook_example_senses',
      array['example_id','sense_id','wordbook_entry_id','student_id','domain']::text[],
      array['uuid','uuid','uuid','uuid','text']::text[], array[]::text[])
  ) as expected(table_name, columns, types, nullable_columns) loop
    v_oid := to_regclass('public.' || v.table_name);
    if not exists (select 1 from pg_class where oid = v_oid and relkind = 'r' and relrowsecurity) then
      raise exception 'WORDBOOK_VERIFY_TABLE_OR_RLS_MISSING: %', v.table_name;
    end if;
    if (select array_agg(attname::text order by attnum) from pg_attribute
      where attrelid = v_oid and attnum > 0 and not attisdropped) is distinct from v.columns
      or (select array_agg(format_type(atttypid,atttypmod) order by attnum) from pg_attribute
        where attrelid = v_oid and attnum > 0 and not attisdropped) is distinct from v.types
      or (select coalesce(array_agg(attname::text order by attnum) filter (where not attnotnull),array[]::text[])
        from pg_attribute where attrelid = v_oid and attnum > 0 and not attisdropped) is distinct from v.nullable_columns then
      raise exception 'WORDBOOK_VERIFY_COLUMN_MISMATCH: %', v.table_name;
    end if;
    -- Exact columns also exclude copied enrichment and question-navigation FKs.
    if (select count(*) from pg_policy where polrelid = v_oid) <> 1
      or not exists (select 1 from pg_policy where polrelid = v_oid and polcmd = 'r' and polpermissive
        and polroles = array[(select oid from pg_roles where rolname = 'authenticated')]::oid[]
        and polwithcheck is null
        and regexp_replace(pg_get_expr(polqual,polrelid),'[[:space:]()]','','g') =
          'student_id=SELECTauth.uidASuidANDSELECTpublic.can_use_student_experienceAScan_use_student_experience') then
      raise exception 'WORDBOOK_VERIFY_OWNER_POLICY_MISMATCH: %', v.table_name;
    end if;
    foreach v_role in array array['anon','authenticated'] loop
      if not exists (select 1 from pg_roles where rolname = v_role and not rolsuper and not rolbypassrls)
        or pg_has_role(v_role, (select pg_get_userbyid(relowner) from pg_class where oid = v_oid), 'USAGE')
        or has_table_privilege(v_role, v_oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege(v_role, v_oid, 'INSERT,UPDATE,REFERENCES')
        or (v_role = 'anon' and has_any_column_privilege(v_role, v_oid, 'SELECT')) then
        raise exception 'WORDBOOK_VERIFY_CLIENT_PRIVILEGE_UNSAFE: % %', v.table_name, v_role;
      end if;
    end loop;
    if not has_table_privilege('authenticated',v_oid,'SELECT')
      or not has_table_privilege('service_role',v_oid,'SELECT')
      or not has_table_privilege('service_role',v_oid,'INSERT')
      or not has_table_privilege('service_role',v_oid,'UPDATE')
      or not has_table_privilege('service_role',v_oid,'DELETE') then
      raise exception 'WORDBOOK_VERIFY_REQUIRED_GRANT_MISSING: %', v.table_name;
    end if;
  end loop;

  -- Extra cascade FKs or extra user triggers can defeat the intended guards;
  -- this verifier describes this exact A1 installation, not future additions.
  for v in select * from (values
    ('student_wordbook_entries',1,1), ('student_wordbook_canonical_links',2,2),
    ('student_wordbook_senses',1,1), ('student_wordbook_examples',1,1),
    ('student_wordbook_example_senses',2,1)
  ) as expected(table_name,fk_count,trigger_count) loop
    if (select count(*) from pg_constraint where conrelid = to_regclass('public.' || v.table_name) and contype = 'f') <> v.fk_count
      or (select count(*) from pg_trigger where tgrelid = to_regclass('public.' || v.table_name) and not tgisinternal) <> v.trigger_count then
      raise exception 'WORDBOOK_VERIFY_UNEXPECTED_FK_OR_TRIGGER: %', v.table_name;
    end if;
  end loop;

  for v in select * from (values
    ('student_wordbook_entries',array['wordbook_entry_id']::text[],true),
    ('student_wordbook_entries',array['student_id','domain','lexeme_key']::text[],false),
    ('student_wordbook_entries',array['wordbook_entry_id','student_id','domain']::text[],false),
    ('student_wordbook_canonical_links',array['wordbook_entry_id','lexical_entry_id']::text[],true),
    ('student_wordbook_canonical_links',array['student_id','domain','lexical_entry_id']::text[],false),
    ('student_wordbook_senses',array['sense_id']::text[],true),
    ('student_wordbook_senses',array['wordbook_entry_id','snapshot_key']::text[],false),
    ('student_wordbook_senses',array['sense_id','wordbook_entry_id','student_id','domain']::text[],false),
    ('student_wordbook_examples',array['example_id']::text[],true),
    ('student_wordbook_examples',array['wordbook_entry_id','snapshot_key']::text[],false),
    ('student_wordbook_examples',array['example_id','wordbook_entry_id','student_id','domain']::text[],false),
    ('student_wordbook_example_senses',array['example_id','sense_id']::text[],true)
  ) as expected(table_name,columns,require_primary) loop
    if not exists (select 1 from pg_index i join pg_constraint co on co.conindid = i.indexrelid and co.conrelid = i.indrelid
      where i.indrelid = to_regclass('public.' || v.table_name) and i.indisunique and i.indisvalid and i.indisready
        and i.indimmediate and i.indpred is null and i.indexprs is null and i.indnkeyatts = cardinality(v.columns)
        and co.convalidated and not co.condeferrable and co.contype = case when v.require_primary then 'p' else 'u' end
        and (select array_agg(a.attname::text order by k.ordinality)
          from unnest(i.indkey::smallint[]) with ordinality k(attnum,ordinality)
          join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
          where k.ordinality <= i.indnkeyatts) = v.columns) then
      raise exception 'WORDBOOK_VERIFY_UNIQUE_CONSTRAINT_MISSING: % %', v.table_name, v.columns;
    end if;
  end loop;
  for v in select * from (values
    ('student_wordbook_entries','student_wordbook_entries_list_idx','btree',array['student_id','domain','first_saved_at','wordbook_entry_id']::text[]),
    ('student_wordbook_canonical_links','student_wordbook_canonical_links_lexical_idx','btree',array['lexical_entry_id']::text[]),
    ('student_wordbook_senses','student_wordbook_senses_owner_idx','btree',array['student_id','domain','wordbook_entry_id']::text[]),
    ('student_wordbook_examples','student_wordbook_examples_owner_idx','btree',array['student_id','domain','wordbook_entry_id']::text[]),
    ('student_wordbook_examples','student_wordbook_examples_sources_idx','gin',array['source_types']::text[]),
    ('student_wordbook_example_senses','student_wordbook_example_senses_sense_idx','btree',array['sense_id','wordbook_entry_id','student_id','domain']::text[]),
    ('student_wordbook_example_senses','student_wordbook_example_senses_owner_idx','btree',array['student_id','domain','wordbook_entry_id']::text[])
  ) as expected(table_name,index_name,method,columns) loop
    if not exists (select 1 from pg_index i join pg_class c on c.oid = i.indexrelid join pg_am am on am.oid = c.relam
      where i.indexrelid = to_regclass('public.' || v.index_name) and i.indrelid = to_regclass('public.' || v.table_name)
        and i.indisvalid and i.indisready and i.indpred is null and i.indexprs is null
        and am.amname = v.method and i.indnkeyatts = cardinality(v.columns)
        and (select array_agg(a.attname::text order by k.ordinality)
          from unnest(i.indkey::smallint[]) with ordinality k(attnum,ordinality)
          join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
          where k.ordinality <= i.indnkeyatts) = v.columns) then
      raise exception 'WORDBOOK_VERIFY_INDEX_MISSING: %', v.index_name;
    end if;
  end loop;

  for v in select * from (values
    ('student_wordbook_entries',array['student_id']::text[],'profiles',array['id']::text[],'c','a'),
    ('student_wordbook_canonical_links',array['lexical_entry_id']::text[],'lexical_entries',array['entry_id']::text[],'r','c'),
    ('student_wordbook_canonical_links',array['wordbook_entry_id','student_id','domain']::text[],'student_wordbook_entries',array['wordbook_entry_id','student_id','domain']::text[],'c','a'),
    ('student_wordbook_senses',array['wordbook_entry_id','student_id','domain']::text[],'student_wordbook_entries',array['wordbook_entry_id','student_id','domain']::text[],'c','a'),
    ('student_wordbook_examples',array['wordbook_entry_id','student_id','domain']::text[],'student_wordbook_entries',array['wordbook_entry_id','student_id','domain']::text[],'c','a'),
    ('student_wordbook_example_senses',array['example_id','wordbook_entry_id','student_id','domain']::text[],'student_wordbook_examples',array['example_id','wordbook_entry_id','student_id','domain']::text[],'c','a'),
    ('student_wordbook_example_senses',array['sense_id','wordbook_entry_id','student_id','domain']::text[],'student_wordbook_senses',array['sense_id','wordbook_entry_id','student_id','domain']::text[],'c','a')
  ) as expected(table_name,columns,target_table,target_columns,delete_action,update_action) loop
    if not exists (select 1 from pg_constraint co where co.contype = 'f' and co.convalidated and not co.condeferrable
      and co.conrelid = to_regclass('public.' || v.table_name) and co.confrelid = to_regclass('public.' || v.target_table)
      and co.confdeltype::text = v.delete_action and co.confupdtype::text = v.update_action
      and (select array_agg(a.attname::text order by k.ordinality) from unnest(co.conkey) with ordinality k(attnum,ordinality)
        join pg_attribute a on a.attrelid = co.conrelid and a.attnum = k.attnum) = v.columns
      and (select array_agg(a.attname::text order by k.ordinality) from unnest(co.confkey) with ordinality k(attnum,ordinality)
        join pg_attribute a on a.attrelid = co.confrelid and a.attnum = k.attnum) = v.target_columns) then
      raise exception 'WORDBOOK_VERIFY_FK_ACTION_MISMATCH: % %', v.table_name, v.columns;
    end if;
  end loop;

  for v in select * from (values
    ('student_wordbook_entries','lexeme_key','public.wordbook_snapshot_keyARRAY[normalized_expression,expression_type,identity_variant]'),
    ('student_wordbook_senses','snapshot_key','public.wordbook_snapshot_keyARRAY[context_pos,context_meaning_zh,context_definition_en]'),
    ('student_wordbook_examples','snapshot_key','public.wordbook_snapshot_keyARRAY[example_text]')
  ) as expected(table_name,column_name,expression) loop
    if not exists (select 1 from pg_attribute a join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = to_regclass('public.' || v.table_name) and a.attname = v.column_name and a.attgenerated = 's'
        and regexp_replace(pg_get_expr(d.adbin,d.adrelid),'[[:space:]()]','','g') = v.expression) then
      raise exception 'WORDBOOK_VERIFY_GENERATED_KEY_MISMATCH: %', v.table_name;
    end if;
  end loop;

  -- Bind CHECK predicates and guard bodies to the approved migration, not just
  -- their names/counts (a CHECK(true) or return-NEW guard must fail verification).
  -- CHECK expressions are deparsed with a fixed search_path and whitespace-free
  -- canonical ordering; the diagnostics below still show full definitions.
  for v in select * from (values
    ('student_wordbook_entries',4,'5792da027ab1fecb77cbb4fbc3afec0d645e94339a3c225198d445cbf1dfb501'),
    ('student_wordbook_canonical_links',2,'492bc9c420208bb017590ba87e3a980e7e894ef0e3e40de89cf77784e2cf8364'),
    ('student_wordbook_senses',3,'7573a452b32680b7794fac020f2342daaf9d3cc3f6381172a51fd43164bd86e2'),
    ('student_wordbook_examples',5,'53c0bbdd9d7136db28a9fde0a98a5b3fde9920d840ae4985049a58e655617352'),
    ('student_wordbook_example_senses',0,null)
  ) as expected(table_name,check_count,hash) loop
    select encode(sha256(convert_to(string_agg(regexp_replace(pg_get_expr(conbin,conrelid),'[[:space:]]+','','g'),E'\n'
      order by regexp_replace(pg_get_expr(conbin,conrelid),'[[:space:]]+','','g') collate "C"),'UTF8')),'hex') into v_actual
      from pg_constraint where conrelid = to_regclass('public.' || v.table_name) and contype = 'c';
    if v_actual is distinct from v.hash
      or (select count(*) from pg_constraint where conrelid = to_regclass('public.' || v.table_name)
        and contype = 'c' and convalidated) <> v.check_count then
      raise exception 'WORDBOOK_VERIFY_CHECK_MISMATCH: %', v.table_name;
    end if;
  end loop;
  for v in select * from (values
    ('public.wordbook_snapshot_key(text[])','bytea','i',true,'aa8dd2c76a9da343fde0ce1fe36b7d0bde72a16889e1eaf6bb1243026c4a56d1'),
    ('public.wordbook_source_types_valid(text[],text)','boolean','i',true,'3b7087b608445154a219f87fd8cfc0ffb7a9a2c4b97cde0196f12f4a4fa0bc79'),
    ('public.guard_student_wordbook_snapshot()','trigger','v',false,'8fb23da0d110dc58b3ac998f906dc6b03be98858ed89a6d42d565ff213f0cca5'),
    ('public.guard_student_wordbook_canonical_link()','trigger','v',false,'9fe6c3b748eaeb28a53db8c733b68585593b6fe221156676dda599bc2f68ba9a')
  ) as expected(signature,return_type,volatility,is_strict,body_hash) loop
    v_oid := to_regprocedure(v.signature);
    if not exists (select 1 from pg_proc where oid = v_oid and not prosecdef
      and prorettype = to_regtype(v.return_type) and provolatile::text = v.volatility and proisstrict = v.is_strict
      and proconfig = array['search_path=pg_catalog']::text[]
      and encode(sha256(convert_to(btrim(replace(prosrc,E'\r\n',E'\n'),E' \n\r\t'),'UTF8')),'hex') = v.body_hash) then
      raise exception 'WORDBOOK_VERIFY_FUNCTION_MISMATCH: %', v.signature;
    end if;
    if has_function_privilege('anon',v_oid,'EXECUTE') or has_function_privilege('authenticated',v_oid,'EXECUTE')
      or not has_function_privilege('service_role',v_oid,'EXECUTE') then
      raise exception 'WORDBOOK_VERIFY_FUNCTION_PRIVILEGE_UNSAFE: %', v.signature;
    end if;
  end loop;
  for v in select * from (values
    ('student_wordbook_entries','student_wordbook_entries_snapshot_guard','public.guard_student_wordbook_snapshot()',19),
    ('student_wordbook_senses','student_wordbook_senses_snapshot_guard','public.guard_student_wordbook_snapshot()',19),
    ('student_wordbook_examples','student_wordbook_examples_snapshot_guard','public.guard_student_wordbook_snapshot()',19),
    ('student_wordbook_example_senses','student_wordbook_example_senses_snapshot_guard','public.guard_student_wordbook_snapshot()',19),
    ('student_wordbook_canonical_links','student_wordbook_canonical_links_snapshot_guard','public.guard_student_wordbook_snapshot()',19),
    ('student_wordbook_canonical_links','student_wordbook_canonical_links_identity_guard','public.guard_student_wordbook_canonical_link()',23)
  ) as expected(table_name,trigger_name,signature,event_bits) loop
    if not exists (select 1 from pg_trigger where tgrelid = to_regclass('public.' || v.table_name)
      and tgname = v.trigger_name and not tgisinternal and tgenabled in ('O','A')
      and tgfoid = to_regprocedure(v.signature) and tgtype = v.event_bits and tgqual is null
      and cardinality(tgattr::smallint[]) = 0 and tgnargs = 0) then
      raise exception 'WORDBOOK_VERIFY_TRIGGER_MISSING_OR_DISABLED: %', v.trigger_name;
    end if;
  end loop;
  if exists (select 1 from public.student_wordbook_canonical_links l
    left join public.lexical_entries e on e.entry_id = l.lexical_entry_id
    where e.entry_id is null or row(l.canonical_normalized_expression,l.canonical_expression_type,l.canonical_identity_variant)
      is distinct from row(e.normalized_expression,e.expression_type,e.identity_variant)) then
    raise exception 'WORDBOOK_VERIFY_CANONICAL_LINK_DRIFT';
  end if;
end;
$$;
select c.relname as table_name, c.relrowsecurity, co.conname,
  pg_get_constraintdef(co.oid) as definition
from pg_class c join pg_namespace n on n.oid = c.relnamespace
left join pg_constraint co on co.conrelid = c.oid
where n.nspname = 'public' and c.relname in (
  'student_wordbook_entries','student_wordbook_senses',
  'student_wordbook_examples','student_wordbook_example_senses','student_wordbook_canonical_links'
) order by c.relname, co.conname;
select tablename, indexname, indexdef from pg_indexes
where schemaname = 'public' and tablename like 'student_wordbook_%'
order by tablename, indexname;
select tablename, policyname, roles, cmd, qual, with_check from pg_policies
where schemaname = 'public' and tablename like 'student_wordbook_%'
order by tablename, policyname;
select grantee, table_name, privilege_type from information_schema.table_privileges
where table_schema = 'public' and table_name like 'student_wordbook_%'
  and grantee in ('PUBLIC','anon','authenticated','service_role')
order by table_name, grantee, privilege_type;
select c.relname as table_name, t.tgname, pg_get_triggerdef(t.oid) as definition
from pg_trigger t join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname like 'student_wordbook_%' and not t.tgisinternal;
select p.proname, p.provolatile, p.prosecdef, p.proacl,
  has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
  has_function_privilege('service_role',p.oid,'EXECUTE') as service_execute
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in (
  'wordbook_snapshot_key','wordbook_source_types_valid','guard_student_wordbook_snapshot',
  'guard_student_wordbook_canonical_link'
);

-- Expected zero orphan links. There is deliberately NO occurrence/block FK.
select count(*) as missing_canonical_entries
from public.student_wordbook_canonical_links l left join public.lexical_entries e on e.entry_id = l.lexical_entry_id
where e.entry_id is null;
-- Must remain zero: identity mutation of a referenced canonical row is NOT an
-- enrichment update. It needs a reviewed relink migration, never blind reuse.
select count(*) as changed_canonical_identities
from public.student_wordbook_canonical_links l join public.lexical_entries e on e.entry_id = l.lexical_entry_id
where row(l.canonical_normalized_expression,l.canonical_expression_type,l.canonical_identity_variant)
  is distinct from row(e.normalized_expression,e.expression_type,e.identity_variant);
-- A1 has no write API: all counts should initially be zero. After A2, nonzero
-- entries_without_senses/examples or unlinked children signal an incomplete save.
select
  (select count(*) from public.student_wordbook_entries) as entries,
  (select count(*) from public.student_wordbook_senses) as senses,
  (select count(*) from public.student_wordbook_examples) as examples,
  (select count(*) from public.student_wordbook_example_senses) as links,
  (select count(*) from public.student_wordbook_canonical_links) as canonical_links,
  (select count(*) from public.student_wordbook_entries w where not exists
    (select 1 from public.student_wordbook_canonical_links l where l.wordbook_entry_id = w.wordbook_entry_id)) as entries_without_canonical_links,
  (select count(*) from public.student_wordbook_entries w where not exists
    (select 1 from public.student_wordbook_senses s where s.wordbook_entry_id = w.wordbook_entry_id)) as entries_without_senses,
  (select count(*) from public.student_wordbook_entries w where not exists
    (select 1 from public.student_wordbook_examples x where x.wordbook_entry_id = w.wordbook_entry_id)) as entries_without_examples,
  (select count(*) from public.student_wordbook_senses s where not exists
    (select 1 from public.student_wordbook_example_senses l where l.sense_id = s.sense_id)) as unlinked_senses,
  (select count(*) from public.student_wordbook_examples x where not exists
    (select 1 from public.student_wordbook_example_senses l where l.example_id = x.example_id)) as unlinked_examples;
select context_kind, extraction_method, source_block_kind, count(*) as examples
from public.student_wordbook_examples group by context_kind, extraction_method, source_block_kind
order by context_kind, extraction_method, source_block_kind;

-- Bounded illustration of the FUTURE API composition, not a new public view.
-- The authenticated service API must additionally scope to verified student_id
-- and selected domain. Never replace these values with saved enrichment copies.
-- BEGIN_DYNAMIC_ENRICHMENT_EXAMPLE
with page as materialized (
  select * from public.student_wordbook_entries
  order by first_saved_at desc, wordbook_entry_id limit 20
), linked_sources as (
  select l.*, e.review_status, e.common_senses, e.derived_words, e.useful_patterns,
    row(l.canonical_normalized_expression,l.canonical_expression_type,l.canonical_identity_variant)
      = row(e.normalized_expression,e.expression_type,e.identity_variant) as identity_matches
  from page w join public.student_wordbook_canonical_links l using(wordbook_entry_id)
  join public.lexical_entries e on e.entry_id = l.lexical_entry_id
), sources as (
  select wordbook_entry_id, lexical_entry_id, association_kind, review_status, identity_matches,
    case when identity_matches then common_senses else '[]'::jsonb end as common_senses,
    case when identity_matches then derived_words else '[]'::jsonb end as derived_words,
    case when identity_matches then useful_patterns else '[]'::jsonb end as useful_patterns
  from linked_sources
), items as (
  select s.wordbook_entry_id, s.lexical_entry_id, f.field, item.value
  from sources s
  cross join lateral (values ('common_senses',s.common_senses), ('derived_words',s.derived_words),
    ('useful_patterns',s.useful_patterns)) f(field, contents)
  cross join lateral jsonb_array_elements(f.contents) item(value)
), distinct_items as (
  select wordbook_entry_id, field, value,
    array_agg(distinct lexical_entry_id order by lexical_entry_id) as lexical_entry_ids
  from items group by wordbook_entry_id, field, value
), keyed as (
  select *, case
    when field = 'common_senses' and jsonb_typeof(value) = 'object' and value ?& array['pos','definition_en']
      then jsonb_build_array(value->'pos',value->'definition_en')
    when field = 'derived_words' and jsonb_typeof(value) = 'object' and value ?& array['expression','relation']
      then jsonb_build_array(value->'expression',value->'relation')
    when field = 'useful_patterns' and jsonb_typeof(value) = 'object' and value ? 'pattern' then jsonb_build_array(value->'pattern')
    else null end as conflict_key
  from distinct_items
), annotated as (
  select *, conflict_key is not null and count(*) over (
    partition by wordbook_entry_id, field, conflict_key
  ) > 1 as has_conflict from keyed
)
select w.wordbook_entry_id, w.domain, w.expression, w.first_saved_at,
  coalesce((select jsonb_agg(jsonb_build_object('lexicalEntryId',s.lexical_entry_id,
    'associationKind',s.association_kind,'canonicalStatus',s.review_status,
    'enrichmentStatus',case when s.identity_matches then 'available' else 'identity_drift' end,
    'commonSenses',case when s.identity_matches then s.common_senses else null end,
    'derivedWords',case when s.identity_matches then s.derived_words else null end,
    'usefulPatterns',case when s.identity_matches then s.useful_patterns else null end)
    order by s.lexical_entry_id) from sources s where s.wordbook_entry_id = w.wordbook_entry_id), '[]'::jsonb) as enrichment_sources,
  coalesce((select jsonb_agg(jsonb_build_object('field',a.field,'value',a.value,
    'lexicalEntryIds',a.lexical_entry_ids,'hasConflict',a.has_conflict)
    order by a.field collate "C", a.value::text collate "C") from annotated a
    where a.wordbook_entry_id = w.wordbook_entry_id), '[]'::jsonb) as enrichment_items
from page w order by w.first_saved_at desc, w.wordbook_entry_id;
-- END_DYNAMIC_ENRICHMENT_EXAMPLE
select 'WORDBOOK_VERIFY_OK'::text as status,
  'installation metadata/ACL verified; empty tables are not multi-user runtime proof'::text as note;
commit;
