import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllSupabaseRows } from "@/lib/supabasePagination";
import {
  buildResultPeerComparison,
  EMPTY_RESULT_PEER_COMPARISON,
  type ResultPeerComparison
} from "@/lib/resultPeerComparison";
import {
  mapLogicalPeerAttempts,
  selectLatestLogicalPeerAttempts,
  type LogicalPeerAnswer,
  type LogicalPeerCandidateAttempt,
  type LogicalPeerQuestionMap,
  type LogicalPeerSource
} from "@/lib/resultPeerComparisonLogical";
import { isVirtualPracticeSetId } from "@/lib/studentNavigation";

type CurrentSourceRow = Pick<LogicalPeerSource, "source_id" | "item_id" | "source_set_id">;

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

  const currentSourceResult = await db
    .from("practice_item_sources")
    .select("source_id,item_id,source_set_id")
    .eq("task_type", "build_sentence")
    .eq("source_set_id", setId)
    .maybeSingle();
  const currentSource = currentSourceResult.data as CurrentSourceRow | null;
  if (currentSourceResult.error || !currentSource) return EMPTY_RESULT_PEER_COMPARISON;

  const sourceResult = await readAllSupabaseRows<LogicalPeerSource>((from, to) =>
    db
      .from("practice_item_sources")
      .select("source_id,item_id,source_set_id")
      .eq("item_id", currentSource.item_id)
      .eq("task_type", "build_sentence")
      .not("source_set_id", "is", null)
      .order("source_id", { ascending: true })
      .range(from, to)
  );
  if (sourceResult.error) return EMPTY_RESULT_PEER_COMPARISON;

  const sources = (sourceResult.data ?? []).filter(
    (source) => source.source_set_id && !isVirtualPracticeSetId(source.source_set_id)
  );
  const sourceIds = distinct(sources.map((source) => source.source_id));
  const sourceSetIds = distinct(sources.flatMap((source) =>
    source.source_set_id ? [source.source_set_id] : []
  ));
  if (sourceIds.length === 0 || sourceSetIds.length === 0) {
    return EMPTY_RESULT_PEER_COMPARISON;
  }

  const [peerResult, questionMapResult] = await Promise.all([
    readAllSupabaseRows<LogicalPeerCandidateAttempt>((from, to) =>
      db
        .from("attempts")
        .select("attempt_id,student_id,set_id,time_spent_seconds,submitted_at")
        .in("set_id", sourceSetIds)
        .neq("student_id", studentId)
        .not("submitted_at", "is", null)
        .order("submitted_at", { ascending: false })
        .order("attempt_id", { ascending: false })
        .range(from, to)
    ),
    readAllSupabaseRows<LogicalPeerQuestionMap>((from, to) =>
      db
        .from("practice_item_question_map")
        .select("source_id,source_question_id,logical_question_order")
        .in("source_id", sourceIds)
        .order("source_id", { ascending: true })
        .order("logical_question_order", { ascending: true })
        .range(from, to)
    )
  ]);
  if (peerResult.error || questionMapResult.error) return EMPTY_RESULT_PEER_COMPARISON;

  const latestPeerAttempts = selectLatestLogicalPeerAttempts(peerResult.data ?? []);
  const peerAttemptIds = latestPeerAttempts.map((attempt) => attempt.attempt_id);
  const answerResult = peerAttemptIds.length > 0
    ? await readAllSupabaseRows<LogicalPeerAnswer>((from, to) =>
        db
          .from("attempt_answers")
          .select("attempt_id,question_id,is_correct,question_time_seconds")
          .in("attempt_id", peerAttemptIds)
          .order("attempt_id", { ascending: true })
          .order("question_id", { ascending: true })
          .range(from, to)
      )
    : { data: [], error: null };
  if (answerResult.error) return EMPTY_RESULT_PEER_COMPARISON;

  const mapped = mapLogicalPeerAttempts({
    itemId: currentSource.item_id,
    attempts: latestPeerAttempts,
    sources,
    questionMaps: questionMapResult.data ?? [],
    answers: answerResult.data ?? []
  });
  for (const warning of mapped.warnings) {
    console.warn("[result-peer-comparison] logical_answer_excluded", warning);
  }

  return buildResultPeerComparison(
    {
      attemptId: currentAttempt.attemptId,
      correctCount: currentAttempt.correctCount,
      totalQuestions: currentAttempt.totalQuestions,
      timeSpentSeconds: currentAttempt.timeSpentSeconds
    },
    mapped.attempts
  );
}

function distinct(values: string[]) {
  return Array.from(new Set(values));
}
