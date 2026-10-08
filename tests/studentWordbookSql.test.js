const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const sql = fs.readFileSync(path.join(__dirname, '../supabase/student_wordbook_v1_20261008.sql'), 'utf8');
const preflight = fs.readFileSync(path.join(__dirname, '../supabase/student_wordbook_v1_preflight_20261008.sql'), 'utf8');
const verify = fs.readFileSync(path.join(__dirname, '../supabase/student_wordbook_v1_verify_20261008.sql'), 'utf8');
// Explicit local WASM engine only. No env file, URL, service key, source artifacts
// or production client is loaded. No package.json/dependency changes required.
const runtime = process.env.WORDBOOK_SQL_TEST_PGLITE;
const PGlite = runtime ? require(path.resolve(runtime)).PGlite : null;
const engineTest = (name, fn) => test(name, { skip: !PGlite }, fn);
const U1 = '00000000-0000-4000-8000-000000000001';
const U2 = '00000000-0000-4000-8000-000000000002';
const E1 = '00000000-0000-4000-8000-000000000011';
const E2 = '00000000-0000-4000-8000-000000000012';
const E3 = '00000000-0000-4000-8000-000000000013';
const E4 = '00000000-0000-4000-8000-000000000014';

// Dependency model from tracked production/lookup/incremental contracts, NOT a
// claim that the missing base DDL or live metadata was inspected.
const dependencies = `
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid; $$;
grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on function auth.uid() to authenticated, service_role;
create table auth.users(id uuid primary key);
create table public.profiles(id uuid primary key references auth.users(id) on delete cascade,
  role text not null, is_active boolean not null);
create function public.can_use_student_experience() returns boolean language sql stable security definer
set search_path = public as $$ select exists(select 1 from profiles where id = auth.uid()
  and is_active and role in ('student','teacher','admin')); $$;
revoke all on function public.can_use_student_experience() from public, anon;
grant execute on function public.can_use_student_experience() to authenticated;
create table public.lexical_entries(
  entry_id uuid primary key, canonical_expression text not null, normalized_expression text not null,
  expression_type text not null, identity_variant text not null default '', lemma text,
  common_senses jsonb not null default '[]', derived_words jsonb not null default '[]',
  useful_patterns jsonb not null default '[]', review_status text not null default 'generated', review_notes text,
  constraint lexical_fixture_identity_key unique(normalized_expression, expression_type, identity_variant)
);
create table public.lexical_source_blocks(block_id uuid primary key,
  source_type text not null, source_item_id text not null, content_block_id text not null,
  block_kind text not null, source_text_hash text not null, generation_status text not null,
  unique(source_type,source_item_id,content_block_id));
create table public.lexical_occurrences(occurrence_id uuid primary key,
  entry_id uuid not null references public.lexical_entries(entry_id) on update cascade,
  source_type text not null default 'ctw',source_item_id text not null default 'fixture',
  content_block_id text not null default 'paragraph:p',sentence_id text,source_anchor_id text,
  surface_text text not null default 'run',start_offset integer not null default 3,end_offset integer not null default 6,
  context_pos text,context_definition_en text,review_status text not null default 'generated',
  context_text text not null, context_meaning_zh text not null,
  unique(source_type,source_item_id,content_block_id,start_offset,end_offset));
alter table public.lexical_entries enable row level security;
alter table public.lexical_occurrences enable row level security;
alter table public.lexical_source_blocks enable row level security;
revoke all on public.lexical_entries,public.lexical_occurrences,public.lexical_source_blocks from public,anon,authenticated;
grant select on public.lexical_entries,public.lexical_occurrences,public.lexical_source_blocks to service_role;
insert into auth.users values ('${U1}'),('${U2}');
insert into profiles values ('${U1}','student',true),('${U2}','student',true);
insert into lexical_entries(entry_id, canonical_expression, normalized_expression, expression_type, lemma)
values ('${E1}','run','run','word','run'),('${E2}','running','running','word','run');
insert into lexical_occurrences(occurrence_id,entry_id,context_text,context_meaning_zh)
  values ('${E3}','${E1}','We run every day.','跑步');
`;
async function fixture() {
  const db = new PGlite();
  try { await db.exec(dependencies); await db.exec(sql); return db; }
  catch (error) { await db.close(); throw error; }
}
const one = async (db, query, params = []) => (await db.query(query, params)).rows[0];
async function counts(db) {
  return one(db, `select
    (select count(*)::int from student_wordbook_entries) as entries,
    (select count(*)::int from student_wordbook_senses) as senses,
    (select count(*)::int from student_wordbook_examples) as examples,
    (select count(*)::int from student_wordbook_example_senses) as links`);
}
const canonicalCount = async db => (await one(db,'select count(*)::int as n from student_wordbook_canonical_links')).n;
const readEnrichment = async db => (await db.query(verify.split('-- BEGIN_DYNAMIC_ENRICHMENT_EXAMPLE\n')[1]
  .split('-- END_DYNAMIC_ENRICHMENT_EXAMPLE')[0])).rows;
async function addReviewedFixture(db) {
  // Synthetic schema fixture only: no production variant pair is approved here.
  await db.query(`insert into lexical_entries(entry_id,canonical_expression,normalized_expression,expression_type,identity_variant,lemma)
    values($1,'run','run','word','offline-equivalent-fixture','run')`,[E4]);
}
const reviewedFixture = { lexical:E4,anchorLexical:E1,reviewReference:'offline-approved-fixture-only:run-v1' };

