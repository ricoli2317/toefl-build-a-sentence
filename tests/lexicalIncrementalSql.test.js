const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { buildIncrementalImportSql } = require('../lib/lexical/incremental/importer.ts');
const { bindImportBaseline } = require('../lib/lexical/incremental/importBaseline.ts');
const { preflightIncrementalImport } = require('../lib/lexical/incremental/importPreflight.ts');
const { baselineValue, baselineRowsSha256, baselineRowsHashSql, BASELINE_HASH_SQL } = require('../lib/lexical/incremental/baselineHash.ts');
const { ENTRY_COLUMNS, BLOCK_COLUMNS, OCCURRENCE_COLUMNS, productionId } = require('../lib/lexical/production.ts');
const { canonicalSourceTextHash } = require('../lib/lexical/hash.ts');

// Opt-in real PostgreSQL engine (WASM); no production connection or tracked dependency required.
const modulePath = process.env.LEXICAL_SQL_TEST_PGLITE;
const PGlite = modulePath ? require(path.resolve(modulePath)).PGlite : null;
const engineTest = (name, fn) => test(name, { skip: !PGlite }, fn);
const id = name => productionId('fixture', name);
const schema = `
CREATE TABLE lexical_entries (
 entry_id uuid PRIMARY KEY, canonical_expression text NOT NULL, normalized_expression text NOT NULL,
 expression_type text NOT NULL, lemma text, common_senses jsonb NOT NULL DEFAULT '[]', derived_words jsonb NOT NULL DEFAULT '[]',
 useful_patterns jsonb NOT NULL DEFAULT '[]', review_status text NOT NULL DEFAULT 'generated', generation_version text NOT NULL,
 review_notes text, identity_variant text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (normalized_expression,expression_type,identity_variant));
CREATE TABLE lexical_source_blocks (
 block_id uuid PRIMARY KEY, source_type text NOT NULL, source_item_id text NOT NULL, content_block_id text NOT NULL,
 block_kind text NOT NULL, source_text_hash text NOT NULL, generation_status text NOT NULL DEFAULT 'generated',
 generation_version text, last_error text, last_attempted_at timestamptz, generated_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (source_type,source_item_id,content_block_id));
CREATE TABLE lexical_occurrences (
 occurrence_id uuid PRIMARY KEY, entry_id uuid NOT NULL REFERENCES lexical_entries(entry_id),
 source_type text NOT NULL, source_item_id text NOT NULL, content_block_id text NOT NULL, sentence_id text, source_anchor_id text,
 surface_text text NOT NULL, normalized_surface text NOT NULL, start_offset integer NOT NULL, end_offset integer NOT NULL,
 context_pos text, context_meaning_zh text NOT NULL, context_definition_en text, context_text text NOT NULL,
 review_status text NOT NULL DEFAULT 'generated', generation_version text NOT NULL, review_notes text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (source_type,source_item_id,content_block_id,start_offset,end_offset), CHECK (start_offset >= 0 AND end_offset > start_offset));
CREATE TABLE mutation_audit (table_name text, operation text, item text);
CREATE FUNCTION audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN INSERT INTO mutation_audit VALUES (TG_TABLE_NAME,TG_OP,coalesce(to_jsonb(NEW)->>'source_item_id',to_jsonb(OLD)->>'source_item_id',to_jsonb(NEW)->>'entry_id',to_jsonb(OLD)->>'entry_id')); RETURN coalesce(NEW,OLD); END $$;
CREATE TRIGGER audit_entries AFTER INSERT OR UPDATE OR DELETE ON lexical_entries FOR EACH ROW EXECUTE FUNCTION audit_mutation();
CREATE TRIGGER audit_blocks AFTER INSERT OR UPDATE OR DELETE ON lexical_source_blocks FOR EACH ROW EXECUTE FUNCTION audit_mutation();
CREATE TRIGGER audit_occurrences AFTER INSERT OR UPDATE OR DELETE ON lexical_occurrences FOR EACH ROW EXECUTE FUNCTION audit_mutation();
`;
const entry = (name) => ({ entry_id:id(name), canonical_expression:name, normalized_expression:name, expression_type:'word', lemma:name,
 common_senses:[], derived_words:[], useful_patterns:[], review_status:'generated', generation_version:'lexical-v1', review_notes:null, identity_variant:'' });
