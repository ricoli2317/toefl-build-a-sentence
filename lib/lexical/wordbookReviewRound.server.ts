import type { SupabaseClient } from "@supabase/supabase-js";
import { ReviewError, type ReviewAnswer, type ReviewCard, type ReviewRound, type ReviewState } from "./wordbookReview.ts";
import { reviewRpc } from "./wordbookReview.server.ts";

type Snapshot = ReviewCard["expected"] & { testedSources: string[]; posOptions: ReviewCard["options"];
   options: ReviewCard["options"]; surfaceForms?: string[]; evidence?: { occurrence_id: string; source_type: string; lexical_entry_id: string }[] };
type ItemRow = { item_id: string; position: number; kind: ReviewCard["kind"]; snapshot: Snapshot };

/** Read only the authenticated owner's immutable round, never redraw candidates.
 * Snapshot examples already belong to its chosen sense. No second provenance
 * rejection against today's collection (which may have been unfavourited). */
export async function readReviewRound(db: SupabaseClient, student: string, session: string): Promise<ReviewRound> {
  const raw = await reviewRpc(db, "wordbook_review_flow_state", {
    p_student: student, p_session: session, p_action: "read", p_item: null, p_answer: null
  }) as ReviewState;
  const rows: ItemRow[] = [];
  for (let start = 0; start < raw.session.total; start += 1000) {
    const { data, error } = await db.from("student_wordbook_review_items")
      .select("item_id,position,kind,snapshot").eq("student_id", student).eq("session_id", session)
      .order("position").range(start, start + 999);
    if (error || !data) throw new ReviewError("REVIEW_UNAVAILABLE", 503, "本轮题目暂未读取完成，请重试。");
    rows.push(...data as ItemRow[]);
  }
  if (rows.length !== raw.session.total) throw new ReviewError("REVIEW_UNAVAILABLE", 503, "本轮题目未完整读取，请重试。");
  const answers: { item_id: string; student_answer: ReviewAnswer["student"];
    assessments: Record<string, boolean>; item_correct: boolean; submitted_at: string }[] = [];
  for (let start = 0; start < raw.session.answered; start += 1000) {
    const { data, error } = await db.from("student_wordbook_review_answers")
      .select("item_id,student_answer,assessments,item_correct,submitted_at").eq("student_id", student).eq("session_id", session)
      .order("item_id").range(start, start + 999);
    if (error || !data) throw new ReviewError("REVIEW_UNAVAILABLE", 503, "已保存作答暂未读取完成，请重试。");
    answers.push(...data as typeof answers);
  }
  if (answers.length !== raw.session.answered) throw new ReviewError("REVIEW_UNAVAILABLE", 503, "已保存作答状态发生变化，请重试读取。");
  // Surface forms are used for decoration only, NOT to change spelling grading
  // or example/sense selection. Missing historical occurrence data is harmless.
  const occurrenceIds = Array.from(new Set(rows.flatMap(r => r.snapshot.evidence?.map(e => e.occurrence_id) ?? [])));
  const forms = new Map<string, { surface_text: string; entry_id: string; source_type: string }>();
  for (let start = 0; start < occurrenceIds.length; start += 100) {
    const { data } = await db.from("lexical_occurrences").select("occurrence_id,surface_text,entry_id,source_type")
      .in("occurrence_id", occurrenceIds.slice(start, start + 100));
    for (const row of data ?? []) forms.set(row.occurrence_id, row);
  }
  const cards: ReviewCard[] = rows.map(row => {
    const s = row.snapshot, saved = answers.find(a => a.item_id === row.item_id);
    const expected = { expression: s.expression, pos: s.pos, standardPos: s.standardPos, meaning: s.meaning,
      definitionEn: s.definitionEn, correctOptionId: s.correctOptionId, examples: s.examples ?? [] };
    return { itemId: row.item_id, position: row.position, kind: row.kind, sourceTypes: s.testedSources,
      prompt: row.kind === "spelling_pos" ? s.meaning : s.expression,
      options: row.kind === "spelling_pos" ? s.posOptions : s.options.map(o => ({ id: o.id, text: o.text })), expected,
      targetForms: Array.from(new Set([s.expression, ...(s.surfaceForms ?? []), ...(s.evidence ?? []).map(e => {
        const form = forms.get(e.occurrence_id);
        return form?.entry_id === e.lexical_entry_id && form.source_type === e.source_type ? form.surface_text : null;
      }).filter((v): v is string => Boolean(v))])),
      ...(saved ? { answer: { ...expected, student: saved.student_answer, assessments: saved.assessments,
        correct: saved.item_correct, submittedAt: saved.submitted_at } } : {}) };
  });
  // Explicit top-level projection excludes raw presentation/evidence/student IDs.
  return { session: raw.session, summary: raw.summary, composition: raw.composition,
    flow: raw.flow, item: raw.item, cards };
}
