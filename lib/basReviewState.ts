import { normalizeChunkForCompare, splitTextItems } from "./questionText.ts";

export type BasReviewWordBlock = {
  id: string;
  text: string;
};

export type BasReviewQuestionState = {
  /** Every option chunk, built exactly like the active practice (`questionId-index`). */
  optionChunks: BasReviewWordBlock[];
  /** Chunks the student actually placed, strictly in the submitted order. */
  placedChunks: BasReviewWordBlock[];
  /** Option chunks the student never placed, in their original option order. */
  unusedChunks: BasReviewWordBlock[];
};

/**
 * Rebuilds the readonly BAS drag state from the data an attempt already stores.
 *
 * `submitted_order_text` keeps only the chunks the student placed, in submission
 * order; empty drag slots are not persisted. The mapping is therefore: placed
 * chunks keep the submitted order, everything else stays in the option tray.
 * Duplicate chunk texts are consumed in option order so two identical options
 * still map to two distinct option ids. Text that no longer matches the current
 * canonical option list (for example after a historical casing fix) is still
 * shown exactly as submitted, just without an option identity.
 */
export function buildBasReviewQuestionState({
  optionsText,
  questionId,
  submittedOrderText
}: {
  optionsText: string | null | undefined;
  questionId: string;
  submittedOrderText: string | null | undefined;
}): BasReviewQuestionState {
  const optionChunks = splitTextItems(optionsText).map((text, index) => ({
    id: `${questionId}-${index}`,
    text
  }));
  const usedOptionIds = new Set<string>();

  const placedChunks = splitTextItems(submittedOrderText).map((text, index) => {
    const match = optionChunks.find(
      (chunk) =>
        !usedOptionIds.has(chunk.id)
        && normalizeChunkForCompare(chunk.text) === normalizeChunkForCompare(text)
    );
    if (match) {
      usedOptionIds.add(match.id);
      return match;
    }
    return { id: `submitted-${questionId}-${index}`, text };
  });

  return {
    optionChunks,
    placedChunks,
    unusedChunks: optionChunks.filter((chunk) => !usedOptionIds.has(chunk.id))
  };
}