// Test-only transaction recipe for constraints/atomicity; NOT a shipped A2
// save implementation. Source authorization/extraction is deliberately absent.
async function save(db, overrides = {}) {
  const p = { student: U1, domain: 'reading', lexical: E1, pos: 'verb', zh: '跑步',
    en: 'Move quickly on foot.', sentence: 'We run every day.', sources: ['ctw'],
    contextKind:'sentence',blockKind:'ctw_paragraph',method:'whole_sentence_block', ...overrides };
  await db.exec('begin');
  try {
    const canonical = await one(db,'select * from lexical_entries where entry_id=$1',[p.lexical]);
    const anchor = p.anchorLexical ? await one(db,'select * from lexical_entries where entry_id=$1',[p.anchorLexical]) : canonical;
    const entry = await one(db, `insert into student_wordbook_entries as target
      (student_id,domain,expression,normalized_expression,expression_type,identity_variant)
      values($1,$2,$3,$4,$5,$6)
      on conflict(student_id,domain,lexeme_key) do update set normalized_expression=target.normalized_expression
      returning *`, [p.student,p.domain,canonical.canonical_expression,anchor.normalized_expression,anchor.expression_type,anchor.identity_variant]);
    assert.deepEqual([entry.normalized_expression,entry.expression_type,entry.identity_variant],
      [anchor.normalized_expression,anchor.expression_type,anchor.identity_variant]);
    await db.query(`insert into student_wordbook_senses
      (wordbook_entry_id,student_id,domain,context_pos,context_meaning_zh,context_definition_en)
      values($1,$2,$3,$4,$5,$6) on conflict(wordbook_entry_id,snapshot_key) do nothing`,
      [entry.wordbook_entry_id,p.student,p.domain,p.pos,p.zh,p.en]);
    // Separate statement after a DO NOTHING wait: don't assume a same-statement
    // CTE snapshot sees a conflicting transaction's row under READ COMMITTED.
    const sense = await one(db, `select * from student_wordbook_senses where wordbook_entry_id=$1
      and snapshot_key=public.wordbook_snapshot_key(array[$2,$3,$4]::text[])`,
      [entry.wordbook_entry_id,p.pos,p.zh,p.en]);
    assert.deepEqual([sense.context_pos,sense.context_meaning_zh,sense.context_definition_en],[p.pos,p.zh,p.en]);
    const example = await one(db, `insert into student_wordbook_examples as target
      (wordbook_entry_id,student_id,domain,example_text,context_kind,source_block_kind,extraction_method,source_types)
      values($1,$2,$3,$4,$5,$6,$7,$8)
      on conflict(wordbook_entry_id,snapshot_key) do update set source_types=
        array(select distinct t collate "C" from unnest(target.source_types || excluded.source_types) t order by t collate "C")
      returning *`, [entry.wordbook_entry_id,p.student,p.domain,p.sentence,p.contextKind,p.blockKind,p.method,p.sources]);
    assert.equal(example.example_text,p.sentence);
    const exact = canonical.normalized_expression === anchor.normalized_expression && canonical.expression_type === anchor.expression_type
      && canonical.identity_variant === anchor.identity_variant;
    await db.query(`insert into student_wordbook_canonical_links
      (wordbook_entry_id,student_id,domain,lexical_entry_id,canonical_normalized_expression,
       canonical_expression_type,canonical_identity_variant,association_kind,identity_review_reference)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(wordbook_entry_id,lexical_entry_id) do nothing`,
      [entry.wordbook_entry_id,p.student,p.domain,p.lexical,canonical.normalized_expression,canonical.expression_type,
        canonical.identity_variant,exact ? 'exact_identity' : 'reviewed_equivalent',p.reviewReference ?? null]);
    await db.query(`insert into student_wordbook_example_senses
      (example_id,sense_id,wordbook_entry_id,student_id,domain) values($1,$2,$3,$4,$5)
      on conflict(example_id,sense_id) do nothing`,
      [example.example_id,p.failLink ? E3 : sense.sense_id,entry.wordbook_entry_id,p.student,p.domain]);
    await db.exec('commit');
    return { entry,sense,example };
  } catch (error) { await db.exec('rollback'); throw error; }
}

test('A1 SQL is Editor-compatible and stays inside schema-only scope', () => {
  const documents = [sql,preflight,verify,
    fs.readFileSync(__filename,'utf8'),
    fs.readFileSync(path.join(__dirname,'../docs/student-wordbook-v1-phase-a1.md'),'utf8')];
  for (const document of documents) {
    assert.ok(document.endsWith('\n'),'new files must end with a newline');
    assert.doesNotMatch(document,/[\t ]+$/m,'new files must not contain trailing whitespace');
  }
  assert.match(sql, /begin;/i); assert.match(sql, /commit;\s*$/i);
  assert.doesNotMatch(sql, /^\\|COPY .*STDIN|create.*function.*save_student_wordbook/im);
  assert.doesNotMatch(sql, /(?:alter|update|delete from|insert into)\s+(?:table\s+)?public\.lexical_/i);
  assert.equal((sql.match(/create table public\.student_wordbook_/g) || []).length,5);
  const tables = sql.match(/create table public\.student_wordbook_[\s\S]*?\n\);/g);
  for (const table of tables) assert.doesNotMatch(table,/common_senses|derived_words|useful_patterns/);
  for (const script of [preflight,verify]) {
    assert.match(script,/begin transaction read only;/i);
    // Read-only DO/RAISE blocks assert metadata without writes or persistent RPCs.
    assert.match(script,/^do \$\$/m);
    assert.doesNotMatch(script,/^\s*(insert|update|delete|alter|create|drop|grant|revoke|call|execute)\b/im);
  }
  const dependencyBlock = script => script.split('-- BEGIN_WORDBOOK_DEPENDENCY_ASSERTIONS\n')[1]
    .split('-- END_WORDBOOK_DEPENDENCY_ASSERTIONS')[0];
  assert.equal(dependencyBlock(preflight),dependencyBlock(sql),'preflight and migration must assert identical dependencies');
  assert.match(preflight,/select 'WORDBOOK_PREFLIGHT_OK'/);
  assert.match(verify,/select 'WORDBOOK_VERIFY_OK'/);
  for (const match of sql.matchAll(/create function public\.\w+\([\s\S]*?as \$\$([\s\S]*?)\$\$;/g)) {
    const body = match[1].replace(/\r\n/g,'\n').replace(/^[ \n\r\t]+|[ \n\r\t]+$/g,'');
    assert.ok(verify.includes(createHash('sha256').update(body).digest('hex')),'verify must bind the approved guard/helper body');
  }
});

