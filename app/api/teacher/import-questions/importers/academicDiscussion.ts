import { ACADEMIC_DISCUSSION_HEADERS } from "@/lib/questionCsvSchemas";
import type { ImporterContext } from "./types";
import { importWritingQuestions } from "./writingQuestion";

export function importAcademicDiscussionQuestions(context: ImporterContext) {
  return importWritingQuestions(context, {
    fields: ACADEMIC_DISCUSSION_HEADERS,
    table: "academic_discussion_questions",
    upsertOperation: "upsert academic discussion questions"
  });
}