const block = (item,text) => ({ block_id:id(`block-${item}`), source_type:'ctw',source_item_id:item,content_block_id:'paragraph:p',block_kind:'ctw_paragraph',
 source_text_hash:canonicalSourceTextHash(text),generation_status:'generated',generation_version:'lexical-v1',last_error:null });
const occurrence = (item,word='old') => ({ occurrence_id:id(`occ-${item}`),entry_id:id(word),source_type:'ctw',source_item_id:item,content_block_id:'paragraph:p',
 sentence_id:null,source_anchor_id:null,surface_text:word,normalized_surface:word,start_offset:0,end_offset:word.length,
 context_pos:'adjective',context_meaning_zh:'此处的含义',context_definition_en:'Previously existing.',context_text:`${word} text.`,
 review_status:'generated',generation_version:'lexical-v1',review_notes:null });

async function insert(db,table,row) {
 const keys=Object.keys(row); const values=keys.map(key=>typeof row[key]==='object' && row[key]!==null?JSON.stringify(row[key]):row[key]);
 await db.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(',')})`,values);
}
async function snapshot(db) {
 const fetch = async (table,order) => (await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY ${order}`)).rows.map(row=>row.row);
 return { entries:await fetch('lexical_entries','normalized_expression,expression_type,identity_variant'),
  blocks:await fetch('lexical_source_blocks','source_type,source_item_id,content_block_id'),
  occurrences:await fetch('lexical_occurrences','source_type,source_item_id,content_block_id,start_offset,end_offset,occurrence_id') };
}
async function fixture() {
 const db=new PGlite(); await db.exec("SET timezone='UTC';"+schema);
 await insert(db,'lexical_entries',entry('old'));
 for (const item of ['same','changed','removed']) {
  await insert(db,'lexical_source_blocks',block(item,'old text.'));
  await insert(db,'lexical_occurrences',occurrence(item));
 }
 await db.exec('DELETE FROM mutation_audit;');
 const before=await snapshot(db);
 await db.exec('CREATE TEMP TABLE hash_init (id int);'+BASELINE_HASH_SQL);
 for(const table of ['lexical_entries','lexical_source_blocks','lexical_occurrences']) {
  const rows=(await db.query(`SELECT to_jsonb(t) AS row,pg_temp.lexical_baseline_value(to_jsonb(t)) AS encoded FROM ${table} t`)).rows;
  for(const row of rows) assert.equal(baselineValue(row.row),row.encoded);
 }
 await db.exec("SET timezone='UTC';");
 for(const row of before.blocks) {
  const result=await db.query(baselineRowsHashSql('lexical_source_blocks','b','b.block_id',`b.block_id='${row.block_id}'`));
  assert.equal(Object.values(result.rows[0])[0],baselineRowsSha256([row]),JSON.stringify({before:row,after:(await snapshot(db)).blocks.find(b=>b.block_id===row.block_id)}));
 }
 const target=[block('new','fresh text.'),block('changed','old revised text.')];
 const delta=target.map(row=>({ source_type:row.source_type,source_item_id:row.source_item_id,content_block_id:row.content_block_id,block_kind:row.block_kind,
  action:row.source_item_id==='new'?'new':'changed',old_hash:row.source_item_id==='new'?null:canonicalSourceTextHash('old text.'),new_hash:row.source_text_hash }));
 delta.push({ source_type:'ctw',source_item_id:'removed',content_block_id:'paragraph:p',block_kind:'ctw_paragraph',action:'removed',old_hash:canonicalSourceTextHash('old text.'),new_hash:null });
 const data=bindImportBaseline({ entries:[entry('fresh')],blocks:target,occurrences:[occurrence('new','fresh'),occurrence('changed')],
  removed:[delta[2]],delta,meta:{ final_entries_count:'2',final_blocks_count:'3',final_occurrences_count:'3',reused_entries:'1' },
  entryColumns:[...ENTRY_COLUMNS],blockColumns:[...BLOCK_COLUMNS],occurrenceColumns:[...OCCURRENCE_COLUMNS] },before);
 return { db,data,before };
}