engineTest('local PostgreSQL: repeat saves, sense/example dedupe, M:N links and monotone source union', async () => {
  const db = await fixture();
  try {
    const first = await save(db);
    const repeat = await save(db, { sources:['rdl'] });
    assert.equal(repeat.entry.wordbook_entry_id,first.entry.wordbook_entry_id);
    assert.equal(repeat.entry.first_saved_at.getTime(),first.entry.first_saved_at.getTime());
    assert.deepEqual(repeat.example.source_types,['ctw','rdl']);
    // A writer holding the old ['ctw'] snapshot cannot drop a now-committed
    // 'rdl' tag when trying to add 'rap'. Guard rejects the stale replacement;
    // ON CONFLICT target union below correctly appends without a lost update.
    await assert.rejects(db.query('update student_wordbook_examples set source_types=$1 where example_id=$2',
      [['ctw','rap'],first.example.example_id]),/IMMUTABLE/i);
    await save(db, { sources:['rap'] }); await save(db);
    assert.deepEqual(await counts(db),{ entries:1,senses:1,examples:1,links:1 });
    assert.equal(await canonicalCount(db),1);
    await save(db,{ zh:'经营',en:'Operate or manage.',sources:['rdl'] });
    assert.deepEqual(await counts(db),{ entries:1,senses:2,examples:1,links:2 });
    await save(db,{ sentence:'They run in the park.' });
    assert.deepEqual(await counts(db),{ entries:1,senses:2,examples:2,links:3 });
    const row = await one(db,'select source_types from student_wordbook_examples where example_id=$1',[first.example.example_id]);
    assert.deepEqual(row.source_types,['ctw','rap','rdl']);
  } finally { await db.close(); }
});

engineTest('local PostgreSQL: user/domain/entry identity isolation; same lemma never merges', async () => {
  const db = await fixture();
  try {
    await save(db); await save(db,{ student:U2 });
    const writing = await save(db,{ domain:'writing',sources:['academic_discussion','bas','write_email'] });
    assert.deepEqual(writing.example.source_types,['academic_discussion','bas','write_email']);
    await save(db,{ lexical:E2 });
    assert.deepEqual(await counts(db),{ entries:4,senses:4,examples:4,links:4 });
    const row = await one(db,'select count(*)::int as n from student_wordbook_entries where student_id=$1 and domain=$2',[U1,'reading']);
    assert.equal(row.n,2);
    await assert.rejects(db.query(`insert into student_wordbook_senses
      (wordbook_entry_id,student_id,domain,context_meaning_zh) values($1,$2,'reading','错误')`,
      [writing.entry.wordbook_entry_id,U2]),/foreign key/i);
    const other = await one(db,'select * from student_wordbook_senses where student_id=$1',[U2]);
    await assert.rejects(db.query(`insert into student_wordbook_example_senses
      (example_id,sense_id,wordbook_entry_id,student_id,domain) values($1,$2,$3,$4,'writing')`,
      [writing.example.example_id,other.sense_id,writing.entry.wordbook_entry_id,U1]),/foreign key/i);
  } finally { await db.close(); }
});

engineTest('local PostgreSQL: all existing expression types and homograph identities stay independent', async () => {
  const db = await fixture();
  try {
    await save(db);
    const expressions = [
      ['phrase','in the park',''],['phrasal_verb','run into',''],
      ['idiom','a piece of cake',''],['proper_noun','New York',''],['word','run','reviewed-homograph']
    ];
    for (const [index,[type,expression,variant]] of expressions.entries()) {
      const id = `00000000-0000-4000-8000-${String(100+index).padStart(12,'0')}`;
      await db.query(`insert into lexical_entries(entry_id,canonical_expression,normalized_expression,expression_type,identity_variant)
        values($1,$2,$3,$4,$5)`,[id,expression,expression.toLowerCase(),type,variant]);
      const saved = await save(db,{lexical:id});
      const row = await one(db,'select expression_type,identity_variant from student_wordbook_entries where wordbook_entry_id=$1',[saved.entry.wordbook_entry_id]);
      assert.deepEqual(row,{expression_type:type,identity_variant:variant});
    }
    assert.equal((await counts(db)).entries,6);
  } finally { await db.close(); }
});

engineTest('local PostgreSQL: snapshots immutable; source replacement/removal and enrichment refresh independent', async () => {
  const db = await fixture();
  try {
    const first = await save(db);
    const before = (await db.query('select to_jsonb(s) as value from student_wordbook_senses s')).rows;
    await db.exec(`update lexical_occurrences set context_text='Changed sentence.',context_meaning_zh='改义';
      delete from lexical_occurrences;
      update lexical_entries set canonical_expression='RUN',review_status='disabled',
        common_senses='[{"meaning_zh":"新义项"}]',derived_words='[{"expression":"runner"}]',
        useful_patterns='[{"pattern":"run into"}]' where entry_id='${E1}';`);
    assert.deepEqual((await db.query('select to_jsonb(s) as value from student_wordbook_senses s')).rows,before);
    const fetched = await one(db, `select w.expression,e.common_senses,e.derived_words,e.useful_patterns,e.review_status
      from student_wordbook_entries w join student_wordbook_canonical_links l using(wordbook_entry_id)
      join lexical_entries e on e.entry_id=l.lexical_entry_id`);
    assert.equal(fetched.expression,'run'); assert.equal(fetched.review_status,'disabled');
    assert.deepEqual(fetched.common_senses,[{meaning_zh:'新义项'}]);
    assert.deepEqual(fetched.derived_words,[{expression:'runner'}]);
    assert.deepEqual(fetched.useful_patterns,[{pattern:'run into'}]);
    await assert.rejects(db.query('update student_wordbook_senses set context_meaning_zh=$1 where sense_id=$2',['改义',first.sense.sense_id]),/IMMUTABLE/);
    await assert.rejects(db.query('update student_wordbook_entries set first_saved_at=now() where wordbook_entry_id=$1',[first.entry.wordbook_entry_id]),/IMMUTABLE/);
    await assert.rejects(db.query('update student_wordbook_examples set example_text=$1 where example_id=$2',['Fabricated.',first.example.example_id]),/IMMUTABLE/);
    await save(db,{ sources:['rdl'] });
    const stable = await counts(db);
    await assert.rejects(save(db,{zh:'新义项但最后一步失败',sources:['rap'],failLink:true}),/foreign key/i);
    assert.deepEqual(await counts(db),stable);
    assert.deepEqual((await one(db,'select source_types from student_wordbook_examples where example_id=$1',[first.example.example_id])).source_types,['ctw','rdl']);
    await assert.rejects(db.query('update student_wordbook_examples set source_types=$1 where example_id=$2',[['ctw'],first.example.example_id]),/IMMUTABLE/);
    // Verify UPDATE no-ops tolerate generated-column BEFORE-trigger semantics.
    await db.exec('update student_wordbook_senses set context_pos=context_pos; update student_wordbook_examples set source_types=source_types;');
  } finally { await db.close(); }
});

