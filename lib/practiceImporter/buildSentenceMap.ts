import { buildSentenceQuestionFingerprint } from "./normalization.ts";
import type { BuildSentenceMapRow, BuildSentenceQuestionInput } from "./types.ts";

export function mapNewBuildSentenceQuestions(questions: BuildSentenceQuestionInput[]) {
  validateTenQuestions(questions);
  return [...questions]
    .sort((left, right) => left.questionOrder - right.questionOrder)
    .map((question, index) => mapRow(question, index + 1));
}

export function mapMergedBuildSentenceQuestions(
  incoming: BuildSentenceQuestionInput[],
  canonical: BuildSentenceQuestionInput[],
  canonicalLogicalOrderByQuestionId: Map<string, number>
) {
  validateTenQuestions(incoming);
  validateTenQuestions(canonical);
  const canonicalByFingerprint = new Map<string, BuildSentenceQuestionInput[]>();

  for (const question of canonical) {
    const fingerprint = buildSentenceQuestionFingerprint(question);
    canonicalByFingerprint.set(fingerprint, [
      ...(canonicalByFingerprint.get(fingerprint) ?? []),
      question
    ]);
  }

  const rows: BuildSentenceMapRow[] = [];
  for (const question of incoming) {
    const questionFingerprint = buildSentenceQuestionFingerprint(question);
    const matches = canonicalByFingerprint.get(questionFingerprint) ?? [];
    if (matches.length !== 1) {
      throw new Error("BAS exact content cannot be mapped uniquely to canonical logical questions");
    }
    const logicalQuestionOrder = canonicalLogicalOrderByQuestionId.get(matches[0].questionId);
    if (!logicalQuestionOrder) {
      throw new Error("Canonical BAS logical question map is incomplete");
    }
    rows.push(mapRow(question, logicalQuestionOrder));
  }
  const logicalOrders = rows.map(({ logicalQuestionOrder }) => logicalQuestionOrder);
  if (new Set(logicalOrders).size !== 10 || !logicalOrders.every((order) => order >= 1 && order <= 10)) {
    throw new Error("BAS logical question mapping is not one-to-one");
  }
  return rows;
}

function mapRow(question: BuildSentenceQuestionInput, logicalQuestionOrder: number): BuildSentenceMapRow {
  return {
    sourceQuestionId: question.questionId,
    sourceQuestionOrder: question.questionOrder,
    logicalQuestionOrder,
    questionFingerprint: buildSentenceQuestionFingerprint(question)
  };
}

function validateTenQuestions(questions: BuildSentenceQuestionInput[]) {
  if (questions.length !== 10) throw new Error("A BAS logical set must contain exactly 10 questions");
  const orders = questions.map(({ questionOrder }) => questionOrder);
  if (new Set(orders).size !== 10 || !orders.every((order) => order >= 1 && order <= 10)) {
    throw new Error("BAS source question_order must contain 1–10 exactly once");
  }
  if (new Set(questions.map(({ questionId }) => questionId)).size !== 10) {
    throw new Error("BAS source must contain 10 distinct question_id values");
  }
}
