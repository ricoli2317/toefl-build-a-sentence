// OFFLINE supplemental labels only. Never changes the 493 word/meaning/source
// rows or original approvals. Runtime NEVER infers labels from these word lists.
const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const text=fs.readFileSync('data/wordbook-review/fixed-pool-v2.full-review.json','utf8'),pool=JSON.parse(text);
assert.equal(crypto.createHash('sha256').update(text).digest('hex'),'b94b9fd17d02d8a7b91125eba803a1f3181b9d86b26401f512ca09f4aa14b352');
// Explicitly reviewed option meanings. Concrete = identifiable material/object,
// organism/place; abstract = concept/relation/process; other = mixed senses,
// discipline or classifications not reliably described by either simple kind.
const concrete=new Set(`enzyme crust glacier asteroid artifact inscription pottery semiconductor sample institution protein neuron hormone habitat predator wetland sediment fossil fault mantle delta galaxy empire sculpture sensor processor gene mineral atmosphere`.split(' '));
const other=new Set(`evidence component entity resource ecosystem archaeology heritage architecture`.split(' '));
const abstract=new Set(`mutation photosynthesis biodiversity symbiosis resilience erosion supernova gravity dynasty hierarchy colonization perspective patronage realism cognition inference intuition algorithm simulation paradigm correlation methodology assumption constraint implication conclusion analysis observation experiment variable theory framework procedure measurement accuracy reliability bias interpretation mechanism argument consensus controversy uncertainty probability significance criterion analogy category structure dimension distribution pattern sequence scope principle function context phenomenon factor complexity diversity variation transition emergence expansion decline fluctuation continuity stability equilibrium cycle interaction integration displacement assessment estimate exception limitation capacity potential efficiency drawback priority outcome contribution strategy solution incentive cooperation ownership dependency metabolism respiration extinction orbit wavelength fusion excavation domestication chronology civilization monarchy urbanization motif genre choreography imagery stimulus perception motivation consciousness laser friction`.split(' '));
const rows=pool.map(r=>{
 let noun_kind=null;
 if(r.pos==='noun'){const groups=[concrete,other,abstract].filter(s=>s.has(r.english));assert.equal(groups.length,1,'Explicit noun tag missing/overlap '+r.english);
  noun_kind=concrete.has(r.english)?'concrete':other.has(r.english)?'other':'abstract';}
 return {pool_id:r.pool_id,canonical_entry_id:r.canonical_entry_id,normalized_expression:r.normalized_expression,pos:r.pos,meaning:r.meaning,
  lexical_category:['通用学术','学科专业'].includes(r.lexical_category)?r.lexical_category:null,
  subject:['通用学术','学科专业'].includes(r.lexical_category)?r.subject:null,noun_kind,
  label_status:'REVIEW_SORTING_HINT_NOT_ELIGIBILITY',label_basis:r.pos==='noun'?'按该中文义显式预标注；不在运行时推测':'复用现有493条类别/学科标签'};
});
assert.equal(concrete.size+other.size+abstract.size,150);
fs.writeFileSync('data/wordbook-review/fixed-pool-v2.preference-tags.json',JSON.stringify(rows,null,2)+'\n');
const fields=['pool_id','canonical_entry_id','normalized_expression','pos','meaning','lexical_category','subject','noun_kind','label_basis'];
const literal=x=>x==null?'null':"'"+String(x).replaceAll("'","''")+"'";
fs.writeFileSync('supabase/student_wordbook_review_v1_choice_preference_tags.sql',`-- USER-MANUAL optional labels ONLY; NEVER inserts or approves pool meanings.
-- Apply AFTER choice_preference_migration and AFTER the separately approved
-- exact 493-row V2 pool exists. Empty/old/different pools fail, no partial update.
begin;
set local lock_timeout='5s';
lock table public.wordbook_review_fixed_distractors in share row exclusive mode;
create temporary table review_preference_tags on commit drop as select pool_id,canonical_entry_id,normalized_expression,pos,meaning,
 lexical_category,subject,noun_kind from public.wordbook_review_fixed_distractors with no data;
insert into review_preference_tags (${fields.slice(0,8).join(',')}) values
${rows.map(r=>'('+fields.slice(0,8).map(k=>literal(r[k])).join(',')+')').join(',\n')};
do $guard$
begin
 if (select count(*) from public.wordbook_review_fixed_distractors)<>493
  or exists(select 1 from review_preference_tags t left join public.wordbook_review_fixed_distractors f on f.pool_id=t.pool_id
    where f.pool_id is null or (f.canonical_entry_id,f.normalized_expression,f.pos,f.meaning) is distinct from
      (t.canonical_entry_id,t.normalized_expression,t.pos,t.meaning)) then
   raise exception 'REVIEW_PREFERENCE_EXACT_V2_POOL_REQUIRED'; end if;
end;
$guard$;
update public.wordbook_review_fixed_distractors f set lexical_category=t.lexical_category,subject=t.subject,noun_kind=t.noun_kind
 from review_preference_tags t where f.pool_id=t.pool_id;
commit;
select 'WORDBOOK_CHOICE_PREFERENCE_TAGS_OK' as result;
`);
console.log(JSON.stringify({rows:rows.length,nounKinds:{abstract:abstract.size,concrete:concrete.size,other:other.size},originalPoolUnchanged:true},null,2));