engineTest('local PostgreSQL: canonical delete restrict, ID cascade and merge conflict fail closed', async () => {
  const db = await fixture();
  try {
    const first = await save(db); await save(db,{ lexical:E2 });
    await db.exec('delete from lexical_occurrences');
    await assert.rejects(db.query('delete from lexical_entries where entry_id=$1',[E1]),/foreign key/i);
    await db.query('update lexical_entries set entry_id=$1 where entry_id=$2',[E3,E1]);
    assert.equal((await one(db,'select lexical_entry_id from student_wordbook_canonical_links where wordbook_entry_id=$1',[first.entry.wordbook_entry_id])).lexical_entry_id,E3);
    await assert.rejects(db.query('update student_wordbook_canonical_links set lexical_entry_id=$1 where wordbook_entry_id=$2',[E2,first.entry.wordbook_entry_id]),/IDENTITY_MISMATCH/i);
    assert.deepEqual(await counts(db),{ entries:2,senses:2,examples:2,links:2 });
  } finally { await db.close(); }
});

engineTest('local PostgreSQL: atomic failure, source constraints and unfavourite/recollect lifecycle', async () => {
  const db = await fixture();
  try {
    for (const sources of [[],['bas'],['ctw','ctw'],['rdl','ctw'],['ctw',null],['we'],['ad']]) {
      await assert.rejects(save(db,{sources}));
      assert.deepEqual(await counts(db),{entries:0,senses:0,examples:0,links:0});
      assert.equal(await canonicalCount(db),0);
    }
    await db.exec(`set role service_role;`);
    const first = await save(db);
    await db.query('delete from student_wordbook_entries where student_id=$1 and wordbook_entry_id=$2',[U1,first.entry.wordbook_entry_id]);
    assert.deepEqual(await counts(db),{entries:0,senses:0,examples:0,links:0});
    assert.equal(await canonicalCount(db),0);
    const second = await save(db);
    assert.notEqual(second.entry.wordbook_entry_id,first.entry.wordbook_entry_id);
    assert.ok(second.entry.first_saved_at.getTime() > first.entry.first_saved_at.getTime());
  } finally { await db.close(); }
});

engineTest('local PostgreSQL: RLS owner reads, disabled account exclusion, browser writes and helper calls denied', async () => {
  const db = await fixture();
  try {
    await save(db); await save(db,{student:U2});
    await db.exec(`set role authenticated; set request.jwt.claim.sub='${U1}';`);
    for (const table of ['entries','senses','examples','example_senses','canonical_links']) {
      const rows = (await db.query(`select student_id from student_wordbook_${table}`)).rows;
      assert.equal(rows.length,1); assert.equal(rows[0].student_id,U1);
      await assert.rejects(db.exec(`delete from student_wordbook_${table}`),/permission denied/i);
      await assert.rejects(db.exec(`update student_wordbook_${table} set student_id=student_id`),/permission denied/i);
    }
    await assert.rejects(db.exec('select public.wordbook_snapshot_key(array[\'untrusted\'])'),/permission denied/i);
    await assert.rejects(db.exec(`insert into student_wordbook_entries
      (student_id,domain,expression,normalized_expression,expression_type,identity_variant)
      values('${U1}','reading','run','run','word','')`),/permission denied/i);
    await db.exec(`reset role; update profiles set is_active=false where id='${U1}'; set role authenticated;`);
    assert.equal((await counts(db)).entries,0);
    await db.exec('set role anon;');
    await assert.rejects(db.exec('select * from student_wordbook_entries'),/permission denied/i);
  } finally { await db.close(); }
});

engineTest('local PostgreSQL: hash boundaries/NULL semantics and long snapshots avoid btree size failures', async () => {
  const db = await fixture();
  try {
    const keys = await one(db, `select
      public.wordbook_snapshot_key(array[null,'a','b']) <> public.wordbook_snapshot_key(array['','a','b']) as null_distinct,
      public.wordbook_snapshot_key(array['a',E'b\\x1fc','d']) <> public.wordbook_snapshot_key(array[E'a\\x1fb','c','d']) as boundary_distinct,
      octet_length(public.wordbook_snapshot_key(array['😀中文'])) as bytes`);
    assert.deepEqual(keys,{null_distinct:true,boundary_distinct:true,bytes:32});
    await save(db,{en:'Long definition. '.repeat(2000),sentence:'An exact local fixture sentence '.repeat(2000)});
    assert.equal((await counts(db)).examples,1);
    await save(db,{en:null}); assert.equal((await counts(db)).senses,2);
  } finally { await db.close(); }
});

engineTest('local PostgreSQL: drifted dependency and accidental rerun fail atomically; verification SQL executes read-only', async () => {
  const db = await fixture();
  try {
    await db.exec(verify);
    await assert.rejects(db.exec(sql),/already exists/i);
    await db.exec('rollback'); assert.deepEqual(await counts(db),{entries:0,senses:0,examples:0,links:0});
  } finally { await db.close(); }
  const missing = new PGlite();
  try {
    await missing.exec(dependencies);
    await missing.exec('alter table lexical_entries alter column common_senses type text using common_senses::text');
    await assert.rejects(missing.exec(sql),/SCHEMA_DEPENDENCY_MISMATCH/);
    await missing.exec('rollback');
    assert.equal((await one(missing,"select to_regclass('public.student_wordbook_entries') as t")).t,null);
  } finally { await missing.close(); }
  const wrongIndex = new PGlite();
  try {
    await wrongIndex.exec(dependencies);
    await wrongIndex.exec('alter table lexical_entries drop constraint lexical_fixture_identity_key');
    await assert.rejects(wrongIndex.exec(sql),/DEPENDENCY_INDEX_REQUIRED/);
    await wrongIndex.exec('rollback');
    assert.equal((await one(wrongIndex,"select to_regclass('public.student_wordbook_entries') as t")).t,null);
  } finally { await wrongIndex.close(); }
});

