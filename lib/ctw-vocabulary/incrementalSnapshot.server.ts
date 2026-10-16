import { digest, validateSnapshot, type CtwSnapshot } from "./incremental.ts";

type ReadOnlyClient = { from: (table: string) => any };
type Row = Record<string, any>;
const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** API-only read fallback: no DB URL is needed for preparation/Verify. Never reads student tables/assets. */
export async function readCtwSnapshotViaApi(db: ReadOnlyClient): Promise<CtwSnapshot> {
  async function pages(table: string, columns: string, order: string[], ctw = false): Promise<Row[]> {
    const rows: Row[] = [], seen = new Set<string>();
    for (let offset = 0; ; offset += 1000) {
      let q = db.from(table).select(columns).range(offset, offset + 999);
      if (ctw) q = q.eq("module", "ctw");
      for (const key of order) q = q.order(key, { ascending: true });
      const { data, error } = await q;
      if (error || !Array.isArray(data)) throw new Error(`CTW snapshot read failed: ${table}`);
      for (const row of data) {
        if (order.some(key => row[key] === undefined || row[key] === null)) throw new Error(`Malformed CTW snapshot primary key: ${table}`);
        const identity = JSON.stringify(order.map(key => row[key]));
        if (seen.has(identity)) throw new Error(`Duplicate/non-advancing CTW snapshot page: ${table}`);
        seen.add(identity);
      }
      rows.push(...data);
      if (data.length < 1000) return rows;
    }
  }
  async function capture(): Promise<CtwSnapshot> {
    const [items, questions, paragraphs, segments, slots, entries, memberships] = await Promise.all([
      pages("reading_logical_items", "logical_item_id,module", ["logical_item_id"], true),
      pages("reading_questions", "question_id,logical_item_id,module", ["question_id"], true),
      pages("reading_ctw_paragraphs", "question_id,paragraph_id,paragraph_order", ["question_id", "paragraph_id"]),
      pages("reading_ctw_segments", "question_id,paragraph_id,segment_order,segment_type,text_content,slot_id", ["question_id", "paragraph_id", "segment_order"]),
      pages("reading_ctw_slots", "question_id,slot_id,paragraph_id,answer", ["question_id", "slot_id"]),
      pages("ctw_vocabulary_entries", "entry_id,word,normalized_word,list_number,list_position,cefr,senses,irregular_forms,source_sha256", ["entry_id"]),
      pages("ctw_vocabulary_cefr_memberships", "entry_id,cefr_group,list_number,list_position", ["entry_id"])
    ]);
    const canonical = items.map(item => {
      const qs = questions.filter(q => q.logical_item_id === item.logical_item_id);
      if (qs.length !== 1) throw new Error("CTW item must have exactly one canonical question");
      const id = qs[0].question_id;
      return { sourceItemId: item.logical_item_id,
        paragraphs: paragraphs.filter(p => p.question_id === id).sort((a, b) => a.paragraph_order - b.paragraph_order)
          .map(p => ({ paragraphId: p.paragraph_id, paragraphOrder: p.paragraph_order })),
        segments: segments.filter(s => s.question_id === id).sort((a, b) => compare(a.paragraph_id, b.paragraph_id) || a.segment_order - b.segment_order)
          .map(s => ({ paragraphId: s.paragraph_id, segmentOrder: s.segment_order, segmentType: s.segment_type, textContent: s.text_content, slotId: s.slot_id })),
        slots: slots.filter(s => s.question_id === id).sort((a, b) => compare(a.slot_id, b.slot_id))
          .map(s => ({ slotId: s.slot_id, paragraphId: s.paragraph_id, answer: s.answer }))
      };
    }).sort((a, b) => compare(a.sourceItemId, b.sourceItemId));
    return { canonical, entries, memberships } as CtwSnapshot;
  }
  // REST has no multi-request transaction. Require two stable, fully paginated observations;
  // the import transaction still repeats the authoritative exact gate under database locks.
  const first = await capture(), second = await capture();
  if (digest(first) !== digest(second)) throw new Error("CTW snapshot drift across API captures; retry without replacing a plan");
  validateSnapshot(second);
  return second;
}
