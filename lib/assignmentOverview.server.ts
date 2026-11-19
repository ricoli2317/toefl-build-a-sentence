import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllSupabaseRows } from "./supabasePagination.ts";

const STUDENT_BATCH_SIZE = 100;

type PracticeSummaryRow = {
  student_id: string;
  latest_practice_at: string | null;
};

/**
 * Platform-wide latest valid practice time for the given students.
 *
 * The database maintains `student_practice_summary` incrementally when a
 * practice completes (reading, wrongbook, full set, BAS, writing), so this
 * reads one lightweight row per student instead of scanning attempts/reviews.
 * Missing rows stay `null` and render as `—`.
 */
export async function loadStudentLatestPracticeAt(
  db: SupabaseClient,
  studentIds: ReadonlyArray<string>
): Promise<Map<string, string | null>> {
  const latestPracticeAt = new Map<string, string | null>();
  const ids = Array.from(new Set(studentIds.filter(Boolean)));
  for (let index = 0; index < ids.length; index += STUDENT_BATCH_SIZE) {
    const batch = ids.slice(index, index + STUDENT_BATCH_SIZE);
    const result = await readAllSupabaseRows<PracticeSummaryRow>((from, to) =>
      db
        .from("student_practice_summary")
        .select("student_id,latest_practice_at")
        .in("student_id", batch)
        .order("student_id", { ascending: true })
        .range(from, to)
    );
    if (result.error) throw result.error;
    for (const row of result.data ?? []) {
      const studentId = String(row.student_id ?? "").trim();
      if (!studentId) continue;
      const value = typeof row.latest_practice_at === "string"
        && Number.isFinite(Date.parse(row.latest_practice_at))
        ? row.latest_practice_at
        : null;
      latestPracticeAt.set(studentId, value);
    }
  }
  return latestPracticeAt;
}
