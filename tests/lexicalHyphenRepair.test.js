const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { fullSnapshotHashes } = require('../lib/lexical/incremental/importBaseline.ts');
const { sortBlocks, sortEntries, sortOccurrences } = require('../lib/lexical/incremental/productionBaseline.server.ts');
const { validateHyphenRepair, validateHyphenRepairSemanticQa, preflightHyphenRepair, buildHyphenRepairSql } = require('../lib/lexical/incremental/hyphenRepair.ts');
const { productionId, ENTRY_COLUMNS, OCCURRENCE_COLUMNS } = require('../lib/lexical/production.ts');
const { canonicalSourceTextHash } = require('../lib/lexical/hash.ts');
const PGlite = process.env.LEXICAL_SQL_TEST_PGLITE ? require(path.resolve(process.env.LEXICAL_SQL_TEST_PGLITE)).PGlite : null;
const engineTest = (name,fn) => test(name,{skip:!PGlite},fn);
const schema = `
CREATE TABLE lexical_entries (entry_id uuid PRIMARY KEY, canonical_expression text NOT NULL, normalized_expression text NOT NULL,
 expression_type text NOT NULL, lemma text, common_senses jsonb NOT NULL DEFAULT '[]', derived_words jsonb NOT NULL DEFAULT '[]', useful_patterns jsonb NOT NULL DEFAULT '[]',
 review_status text NOT NULL, generation_version text NOT NULL, review_notes text, identity_variant text NOT NULL DEFAULT '',
 created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), UNIQUE(normalized_expression,expression_type,identity_variant));
CREATE TABLE lexical_source_blocks (block_id uuid PRIMARY KEY, source_type text NOT NULL, source_item_id text NOT NULL, content_block_id text NOT NULL,
 block_kind text NOT NULL, source_text_hash text NOT NULL, generation_status text NOT NULL, generation_version text, last_error text,
 created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), UNIQUE(source_type,source_item_id,content_block_id));
CREATE TABLE lexical_occurrences (occurrence_id uuid PRIMARY KEY,entry_id uuid NOT NULL REFERENCES lexical_entries(entry_id),source_type text NOT NULL,
 source_item_id text NOT NULL,content_block_id text NOT NULL,sentence_id text,source_anchor_id text,surface_text text NOT NULL,normalized_surface text NOT NULL,
 start_offset integer NOT NULL,end_offset integer NOT NULL,context_pos text,context_meaning_zh text NOT NULL,context_definition_en text,context_text text NOT NULL,
 review_status text NOT NULL,generation_version text NOT NULL,review_notes text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),
 UNIQUE(source_type,source_item_id,content_block_id,start_offset,end_offset));
CREATE TABLE mutation_audit (tbl text, op text);
CREATE FUNCTION audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO mutation_audit VALUES(TG_TABLE_NAME,TG_OP); RETURN coalesce(NEW,OLD); END $$;
CREATE TRIGGER audit_entries AFTER INSERT OR UPDATE OR DELETE ON lexical_entries FOR EACH ROW EXECUTE FUNCTION audit_mutation();
CREATE TRIGGER audit_occurrences AFTER INSERT OR UPDATE OR DELETE ON lexical_occurrences FOR EACH ROW EXECUTE FUNCTION audit_mutation();
CREATE TRIGGER audit_blocks AFTER INSERT OR UPDATE OR DELETE ON lexical_source_blocks FOR EACH ROW EXECUTE FUNCTION audit_mutation();
`;
const id = s => productionId('fixture',s);
const b = {sourceType:'rdl',sourceItemId:'item',contentBlockId:'material:RDL-test',blockKind:'rdl_material',text:'eco-friendly'};
const e = (word,type='word') => ({entry_id:id(word),canonical_expression:word,normalized_expression:word,expression_type:type,lemma:word,
 common_senses:[],derived_words:[],useful_patterns:[],review_status:'generated',generation_version:'lexical-v1',review_notes:null,identity_variant:''});
const o = (word,start,end,type='word') => ({occurrence_id:id('occ-'+word),entry_id:id(word),source_type:'rdl',source_item_id:'item',content_block_id:b.contentBlockId,
 sentence_id:null,source_anchor_id:null,surface_text:word,normalized_surface:word,start_offset:start,end_offset:end,context_pos:'adjective',
 context_meaning_zh:type==='phrase'?'环保的':'组成词含义',context_definition_en:type==='phrase'?'Designed to cause little harm to the environment.':'A contextual component definition.',
 context_text:b.text,review_status:'generated',generation_version:'lexical-v1',review_notes:null});
const baselineFixture = () => ({entries:[e('eco'),e('friendly')],blocks:[{block_id:id('block'),source_type:'rdl',source_item_id:'item',content_block_id:b.contentBlockId,
 block_kind:b.blockKind,source_text_hash:canonicalSourceTextHash(b.text),generation_status:'generated',generation_version:'lexical-v1',last_error:null}],occurrences:[o('eco',0,3),o('friendly',4,12)]});
