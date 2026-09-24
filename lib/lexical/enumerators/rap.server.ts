import {
  rapSentenceInsertionInstruction,
  rapSentenceSelectionStem,
  validateRapInsertionAnchors
} from "../../reading/rapInteraction.ts";
import type { CanonicalLexicalBlock } from "../types.ts";

export type RapLexicalInput = {
  sourceItemId: string;
  passageId: string;
  paragraphs: Array<{
    paragraphId: string;
    paragraphOrder: number;
    paragraphText: string;
    sentences: Array<{ sentenceId: string; sentenceOrder: number; sentenceText: string }>;
  }>;
  questions: Array<{
    questionId: string;
    questionOrder: number;
    questionType: "rap_multiple_choice" | "rap_sentence_insertion" | "rap_sentence_selection";
    stem: string;
    insertSentence?: string | null;
    options: Array<{ optionId: string; optionOrder: number; optionText: string }>;
    insertionAnchors?: Array<{
      anchorId: string;
      anchorOrder: number;
      boundaryIndex: number;
      paragraphId: string;
      afterSentenceId: string | null;
    }>;
  }>;
};

export function enumerateRapBlocks(input: RapLexicalInput): CanonicalLexicalBlock[] {
  const passageBlocks = [...input.paragraphs].sort((left, right) => left.paragraphOrder - right.paragraphOrder).map((paragraph) => {
    const orderedSentences = [...paragraph.sentences].sort((left, right) => left.sentenceOrder - right.sentenceOrder);
    if (orderedSentences.map((sentence) => sentence.sentenceText).join(" ") !== paragraph.paragraphText) {
      throw new Error(`RAP paragraph ${paragraph.paragraphId} sentence join does not equal paragraph_text.`);
    }
    let offset = 0;
    const anchors = orderedSentences.map((sentence, index) => {
      const startOffset = offset;
      offset += sentence.sentenceText.length;
      const anchor = {
        anchorId: sentence.sentenceId,
        anchorKind: "rap_sentence" as const,
        startOffset,
        endOffset: offset,
        expectedText: sentence.sentenceText
      };
      if (index < orderedSentences.length - 1) offset += 1;
      return anchor;
    });
    return {
      sourceType: "rap" as const,
      sourceItemId: input.sourceItemId,
      contentBlockId: `passage:${input.passageId}:paragraph:${paragraph.paragraphId}`,
      blockKind: "rap_paragraph",
      text: paragraph.paragraphText,
      anchors
    };
  });
  const questionBlocks = [...input.questions].sort((left, right) => left.questionOrder - right.questionOrder).flatMap((question) => {
    const options = [...question.options].sort((left, right) => left.optionOrder - right.optionOrder).map((option) => ({
      sourceType: "rap" as const,
      sourceItemId: input.sourceItemId,
      contentBlockId: `question:${question.questionId}:option:${option.optionId}`,
      blockKind: "rap_question_option",
      text: option.optionText
    }));
    if (question.questionType === "rap_sentence_insertion") {
      if (!question.insertSentence) throw new Error(`RAP insertion question ${question.questionId} has no insert_sentence.`);
      const validation = validateRapInsertionAnchors(
        { paragraphs: input.paragraphs.map((paragraph) => ({ paragraphId: paragraph.paragraphId, sentences: paragraph.sentences })) },
        question.insertionAnchors ?? []
      );
      if (!validation.valid) {
        throw new Error(`RAP insertion question ${question.questionId} has invalid anchors: ${validation.reason}.`);
      }
      return [{
        sourceType: "rap" as const,
        sourceItemId: input.sourceItemId,
        contentBlockId: `question:${question.questionId}:instruction`,
        blockKind: "rap_question_instruction",
        text: rapSentenceInsertionInstruction(),
        anchors: validation.anchors.map((anchor) => ({
          anchorId: anchor.anchorId,
          anchorKind: "rap_insertion_position" as const,
          metadata: { paragraphId: anchor.paragraphId, boundaryIndex: anchor.boundaryIndex }
        }))
      }, {
        sourceType: "rap" as const,
        sourceItemId: input.sourceItemId,
        contentBlockId: `question:${question.questionId}:insert-sentence`,
        blockKind: "rap_insert_sentence",
        text: question.insertSentence
      }];
    }
    return [{
      sourceType: "rap" as const,
      sourceItemId: input.sourceItemId,
      contentBlockId: `question:${question.questionId}:stem`,
      blockKind: "rap_question_stem",
      text: question.questionType === "rap_sentence_selection" ? rapSentenceSelectionStem(question.stem) : question.stem
    }, ...options];
  });
  return [...passageBlocks, ...questionBlocks];
}
