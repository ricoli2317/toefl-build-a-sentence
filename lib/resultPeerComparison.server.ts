import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllSupabaseRows } from "@/lib/supabasePagination";
import {
  buildResultPeerComparison,
  EMPTY_RESULT_PEER_COMPARISON,
  type ResultPeerAttempt,
  type ResultPeerComparison
} from "@/lib/resultPeerComparison";

type PeerAttemptRow = {
  attempt_id: string;
  student_id: string;
  correct_count: number | null;
  total_questions: number | null;
  time_spent_seconds: number | null;
  submitted_at: string | null;
};

export async function loadResultPeerComparison({
  comparable,
  currentAttempt,
  db,
  setId,
  studentId
}: {
  comparable: boolean;
  currentAttempt: {
    attemptId: string;
    correctCount: number;
    totalQuestions: number;
    timeSpentSeconds: number;
  };
  db: SupabaseClient;
  setId: string;
  studentId: string;
}): Promise<ResultPeerComparison> {
  if (!comparable) return EMPTY_RESULT_PEER_COMPARISON;

  const peerResult = await readAllSupabaseRows<PeerAttemptRow>((from, to) =>
    db
      .from("attempts")
      .select(
        "attempt_id,student_id,correct_count,total_questions,time_spent_seconds,submitted_at"
      )
      .eq("set_id", setId)
      .neq("student_id", studentId)
      .not("submitted_at", "is", null)
      .order("submitted_at", { ascending: false })
      .order("attempt_id", { ascending: false })
      .range(from, to)
  );

  if (peerResult.error) return EMPTY_RESULT_PEER_COMPARISON;

  const peerAttempts: ResultPeerAttempt[] = (peerResult.data ?? []).map((attempt) => ({
    attemptId: String(attempt.attempt_id),
    studentId: String(attempt.student_id),
    correctCount: attempt.correct_count ?? 0,
    totalQuestions: attempt.total_questions ?? 0,
    timeSpentSeconds: attempt.time_spent_seconds ?? 0,
    submittedAt: attempt.submitted_at
  }));

  return buildResultPeerComparison(
    {
      attemptId: currentAttempt.attemptId,
      correctCount: currentAttempt.correctCount,
      totalQuestions: currentAttempt.totalQuestions,
      timeSpentSeconds: currentAttempt.timeSpentSeconds
    },
    peerAttempts
  );
}
