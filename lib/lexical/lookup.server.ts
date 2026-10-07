import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalSourceTextHash } from "./hash.ts";
import { lexicalSelectionBounds, matchLexicalSelection, type LexicalLookupRequest, type LexicalLookupOccurrence } from "./lookup.ts";
import { rapSentenceInsertionInstruction, rapSentenceSelectionStem } from "../reading/rapInteraction.ts";

type Row = Record<string, any>;
export type LexicalPageReaders = {
  fullSetAttempt: (attemptId: string) => Promise<{ attempt: null | { status: string; completedAt: string | null }; error: unknown }>;
  writingAttempt: (attemptId: string) => Promise<{ data: Row | null; error: unknown }>;
  writingQuestion: (attempt: Row) => Promise<{ data: Row | null; error: unknown; questionSource: string | null; assignmentAvailable?: boolean }>;
  basFinalVisible: (attempt: Row, answer: Row) => boolean;
};
export class LexicalAccessError extends Error {
  status: number;
  constructor(status = 403) { super("当前页面不可查词。"); this.status = status; }
}
async function one(query: PromiseLike<{ data: any; error: any }>): Promise<Row> {
  const { data, error } = await query;
  if (error) throw new Error("Lexical source query failed");
  if (!data) throw new LexicalAccessError();
  return data;
}
const reject = (ok: unknown) => { if (!ok) throw new LexicalAccessError(); };

/** All service-role corpus reads happen only after this owned-page authorization. */
export async function authorizeLexicalSource(client: SupabaseClient, db: SupabaseClient, userId: string, r: LexicalLookupRequest, readers: LexicalPageReaders) {
  if (r.access.kind === "reading" || r.access.kind === "reading_wrongbook" || r.access.kind === "full_set") {
    reject(["ctw", "rdl", "rap"].includes(r.sourceType) && r.sourceItemId);
    if (r.access.kind === "reading") {
      const a = await one(client.from("reading_attempts").select("logical_item_id,task_type,status,submitted_at")
        .eq("attempt_id", r.access.attemptId).eq("student_id", userId).maybeSingle());
      if (a.status !== "submitted" || !a.submitted_at) throw new LexicalAccessError(409);
      reject(a.logical_item_id === r.sourceItemId && a.task_type === r.sourceType);
    } else if (r.access.kind === "reading_wrongbook") {
      const a = await one(client.from("reading_wrongbook_attempts").select("logical_item_id,task_type,status,submitted_at,targets")
        .eq("attempt_id", r.access.attemptId).eq("student_id", userId).maybeSingle());
      if (a.status !== "submitted" || !a.submitted_at) throw new LexicalAccessError(409);
      const targets = Array.isArray(a.targets) ? a.targets as Row[] : [];
      const questionBlock = /^question:([^:]+):/.exec(r.contentBlockId);
      if (a.task_type === "full_set") reject(targets.some(t => t.logicalItemId === r.sourceItemId && t.taskType === r.sourceType
        && (!questionBlock || t.questionId === questionBlock[1])));
      else reject(a.logical_item_id === r.sourceItemId && a.task_type === r.sourceType
        && (!questionBlock || targets.some(t => t.questionId === questionBlock[1])));
    } else {
      const owned = await readers.fullSetAttempt(r.access.attemptId);
      reject(!owned.error && owned.attempt);
      if (owned.attempt!.status !== "completed" || !owned.attempt!.completedAt) throw new LexicalAccessError(409);
      const modules = await db.from("reading_full_set_module_attempts").select("module_attempt_id").eq("attempt_id", r.access.attemptId);
      if (modules.error) throw new Error("Full Set module query failed");
      reject(modules.data?.length === 2);
      let membership = db.from("reading_full_set_answers").select("answer_id")
        .in("module_attempt_id", modules.data!.map(m => m.module_attempt_id)).eq("logical_item_id", r.sourceItemId!);
      const questionBlock = /^question:([^:]+):/.exec(r.contentBlockId);
      if (questionBlock) membership = membership.eq("question_id", questionBlock[1]);
      await one(membership.limit(1).maybeSingle());
    }
    const item = await one(db.from("reading_logical_items").select("module").eq("logical_item_id", r.sourceItemId!).maybeSingle());
    reject(item.module === r.sourceType);
    const block = await readingBlockText(db, r);
    if (typeof block === "string") return { sourceItemId: r.sourceItemId!, contentBlockId: r.contentBlockId, text: block };
    reject(block.visibleText === r.blockText);
    return { sourceItemId: r.sourceItemId!, contentBlockId: r.contentBlockId, text: block.text,
      selection: { blockText: block.text, startOffset: block.baseOffset + r.startOffset, endOffset: block.baseOffset + r.endOffset,
        selectedText: r.selectedText } };
  }
  if (r.access.kind === "writing") {
    const result = await readers.writingAttempt(r.access.attemptId);
    reject(!result.error && result.data);
    const a = result.data!;
    reject(r.sourceType === (a.task_type === "email" ? "write_email" : "academic_discussion"));
    reject(a.status === "draft" || a.status === "submitted");
    const visible = await readers.writingQuestion(a);
    reject(!visible.error && visible.data && visible.questionSource === "question_bank");
    if (a.status === "draft") reject(visible.assignmentAvailable !== false);
    const source = await one(db.from("practice_item_sources").select("item_id,source_question_id")
      .eq("task_type", a.task_type).eq("source_question_id", a.question_id).eq("is_canonical", true).maybeSingle());
    reject(!r.sourceItemId || r.sourceItemId === source.item_id);
    const fields: Record<string, string> = a.task_type === "email"
      ? { scenario: "scenario", "task-instruction": "task_instruction", "requirement:1": "requirement_1", "requirement:2": "requirement_2", "requirement:3": "requirement_3", subject: "subject" }
      : { "professor-prompt": "professor_prompt", "student-response:1": "student_1_response", "student-response:2": "student_2_response" };
    const field = fields[r.contentBlockId]; reject(field);
    // A stale/custom snapshot never becomes a second corpus: current visible text must match the frozen hash below.
    return { sourceItemId: String(source.item_id), contentBlockId: r.contentBlockId, text: (visible.data as unknown as Row)[field] as string };
  }
  reject((r.access.kind === "bas" || r.access.kind === "bas_prompt") && r.sourceType === "bas" && r.access.questionId);
  if (r.access.kind !== "bas_prompt") {
    const a = await one(db.from("attempts").select("set_id,submitted_at").eq("attempt_id", r.access.attemptId).eq("student_id", userId).maybeSingle());
    reject(a.submitted_at);
    const answer = await one(db.from("attempt_answers").select("question_id,is_correct").eq("attempt_id", r.access.attemptId).eq("question_id", r.access.questionId!).maybeSingle());
    if (r.contentBlockId === "final-sentence") reject(readers.basFinalVisible(a, answer));
  }
  const raw = await one(db.from("questions").select("set_id,prompt,final_sentence").eq("question_id", r.access.questionId!).maybeSingle());
  if (r.access.kind === "bas_prompt") reject(raw.set_id === r.access.setId && r.contentBlockId === "prompt");
  const sources = await db.from("practice_item_sources").select("source_id,item_id").eq("task_type", "build_sentence").eq("source_set_id", raw.set_id).eq("is_canonical", true);
  if (sources.error) throw new Error("BAS source query failed");
  reject(sources.data?.length);
  const mapping = await one(db.from("practice_item_question_map").select("source_id,logical_question_order")
    .in("source_id", sources.data!.map(s => s.source_id)).eq("source_question_id", r.access.questionId!).maybeSingle());
  const source = sources.data!.find(s => s.source_id === mapping.source_id)!;
  reject(!r.sourceItemId || r.sourceItemId === source.item_id);
  reject(r.contentBlockId === "prompt" || r.contentBlockId === "final-sentence");
  return { sourceItemId: String(source.item_id), contentBlockId: `question:q${String(mapping.logical_question_order).padStart(2,"0")}:${r.contentBlockId}`,
    text: r.contentBlockId === "prompt" ? raw.prompt : raw.final_sentence };
}