engineTest('local PostgreSQL: lexeme identity survives canonical UUID migration and repeat collection', async () => {
  const db = await fixture();
  try {
    const first = await save(db);
    await db.query('update lexical_entries set entry_id=$1 where entry_id=$2',[E3,E1]);
    const repeat = await save(db,{lexical:E3,sources:['rap']});
    assert.equal(repeat.entry.wordbook_entry_id,first.entry.wordbook_entry_id);
    assert.equal(repeat.entry.first_saved_at.getTime(),first.entry.first_saved_at.getTime());
    assert.deepEqual(await counts(db),{entries:1,senses:1,examples:1,links:1});
    assert.equal(await canonicalCount(db),1);
    assert.deepEqual(repeat.example.source_types,['ctw','rap']);
    const entry = await one(db,`select count(*)::int as n from student_wordbook_entries where student_id=$1 and domain='reading'
      and lexeme_key=public.wordbook_snapshot_key(array['run','word',''])`,[U1]);
    assert.equal(entry.n,1);
    await assert.rejects(db.query(`insert into student_wordbook_entries
      (student_id,domain,expression,normalized_expression,expression_type,identity_variant)
      values($1,'reading','RUN','run','word','')`,[U1]),/unique/i);
  } finally { await db.close(); }
});

engineTest('local PostgreSQL: reviewed multi-canonical association is explicit; identity/form/type/owner mistakes fail atomically', async () => {
  const db = await fixture();
  try {
    const first = await save(db); await addReviewedFixture(db);
    await assert.rejects(save(db,{...reviewedFixture,reviewReference:null,sources:['rdl']}),/check constraint/i);
    assert.equal(await canonicalCount(db),1);
    assert.deepEqual((await one(db,'select source_types from student_wordbook_examples')).source_types,['ctw']);
    const second = await save(db,{...reviewedFixture,sources:['rdl']});
    assert.equal(second.entry.wordbook_entry_id,first.entry.wordbook_entry_id);
    assert.equal(second.entry.first_saved_at.getTime(),first.entry.first_saved_at.getTime());
    assert.deepEqual(await counts(db),{entries:1,senses:1,examples:1,links:1});
    assert.equal(await canonicalCount(db),2);
    await save(db,{...reviewedFixture,sources:['rap'],zh:'经营',en:'Operate or manage.'});
    assert.deepEqual(await counts(db),{entries:1,senses:2,examples:1,links:2});
    assert.equal(await canonicalCount(db),2);
    await assert.rejects(save(db,{...reviewedFixture,lexical:E2}),/IDENTITY_MISMATCH/i); // same lemma, different form
    await db.query(`insert into lexical_entries(entry_id,canonical_expression,normalized_expression,expression_type,identity_variant)
      values($1,'Run','run','proper_noun','')`,[E3]);
    await assert.rejects(save(db,{...reviewedFixture,lexical:E3}),/IDENTITY_MISMATCH/i);
    await assert.rejects(db.query(`insert into student_wordbook_canonical_links
      (wordbook_entry_id,student_id,domain,lexical_entry_id,canonical_normalized_expression,
       canonical_expression_type,canonical_identity_variant,association_kind)
      values($1,$2,'reading',$3,'run','word','offline-equivalent-fixture','exact_identity')`,
      [first.entry.wordbook_entry_id,U1,E4]),/EQUIVALENCE_REVIEW_REQUIRED/i);
    await assert.rejects(db.query(`update student_wordbook_canonical_links set identity_review_reference='changed'
      where lexical_entry_id=$1`,[E4]),/IMMUTABLE/i);
    await assert.rejects(db.query(`insert into student_wordbook_canonical_links
      (wordbook_entry_id,student_id,domain,lexical_entry_id,canonical_normalized_expression,
       canonical_expression_type,canonical_identity_variant,association_kind)
      values($1,$2,'reading',$3,'run','word','','exact_identity')`,[first.entry.wordbook_entry_id,U2,E1]),/OWNER_MISMATCH/i);
    assert.deepEqual(await counts(db),{entries:1,senses:2,examples:1,links:2});
    // Even a valid canonical cannot belong to TWO lexeme anchors for this user/domain.
    const other = await one(db,`insert into student_wordbook_entries
      (student_id,domain,expression,normalized_expression,expression_type,identity_variant)
      values($1,'reading','run','run','word','offline-equivalent-fixture') returning *`,[U1]);
    await assert.rejects(db.query(`insert into student_wordbook_canonical_links
      (wordbook_entry_id,student_id,domain,lexical_entry_id,canonical_normalized_expression,
       canonical_expression_type,canonical_identity_variant,association_kind)
      values($1,$2,'reading',$3,'run','word','offline-equivalent-fixture','exact_identity')`,
      [other.wordbook_entry_id,U1,E4]),/unique/i);
  } finally { await db.close(); }
});

engineTest('local PostgreSQL: production-contract it/IT fixture is never auto-merged by displayed spelling or lemma', async () => {
  const db = await fixture();
  try {
    // Concrete existing OFFLINE fixture from lexicalProduction.test.js, not live data.
    await db.query(`insert into lexical_entries(entry_id,canonical_expression,normalized_expression,expression_type,identity_variant,lemma)
      values($1,'it','it','word','pronoun','it'),($2,'IT','it','word','abbreviation','IT')`,[E3,E4]);
    const pronoun = await save(db,{lexical:E3,zh:'它',en:'A pronoun.'});
    const abbreviation = await save(db,{lexical:E4,zh:'信息技术',en:'Information technology.'});
    assert.notEqual(pronoun.entry.wordbook_entry_id,abbreviation.entry.wordbook_entry_id);
    assert.notDeepEqual(pronoun.entry.lexeme_key,abbreviation.entry.lexeme_key);
    assert.equal((await counts(db)).entries,2);
    await assert.rejects(save(db,{lexical:E4,anchorLexical:E3}),/check constraint/i);
    assert.equal(await canonicalCount(db),2);
  } finally { await db.close(); }
});

