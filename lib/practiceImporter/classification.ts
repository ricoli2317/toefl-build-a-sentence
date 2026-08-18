import {
  buildSentenceQuestionFingerprint,
  normalizeAcademicDiscussionIdentity,
  normalizeBuildSentenceQuestion,
  normalizeEmailIdentity,
  normalizedSimilarity,
  stableSerialize
} from "./normalization.ts";
import type {
  AcademicDiscussionIdentityInput,
  BuildSentenceQuestionInput,
  ClassificationResult,
  EmailIdentityInput,
  LogicalCandidate
} from "./types.ts";

const HIGH_SIMILARITY = 0.9;

export function classifyBuildSentence(
  incoming: BuildSentenceQuestionInput[],
  candidates: Array<LogicalCandidate<BuildSentenceQuestionInput[]>>
): ClassificationResult {
  const incomingFingerprints = incoming.map(buildSentenceQuestionFingerprint);
  const exactCandidates = candidates.filter(({ content }) =>
    sameMultiset(incomingFingerprints, content.map(buildSentenceQuestionFingerprint))
  );

  if (exactCandidates.length === 1) {
    return result("AUTO_MERGE", exactCandidates[0].itemId, { exactQuestions: 10 });
  }
  if (exactCandidates.length > 1) {
    return result("NEEDS_REVIEW", exactCandidates[0].itemId, {
      reason: "multiple_exact_candidates",
      candidateItemIds: exactCandidates.map(({ itemId }) => itemId)
    });
  }

  const reviews = candidates
    .map((candidate) => ({ candidate, ...scoreBuildSentence(incoming, candidate.content) }))
    .filter(({ review }) => review)
    .sort((left, right) => right.score - left.score || compareText(left.candidate.itemId, right.candidate.itemId));

  if (reviews.length > 0) {
    const best = reviews[0];
    return result("NEEDS_REVIEW", best.candidate.itemId, {
      exactQuestions: best.exact,
      remainingSimilarities: best.similarities,
      score: best.score,
      candidateItemIds: reviews.map(({ candidate }) => candidate.itemId)
    });
  }
  return result("NEW_ITEM", null, { exactQuestions: 0 });
}

export function classifyEmail(
  incoming: EmailIdentityInput,
  candidates: Array<LogicalCandidate<EmailIdentityInput>>
): ClassificationResult {
  const normalizedIncoming = normalizeEmailIdentity(incoming);
  const exact = candidates.filter(
    ({ content }) => stableSerialize(normalizeEmailIdentity(content)) === stableSerialize(normalizedIncoming)
  );
  if (exact.length === 1) return result("AUTO_MERGE", exact[0].itemId, { exactComponents: 6 });
  if (exact.length > 1) {
    return result("NEEDS_REVIEW", exact[0].itemId, {
      reason: "multiple_exact_candidates",
      candidateItemIds: exact.map(({ itemId }) => itemId)
    });
  }

  const reviews = candidates
    .map((candidate) => ({ candidate, ...scoreEmail(incoming, candidate.content) }))
    .filter(({ review }) => review)
    .sort((left, right) => right.score - left.score || compareText(left.candidate.itemId, right.candidate.itemId));
  if (reviews.length > 0) {
    const best = reviews[0];
    return result("NEEDS_REVIEW", best.candidate.itemId, {
      exactComponents: best.exact,
      remainingSimilarity: best.remainingSimilarity,
      score: best.score,
      candidateItemIds: reviews.map(({ candidate }) => candidate.itemId)
    });
  }
  return result("NEW_ITEM", null, { exactComponents: 0 });
}

export function classifyAcademicDiscussion(
  incoming: AcademicDiscussionIdentityInput,
  candidates: Array<LogicalCandidate<AcademicDiscussionIdentityInput>>
): ClassificationResult {
  const normalizedIncoming = normalizeAcademicDiscussionIdentity(incoming);
  const exact = candidates.filter(
    ({ content }) =>
      stableSerialize(normalizeAcademicDiscussionIdentity(content)) === stableSerialize(normalizedIncoming)
  );
  if (exact.length === 1) return result("AUTO_MERGE", exact[0].itemId, { exactComponents: 3 });
  if (exact.length > 1) {
    return result("NEEDS_REVIEW", exact[0].itemId, {
      reason: "multiple_exact_candidates",
      candidateItemIds: exact.map(({ itemId }) => itemId)
    });
  }

  const reviews = candidates
    .map((candidate) => ({ candidate, ...scoreAcademicDiscussion(incoming, candidate.content) }))
    .filter(({ review }) => review)
    .sort((left, right) => right.score - left.score || compareText(left.candidate.itemId, right.candidate.itemId));
  if (reviews.length > 0) {
    const best = reviews[0];
    return result("NEEDS_REVIEW", best.candidate.itemId, {
      exactComponents: best.exact,
      similarities: best.similarities,
      score: best.score,
      candidateItemIds: reviews.map(({ candidate }) => candidate.itemId)
    });
  }
  return result("NEW_ITEM", null, { exactComponents: 0 });
}