async function readingBlockText(db: SupabaseClient, r: LexicalLookupRequest): Promise<string | { text: string; visibleText: string; baseOffset: number }> {
  const id = r.contentBlockId;
  if (r.sourceType === "ctw" && id.startsWith("paragraph:")) {
    const paragraphId = id.slice(10);
    const p = await one(db.from("reading_ctw_paragraphs").select("question_id").eq("paragraph_id", paragraphId).maybeSingle());
    await one(db.from("reading_questions").select("question_id").eq("question_id", p.question_id).eq("logical_item_id", r.sourceItemId!).eq("module", "ctw").maybeSingle());
    const [segments, slots] = await Promise.all([
      db.from("reading_ctw_segments").select("segment_type,text_content,slot_id,segment_order").eq("paragraph_id", paragraphId).order("segment_order"),
      db.from("reading_ctw_slots").select("slot_id,answer").eq("paragraph_id", paragraphId)
    ]);
    if (segments.error || slots.error) throw new Error("CTW block query failed");
    const answers = new Map((slots.data ?? []).map(s => [s.slot_id, s.answer]));
    let text = ""; let projection: { visibleText: string; baseOffset: number } | undefined;
    (segments.data ?? []).forEach((s, segmentIndex) => {
      const value = String(s.segment_type === "text" ? s.text_content ?? "" : answers.get(s.slot_id) ?? "");
      if (r.ctwAnchor && (r.ctwAnchor.kind === "text" ? s.segment_type === "text" && segmentIndex === r.ctwAnchor.segmentIndex
        : s.segment_type === "blank" && s.slot_id === r.ctwAnchor.slotId)) projection = { visibleText: value, baseOffset: text.length };
      text += value;
    });
    if (r.ctwAnchor) { reject(projection); return { text, ...projection! }; }
    return text;
  }
  if (r.sourceType === "rdl" && id.startsWith("material:")) {
    const materialId = id.slice(9);
    await one(db.from("reading_questions").select("question_id").eq("logical_item_id", r.sourceItemId!)
      .eq("module", "rdl").eq("material_id", materialId).limit(1).maybeSingle());
    const material = await one(db.from("reading_materials").select("binding_status,image_asset_path,hitbox_data_path")
      .eq("material_id", materialId).maybeSingle());
    reject(material.binding_status === "bound" && material.image_asset_path && material.hitbox_data_path);
    // The page already verifies the existing image/selection-map binding. Never re-download
    // the image per selection: the corpus block hash below independently verifies the exact text.
    return r.blockText;
  }
  if (r.sourceType === "rap" && id.startsWith("passage:")) {
    const match = /^passage:([^:]+):paragraph:([^:]+)$/.exec(id); reject(match);
    await one(db.from("reading_passages").select("passage_id").eq("passage_id", match![1]).eq("logical_item_id", r.sourceItemId!).maybeSingle());
    const p = await one(db.from("reading_passage_paragraphs").select("paragraph_text").eq("passage_id", match![1]).eq("paragraph_id", match![2]).maybeSingle());
    return p.paragraph_text;
  }
  const match = /^question:([^:]+):(stem|instruction|insert-sentence|option:([^:]+))$/.exec(id); reject(match);
  const q = await one(db.from("reading_questions").select("stem,question_type,insert_sentence")
    .eq("question_id", match![1]).eq("logical_item_id", r.sourceItemId!).eq("module", r.sourceType).maybeSingle());
  if (match![2] === "instruction" || match![2] === "insert-sentence") {
    reject(q.question_type === "rap_sentence_insertion");
    return match![2] === "instruction" ? rapSentenceInsertionInstruction() : q.insert_sentence;
  }
  reject(q.question_type !== "rap_sentence_insertion");
  if (match![3]) {
    reject(q.question_type === "rdl" || q.question_type === "rap_multiple_choice");
    return (await one(db.from("reading_question_options").select("option_text").eq("question_id", match![1]).eq("option_id", match![3]).maybeSingle())).option_text;
  }
  return q.question_type === "rap_sentence_selection" ? rapSentenceSelectionStem(q.stem) : q.stem;
}

