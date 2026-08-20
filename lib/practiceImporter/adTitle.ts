import {
  generateLogicalWritingTitle,
  validateLogicalWritingTitle
} from "./logicalTitle.ts";

export const validateAcademicDiscussionTitle = validateLogicalWritingTitle;

export function generateAcademicDiscussionTitle(
  professorPrompt: string,
  options?: Parameters<typeof generateLogicalWritingTitle>[2]
) {
  return generateLogicalWritingTitle(professorPrompt, "academic_discussion", options);
}
