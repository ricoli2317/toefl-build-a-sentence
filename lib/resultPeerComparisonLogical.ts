import type { ResultPeerAttempt } from "./resultPeerComparison.ts";
import { isVirtualPracticeSetId } from "./studentNavigation.ts";
import { isLaterOfficialAttempt } from "./studentSetStatus.ts";

export type LogicalPeerCandidateAttempt = {
  attempt_id: string;
  student_id: string;
  set_id: string;
  time_spent_seconds: number | null;
  submitted_at: string | null;
};

export type LogicalPeerSource = {
  source_id: string;
  item_id: string;
  source_set_id: string | null;
};

export type LogicalPeerQuestionMap = {
  source_id: string;
  source_question_id: string;
  logical_question_order: number;
};

export type LogicalPeerAnswer = {
  attempt_id: string;
  question_id: string;
  is_correct: boolean;
  question_time_seconds: number | null;
};

export type MappedLogicalPeerAnswer = {
  logicalQuestionOrder: number;
  isCorrect: boolean;
  questionTimeSeconds: number | null;
};

export type MappedLogicalPeerAttempt = ResultPeerAttempt & {
  setId: string;
  logicalAnswers: MappedLogicalPeerAnswer[];
};

export type LogicalPeerMappingWarning = {
  code:
    | "SOURCE_NOT_FOUND"
    | "QUESTION_MAP_NOT_FOUND"
    | "INVALID_LOGICAL_ORDER"
    | "DUPLICATE_LOGICAL_ORDER";
  itemId: string;
  attemptId: string;
  setId: string;
  questionId: string | null;
  message: string;
};

export function selectLatestLogicalPeerAttempts(
  attempts: LogicalPeerCandidateAttempt[]
) {
  const latestByStudent = new Map<string, LogicalPeerCandidateAttempt>();
  for (const attempt of attempts) {
    if (
      !attempt.student_id ||
      !attempt.submitted_at ||
      isVirtualPracticeSetId(attempt.set_id)
    ) {
      continue;
    }
    const current = latestByStudent.get(attempt.student_id);
    if (!current || isLaterOfficialAttempt(attempt, current)) {
      latestByStudent.set(attempt.student_id, attempt);
    }
  }
  return Array.from(latestByStudent.values());
}

export function mapLogicalPeerAttempts(input: {
  itemId: string;
  attempts: LogicalPeerCandidateAttempt[];
  sources: LogicalPeerSource[];
  questionMaps: LogicalPeerQuestionMap[];
  answers: LogicalPeerAnswer[];
}): {
  attempts: MappedLogicalPeerAttempt[];
  warnings: LogicalPeerMappingWarning[];
} {
  const latestAttempts = selectLatestLogicalPeerAttempts(input.attempts);
  const selectedAttemptIds = new Set(latestAttempts.map((attempt) => attempt.attempt_id));
  const answersByAttempt = groupBy(
    input.answers.filter((answer) => selectedAttemptIds.has(answer.attempt_id)),
    (answer) => answer.attempt_id
  );
  const sourceBySetId = new Map(
    input.sources.flatMap((source) =>
      source.source_set_id && !isVirtualPracticeSetId(source.source_set_id)
        ? [[source.source_set_id, source] as const]
        : []
    )
  );
  const logicalOrderBySourceQuestion = new Map(
    input.questionMaps.map((mapping) => [
      sourceQuestionKey(mapping.source_id, mapping.source_question_id),
      Number(mapping.logical_question_order)
    ])
  );
  const warnings: LogicalPeerMappingWarning[] = [];
  const mappedAttempts: MappedLogicalPeerAttempt[] = [];

  for (const attempt of latestAttempts) {
    const source = sourceBySetId.get(attempt.set_id);
    if (!source) {
      warnings.push(warning(
        "SOURCE_NOT_FOUND",
        input.itemId,
        attempt,
        null,
        "Peer attempt raw set has no logical source."
      ));
      continue;
    }

    const logicalAnswers = new Map<number, MappedLogicalPeerAnswer>();
    for (const answer of answersByAttempt.get(attempt.attempt_id) ?? []) {
      const logicalOrder = logicalOrderBySourceQuestion.get(
        sourceQuestionKey(source.source_id, answer.question_id)
      );
      if (logicalOrder === undefined) {
        warnings.push(warning(
          "QUESTION_MAP_NOT_FOUND",
          input.itemId,
          attempt,
          answer.question_id,
          "Historical peer answer has no logical question map."
        ));
        continue;
      }
      if (!Number.isInteger(logicalOrder) || logicalOrder < 1 || logicalOrder > 10) {
        warnings.push(warning(
          "INVALID_LOGICAL_ORDER",
          input.itemId,
          attempt,
          answer.question_id,
          `Historical peer answer maps to invalid logical order ${logicalOrder}.`
        ));
        continue;
      }
      if (logicalAnswers.has(logicalOrder)) {
        warnings.push(warning(
          "DUPLICATE_LOGICAL_ORDER",
          input.itemId,
          attempt,
          answer.question_id,
          `Historical peer attempt maps more than one answer to logical Q${logicalOrder}.`
        ));
        continue;
      }
      logicalAnswers.set(logicalOrder, {
        logicalQuestionOrder: logicalOrder,
        isCorrect: answer.is_correct,
        questionTimeSeconds: answer.question_time_seconds
      });
    }

    const orderedAnswers = Array.from(logicalAnswers.values()).sort(
      (left, right) => left.logicalQuestionOrder - right.logicalQuestionOrder
    );
    mappedAttempts.push({
      attemptId: attempt.attempt_id,
      studentId: attempt.student_id,
      setId: attempt.set_id,
      correctCount: orderedAnswers.filter((answer) => answer.isCorrect).length,
      totalQuestions: orderedAnswers.length,
      timeSpentSeconds: attempt.time_spent_seconds ?? 0,
      submittedAt: attempt.submitted_at,
      logicalAnswers: orderedAnswers
    });
  }

  return { attempts: mappedAttempts, warnings };
}

function sourceQuestionKey(sourceId: string, questionId: string) {
  return `${sourceId}:${questionId}`;
}

function warning(
  code: LogicalPeerMappingWarning["code"],
  itemId: string,
  attempt: LogicalPeerCandidateAttempt,
  questionId: string | null,
  message: string
): LogicalPeerMappingWarning {
  return {
    code,
    itemId,
    attemptId: attempt.attempt_id,
    setId: attempt.set_id,
    questionId,
    message
  };
}

function groupBy<T>(rows: T[], key: (row: T) => string) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const value = key(row);
    grouped.set(value, [...(grouped.get(value) ?? []), row]);
  }
  return grouped;
}