engineTest('local PostgreSQL: sentence and honest fragments from all six sources are accepted and immutable while tags/links append', async () => {
  const db = await fixture();
  try {
    const contexts = [
      {domain:'reading',source:'ctw',block:'ctw_paragraph',text:'We run every day.',kind:'sentence',method:'verified_sentence_span'},
      {domain:'reading',source:'rdl',block:'rdl_question_option',text:'Training courses',kind:'fragment',method:'whole_fragment_block'},
      {domain:'reading',source:'rap',block:'rap_title',text:'Future research',kind:'fragment',method:'whole_fragment_block'},
      {domain:'writing',source:'bas',block:'bas_prompt',text:'Morning exercise',kind:'fragment',method:'whole_fragment_block'},
      {domain:'writing',source:'write_email',block:'email_subject',text:'Training courses',kind:'fragment',method:'whole_fragment_block'},
      {domain:'writing',source:'academic_discussion',block:'academic_student_response',text:'Exact post. More original text.',kind:'fragment',method:'whole_block_fallback'}
    ];
    for (const c of contexts) {
      const result = await save(db,{domain:c.domain,sources:[c.source],sentence:c.text,contextKind:c.kind,blockKind:c.block,method:c.method});
      assert.equal(result.example.example_text,c.text);
      assert.equal(result.example.context_kind,c.kind);
      assert.equal(result.example.extraction_method,c.method);
      assert.equal(result.example.source_block_kind,c.block);
    }
    assert.deepEqual(await counts(db),{entries:2,senses:2,examples:6,links:6});
    const first = await one(db,"select * from student_wordbook_examples where example_text='Training courses' and domain='reading'");
    const appended = await save(db,{sentence:'Training courses',sources:['rap'],contextKind:'fragment',blockKind:'rap_question_option',method:'verified_fragment_span',zh:'训练课程',en:'Courses for training.'});
    assert.equal(appended.example.example_id,first.example_id);
    assert.equal(appended.example.source_block_kind,'rdl_question_option'); // initial provenance preserved
    assert.equal(appended.example.extraction_method,'whole_fragment_block');
    assert.equal(appended.example.first_saved_at.getTime(),first.first_saved_at.getTime());
    assert.deepEqual(appended.example.source_types,['rap','rdl']);
    assert.equal((await counts(db)).examples,6);
    for (const [field,value] of [['context_kind','sentence'],['source_block_kind','fabricated'],['extraction_method','whole_sentence_block']]) {
      await assert.rejects(db.query(`update student_wordbook_examples set ${field}=$1 where example_id=$2`,[value,first.example_id]),/IMMUTABLE/i);
    }
    const before = await counts(db);
    await assert.rejects(save(db,{sentence:'Invalid classification',contextKind:'fragment',method:'canonical_sentence'}),/check constraint/i);
    await assert.rejects(save(db,{sentence:'Invalid classification',contextKind:'sentence',method:'whole_fragment_block'}),/check constraint/i);
    assert.deepEqual(await counts(db),before);
    // A later classification/source does not rewrite an already captured text.
    const same = await save(db,{sentence:'Training courses',sources:['ctw'],contextKind:'sentence',method:'whole_sentence_block'});
    assert.equal(same.example.context_kind,'fragment');
    assert.deepEqual(same.example.source_types,['ctw','rap','rdl']);
  } finally { await db.close(); }
});

engineTest('local PostgreSQL: latest multi-canonical enrichment exact-dedupes, preserves conflicts/provenance and updates without user writes', async () => {
  const db = await fixture();
  try {
    const first = await save(db); await addReviewedFixture(db); await save(db,reviewedFixture);
    await db.query(`update lexical_entries set
      common_senses=$2::jsonb,derived_words=$3::jsonb,useful_patterns=$4::jsonb where entry_id=$1`,[E1,
      JSON.stringify([{pos:'verb',definition_en:'Move quickly on foot.',meaning_zh:'跑步'},{pos:'verb',definition_en:'Operate a business.',meaning_zh:'经营'}]),
      JSON.stringify([{expression:'runner',relation:'agent',meaning_zh:'跑步的人'}]),
      JSON.stringify([{pattern:'run into',meaning_zh:'偶然遇见'}])]);
    await db.query(`update lexical_entries set
      common_senses=$2::jsonb,derived_words=$3::jsonb,useful_patterns=$4::jsonb,review_status='disabled' where entry_id=$1`,[E4,
      JSON.stringify([{meaning_zh:'跑步',definition_en:'Move quickly on foot.',pos:'verb'},{pos:'verb',definition_en:'Operate a business.',meaning_zh:'管理'}]),
      JSON.stringify([{meaning_zh:'跑步的人',relation:'agent',expression:'runner'},{expression:'runner',relation:'agent',meaning_zh:'运动员'}]),
      JSON.stringify([{pattern:'run into',meaning_zh:'偶然遇见'},{pattern:'run into',meaning_zh:'碰到'}])]);
    const userBefore = {};
    for (const table of ['entries','senses','examples','example_senses','canonical_links']) {
      userBefore[table] = (await db.query(`select to_jsonb(t) as value from student_wordbook_${table} t order by to_jsonb(t)::text collate "C"`)).rows;
    }
    const read = (await readEnrichment(db))[0];
    assert.equal(read.wordbook_entry_id,first.entry.wordbook_entry_id);
    assert.deepEqual(read.enrichment_sources.map(s=>[s.lexicalEntryId,s.canonicalStatus]),[[E1,'generated'],[E4,'disabled']]);
    const common = read.enrichment_items.filter(item=>item.field==='common_senses');
    assert.equal(common.length,3);
    const shared = common.find(item=>item.value.meaning_zh==='跑步');
    assert.deepEqual(shared.lexicalEntryIds,[E1,E4]); assert.equal(shared.hasConflict,false);
    const conflicting = common.filter(item=>item.value.definition_en==='Operate a business.');
    assert.equal(conflicting.length,2); assert.ok(conflicting.every(item=>item.hasConflict));
    for (const field of ['derived_words','useful_patterns']) {
      const items = read.enrichment_items.filter(item=>item.field===field);
      assert.equal(items.length,2); assert.ok(items.every(item=>item.hasConflict));
      assert.ok(items.some(item=>item.lexicalEntryIds.length===2));
    }
    assert.deepEqual(await readEnrichment(db),await readEnrichment(db)); // deterministic order
    await db.query(`update lexical_entries set common_senses='[]',derived_words='[]',
      useful_patterns='[{"pattern":"run for","meaning_zh":"竞选"}]' where entry_id=$1`,[E4]);
    const refreshed = (await readEnrichment(db))[0];
    assert.equal(refreshed.enrichment_items.filter(item=>item.field==='common_senses').length,2);
    assert.ok(refreshed.enrichment_items.some(item=>item.value.pattern==='run for'));
    for (const table of Object.keys(userBefore)) {
      assert.deepEqual((await db.query(`select to_jsonb(t) as value from student_wordbook_${table} t order by to_jsonb(t)::text collate "C"`)).rows,userBefore[table]);
    }
    // ID reuse/identity mutation is NOT enrichment. Keep the historical entry,
    // but never attach the now-different identity's enrichment to this lexeme.
    await db.query(`update lexical_entries set normalized_expression='different-identity' where entry_id=$1`,[E4]);
    const drifted = (await readEnrichment(db))[0];
    const unavailable = drifted.enrichment_sources.find(s=>s.lexicalEntryId===E4);
    assert.equal(unavailable.enrichmentStatus,'identity_drift');
    assert.equal(unavailable.commonSenses,null); assert.equal(unavailable.usefulPatterns,null);
    assert.ok(drifted.enrichment_items.every(item=>!item.lexicalEntryIds.includes(E4)));
    assert.equal(drifted.wordbook_entry_id,first.entry.wordbook_entry_id);
    await assert.rejects(db.query('delete from lexical_entries where entry_id=$1',[E4]),/foreign key/i);
  } finally { await db.close(); }
});

