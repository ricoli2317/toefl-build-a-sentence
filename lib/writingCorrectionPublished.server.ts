import type { SupabaseClient } from "@supabase/supabase-js";
import { loadOwnedWritingCorrection } from "./writingCorrection.server.ts";
import { assertPublishedSnapshot } from "./writingCorrectionReview.ts";
import { correctionDisplayName } from "./writingCorrectionTitle.server.ts";
import { WritingCorrectionError, frozenWritingCorrectionSource } from "./writingCorrection.ts";

/** Owner-checked student projection. No working draft, AI raw output or overrides. */
export async function loadStudentCorrectionReview(db: SupabaseClient, userId: string, attemptId: string) {
  const { attempt } = await loadOwnedWritingCorrection(db, userId, attemptId);
  if (attempt.status !== "submitted") throw new WritingCorrectionError("WRITING_CORRECTION_NOT_FOUND", "批改尚未发布。", 404);
  const { data, error } = await db.from("writing_correction_reviews").select("published_review,published_at")
    .eq("attempt_id", attemptId).not("published_at", "is", null).maybeSingle();
  if (error) throw new Error("Correction review read failed");
  if (!data?.published_review) throw new WritingCorrectionError("WRITING_CORRECTION_NOT_FOUND", "批改尚未发布。", 404);
  const snapshot = assertPublishedSnapshot(data.published_review);
  const source = frozenWritingCorrectionSource(attempt);
  return {
    attempt: { attempt_id: attempt.attempt_id, task_type: attempt.task_type, response_text: attempt.response_text,
      word_count: attempt.word_count, submitted_at: attempt.submitted_at, revision_state: attempt.revision_state },
    original_response_text: source.original_response_text,
    question: source.question, question_source: source.question_source,
    display_name: await correctionDisplayName(db, attempt),
    review: {
      published_at: snapshot.published_at, original_score: snapshot.original_score,
      correction_score: snapshot.correction_score, score_delta: snapshot.score_delta,
      score_rationale: snapshot.score_rationale, score_change_explanation: snapshot.score_change_explanation,
      completion: snapshot.completion,
      issues: snapshot.issues.map(issue => ({ issue_id: issue.issue_id, issue_type: issue.issue_type,
        category: issue.category, original_text: issue.original_text, replacement_text: issue.replacement_text,
        original_sentence: issue.original_sentence, issue: issue.issue, suggestion: issue.suggestion,
        status: issue.effective_status, explanation: issue.ai_explanation })),
      new_issues: snapshot.new_issues.filter(issue => issue.review_status !== "dismissed").map(issue => ({
        index: issue.index, type: issue.type, severity: issue.severity, evidence: issue.evidence, explanation: issue.explanation
      }))
    }
  };
}
