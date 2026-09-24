import type { CanonicalLexicalBlock } from "../types.ts";

export type AcademicDiscussionLexicalInput = {
  sourceItemId: string;
  sourceQuestionId: string;
  isCanonical: boolean;
  question: {
    professorPrompt: string;
    student1Response: string;
    student2Response: string;
  };
};

export function enumerateAcademicDiscussionBlocks(
  input: AcademicDiscussionLexicalInput
): CanonicalLexicalBlock[] {
  if (!input.isCanonical) throw new Error(`Academic Discussion source ${input.sourceQuestionId} is not canonical.`);
  return [
    ["professor-prompt", "academic_professor_prompt", input.question.professorPrompt],
    ["student-response:1", "academic_student_response", input.question.student1Response],
    ["student-response:2", "academic_student_response", input.question.student2Response]
  ].map(([contentBlockId, blockKind, text]) => ({
    sourceType: "academic_discussion" as const,
    sourceItemId: input.sourceItemId,
    contentBlockId,
    blockKind,
    text
  }));
}