function scoreBuildSentence(left: BuildSentenceQuestionInput[], right: BuildSentenceQuestionInput[]) {
  const leftValues = left.map((question) => ({
    fingerprint: buildSentenceQuestionFingerprint(question),
    value: stableSerialize(normalizeBuildSentenceQuestion(question))
  }));
  const rightValues = right.map((question) => ({
    fingerprint: buildSentenceQuestionFingerprint(question),
    value: stableSerialize(normalizeBuildSentenceQuestion(question))
  }));
  const unmatchedRight = new Set(rightValues.map((_value, index) => index));
  const unmatchedLeft: number[] = [];
  let exact = 0;

  leftValues.forEach((value, leftIndex) => {
    const match = Array.from(unmatchedRight).find(
      (rightIndex) => rightValues[rightIndex].fingerprint === value.fingerprint
    );
    if (match === undefined) unmatchedLeft.push(leftIndex);
    else {
      exact += 1;
      unmatchedRight.delete(match);
    }
  });

  if (exact < 8) return { exact, similarities: [] as number[], score: exact / 10, review: false };
  const similarities = bestPairSimilarities(
    unmatchedLeft.map((index) => leftValues[index].value),
    Array.from(unmatchedRight).map((index) => rightValues[index].value)
  );
  const review = similarities.length === 10 - exact && similarities.every((value) => value >= HIGH_SIMILARITY);
  return { exact, similarities, score: (exact + sum(similarities)) / 10, review };
}

function scoreEmail(left: EmailIdentityInput, right: EmailIdentityInput) {
  const leftNormalized = normalizeEmailIdentity(left);
  const rightNormalized = normalizeEmailIdentity(right);
  const fixedLeft = [leftNormalized.scenario, leftNormalized.taskInstruction, leftNormalized.recipient];
  const fixedRight = [rightNormalized.scenario, rightNormalized.taskInstruction, rightNormalized.recipient];
  let exact = fixedLeft.reduce((count, value, index) => count + (value === fixedRight[index] ? 1 : 0), 0);
  const fixedSimilarities = fixedLeft
    .map((value, index) => (value === fixedRight[index] ? null : normalizedSimilarity(value, fixedRight[index])))
    .filter((value): value is number => value !== null);
  const requirementScore = scoreUnorderedComponents(
    leftNormalized.requirements,
    rightNormalized.requirements
  );
  exact += requirementScore.exact;
  const remaining = [...fixedSimilarities, ...requirementScore.similarities];
  const review = exact === 5 && remaining.length === 1 && remaining[0] >= HIGH_SIMILARITY;
  return { exact, remainingSimilarity: remaining[0] ?? null, score: (exact + sum(remaining)) / 6, review };
}

function scoreAcademicDiscussion(
  left: AcademicDiscussionIdentityInput,
  right: AcademicDiscussionIdentityInput
) {
  const a = normalizeAcademicDiscussionIdentity(left);
  const b = normalizeAcademicDiscussionIdentity(right);
  const promptExact = a.professorPrompt === b.professorPrompt ? 1 : 0;
  const responseScore = scoreUnorderedComponents(a.studentResponses, b.studentResponses);
  const exact = promptExact + responseScore.exact;
  const similarities = [
    ...(promptExact ? [] : [normalizedSimilarity(a.professorPrompt, b.professorPrompt)]),
    ...responseScore.similarities
  ];
  const allComponentSimilarities = [...Array.from({ length: exact }, () => 1), ...similarities];
  const review =
    (exact === 2 && similarities.length === 1 && similarities[0] >= HIGH_SIMILARITY) ||
    (allComponentSimilarities.length === 3 &&
      allComponentSimilarities.every((value) => value >= HIGH_SIMILARITY));
  return { exact, similarities, score: (exact + sum(similarities)) / 3, review };
}

function scoreUnorderedComponents(left: string[], right: string[]) {
  const unmatchedRight = new Set(right.map((_value, index) => index));
  const unmatchedLeft: string[] = [];
  let exact = 0;
  for (const value of left) {
    const match = Array.from(unmatchedRight).find((index) => right[index] === value);
    if (match === undefined) unmatchedLeft.push(value);
    else {
      exact += 1;
      unmatchedRight.delete(match);
    }
  }
  return {
    exact,
    similarities: bestPairSimilarities(unmatchedLeft, Array.from(unmatchedRight).map((index) => right[index]))
  };
}

function bestPairSimilarities(left: string[], right: string[]) {
  if (left.length !== right.length || left.length === 0) return [];
  let best: number[] = [];
  let bestTotal = -1;
  for (const permutation of permutations(right)) {
    const similarities = left.map((value, index) => normalizedSimilarity(value, permutation[index]));
    const total = sum(similarities);
    if (total > bestTotal) {
      best = similarities;
      bestTotal = total;
    }
  }
  return best;
}

function permutations<T>(values: T[]): T[][] {
  if (values.length <= 1) return [values];
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((rest) => [value, ...rest])
  );
}

function sameMultiset(left: string[], right: string[]) {
  return left.length === right.length && [...left].sort(compareText).every((value, index) => value === [...right].sort(compareText)[index]);
}

function result(
  classification: ClassificationResult["classification"],
  candidateItemId: string | null,
  similaritySummary: Record<string, unknown>
): ClassificationResult {
  return { classification, candidateItemId, similaritySummary };
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
