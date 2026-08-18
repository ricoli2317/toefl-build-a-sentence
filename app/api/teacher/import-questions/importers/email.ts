import { EMAIL_HEADERS } from "@/lib/questionCsvSchemas";
import type { ImporterContext } from "./types";
import { importWritingQuestions } from "./writingQuestion";

export function importEmailQuestions(context: ImporterContext) {
  return importWritingQuestions(context, {
    fields: EMAIL_HEADERS,
    table: "email_questions",
    taskType: "email",
    upsertOperation: "upsert email questions"
  });
}