const dataFor = baseline => ({version:'lexical-hyphen-repair-v1',blocks:[b],entries:[e('eco-friendly','phrase')],occurrences:[o('eco-friendly',0,12,'phrase')],
 baseline:{hashes:fullSnapshotHashes(baseline),counts:{entries:baseline.entries.length,blocks:baseline.blocks.length,occurrences:baseline.occurrences.length}}});

test('independent semantic QA must cover every exact compound with matching semantic identity', () => {
 const provenance={semantic_engine:'openchamber_agent',provider:'openai',model:'gpt-6.1-sol',thinking_effort:'high'};
 const expression={block_key:'block',start_offset:0,end_offset:12,surface_text:'eco-friendly',canonical_expression:'eco-friendly',lemma:'eco-friendly',context_pos:'adjective',expression_type:'phrase'};
 const annotations={provenance,blocks:[{block_key:'block',expressions:[expression]}]};
 const qa={version:'compound-semantic-qa-v1',provenance,reviews:[{...expression,status:'PASS',action:'retain',reason:'Reviewed environmental modifier in canonical context.',corrections:{}}]};
 assert.equal(validateHyphenRepairSemanticQa(qa,annotations).pass,1);
 for (const mutate of [q=>q.reviews=[],q=>q.reviews.push(q.reviews[0]),q=>q.reviews[0].status='ISSUE',q=>q.reviews[0].start_offset=1,q=>q.reviews[0].context_pos='noun']) {
  const changed=structuredClone(qa);mutate(changed);assert.throws(()=>validateHyphenRepairSemanticQa(changed,annotations));
 }
});

test('append-only repair covers exactly missing compounds, retains components and fails on extra/stale/circular data', () => {
 const baseline=baselineFixture(), data=dataFor(baseline);
 assert.doesNotThrow(()=>validateHyphenRepair(data,baseline));
 assert.equal(preflightHyphenRepair(data,baseline,baseline).state,'fresh');
 const applied={...baseline,entries:[...baseline.entries,...data.entries],occurrences:[...baseline.occurrences,...data.occurrences]};
 assert.equal(preflightHyphenRepair(data,baseline,applied).state,'applied');
 assert.throws(()=>preflightHyphenRepair(data,baseline,{...applied,occurrences:baseline.occurrences}),/mixed/);
 assert.throws(()=>preflightHyphenRepair(data,baseline,{...baseline,occurrences:baseline.occurrences.map(o=>({...o,context_meaning_zh:'改动'}))}),/baseline drift/);
 for (const mutate of [d=>d.occurrences.push(o('friendly',4,12)),d=>d.occurrences[0].context_text='other',d=>d.occurrences[0].context_definition_en='eco-friendly',d=>d.blocks[0].text='Eco-friendly']) {
   const changed=structuredClone(data);mutate(changed);assert.throws(()=>validateHyphenRepair(changed,baseline));
 }
 const sql=buildHyphenRepairSql(data);
 assert.doesNotMatch(sql,/UPDATE public\.|DELETE FROM public\./);
 assert.match(sql,/pg_advisory_xact_lock\(7631043\)/);
 assert.match(sql,/Repair mixed fresh\/applied/);
});

async function insert(db,table,row) {
 const keys=Object.keys(row);
 await db.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_,i)=>'$'+(i+1)).join(',')})`,keys.map(k=>row[k]!==null&&typeof row[k]==='object'?JSON.stringify(row[k]):row[k]));
}
async function snapshot(db) {
 const rows=async(table)=>(await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t`)).rows.map(r=>r.row);
 return {entries:sortEntries(await rows('lexical_entries')),blocks:sortBlocks(await rows('lexical_source_blocks')),occurrences:sortOccurrences(await rows('lexical_occurrences'))};
}
async function fixture() {
 const db=new PGlite();await db.exec("SET timezone='UTC';"+schema);
 const source=baselineFixture();
 for(const e of source.entries) await insert(db,'lexical_entries',e);
 for(const b of source.blocks) await insert(db,'lexical_source_blocks',b);
 for(const o of source.occurrences) await insert(db,'lexical_occurrences',o);
 await db.exec('DELETE FROM mutation_audit');
 const baseline=await snapshot(db);return {db,baseline,data:dataFor(baseline)};
}
async function execute(db,sql) {
 sql=sql.replace(/^\\set ON_ERROR_STOP on\n/,'');
 let cursor=0;
 for(const match of sql.matchAll(/COPY [^\n]+ FROM STDIN WITH \(FORMAT csv\);\n([\s\S]*?)^\\\.\n/gm)) {
   await db.exec(sql.slice(cursor,match.index));
   await db.exec(match[0].slice(0,match[0].indexOf('\n')).replace('FROM STDIN',"FROM '/dev/blob'"),{blob:new Blob([match[1]])});
   cursor=match.index+match[0].length;
 }
 await db.exec(sql.slice(cursor));
}