engineTest('local PostgreSQL: domain cancellation removes all canonical links and children only there; recollection is new', async () => {
  const db = await fixture();
  try {
    await addReviewedFixture(db);
    const reading = await save(db); await save(db,reviewedFixture);
    const writing = await save(db,{domain:'writing',sources:['bas']});
    await save(db,{...reviewedFixture,domain:'writing',sources:['write_email']});
    assert.equal(await canonicalCount(db),4);
    await db.query(`delete from student_wordbook_entries where student_id=$1 and domain='reading' and wordbook_entry_id=$2`,[U1,reading.entry.wordbook_entry_id]);
    assert.deepEqual(await counts(db),{entries:1,senses:1,examples:1,links:1});
    assert.equal(await canonicalCount(db),2);
    const retained = await one(db,'select * from student_wordbook_entries');
    assert.equal(retained.wordbook_entry_id,writing.entry.wordbook_entry_id);
    assert.equal(retained.first_saved_at.getTime(),writing.entry.first_saved_at.getTime());
    const again = await save(db);
    assert.notEqual(again.entry.wordbook_entry_id,reading.entry.wordbook_entry_id);
    assert.ok(again.entry.first_saved_at.getTime() > reading.entry.first_saved_at.getTime());
    assert.equal(await canonicalCount(db),3);
    assert.equal((await one(db,'select count(*)::int as n from lexical_entries where entry_id=$1',[E4])).n,1);
  } finally { await db.close(); }
});

engineTest('local PostgreSQL: preflight is executable/read-only; PK/FK/privilege/nullability/array prerequisites fail closed', async () => {
  const initial = new PGlite();
  try {
    await initial.exec(dependencies); await initial.exec(preflight);
    assert.equal((await one(initial,"select to_regclass('public.student_wordbook_entries') as t")).t,null);
  } finally { await initial.close(); }
  const cases = [
    ['PK', 'alter table lexical_source_blocks drop constraint lexical_source_blocks_pkey', /DEPENDENCY_INDEX_REQUIRED/],
    ['FK', 'alter table lexical_occurrences drop constraint lexical_occurrences_entry_id_fkey', /DEPENDENCY_FK_REQUIRED/],
    ['permission', 'grant select on lexical_entries to authenticated', /CORPUS_PERMISSION_MISMATCH/],
    ['nullability', 'alter table lexical_entries alter column identity_variant drop not null', /NOT_NULL_REQUIRED/],
    ['shape', "update lexical_entries set useful_patterns='{}'", /ENRICHMENT_ARRAYS_REQUIRED/],
    ['capability', 'revoke execute on function can_use_student_experience() from authenticated', /STUDENT_CAPABILITY_REQUIRED/]
  ];
  for (const [label,drift,error] of cases) {
    const db = new PGlite();
    try {
      await db.exec(dependencies); await db.exec(drift);
      await assert.rejects(db.exec(sql),error,label); await db.exec('rollback');
      assert.equal((await one(db,"select to_regclass('public.student_wordbook_entries') as t")).t,null,label);
    } finally { await db.close(); }
  }
});

