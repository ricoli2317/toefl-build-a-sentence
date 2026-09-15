import type { ReadingSubmittedAnswer } from "./attempts.ts";

type AnswerIdentity = Pick<ReadingSubmittedAnswer, "kind" | "questionId" | "slotId">;

export type ReadingFullSetAnswerMergeResult = {
  conflicts: AnswerIdentity[];
  merged: ReadingSubmittedAnswer[];
};

/**
 * Three-way merge for one occurrence. Timing is telemetry, not answer
 * concurrency: the greatest observed time is retained without creating an
 * edit conflict. Only different student answers changed from the same base
 * are a genuine conflict.
 */
export function mergeReadingFullSetAnswers(input: {
  base: ReadingSubmittedAnswer[];
  local: ReadingSubmittedAnswer[];
  server: ReadingSubmittedAnswer[];
}): ReadingFullSetAnswerMergeResult {
  const base = answerMap(input.base);
  const local = answerMap(input.local);
  const server = answerMap(input.server);
  const identities = new Set([
    ...Array.from(base.keys()),
    ...Array.from(local.keys()),
    ...Array.from(server.keys())
  ]);
  const conflicts: AnswerIdentity[] = [];
  const merged: ReadingSubmittedAnswer[] = [];

  for (const identity of Array.from(identities).sort()) {
    const baseAnswer = base.get(identity);
    const localAnswer = local.get(identity);
    const serverAnswer = server.get(identity);
    const shape = localAnswer ?? serverAnswer ?? baseAnswer;
    if (!shape) continue;
    const baseValue = baseAnswer?.studentAnswer ?? null;
    const localValue = localAnswer?.studentAnswer ?? null;
    const serverValue = serverAnswer?.studentAnswer ?? null;
    const localChanged = localValue !== baseValue;
    const serverChanged = serverValue !== baseValue;
    if (localChanged && serverChanged && localValue !== serverValue) {
      conflicts.push(answerIdentity(shape));
    }
    const studentAnswer = !localChanged && serverChanged ? serverValue : localValue;
    merged.push({
      kind: shape.kind,
      questionId: shape.questionId,
      questionTimeSeconds: Math.max(
        baseAnswer?.questionTimeSeconds ?? 0,
        localAnswer?.questionTimeSeconds ?? 0,
        serverAnswer?.questionTimeSeconds ?? 0
      ),
      ...(shape.slotId ? { slotId: shape.slotId } : {}),
      studentAnswer
    });
  }
  return { conflicts, merged };
}

export function sameReadingFullSetAnswerValues(
  left: ReadingSubmittedAnswer[],
  right: ReadingSubmittedAnswer[]
) {
  const leftMap = answerMap(left);
  const rightMap = answerMap(right);
  if (leftMap.size !== rightMap.size) return false;
  return Array.from(leftMap).every(([identity, answer]) =>
    rightMap.get(identity)?.studentAnswer === answer.studentAnswer
  );
}

function answerMap(answers: ReadingSubmittedAnswer[]) {
  return new Map(answers.map((answer) => [answerKey(answer), answer]));
}

function answerKey(answer: AnswerIdentity) {
  return `${answer.questionId}\u0000${answer.slotId ?? ""}\u0000${answer.kind}`;
}

function answerIdentity(answer: ReadingSubmittedAnswer): AnswerIdentity {
  return {
    kind: answer.kind,
    questionId: answer.questionId,
    ...(answer.slotId ? { slotId: answer.slotId } : {})
  };
}