engineTest('Postgres repair adds full occurrence, never writes components/blocks, rerun is zero-write', async()=>{
 const {db,baseline,data}=await fixture();try {
   const sql=buildHyphenRepairSql(data);await execute(db,sql);
   const after=await snapshot(db);assert.equal(preflightHyphenRepair(data,baseline,after).state,'applied');
   assert.deepEqual(after.blocks,baseline.blocks);
   assert.deepEqual(after.occurrences.filter(o=>o.surface_text!=='eco-friendly'),baseline.occurrences);
   assert.deepEqual((await db.query('SELECT tbl,op FROM mutation_audit')).rows,[{tbl:'lexical_entries',op:'INSERT'},{tbl:'lexical_occurrences',op:'INSERT'}]);
   await db.exec('DELETE FROM mutation_audit');await execute(db,sql);
   assert.deepEqual((await db.query('SELECT * FROM mutation_audit')).rows,[]);
   assert.deepEqual(await snapshot(db),after);
 }finally{await db.close();}
});

engineTest('Postgres repair rejects drift and mixed state without overwriting existing semantics', async()=>{
 for(const mode of ['drift','mixed','staged-drift']) {
  const {db,data}=await fixture();try {
   if(mode==='drift') await db.exec("UPDATE lexical_occurrences SET context_meaning_zh='修改' WHERE surface_text='friendly'");
   else {await insert(db,'lexical_entries',data.entries[0]);if(mode==='staged-drift'){await insert(db,'lexical_occurrences',{...data.occurrences[0],context_meaning_zh:'不同词义'});}}
   const before=await snapshot(db);await db.exec('DELETE FROM mutation_audit');
   await assert.rejects(execute(db,buildHyphenRepairSql(data)),/Repair (baseline drift|mixed|staged semantic drift)/);
   await db.exec('ROLLBACK');assert.deepEqual(await snapshot(db),before);
   assert.deepEqual((await db.query('SELECT * FROM mutation_audit')).rows,[]);
  }finally{await db.close();}
 }
});

engineTest('Postgres repair rolls back new entry if exact-span insertion conflicts', async()=>{
 const {db,baseline,data}=await fixture();try {
  const collision={...o('existing',0,12),entry_id:baseline.entries[0].entry_id};await insert(db,'lexical_occurrences',collision);
  const before=await snapshot(db);
  const modified={...data,baseline:{...data.baseline,hashes:fullSnapshotHashes(before),counts:{...data.baseline.counts,occurrences:before.occurrences.length}}};
  await db.exec('DELETE FROM mutation_audit');await assert.rejects(execute(db,buildHyphenRepairSql(modified)),/unique|duplicate/i);
  await db.exec('ROLLBACK');assert.deepEqual(await snapshot(db),before);
  assert.deepEqual((await db.query('SELECT * FROM mutation_audit')).rows,[]);
 }finally{await db.close();}
});

engineTest('Postgres repair refuses missing exact-span uniqueness', async()=>{
 const {db,data}=await fixture();try {
  const constraint=(await db.query("SELECT conname FROM pg_constraint WHERE conrelid='lexical_occurrences'::regclass AND contype='u'")).rows[0].conname;
  await db.exec(`ALTER TABLE lexical_occurrences DROP CONSTRAINT "${constraint}"`);
  await assert.rejects(execute(db,buildHyphenRepairSql(data)),/Repair schema lacks required unique/);
  await db.exec('ROLLBACK');
 }finally{await db.close();}
});

engineTest('Postgres repair reuses an existing entry without mutating its metadata', async()=>{
 const {db}=await fixture();try {
  await insert(db,'lexical_entries',{...e('eco-friendly','phrase'),review_notes:'Keep existing semantics',common_senses:[{pos:'adjective',meaning_zh:'环保的',definition_en:'Causing little harm to the environment.'}]});
  const baseline=await snapshot(db);const data={...dataFor(baseline),entries:[]};
  validateHyphenRepair(data,baseline);await db.exec('DELETE FROM mutation_audit');
  const sql=buildHyphenRepairSql(data);await execute(db,sql);
  const after=await snapshot(db);assert.deepEqual(after.entries,baseline.entries);assert.deepEqual(after.blocks,baseline.blocks);
  assert.deepEqual((await db.query('SELECT tbl,op FROM mutation_audit')).rows,[{tbl:'lexical_occurrences',op:'INSERT'}]);
  await db.exec('DELETE FROM mutation_audit');await execute(db,sql);
  assert.deepEqual((await db.query('SELECT * FROM mutation_audit')).rows,[]);
 }finally{await db.close();}
});

engineTest('Postgres repair post-check failure rolls back entries, occurrences and audit writes', async()=>{
 const {db,baseline,data}=await fixture();try {
  await db.exec(`CREATE FUNCTION spoil_compound() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.surface_text='eco-friendly' THEN UPDATE lexical_occurrences SET context_meaning_zh='故意破坏词义' WHERE occurrence_id=NEW.occurrence_id; END IF;
    RETURN NEW; END $$;
    CREATE TRIGGER spoil AFTER INSERT ON lexical_occurrences FOR EACH ROW EXECUTE FUNCTION spoil_compound();`);
  await assert.rejects(execute(db,buildHyphenRepairSql(data)),/Repair post-verification failed/);
  await db.exec('ROLLBACK');assert.deepEqual(await snapshot(db),baseline);
  assert.deepEqual((await db.query('SELECT * FROM mutation_audit')).rows,[]);
 }finally{await db.close();}
});
