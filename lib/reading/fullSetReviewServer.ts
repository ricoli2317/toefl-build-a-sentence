import type { SupabaseClient } from "@supabase/supabase-js";
import { loadReadingFullSetResult, type OwnedReadingFullSetResultAttempt } from "./fullSetResultServer.ts";
import { buildReadingFullSetReviewItems, type ReadingFullSetReviewPayload } from "./fullSetReview.ts";
import { buildSubmittedReadingAnswerState } from "./review.ts";
import { loadReadingAnswerDisclosures } from "./reviewDisclosures.server.ts";
import { loadStudentReadingPractice } from "./studentPractice.ts";

export type ReadingFullSetFinalSnapshot = {
  result: Awaited<ReturnType<typeof loadReadingFullSetResult>>;
  review: ReadingFullSetReviewPayload;
};

/**
 * Loads the server-confirmed fields needed to finalize the client snapshot.
 * The submit endpoint uses this once, after the final module commit, so the
 * result and readonly route do not need a second attempt-detail bootstrap.
 */
export async function loadReadingFullSetFinalSnapshot(
  db: SupabaseClient,
  attempt: OwnedReadingFullSetResultAttempt,
  options: { reuseOccurrenceIds?: readonly string[] } = {}
): Promise<ReadingFullSetFinalSnapshot> {
  const result = await loadReadingFullSetResult(db, attempt);
  const occurrenceMetadata = Array.from(new Map(result.answers.map((answer) => [
    answer.occurrenceId,
    {
      logicalItemId: answer.logicalItemId,
      moduleNumber: answer.moduleNumber,
      occurrenceId: answer.occurrenceId
    }
  ])).values());
  const reusedOccurrenceIds = new Set(options.reuseOccurrenceIds ?? []);
  const occurrenceMetadataToLoad = occurrenceMetadata.filter(
    (occurrence) => !reusedOccurrenceIds.has(occurrence.occurrenceId)
  );
  const practices = await Promise.all(occurrenceMetadataToLoad.map((occurrence) =>
    loadStudentReadingPractice(db, occurrence.logicalItemId)
  ));
  const answerIds = result.answers.map((answer) => answer.answerId);
  const answerResult = await db.from("reading_full_set_answers")
    .select("answer_id,occurrence_id,question_id,slot_id,answer_kind,student_answer")
    .in("answer_id", answerIds);
  if (answerResult.error) throw new Error(answerResult.error.message);
  const submittedRows = answerResult.data ?? [];
  const disclosureRows = submittedRows.map((row) => ({
    ...row,
    attempt_answer_id: row.answer_id
  }));
  // During final submit this contains only content missing from the active
  // session. The client fills reused occurrences from its hot cache. Cold GET
  // callers omit reuseOccurrenceIds and receive the complete payload.
  const occurrences = occurrenceMetadataToLoad.map((occurrence, index) => {
    const practice = practices[index];
    if (!practice) throw new Error("READING_FULL_SET_REVIEW_PRACTICE_MISSING");
    return {
      answers: buildSubmittedReadingAnswerState(
        practice,
        submittedRows.filter((row) => row.occurrence_id === occurrence.occurrenceId)
      ),
      moduleNumber: occurrence.moduleNumber,
      occurrenceId: occurrence.occurrenceId,
      practice
    };
  });
  const reviewBaseHref = `/student/reading/full-sets/${encodeURIComponent(result.attempt.fullSetId)}/result/${encodeURIComponent(result.attempt.attemptId)}/questions`;
  return {
    result,
    review: {
      attempt: {
        attemptId: result.attempt.attemptId,
        fullSetId: result.attempt.fullSetId,
        title: result.attempt.title
      },
      disclosures: await loadReadingAnswerDisclosures(db, disclosureRows),
      occurrences,
      reviewItems: buildReadingFullSetReviewItems(
        result.answers,
        (sourceAnswerIndex) => `${reviewBaseHref}/${sourceAnswerIndex}`
      )
    }
  };
}
