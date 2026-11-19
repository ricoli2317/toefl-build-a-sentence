import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllSupabaseRows } from "./supabasePagination.ts";

export type WritingReviewSummary = {
  status: "reviewing" | "published";
  /** Published teacher score (0-5); null when no usable score was published. */
  score: number | null;
};

type ReviewRow = {
  attempt_id: string;
  status: string;
  published_at: string | null;
  official_score: string | number | null;
};

const QUERY_BATCH_SIZE = 100;

/**
 * The one shared reading of a writing attempt's review state.
 *
 * The batch assignment detail uses it for per-item completion and the class
 * overview uses it for the same items, so both surfaces can never disagree
 * about "published" or about the final teacher score. Only
 * `published_scores.official_score.teacher_score` is read; AI scores and
 * unsaved drafts never enter a published average.
 */
export async function loadWritingReviewSummaries(
  db: SupabaseClient,
  attemptIds: ReadonlyArray<string>
): Promise<Map<string, WritingReviewSummary>> {
  const summaries = new Map<string, WritingReviewSummary>();
  const ids = Array.from(new Set(attemptIds.filter(Boolean)));
  for (let index = 0; index < ids.length; index += QUERY_BATCH_SIZE) {
    const batch = ids.slice(index, index + QUERY_BATCH_SIZE);
    const result = await readAllSupabaseRows<ReviewRow>((from, to) =>
      db
        .from("writing_reviews")
        .select(
          "attempt_id,status,published_at,official_score:published_scores->official_score->>teacher_score"
        )
        .in("attempt_id", batch)
        .range(from, to)
    );
    if (result.error) throw result.error;
    for (const review of result.data ?? []) {
      const status = review.status === "published" && review.published_at
        ? "published"
        : "reviewing";
      const score = parsePublishedScore(review.official_score);
      summaries.set(String(review.attempt_id), {
        status,
        score: status === "published" && score !== null && score >= 0 && score <= 5
          ? score
          : null
      });
    }
  }
  return summaries;
}

/** A missing jsonb score is `—`, never an accidental numeric 0. */
function parsePublishedScore(value: string | number | null | undefined) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