engineTest('final audit: preflight asserts compatibility/footprint, returns explicit success and changes no canonical rows', async () => {
  const db = new PGlite();
  try {
    await db.exec(dependencies);
    const snapshot = async () => Promise.all(['lexical_entries','lexical_occurrences','lexical_source_blocks']
      .map(async table=>(await db.query(`select to_jsonb(t) as value from ${table} t order by to_jsonb(t)::text collate "C"`)).rows));
    const before = await snapshot();
    const results = await db.exec(preflight);
    assert.ok(results.some(result=>(result.rows||[]).some(row=>row.status==='WORDBOOK_PREFLIGHT_OK')));
    assert.deepEqual(await snapshot(),before);
    await db.exec('alter table lexical_entries drop constraint lexical_fixture_identity_key');
    // The final lemma query could still succeed, but the assertion MUST abort.
    await assert.rejects(db.exec(preflight),/DEPENDENCY_INDEX_REQUIRED/); await db.exec('rollback');
    await db.exec('alter table lexical_entries add constraint lexical_fixture_identity_key unique(normalized_expression,expression_type,identity_variant)');
    await db.exec(sql);
    await assert.rejects(db.exec(preflight),/PREFLIGHT_EXISTING_OBJECT/); await db.exec('rollback');
  } finally { await db.close(); }
  const unsafe = new PGlite();
  try {
    await unsafe.exec(dependencies); await unsafe.exec('alter role authenticated bypassrls');
    await assert.rejects(unsafe.exec(preflight),/CLIENT_ROLE_UNSAFE/); await unsafe.exec('rollback');
    await assert.rejects(unsafe.exec(sql),/CLIENT_ROLE_UNSAFE/); await unsafe.exec('rollback');
    assert.equal((await one(unsafe,"select to_regclass('public.student_wordbook_entries') as t")).t,null);
  } finally { await unsafe.close(); }
});

engineTest('final audit: inherited default grants cause atomic migration failure rather than unsafe installation', async () => {
  const db = new PGlite();
  try {
    await db.exec(dependencies);
    await db.exec(`create role offline_inherited_writer;
      grant offline_inherited_writer to authenticated;
      alter default privileges in schema public grant update on tables to offline_inherited_writer;`);
    await assert.rejects(db.exec(sql),/EFFECTIVE_TABLE_PRIVILEGE_UNSAFE/); await db.exec('rollback');
    assert.equal((await one(db,"select to_regclass('public.student_wordbook_entries') as t")).t,null);
    assert.equal((await one(db,"select to_regprocedure('public.wordbook_snapshot_key(text[])') as f")).f,null);
    assert.equal((await one(db,'select count(*)::int as n from lexical_entries')).n,2);
  } finally { await db.close(); }
});

engineTest('final audit: verify detects incomplete installation and metadata/ACL weakening even with empty tables', async () => {
  const db = await fixture();
  const verifyOk = async () => {
    const results = await db.exec(verify);
    assert.ok(results.some(result=>(result.rows||[]).some(row=>row.status==='WORDBOOK_VERIFY_OK')));
  };
  const fails = async (mutation,error,restore) => {
    await db.exec(mutation);
    await assert.rejects(db.exec(verify),error); await db.exec('rollback');
    await db.exec(restore); await verifyOk();
  };
  try {
    await verifyOk();
    await fails(`alter policy students_select_own_wordbook_entries on student_wordbook_entries using(true)`,
      /OWNER_POLICY_MISMATCH/,`alter policy students_select_own_wordbook_entries on student_wordbook_entries
        using(student_id=(select auth.uid()) and (select public.can_use_student_experience()))`);
    await fails('grant update on student_wordbook_entries to authenticated',/CLIENT_PRIVILEGE_UNSAFE/,
      'revoke update on student_wordbook_entries from authenticated');
    await fails('grant update(expression) on student_wordbook_entries to authenticated',/CLIENT_PRIVILEGE_UNSAFE/,
      'revoke update(expression) on student_wordbook_entries from authenticated');
    await fails('alter table student_wordbook_examples disable trigger student_wordbook_examples_snapshot_guard',
      /TRIGGER_MISSING_OR_DISABLED/,'alter table student_wordbook_examples enable trigger student_wordbook_examples_snapshot_guard');
    const canonicalFk = await one(db,`select conname from pg_constraint where conrelid='student_wordbook_canonical_links'::regclass
      and contype='f' and confrelid='lexical_entries'::regclass`);
    await fails(`alter table student_wordbook_canonical_links drop constraint "${canonicalFk.conname}";
      alter table student_wordbook_canonical_links add constraint "${canonicalFk.conname}"
        foreign key(lexical_entry_id) references lexical_entries(entry_id) on delete cascade on update cascade`,
      /FK_ACTION_MISMATCH/,`alter table student_wordbook_canonical_links drop constraint "${canonicalFk.conname}";
      alter table student_wordbook_canonical_links add constraint "${canonicalFk.conname}"
        foreign key(lexical_entry_id) references lexical_entries(entry_id) on delete restrict on update cascade`);
    const sourceCheck = await one(db,`select conname from pg_constraint where conrelid='student_wordbook_examples'::regclass
      and contype='c' and pg_get_expr(conbin,conrelid) like '%wordbook_source_types_valid%'`);
    await fails(`alter table student_wordbook_examples drop constraint "${sourceCheck.conname}";
      alter table student_wordbook_examples add constraint "${sourceCheck.conname}" check(true)`,/CHECK_MISMATCH/,
      `alter table student_wordbook_examples drop constraint "${sourceCheck.conname}";
      alter table student_wordbook_examples add constraint "${sourceCheck.conname}"
        check(public.wordbook_source_types_valid(source_types,domain))`);
    const originalGuard = sql.match(/create function public\.guard_student_wordbook_snapshot\(\)[\s\S]*?\$\$;/)[0];
    await fails(`create or replace function public.guard_student_wordbook_snapshot() returns trigger
      language plpgsql set search_path=pg_catalog as $$ begin return new; end; $$`,/FUNCTION_MISMATCH/,
      originalGuard.replace('create function','create or replace function'));
    await fails('alter table student_wordbook_entries add column common_senses jsonb',/COLUMN_MISMATCH/,
      'alter table student_wordbook_entries drop column common_senses');
    await fails('drop index student_wordbook_examples_sources_idx',/INDEX_MISSING/,
      'create index student_wordbook_examples_sources_idx on student_wordbook_examples using gin(source_types)');
    await fails('grant execute on function wordbook_snapshot_key(text[]) to authenticated',/FUNCTION_PRIVILEGE_UNSAFE/,
      'revoke execute on function wordbook_snapshot_key(text[]) from authenticated');
    assert.deepEqual(await counts(db),{entries:0,senses:0,examples:0,links:0});
  } finally { await db.close(); }
  const missing = new PGlite();
  try {
    await missing.exec(dependencies);
    await assert.rejects(missing.exec(verify),/TABLE_OR_RLS_MISSING/); await missing.exec('rollback');
  } finally { await missing.close(); }
});
