export const BUILD_A_SENTENCE_HEADERS = [
  "question_id",
  "set_id",
  "set_title",
  "question_order",
  "prompt",
  "sentence_template",
  "blank_count",
  "options_text",
  "correct_order_text",
  "distractors_text",
  "final_sentence",
  "grammar_tags_text"
] as const;

export const LOGICAL_WRITING_TITLE_HEADER = "logical_title" as const;

export const EMAIL_HEADERS = [
  "question_id",
  "set_id",
  "set_title",
  "year_month",
  "source_labels",
  "scenario",
  "task_instruction",
  "requirement_1",
  "requirement_2",
  "requirement_3",
  "closing_instruction",
  "recipient",
  "subject",
  LOGICAL_WRITING_TITLE_HEADER
] as const;

export const ACADEMIC_DISCUSSION_HEADERS = [
  "question_id",
  "set_id",
  "set_title",
  "year_month",
  "source_labels",
  "professor_name",
  "professor_prompt",
  "student_1_name",
  "student_1_response",
  "student_2_name",
  "student_2_response",
  LOGICAL_WRITING_TITLE_HEADER
] as const;

export function rawWritingQuestionPayload(row: Record<string, string>) {
  const { [LOGICAL_WRITING_TITLE_HEADER]: _logicalTitle, ...rawPayload } = row;
  return rawPayload;
}

export type QuestionType =
  | "build_a_sentence"
  | "email"
  | "academic_discussion"
  | "unknown";

export const QUESTION_TYPE_LABELS: Record<Exclude<QuestionType, "unknown">, string> = {
  build_a_sentence: "Build a Sentence",
  email: "Write an Email",
  academic_discussion: "Academic Discussion"
};

export const QUESTION_TYPE_SCHEMAS = {
  build_a_sentence: BUILD_A_SENTENCE_HEADERS,
  email: EMAIL_HEADERS,
  academic_discussion: ACADEMIC_DISCUSSION_HEADERS
} as const;

export type KnownQuestionType = keyof typeof QUESTION_TYPE_SCHEMAS;

export type HeaderDifference = {
  missingFields: string[];
  unexpectedFields: string[];
};

function headersExactlyMatch(headers: readonly string[], schema: readonly string[]) {
  return (
    headers.length === schema.length &&
    headers.every((header, index) => header === schema[index])
  );
}

export function detectQuestionType(headers: readonly string[]): QuestionType {
  const normalizedHeaders = headers.map((header, index) =>
    (index === 0 ? header.replace(/^\uFEFF/, "") : header).trim()
  );
  const match = (Object.entries(QUESTION_TYPE_SCHEMAS) as Array<
    [KnownQuestionType, readonly string[]]
  >).find(([, schema]) => headersExactlyMatch(normalizedHeaders, schema));

  return match?.[0] ?? "unknown";
}

export function compareHeaders(
  headers: readonly string[],
  schema: readonly string[]
): HeaderDifference {
  const normalizedHeaders = headers.map((header, index) =>
    (index === 0 ? header.replace(/^\uFEFF/, "") : header).trim()
  );
  return {
    missingFields: schema.filter((field) => !normalizedHeaders.includes(field)),
    unexpectedFields: normalizedHeaders.filter((field) => !schema.includes(field))
  };
}

export function closestQuestionSchema(headers: readonly string[]) {
  const candidates = (Object.entries(QUESTION_TYPE_SCHEMAS) as Array<
    [KnownQuestionType, readonly string[]]
  >).map(([questionType, schema]) => {
    const difference = compareHeaders(headers, schema);
    const normalizedHeaders = headers.map((header, index) =>
      (index === 0 ? header.replace(/^\uFEFF/, "") : header).trim()
    );
    const sharedFieldCount = schema.filter((field) => normalizedHeaders.includes(field)).length;
    return { difference, questionType, schema, sharedFieldCount };
  });

  return candidates.sort(
    (left, right) =>
      right.sharedFieldCount - left.sharedFieldCount ||
      left.difference.missingFields.length + left.difference.unexpectedFields.length -
        (right.difference.missingFields.length + right.difference.unexpectedFields.length)
  )[0];
}
