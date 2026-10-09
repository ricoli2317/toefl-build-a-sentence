import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalSourceTextHash } from "./hash.ts";
import { lexicalSelectionBounds, matchLexicalSelection, type LexicalLookupRequest, type LexicalLookupOccurrence } from "./lookup.ts";
import { rapSentenceInsertionInstruction, rapSentenceSelectionStem } from "../reading/rapInteraction.ts";
import { loadTeacherScope } from "../teacherScope.server.ts";
import { isActiveStudent, type AccountActor } from "../accountAccess.ts";
import { loadPublicCanonicalPracticeSource } from "../practicePublicUniverse.ts";
import { loadAuthorizedWritingReviewSource } from "../writingReviewWorkspaceServer.ts";
import { readWritingQuestionForReview } from "../writingReviewSource.ts";
import { readAllSupabaseRows } from "../supabasePagination.ts";

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

/** Corpus reads follow owned-page or explicitly authorized teaching-page access. */
export async function authorizeLexicalSource(client: SupabaseClient, db: SupabaseClient, userId: string, r: LexicalLookupRequest, readers: LexicalPageReaders,
  lookupActor?: AccountActor) {
  // Only Lookup passes a trusted actor. Wordbook's unchanged call cannot grant
  // teacher access, even when a caller submits a valid teacher lookup request.
  const teacher = r.teacherReadonly === true;
  reject(!teacher || (lookupActor?.role === "teacher" && lookupActor.userId === userId));
  reject(teacher || (r.access.kind !== "teacher_bank" && !r.access.studentId && !r.access.sessionId));
  const bankAccess = r.access.kind === "teacher_bank" || (teacher && r.access.kind === "bas_prompt");
  const itemId = r.access.kind === "teacher_bank" ? r.access.itemId : r.sourceItemId;
  let bank: Awaited<ReturnType<typeof loadPublicCanonicalPracticeSource>> = null;
  if (bankAccess) {
    reject(r.access.kind !== "bas_prompt" || r.sourceType === "bas");
    reject(itemId && (!r.sourceItemId || r.sourceItemId === itemId));
    if (!["ctw", "rdl", "rap"].includes(r.sourceType)) {
      bank = await loadPublicCanonicalPracticeSource(db, itemId!);
      reject(bank && r.sourceType === (bank.taskType === "build_sentence" ? "bas" : bank.taskType === "email" ? "write_email" : "academic_discussion"));
      if (r.sourceType === "bas") reject(bank!.canonicalQuestions?.some(q => q.questionId === r.access.questionId));
    }
  }
  const pageClient = teacher ? db : client;
  const ownerId = teacher ? r.access.studentId : userId;
  if (teacher && !bankAccess) {
    reject(ownerId);
    if (r.access.kind !== "writing") {
      const scope = await loadTeacherScope(db, lookupActor!);
      reject(scope.studentProfiles.has(ownerId!) && scope.studentDomains.get(ownerId!)?.includes(r.sourceType === "bas" ? "writing" : "reading"));
    }
  }
  if (["ctw", "rdl", "rap"].includes(r.sourceType) && (bankAccess || r.access.kind === "reading" || r.access.kind === "reading_wrongbook" || r.access.kind === "reading_category" || r.access.kind === "full_set")) {
    reject(["ctw", "rdl", "rap"].includes(r.sourceType) && r.sourceItemId);
    if (bankAccess) {
      reject(/^reading-(ctw|rdl|rap)-[a-f0-9]{24}$/.test(itemId!));
    } else if (r.access.kind === "reading") {
      const a = await one(pageClient.from("reading_attempts").select("logical_item_id,task_type,status,submitted_at")
        .eq("attempt_id", r.access.attemptId).eq("student_id", ownerId).maybeSingle());
      if (a.status !== "submitted" || !a.submitted_at) throw new LexicalAccessError(409);
      reject(a.logical_item_id === r.sourceItemId && a.task_type === r.sourceType);
    } else if (r.access.kind === "reading_wrongbook") {
      const a = await one(pageClient.from("reading_wrongbook_attempts").select("logical_item_id,task_type,status,submitted_at,targets")
        .eq("attempt_id", r.access.attemptId).eq("student_id", ownerId).maybeSingle());
      if (a.status !== "submitted" || !a.submitted_at) throw new LexicalAccessError(409);
      if (teacher) await authorizeWrongbookSession(db, ownerId!, r);
      const targets = Array.isArray(a.targets) ? a.targets as Row[] : [];
      const questionBlock = /^question:([^:]+):/.exec(r.contentBlockId);
      if (a.task_type === "full_set") reject(targets.some(t => t.logicalItemId === r.sourceItemId && t.taskType === r.sourceType
        && (!questionBlock || t.questionId === questionBlock[1])));
      else reject(a.logical_item_id === r.sourceItemId && a.task_type === r.sourceType
        && (!questionBlock || targets.some(t => t.questionId === questionBlock[1])));
    } else if (r.access.kind === "reading_category") {
      // Category has no ordinary/wrongbook attempt. The existing owner SELECT
      // policy authorizes its completed session, then its frozen source/targets.
      const a = await one(pageClient.from("reading_question_category_sessions").select("status,completed_at,manifest,progress")
        .eq("session_id", r.access.attemptId).eq("student_id", ownerId).maybeSingle());
      if (a.status !== "completed" || !a.completed_at) throw new LexicalAccessError(409);
      reject(r.sourceType === "rap");
      const groups = Array.isArray(a.manifest?.groups) ? a.manifest.groups as Row[] : [];
      const group = groups.find(g => g.logicalItemId === r.sourceItemId);
      reject(group && a.progress?.[r.sourceItemId!]);
      if (teacher) reject(a.progress[r.sourceItemId!].submittedAt);
      const questionBlock = /^question:([^:]+):/.exec(r.contentBlockId);
      reject(!questionBlock || (Array.isArray(group!.targets) && group!.targets.some((t: Row) => t.questionId === questionBlock[1])));
    } else {
      // Teacher lookups are pure SELECTs, never the owned/reconciling RPC.
      const owned = teacher ? await readTeacherFullSetAttempt(db, ownerId!, r.access.attemptId!) : await readers.fullSetAttempt(r.access.attemptId!);
      reject(!owned.error && owned.attempt);
      if (owned.attempt!.status !== "completed" || !owned.attempt!.completedAt) throw new LexicalAccessError(409);
      const modules = await db.from("reading_full_set_module_attempts")
        .select(teacher ? "module_attempt_id,module_number,status,submitted_at" : "module_attempt_id").eq("attempt_id", r.access.attemptId);
      if (modules.error) throw new Error("Full Set module query failed");
      const moduleRows = modules.data as unknown as Row[] | null;
      reject(moduleRows?.length === 2);
      if (teacher) {
        reject(new Set(moduleRows!.map(m => m.module_number)).size === 2 && moduleRows!.every(m => [1, 2].includes(m.module_number)));
        if (moduleRows!.some(m => m.status !== "submitted" || !m.submitted_at)) throw new LexicalAccessError(409);
      }
      let membership = db.from("reading_full_set_answers").select("answer_id")
        .in("module_attempt_id", moduleRows!.map(m => m.module_attempt_id)).eq("logical_item_id", r.sourceItemId!);
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
  if (r.access.kind === "writing" || (bankAccess && bank && r.sourceType !== "bas")) {
    const reviewSource = teacher && r.access.kind === "writing"
      ? await loadAuthorizedWritingReviewSource(db, lookupActor!, r.access.attemptId) : null;
    if (reviewSource) {
      reject(reviewSource.attempt.user_id === ownerId && await isActiveStudent(db, ownerId!));
      if (reviewSource.attempt.status !== "submitted" || !reviewSource.attempt.submitted_at) throw new LexicalAccessError(409);
    }
    const result = bank ? { data: { task_type: bank.taskType, question_id: bank.sourceQuestionId }, error: null }
      : reviewSource ? { data: reviewSource.attempt, error: null } : await readers.writingAttempt(r.access.attemptId!);
    reject(!result.error && result.data);
    const a = result.data!;
    reject(r.sourceType === (a.task_type === "email" ? "write_email" : "academic_discussion"));
    if (!bank) reject(a.status === "draft" || a.status === "submitted");
    const visible = teacher ? await readWritingQuestionForReview(db, a.task_type, a.question_id, a.assignment_id,
      reviewSource ? { assignment: reviewSource.assignment } : undefined) : await readers.writingQuestion(a);
    reject(!visible.error && visible.data && visible.questionSource === "question_bank");
    if (teacher) reject(visible.data!.question_id === a.question_id);
    if (a.status === "draft") reject((visible as { assignmentAvailable?: boolean }).assignmentAvailable !== false);
    const source = await one(db.from("practice_item_sources").select("item_id,source_question_id")
      .eq("task_type", a.task_type).eq("source_question_id", a.question_id).eq("is_canonical", true).maybeSingle());
    reject(!r.sourceItemId || r.sourceItemId === source.item_id);
    const fields: Record<string, string> = a.task_type === "email"
      ? { scenario: "scenario", "task-instruction": "task_instruction", "requirement:1": "requirement_1", "requirement:2": "requirement_2", "requirement:3": "requirement_3", subject: "subject" }
       : { "professor-prompt": "professor_prompt", "student-response:1": "student_1_response", "student-response:2": "student_2_response" };
    if (teacher) reject(r.contentBlockId !== "subject"); // Teacher prompt panes do not display the response-panel subject.
    const field = fields[r.contentBlockId]; reject(field);
    // A stale/custom snapshot never becomes a second corpus: current visible text must match the frozen hash below.
    return { sourceItemId: String(source.item_id), contentBlockId: r.contentBlockId, text: (visible.data as unknown as Row)[field] as string };
  }
  reject((r.access.kind === "bas" || r.access.kind === "bas_prompt" || bankAccess) && r.sourceType === "bas" && r.access.questionId);
  if (!bankAccess && r.access.kind !== "bas_prompt") {
    const a = await one(db.from("attempts").select("set_id,submitted_at").eq("attempt_id", r.access.attemptId).eq("student_id", ownerId).maybeSingle());
    reject(a.submitted_at);
    const answer = await one(db.from("attempt_answers").select("question_id,is_correct").eq("attempt_id", r.access.attemptId).eq("question_id", r.access.questionId!).maybeSingle());
    if (r.contentBlockId === "final-sentence") reject(readers.basFinalVisible(a, answer));
  }
  const raw = await one(db.from("questions").select("set_id,prompt,final_sentence").eq("question_id", r.access.questionId!).maybeSingle());
  if (bank) reject(raw.set_id === bank.sourceSetId);
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

async function readTeacherFullSetAttempt(db: SupabaseClient, studentId: string, attemptId: string) {
  const a = await one(db.from("reading_full_set_attempts").select("status,completed_at")
    .eq("attempt_id", attemptId).eq("student_id", studentId).maybeSingle());
  return { attempt: { status: a.status, completedAt: a.completed_at }, error: null };
}

async function authorizeWrongbookSession(db: SupabaseClient, studentId: string, r: LexicalLookupRequest) {
  // Use the record viewer's actual session membership, not just the caller's
  // optional context. Omitting sessionId must not expose an unfinished session.
  const sessions = await readAllSupabaseRows<Row>((from, to) => {
    let query = db.from("student_wrong_question_sessions").select("session_id,task_type,manifest,progress")
      .eq("student_id", studentId).order("created_at", { ascending: false }).order("session_id", { ascending: true }).range(from, to);
    if (r.access.sessionId) query = query.eq("session_id", r.access.sessionId);
    return query;
  });
  if (sessions.error) throw new Error("Wrongbook session query failed");
  const s = sessions.data?.find(row => Object.values(row.progress ?? {}).some(entry => (entry as Row | null)?.attemptId === r.access.attemptId));
  if (!s) { reject(!r.access.sessionId); return; }
  reject(s.task_type === r.sourceType);
  const groups: Row[] = Array.isArray(s.manifest?.groups) ? s.manifest.groups : [];
  const group = groups.find(g => g.logicalItemId === r.sourceItemId);
  reject(group && s.progress?.[r.sourceItemId!]?.attemptId === r.access.attemptId);
  const ids = groups.map(g => s.progress?.[g.logicalItemId]?.attemptId);
  if (!ids.length || ids.some(id => !id)) throw new LexicalAccessError(409);
  const finished = await db.from("reading_wrongbook_attempts").select("attempt_id,status,submitted_at")
    .in("attempt_id", ids).eq("student_id", studentId);
  if (finished.error) throw new Error("Wrongbook session query failed");
  if (finished.data?.length !== new Set(ids).size || finished.data.some(a => a.status !== "submitted" || !a.submitted_at)) throw new LexicalAccessError(409);
  const question = /^question:([^:]+):/.exec(r.contentBlockId);
  reject(!question || (Array.isArray(group!.targets) && group!.targets.some((t: Row) => t.questionId === question[1])));
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
    const titleMatch = /^passage:([^:]+):title$/.exec(id);
    if (titleMatch) {
      const passage = await one(db.from("reading_passages").select("passage_id,title")
        .eq("passage_id", titleMatch[1]).eq("logical_item_id", r.sourceItemId!).maybeSingle());
      reject(typeof passage.title === "string" && passage.title.trim());
      return String(passage.title);
    }
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