export async function lookupAuthorizedSelection(db: SupabaseClient, r: LexicalLookupRequest,
  authorized: { sourceItemId: string; contentBlockId: string; text: string;
    selection?: Pick<LexicalLookupRequest, "blockText" | "startOffset" | "endOffset" | "selectedText"> }) {
  const selection = { ...r, ...authorized.selection };
  if (authorized.text !== selection.blockText || selection.blockText.slice(selection.startOffset, selection.endOffset) !== selection.selectedText) return { status: "unavailable" as const };
  const block = await db.from("lexical_source_blocks").select("source_text_hash,generation_status")
    .eq("source_type", r.sourceType).eq("source_item_id", authorized.sourceItemId).eq("content_block_id", authorized.contentBlockId).maybeSingle();
  if (block.error) throw new Error("Lexical block query failed");
  if (!block.data || block.data.generation_status !== "generated" || block.data.source_text_hash !== canonicalSourceTextHash(authorized.text)) return { status: "unavailable" as const };
  // One bounded join for overlapping candidate spans, not all occurrences or N+1 entry reads.
  const bounds = lexicalSelectionBounds(selection.selectedText);
  const { data, error } = await db.from("lexical_occurrences")
    .select("occurrence_id,entry_id,source_type,source_item_id,content_block_id,start_offset,end_offset,surface_text,context_pos,context_meaning_zh,context_definition_en,lexical_entries!inner(entry_id,canonical_expression,normalized_expression,expression_type,lemma)")
    .eq("source_type", r.sourceType).eq("source_item_id", authorized.sourceItemId).eq("content_block_id", authorized.contentBlockId)
    .lte("start_offset", selection.startOffset + bounds.start).gte("end_offset", selection.startOffset + bounds.end)
    .neq("review_status", "disabled").neq("lexical_entries.review_status", "disabled")
    .order("start_offset", { ascending: false }).order("end_offset", { ascending: true }).limit(32);
  if (error) throw new Error("Lexical occurrence query failed");
  return matchLexicalSelection((data ?? []) as unknown as LexicalLookupOccurrence[], { ...selection, sourceItemId: authorized.sourceItemId, contentBlockId: authorized.contentBlockId });
}