/** psql COPY transport is replaced by PGlite's Blob transport; SQL and CSV bytes stay identical. */
async function executeImport(db,sql) {
 sql=sql.replace(/^\\set ON_ERROR_STOP on\n/,'');
 const copies=[...sql.matchAll(/COPY [^\n]+ FROM STDIN WITH \(FORMAT csv\);\n([\s\S]*?)^\\\.\n/gm)];
 let cursor=0;
 for (const copy of copies) {
  await db.exec(sql.slice(cursor,copy.index));
  const command=copy[0].slice(0,copy[0].indexOf('\n')).replace('FROM STDIN',"FROM '/dev/blob'");
  await db.exec(command,{ blob:new Blob([copy[1]]) });
  cursor=copy.index+copy[0].length;
 }
 await db.exec(sql.slice(cursor));
}

engineTest('actual PostgreSQL: full UTF-8/null/JSON hash encoding agrees with JavaScript',async()=>{
 const db=new PGlite();
 try {
  await db.exec('CREATE TEMP TABLE init (id int);'+BASELINE_HASH_SQL);
  const values=[null,'','\u001f\n😀中文',1e-7,1e21,-0,0.1,{ senses:[{ definition:'a "quoted" value',meaning:'词义',n:3 }],z:null,a:'' }];
  for(const value of values) {
   const { rows }=await db.query('SELECT pg_temp.lexical_baseline_value($1::jsonb) AS encoded',[JSON.stringify(value)]);
   assert.equal(rows[0].encoded,baselineValue(value));
  }
 } finally { await db.close(); }
});

engineTest('actual PostgreSQL: exact replacement, unchanged zero writes, idempotent rerun',async()=>{
 const { db,data,before }=await fixture();
 try {
  assert.equal(preflightIncrementalImport(data,before,before).state,'fresh');
  await executeImport(db,buildIncrementalImportSql(data));
  const after=await snapshot(db);
  assert.equal(preflightIncrementalImport(data,before,after).state,'applied');
  assert.deepEqual(after.blocks.find(row=>row.source_item_id==='same'),before.blocks.find(row=>row.source_item_id==='same'));
  assert.deepEqual(after.occurrences.find(row=>row.source_item_id==='same'),before.occurrences.find(row=>row.source_item_id==='same'));
  assert.equal(after.blocks.length,3); assert.equal(after.occurrences.length,3); assert.equal(after.entries.length,2);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM mutation_audit WHERE item='same'")).rows[0].n,0);
  const audit=(await db.query('SELECT * FROM mutation_audit')).rows;
  await executeImport(db,buildIncrementalImportSql(data));
  assert.deepEqual(await snapshot(db),after);
  assert.deepEqual((await db.query('SELECT * FROM mutation_audit')).rows,audit);
 } finally { await db.close(); }
});

engineTest('actual PostgreSQL: changed-block occurrence semantic drift aborts before writes',async()=>{
 const { db,data }=await fixture();
 try {
  await db.exec("UPDATE lexical_occurrences SET context_text='drift with same source hash' WHERE source_item_id='changed'; DELETE FROM mutation_audit;");
  const before=await snapshot(db);
  await assert.rejects(executeImport(db,buildIncrementalImportSql(data)),/Exact delta pre-state changed/);
  await db.exec('ROLLBACK;'); assert.deepEqual(await snapshot(db),before);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM mutation_audit')).rows[0].n,0);
 } finally { await db.close(); }
});

engineTest('actual PostgreSQL: existing entry JSON semantic drift aborts without overwriting',async()=>{
 const { db,data }=await fixture();
 try {
  await db.exec(`UPDATE lexical_entries SET common_senses='[{"meaning":"人工维护"}]'; DELETE FROM mutation_audit;`);
  const before=await snapshot(db);
  await assert.rejects(executeImport(db,buildIncrementalImportSql(data)),/Unrelated production entries changed/);
  await db.exec('ROLLBACK;'); assert.deepEqual(await snapshot(db),before);
 } finally { await db.close(); }
});

