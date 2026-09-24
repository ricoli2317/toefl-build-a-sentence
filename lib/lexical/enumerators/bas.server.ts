import { buildSentenceDisplay } from "../../questionText.ts";
import type { CanonicalLexicalBlock } from "../types.ts";

export type BasLexicalInput = {
  sourceItemId: string;
  sourceId: string;
  isCanonical: boolean;
  questions: Array<{
    sourceQuestionId: string;
    logicalQuestionOrder: number;
    prompt: string;
    sentenceTemplate: string | null;
    correctOrderText: string | null;
    finalSentence: string;
  }>;
};

export function enumerateBasBlocks(input: BasLexicalInput): CanonicalLexicalBlock[] {
  if (!input.isCanonical) throw new Error(`BAS source ${input.sourceId} is not canonical.`);
  const questions = [...input.questions].sort((left, right) => left.logicalQuestionOrder - right.logicalQuestionOrder);
  if (questions.length !== 10 || questions.some((question, index) => question.logicalQuestionOrder !== index + 1)) {
    throw new Error(`BAS canonical source ${input.sourceId} must resolve exactly logical Q1-Q10.`);
  }
  return questions.flatMap((question) => {
    const rendered = buildSentenceDisplay(question.sentenceTemplate, question.correctOrderText, question.finalSentence);
    const questionId = `q${String(question.logicalQuestionOrder).padStart(2, "0")}`;
    return [{
      sourceType: "bas" as const,
      sourceItemId: input.sourceItemId,
      contentBlockId: `question:${questionId}:prompt`,
      blockKind: "bas_prompt",
      text: question.prompt
    }, {
      sourceType: "bas" as const,
      sourceItemId: input.sourceItemId,
      contentBlockId: `question:${questionId}:final-sentence`,
      blockKind: "bas_final_sentence",
      text: question.finalSentence,
      ...(rendered === question.finalSentence ? {} : {
        anchors: [{
          anchorId: `canonical:${question.sourceQuestionId}`,
          anchorKind: "canonical_question" as const,
          startOffset: 0,
          endOffset: question.finalSentence.length,
          expectedText: question.finalSentence,
          metadata: {
            needsReview: 1,
            reason: "bas_reconstruction_mismatch"
          }
        }]
      })
    }];
  });
}
