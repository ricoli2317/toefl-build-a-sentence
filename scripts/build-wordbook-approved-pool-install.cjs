// OFFLINE delivery generation only: no database/client/env/source fetch/browser.
// Frozen final493 input, no approval archive or duplicate CSV required.
const fs=require('node:fs'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const read=p=>fs.readFileSync(p,'utf8'),json=p=>JSON.parse(read(p));
const hash=p=>crypto.createHash('sha256').update(read(p)).digest('hex');
const prefix='supabase/student_wordbook_review_v1_';
const dataset='data/wordbook-review/fixed-pool-v2.full-review.json';
const datasetSha256='b94b9fd17d02d8a7b91125eba803a1f3181b9d86b26401f512ca09f4aa14b352';
// Original seed/bundle metadata is immutable; this is not new approval.
const approvedOn='2026-10-09';
const pool=json(dataset),tags=json('data/wordbook-review/fixed-pool-v2.preference-tags.json');
assert.equal(hash(dataset),datasetSha256);assert.equal(pool.length,493);
const expectedCounts={noun:150,verb:120,adjective:100,adverb:60,preposition:27,conjunction:16,pronoun:20};
const counts=Object.fromEntries(Object.keys(expectedCounts).map(pos=>[pos,pool.filter(r=>r.pos===pos).length]));
assert.deepEqual(counts,expectedCounts);assert.equal(tags.length,pool.length);
const columns=['pool_id','pos','english','normalized_expression','meaning','raw_pos','canonical_entry_id','occurrence_id',
 'source_type','source_item_id','content_block_id','definition_en','revision','approved'];
const revision='fixed-v2-approved-493-20261009';
const approved=pool.map(r=>({...Object.fromEntries(columns.slice(0,12).map(k=>[k,r[k]])),revision,approved:true}));
assert.equal(new Set(approved.map(r=>r.pool_id)).size,493);
const expected=approved.map(r=>{
 const tag=tags.find(t=>t.pool_id===r.pool_id);assert.ok(tag);
 for(const k of ['canonical_entry_id','normalized_expression','pos','meaning'])assert.equal(tag[k],r[k]);
 return {...r,lexical_category:tag.lexical_category,subject:tag.subject,noun_kind:tag.noun_kind};
});
const literal=x=>x==null?'null':typeof x==='boolean'?String(x):"'"+String(x).replaceAll("'","''")+"'";
// Remove ONLY outer line-level transaction controls/results, not PL/pgSQL BEGIN.
function body(text){assert.equal((text.match(/^begin(?: transaction read only)?;$/gmi)||[]).length,1);
 assert.equal((text.match(/^commit;$/gmi)||[]).length,1);
 return text.replace(/^begin(?: transaction read only)?;\n/gmi,'').replace(/^commit;\n/gmi,'')
  .replace(/^select '[^']+' as result;\n/gm,'');}
const preflight=`-- USER-MANUAL READ ONLY: expected already-installed ASCII/local-POS baseline.
-- Metadata only. Does NOT inspect students or create review sessions.
begin transaction read only;
do $empty$
begin
 if to_regclass('public.wordbook_review_fixed_distractors') is not null then
  raise exception 'REVIEW_V2_PREFLIGHT_FIXED_POOL_ALREADY_PRESENT_STOP_AND_INSPECT'; end if;
end;
$empty$;
${body(read(prefix+'ascii_distractor_verify.sql'))}
commit;
select 'WORDBOOK_FIXED_POOL_V2_PREFLIGHT_OK' as result;
`;
const seed=`-- USER-APPROVED exact 493-row V2 pool; USER-MANUAL installation only.
-- Approval date: ${approvedOn}; immutable review JSON SHA256: ${datasetSha256}
-- Requires fixed_pool migration. Only an EMPTY table is accepted.
-- No DELETE/TRUNCATE/UPSERT, dictionary writes, students or historical changes.
begin;
set transaction isolation level repeatable read;
set local lock_timeout='5s';
lock table public.wordbook_review_fixed_distractors in share row exclusive mode;
do $guard$
begin
 if exists(select 1 from public.wordbook_review_fixed_distractors) then
  raise exception 'REVIEW_V2_SEED_REQUIRES_EMPTY_POOL_NO_OVERWRITE'; end if;
 if not exists(select 1 from pg_proc where oid=to_regprocedure('public.wordbook_review_candidates(uuid,text,text[],timestamp with time zone,timestamp with time zone)')
  and md5(btrim(replace(prosrc,E'\\r\\n',E'\\n'),E' \\t\\r\\n'))='b210f1a05fbea67b249faf81b57d857e') then
  raise exception 'REVIEW_V2_SEED_FIXED_POOL_BASELINE_REQUIRED'; end if;
end;
$guard$;
create temporary table wordbook_approved_v2_seed on commit drop as
 select ${columns.join(',')} from public.wordbook_review_fixed_distractors with no data;
insert into wordbook_approved_v2_seed (${columns.join(',')}) values
${approved.map(r=>'('+columns.map(k=>literal(r[k])).join(',')+')').join(',\n')};
-- Lock only the referenced dictionary rows against concurrent update/delete.
-- Source validation is installation-only, never a runtime distractor query.
do $source$
begin
 perform o.occurrence_id from wordbook_approved_v2_seed f
  join public.lexical_occurrences o on o.occurrence_id=f.occurrence_id
  join public.lexical_entries e on e.entry_id=f.canonical_entry_id
  order by o.occurrence_id,e.entry_id for share of o,e;
 if exists(select 1 from wordbook_approved_v2_seed f
  left join public.lexical_occurrences o on o.occurrence_id=f.occurrence_id
  left join public.lexical_entries e on e.entry_id=f.canonical_entry_id
  where o.occurrence_id is null or e.entry_id is null
   or o.entry_id is distinct from f.canonical_entry_id or btrim(o.context_meaning_zh) is distinct from f.meaning
   or o.context_pos is distinct from f.raw_pos or o.context_definition_en is distinct from f.definition_en
   or o.source_type is distinct from f.source_type or o.source_item_id is distinct from f.source_item_id
   or o.content_block_id is distinct from f.content_block_id or o.review_status is distinct from 'generated'
   or e.review_status is distinct from 'generated' or e.canonical_expression is distinct from f.english
   or e.normalized_expression is distinct from f.normalized_expression or e.expression_type is distinct from 'word'
   or e.identity_variant is distinct from '') then raise exception 'REVIEW_V2_SEED_SOURCE_CHANGED_OR_MISSING'; end if;
 if (select count(*) from wordbook_approved_v2_seed)<>493
  or (select count(distinct pool_id) from wordbook_approved_v2_seed)<>493
  or exists(select 1 from (values ${Object.entries(counts).map(([pos,n])=>`('${pos}',${n})`).join(',')}) expected(pos,n)
   where expected.n<>(select count(*) from wordbook_approved_v2_seed f where f.pos=expected.pos)) then
  raise exception 'REVIEW_V2_SEED_COUNT_MISMATCH'; end if;
end;
$source$;
insert into public.wordbook_review_fixed_distractors (${columns.join(',')})
 select ${columns.join(',')} from wordbook_approved_v2_seed;
do $counts$
begin
 if (select count(*) from public.wordbook_review_fixed_distractors)<>493
  or exists(select 1 from public.wordbook_review_fixed_distractors where not approved or revision<>${literal(revision)}) then
  raise exception 'REVIEW_V2_SEED_POSTCONDITION_FAILED'; end if;
end;
$counts$;
commit;
select 'WORDBOOK_FIXED_POOL_V2_SEED_493_OK' as result;
`;
fs.writeFileSync(prefix+'fixed_pool_v2_seed_APPROVED.sql',seed);
const delimiter='$approved_v2_expected$';assert.ok(!JSON.stringify(expected).includes(delimiter));
const verify=`-- USER-MANUAL READ ONLY final preference + exact approved 493 rows/labels.
-- Checks stored provenance snapshots, not an occurrence query/teaching acceptance.
-- Reviewed dataset SHA256: ${datasetSha256}
begin transaction read only;
${body(read(prefix+'choice_preference_verify.sql'))}
do $exact$
declare expected jsonb:=${delimiter}${JSON.stringify(expected)}${delimiter}::jsonb;
begin
 if jsonb_array_length(expected)<>493 or (select count(*) from public.wordbook_review_fixed_distractors)<>493
  or exists(select 1 from jsonb_array_elements(expected) x(value)
   left join public.wordbook_review_fixed_distractors f on f.pool_id=(x.value->>'pool_id')::uuid
   where f.pool_id is null or not (to_jsonb(f) @> x.value)) then
  raise exception 'REVIEW_V2_FINAL_APPROVED_DATA_OR_LABEL_DRIFT'; end if;
 if not has_table_privilege('service_role','public.wordbook_review_fixed_distractors','SELECT')
  or has_table_privilege('service_role','public.wordbook_review_fixed_distractors','INSERT')
  or has_table_privilege('service_role','public.wordbook_review_fixed_distractors','DELETE')
  or has_table_privilege('service_role','public.wordbook_review_fixed_distractors','TRUNCATE') then
  raise exception 'REVIEW_V2_FINAL_POOL_ACL_DRIFT'; end if;
end;
$exact$;
select pos,count(*) as approved_count from public.wordbook_review_fixed_distractors group by pos order by pos;
commit;
select 'WORDBOOK_FIXED_POOL_V2_PRODUCTION_VERIFY_OK' as result;
`;
fs.writeFileSync(prefix+'fixed_pool_v2_production_verify.sql',verify);
const stages=['fixed_pool_v2_preflight.sql','fixed_pool_migration.sql','fixed_pool_verify.sql','fixed_pool_v2_seed_APPROVED.sql',
 'choice_preference_migration.sql','choice_preference_tags.sql','fixed_pool_v2_production_verify.sql'];
// Source seed SET TRANSACTION must be the first command, so move it to outer BEGIN.
// Stage 1 remains embedded, byte-identical to the installed atomic bundle.
// Its historical filename is a stage identifier, not an external file dependency.
const stageBody=stage=>body(stage===stages[0]?preflight:read(prefix+stage)).replace(/^set transaction isolation level repeatable read;\n/gmi,'');
const bundle=`-- RECOMMENDED USER-MANUAL atomic install from existing ASCII/local-POS V1.
-- User approved exact 493 pool on ${approvedOn}. Review SHA256: ${datasetSha256}
-- Entire file must run as ONE script/transaction by database owner.
-- If anything fails: ROLLBACK; fix/inspect actual error before retry.
-- Do NOT execute both this bundle and its standalone component installers.
-- Empty-table-only. No rejected492 seed, original V1 cleanup or student writes.
begin;
set transaction isolation level repeatable read;
set local lock_timeout='5s';
${stages.map((s,i)=>`-- DEPENDENCY STAGE ${i+1}: ${prefix+s}\n${stageBody(s)}`).join('\n')}
commit;
select 'WORDBOOK_FIXED_POOL_V2_ATOMIC_INSTALL_OK' as result;
`;
fs.writeFileSync(prefix+'fixed_pool_v2_install.sql',bundle);
// Active checksum/dependency manifest, not an approval or installation-status archive.
const manifest={formatVersion:1,revision,dataset,approvedDatasetSha256:datasetSha256,total:493,byPos:counts,
  recommendedAtomicInstaller:prefix+'fixed_pool_v2_install.sql',standaloneDependencyOrder:stages.slice(1).map(s=>prefix+s),
  files:Object.fromEntries([prefix+'fixed_pool_v2_install.sql',...stages.slice(1).map(s=>prefix+s),
   prefix+'ascii_distractor_verify.sql',prefix+'choice_preference_verify.sql',dataset,
   'data/wordbook-review/fixed-pool-v2.preference-tags.json'].map(p=>[p,{sha256:hash(p),bytes:fs.statSync(p).size}]))};
fs.writeFileSync('data/wordbook-review/fixed-pool-v2.install-manifest.json',JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({total:manifest.total,byPos:counts,revision,bundleBytes:fs.statSync(manifest.recommendedAtomicInstaller).size,
  approvedDatasetUnchanged:hash(dataset)===datasetSha256,productionSqlExecuted:false},null,2));