engineTest('actual PostgreSQL: post-check failure rolls back all mutations',async()=>{
 const { db,data,before }=await fixture();
 try {
  data.meta.final_occurrences_count='999';
  await assert.rejects(executeImport(db,buildIncrementalImportSql(data)),/Occurrence count mismatch/);
  await db.exec('ROLLBACK;'); assert.deepEqual(await snapshot(db),before);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM mutation_audit')).rows[0].n,0);
 } finally { await db.close(); }
});

engineTest('actual PostgreSQL: conflicting new entry identity rolls back exact block replacements',async()=>{
 const { db,data }=await fixture();
 try {
  const collision=entry('fresh'); collision.entry_id=id('other-fresh');
  await insert(db,'lexical_entries',collision); await db.exec('DELETE FROM mutation_audit;');
  const before=await snapshot(db);
  await assert.rejects(executeImport(db,buildIncrementalImportSql(data)),/entries changed|foreign key|entries missing/i);
  await db.exec('ROLLBACK;'); assert.deepEqual(await snapshot(db),before);
 } finally { await db.close(); }
});

engineTest('actual PostgreSQL: empty delta COPY streams remain valid no-op transactions',async()=>{
 const { db,before }=await fixture();
 try {
  const data=bindImportBaseline({entries:[],blocks:[],occurrences:[],removed:[],delta:[],
   meta:{final_entries_count:'1',final_blocks_count:'3',final_occurrences_count:'3'},
   entryColumns:[...ENTRY_COLUMNS],blockColumns:[...BLOCK_COLUMNS],occurrenceColumns:[...OCCURRENCE_COLUMNS]},before);
  await executeImport(db,buildIncrementalImportSql(data));
  assert.equal(baselineRowsSha256((await snapshot(db)).entries),baselineRowsSha256(before.entries));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM mutation_audit')).rows[0].n,0);
 } finally { await db.close(); }
});

engineTest('actual PostgreSQL: mixed fresh/applied state is refused without reconciliation',async()=>{
 const { db,data }=await fixture();
 try {
  await insert(db,'lexical_source_blocks',data.blocks.find(row=>row.source_item_id==='new'));
  await db.exec('DELETE FROM mutation_audit;');const before=await snapshot(db);
  assert.throws(()=>preflightIncrementalImport(data,before,before),/mixed partial import/);
  await assert.rejects(executeImport(db,buildIncrementalImportSql(data)),/Mixed applied\/fresh delta block state/);
  await db.exec('ROLLBACK;');assert.deepEqual(await snapshot(db),before);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM mutation_audit')).rows[0].n,0);
 } finally { await db.close(); }
});

engineTest('actual PostgreSQL: an applied hash alone cannot mask an extra delta occurrence',async()=>{
 const { db,data,before }=await fixture();
 try {
  await executeImport(db,buildIncrementalImportSql(data));
  await insert(db,'lexical_occurrences',{...occurrence('new','fresh'),occurrence_id:id('extra'),start_offset:20,end_offset:25});
  await db.exec('DELETE FROM mutation_audit;');const drifted=await snapshot(db);
  assert.throws(()=>preflightIncrementalImport(data,before,drifted),/complete staged post-state/);
  await assert.rejects(executeImport(db,buildIncrementalImportSql(data)),/Unexpected extra delta occurrences/);
  await db.exec('ROLLBACK;');assert.deepEqual(await snapshot(db),drifted);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM mutation_audit')).rows[0].n,0);
 } finally { await db.close(); }
});

engineTest('actual PostgreSQL: missing exact-span uniqueness aborts at the schema gate',async()=>{
 const { db,data,before }=await fixture();
 try {
  const constraint=(await db.query("SELECT conname FROM pg_constraint WHERE conrelid='lexical_occurrences'::regclass AND contype='u'")).rows[0].conname;
  await db.exec(`ALTER TABLE lexical_occurrences DROP CONSTRAINT "${constraint}";`);
  await assert.rejects(executeImport(db,buildIncrementalImportSql(data)),/lacks required unique index/);
  await db.exec('ROLLBACK;');assert.deepEqual(await snapshot(db),before);
 } finally { await db.close(); }
});
