// SQL handoff only. Existing Phase 3 trigger owns CEFR allocation. No new permanent schema.
import { digest, prepareCtw, type CtwPublication } from "./incremental.ts";

export const CTW_CANONICAL_SQL = `select coalesce(jsonb_agg(canonical.item order by (canonical.item->>'sourceItemId') collate "C"),'[]'::jsonb) from (
 select jsonb_build_object('sourceItemId',i.logical_item_id,
  'paragraphs',coalesce((select jsonb_agg(jsonb_build_object('paragraphId',p.paragraph_id,'paragraphOrder',p.paragraph_order) order by p.paragraph_order)
    from public.reading_ctw_paragraphs p where p.question_id=q.question_id),'[]'::jsonb),
  'segments',coalesce((select jsonb_agg(jsonb_build_object('paragraphId',s.paragraph_id,'segmentOrder',s.segment_order,
    'segmentType',s.segment_type,'textContent',s.text_content,'slotId',s.slot_id) order by s.paragraph_id collate "C",s.segment_order)
    from public.reading_ctw_segments s where s.question_id=q.question_id),'[]'::jsonb),
  'slots',coalesce((select jsonb_agg(jsonb_build_object('slotId',s.slot_id,'paragraphId',s.paragraph_id,'answer',s.answer) order by s.slot_id collate "C")
    from public.reading_ctw_slots s where s.question_id=q.question_id),'[]'::jsonb)) item
 from public.reading_logical_items i
 left join public.reading_questions q on q.question_id=(select x.question_id from public.reading_questions x where x.logical_item_id=i.logical_item_id)
 where i.module='ctw'
) canonical`;

// Full known entry payload except created_at, which this tool never updates. No student records read.
export const CTW_ENTRIES_SQL = `select coalesce(jsonb_agg(to_jsonb(e)-'created_at' order by e.entry_id),'[]'::jsonb) from public.ctw_vocabulary_entries e`;
export const CTW_MEMBERSHIPS_SQL = `select coalesce(jsonb_agg(to_jsonb(m) order by m.entry_id),'[]'::jsonb) from public.ctw_vocabulary_cefr_memberships m`;
export const CTW_SNAPSHOT_SQL = `select jsonb_build_object('canonical',(${CTW_CANONICAL_SQL}),
 'entries',(${CTW_ENTRIES_SQL}),'memberships',(${CTW_MEMBERSHIPS_SQL}))`;

const literal = (value: unknown) => `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const sorted = <T extends { entry_id: string }>(rows: T[]) => [...rows].sort((a, b) => a.entry_id < b.entry_id ? -1 : 1);
function canonicalOrder(p: CtwPublication) {
  return p.plan.snapshot.canonical.map(c => ({ ...c,
    paragraphs: [...c.paragraphs].sort((a, b) => a.paragraphOrder - b.paragraphOrder),
    segments: [...c.segments].sort((a, b) => compare(a.paragraphId, b.paragraphId) || a.segmentOrder - b.segmentOrder),
    slots: [...c.slots].sort((a, b) => compare(a.slotId, b.slotId))
  })).sort((a, b) => compare(a.sourceItemId, b.sourceItemId));
}
export function buildCtwDeltaSql(p: CtwPublication) {
  if (digest(prepareCtw(p.plan, p.review)) !== digest(p)) throw new Error("Invalid CTW publication");
  const before = p.plan.snapshot;
  const after = before.entries.map(e => ({ ...e, senses: [...e.senses, ...(p.senses.find(s => s.entry_id === e.entry_id)?.senses ?? [])] })).concat(p.new_entries);
  let tag = "$ctw_delta$";
  while (JSON.stringify(p).includes(tag)) tag = tag.replace(/\$$/, "_x$");
  return `-- CTW delta ${digest(p)}. Explicit manual/CLI execution only; atomic and exact rerun is zero-write.
begin;
set local lock_timeout='10s';
set local statement_timeout='120s';
set local standard_conforming_strings=on;
select pg_advisory_xact_lock(7631044);
lock table public.ctw_vocabulary_entries in share row exclusive mode;
lock table public.ctw_vocabulary_cefr_memberships in share row exclusive mode;
lock table public.reading_logical_items,public.reading_questions,public.reading_ctw_paragraphs,
 public.reading_ctw_segments,public.reading_ctw_slots in share mode;
do ${tag}
declare pre_entries jsonb := ${literal(sorted(before.entries))};
 post_entries jsonb := ${literal(sorted(after))};
 pre_members jsonb := ${literal(sorted(before.memberships))};
 post_members jsonb := ${literal(sorted(before.memberships.concat(p.memberships)))};
 current_entries jsonb; current_members jsonb; item jsonb;
begin
 if (${CTW_CANONICAL_SQL}) is distinct from ${literal(canonicalOrder(p))} then raise exception 'CTW_CANONICAL_DRIFT'; end if;
 current_entries:=(${CTW_ENTRIES_SQL}); current_members:=(${CTW_MEMBERSHIPS_SQL});
 if current_entries=post_entries and current_members=post_members then return; end if;
 if current_entries<>pre_entries or current_members<>pre_members then raise exception 'CTW_BASELINE_DRIFT_OR_PARTIAL_IMPORT'; end if;
 if not exists(select 1 from pg_trigger where tgrelid='public.ctw_vocabulary_entries'::regclass
   and tgname='ctw_vocabulary_append_cefr' and tgenabled='O') then raise exception 'CTW_PHASE3_APPEND_TRIGGER_REQUIRED'; end if;
 for item in select value from jsonb_array_elements(${literal(p.senses)}) loop
   update public.ctw_vocabulary_entries set senses=senses || (item->'senses') where entry_id=(item->>'entry_id')::uuid;
 end loop;
 for item in select value from jsonb_array_elements(${literal(p.new_entries)}) loop
   insert into public.ctw_vocabulary_entries(entry_id,word,list_number,list_position,cefr,senses,irregular_forms,source_sha256)
   values((item->>'entry_id')::uuid,item->>'word',(item->>'list_number')::integer,(item->>'list_position')::smallint,
     item->>'cefr',item->'senses',item->'irregular_forms',item->>'source_sha256');
 end loop;
 if (${CTW_ENTRIES_SQL})<>post_entries or (${CTW_MEMBERSHIPS_SQL})<>post_members then raise exception 'CTW_POST_VERIFY_FAILED'; end if;
end
${tag};
commit;
`;
}
