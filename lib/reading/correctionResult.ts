import type {
  ReadingAnswerRow,
  ReadingQuestionResultRow,
  ReadingResultAnswer,
  ReadingResultPayload
} from "./history.ts";

export type ReadingCorrectionAnswerPart = {
  emphasized: boolean;
  text: string;
};

export type ReadingCorrectionAnswerDisplay =
  | { kind: "text"; text: string }
  | { kind: "ctw_word"; parts: ReadingCorrectionAnswerPart[] };

export type ReadingCorrectionResultAnswer = ReadingResultAnswer & {
  correctAnswer: ReadingCorrectionAnswerDisplay;
  reviewIndex: number;
  studentAnswer: string;
};

export type ReadingCorrectionResultPayload = Omit<ReadingResultPayload, "answers"> & {
  answers: ReadingCorrectionResultAnswer[];
};

export type ReadingCorrectionAnswerPresentation = {
  correctAnswer: ReadingCorrectionAnswerDisplay;
  reviewState?: ReadingCorrectionReviewState;
  studentAnswer: string;
};

export type ReadingCorrectionReviewState = {
  correctAnswerId: string;
  kind: "choice" | "insertion" | "sentence_selection";
  studentAnswerId: string | null;
};

export type ReadingCorrectionMarkState = "correct" | "incorrect" | null;

export type ReadingCorrectionQuestionRow = ReadingQuestionResultRow & {
  correct_anchor_id: string | null;
  correct_option_id: string | null;
  correct_sentence_id: string | null;
};

export type ReadingCorrectionOptionRow = {
  option_id: string;
  option_order: number;
  option_text: string;
  question_id: string;
};

export type ReadingCorrectionCtwSlotRow = {
  answer: string;
  display_text: string;
  missing_text: string;
  prefix: string;
  question_id: string;
  slot_id: string;
};

export type ReadingCorrectionAnchorRow = {
  anchor_id: string;
  anchor_order: number;
  question_id: string;
};

export type ReadingCorrectionSentenceRow = {
  sentence_id: string;
  sentence_order: number;
  sentence_text: string;
};

type ReadingCorrectionAnswerData = {
  correctionRows: ReadingAnswerRow[];
  questions: ReadingCorrectionQuestionRow[];
  options?: ReadingCorrectionOptionRow[];
  ctwSlots?: ReadingCorrectionCtwSlotRow[];
  anchors?: ReadingCorrectionAnchorRow[];
  sentences?: ReadingCorrectionSentenceRow[];
};

export type ReadingAnswerKeyPresentationInput = {
  questions: ReadingCorrectionQuestionRow[];
  options?: ReadingCorrectionOptionRow[];
  ctwSlots?: ReadingCorrectionCtwSlotRow[];
  anchors?: ReadingCorrectionAnchorRow[];
  sentences?: ReadingCorrectionSentenceRow[];
};

/**
 * Canonical correct-answer presentations for a read-only question bank. No
 * student answer exists, so only the correct answer and its review state are
 * filled. Keys are `question_id` for single-answer questions and
 * `question_id:slot_id` for CTW slots.
 */
export function buildReadingAnswerKeyPresentations(
  input: ReadingAnswerKeyPresentationInput
): Record<string, ReadingCorrectionAnswerPresentation> {
  const optionsByQuestion = groupBy(input.options ?? [], (option) => option.question_id);
  const anchorsByQuestion = groupBy(input.anchors ?? [], (anchor) => anchor.question_id);
  const sentenceById = new Map(
    (input.sentences ?? []).map((sentence) => [sentence.sentence_id, sentence])
  );
  const presentations: Record<string, ReadingCorrectionAnswerPresentation> = {};

  for (const question of input.questions) {
    if (question.question_type === "ctw") {
      for (const slot of input.ctwSlots ?? []) {
        if (slot.question_id !== question.question_id) continue;
        presentations[`${slot.question_id}:${slot.slot_id}`] = {
          correctAnswer: { kind: "ctw_word", parts: buildCtwCorrectAnswerParts(slot) },
          reviewState: undefined,
          studentAnswer: ""
        };
      }
      continue;
    }
    if (question.question_type === "rdl" || question.question_type === "rap_multiple_choice") {
      if (!question.correct_option_id) throw new Error("READING_ANSWER_KEY_OPTION_MISSING");
      presentations[question.question_id] = {
        correctAnswer: {
          kind: "text",
          text: formatChoiceAnswer(
            optionsByQuestion.get(question.question_id) ?? [],
            question.correct_option_id
          )
        },
        reviewState: {
          correctAnswerId: question.correct_option_id,
          kind: "choice",
          studentAnswerId: null
        },
        studentAnswer: ""
      };
      continue;
    }
    if (question.question_type === "rap_sentence_insertion") {
      if (!question.correct_anchor_id) throw new Error("READING_ANSWER_KEY_ANCHOR_MISSING");
      presentations[question.question_id] = {
        correctAnswer: {
          kind: "text",
          text: formatInsertionAnswer(
            anchorsByQuestion.get(question.question_id) ?? [],
            question.correct_anchor_id
          )
        },
        reviewState: {
          correctAnswerId: question.correct_anchor_id,
          kind: "insertion",
          studentAnswerId: null
        },
        studentAnswer: ""
      };
      continue;
    }
    if (question.question_type === "rap_sentence_selection") {
      if (!question.correct_sentence_id) throw new Error("READING_ANSWER_KEY_SENTENCE_MISSING");
      presentations[question.question_id] = {
        correctAnswer: {
          kind: "text",
          text: formatSentenceAnswer(
            sentenceById,
            question.correct_sentence_id,
            "READING_ANSWER_KEY_CORRECT_SENTENCE_MISSING"
          )
        },
        reviewState: {
          correctAnswerId: question.correct_sentence_id,
          kind: "sentence_selection",
          studentAnswerId: null
        },
        studentAnswer: ""
      };
      continue;
    }
    throw new Error("READING_ANSWER_KEY_QUESTION_TYPE_INVALID");
  }

  return presentations;
}

export function buildReadingCorrectionAnswerPresentations(
  input: ReadingCorrectionAnswerData
): Record<string, ReadingCorrectionAnswerPresentation> {
  const questionById = new Map(input.questions.map((question) => [question.question_id, question]));
  const optionsByQuestion = groupBy(input.options ?? [], (option) => option.question_id);
  const slotById = new Map((input.ctwSlots ?? []).map((slot) => [
    `${slot.question_id}:${slot.slot_id}`,
    slot
  ]));
  const anchorsByQuestion = groupBy(input.anchors ?? [], (anchor) => anchor.question_id);
  const sentenceById = new Map((input.sentences ?? []).map((sentence) => [
    sentence.sentence_id,
    sentence
  ]));

  return Object.fromEntries(input.correctionRows.map((row) => {
    const question = questionById.get(row.question_id);
    if (!question) throw new Error("READING_CORRECTION_RESULT_QUESTION_MISSING");

    let studentAnswer = "";
    let correctAnswer: ReadingCorrectionAnswerDisplay;
    let reviewState: ReadingCorrectionReviewState | undefined;
    if (row.answer_kind === "ctw_slot" && row.slot_id) {
      const slot = slotById.get(`${row.question_id}:${row.slot_id}`);
      if (!slot) throw new Error("READING_CORRECTION_RESULT_CTW_SLOT_MISSING");
      studentAnswer = row.student_answer
        ? buildCtwStudentWord(slot.display_text, slot.prefix, row.student_answer)
        : "未作答";
      correctAnswer = { kind: "ctw_word", parts: buildCtwCorrectAnswerParts(slot) };
    } else if (row.answer_kind === "option") {
      const options = optionsByQuestion.get(row.question_id) ?? [];
      if (!question.correct_option_id) throw new Error("READING_CORRECTION_RESULT_OPTION_KEY_MISSING");
      studentAnswer = row.student_answer
        ? formatChoiceAnswer(options, row.student_answer)
        : "未作答";
      correctAnswer = {
        kind: "text",
        text: formatChoiceAnswer(options, question.correct_option_id)
      };
      reviewState = {
        correctAnswerId: question.correct_option_id,
        kind: "choice",
        studentAnswerId: row.student_answer
      };
    } else if (row.answer_kind === "insertion_anchor") {
      const anchors = anchorsByQuestion.get(row.question_id) ?? [];
      if (!question.correct_anchor_id) throw new Error("READING_CORRECTION_RESULT_ANCHOR_KEY_MISSING");
      studentAnswer = row.student_answer
        ? formatInsertionAnswer(anchors, row.student_answer)
        : "未作答";
      correctAnswer = {
        kind: "text",
        text: formatInsertionAnswer(anchors, question.correct_anchor_id)
      };
      reviewState = {
        correctAnswerId: question.correct_anchor_id,
        kind: "insertion",
        studentAnswerId: row.student_answer
      };
    } else if (row.answer_kind === "sentence_selection") {
      if (!question.correct_sentence_id) throw new Error("READING_CORRECTION_RESULT_SENTENCE_KEY_MISSING");
      studentAnswer = row.student_answer
        ? formatSentenceAnswer(sentenceById, row.student_answer, "READING_CORRECTION_RESULT_STUDENT_SENTENCE_MISSING")
        : "未作答";
      correctAnswer = {
        kind: "text",
        text: formatSentenceAnswer(
          sentenceById,
          question.correct_sentence_id,
          "READING_CORRECTION_RESULT_CORRECT_SENTENCE_MISSING"
        )
      };
      reviewState = {
        correctAnswerId: question.correct_sentence_id,
        kind: "sentence_selection",
        studentAnswerId: row.student_answer
      };
    } else {
      throw new Error("READING_CORRECTION_RESULT_ANSWER_KIND_INVALID");
    }

    return [row.attempt_answer_id, { correctAnswer, reviewState, studentAnswer }];
  }));
}

export function readingCorrectionMarkState(
  presentation: ReadingCorrectionAnswerPresentation | undefined,
  kind: ReadingCorrectionReviewState["kind"],
  answerId: string
): ReadingCorrectionMarkState {
  const state = presentation?.reviewState;
  if (!state || state.kind !== kind) return null;
  if (answerId === state.correctAnswerId) return "correct";
  if (answerId === state.studentAnswerId) return "incorrect";
  return null;
}

export function buildReadingCorrectionResultAnswers(
  input: ReadingCorrectionAnswerData & { allResultAnswers: ReadingResultAnswer[] }
): ReadingCorrectionResultAnswer[] {
  const resultById = new Map(input.allResultAnswers.map((answer, reviewIndex) => [
    answer.answerId,
    { answer, reviewIndex }
  ]));
  const presentations = buildReadingCorrectionAnswerPresentations(input);

  return input.correctionRows.map((row) => {
    const result = resultById.get(row.attempt_answer_id);
    const presentation = presentations[row.attempt_answer_id];
    if (!result || !presentation) throw new Error("READING_CORRECTION_RESULT_BASE_MISSING");
    return {
      ...result.answer,
      ...presentation,
      reviewIndex: result.reviewIndex
    };
  }).sort((left, right) => left.order - right.order || left.answerId.localeCompare(right.answerId));
}

function formatChoiceAnswer(options: ReadingCorrectionOptionRow[], optionId: string) {
  const ordered = [...options].sort((left, right) => left.option_order - right.option_order);
  const optionIndex = ordered.findIndex((candidate) => candidate.option_id === optionId);
  if (optionIndex < 0) throw new Error("READING_CORRECTION_RESULT_OPTION_MISSING");
  return ordered.length <= 26
    ? String.fromCharCode(65 + optionIndex)
    : ordered[optionIndex].option_text;
}

function formatInsertionAnswer(anchors: ReadingCorrectionAnchorRow[], anchorId: string) {
  const anchor = anchors.find((candidate) => candidate.anchor_id === anchorId);
  if (!anchor) throw new Error("READING_CORRECTION_RESULT_ANCHOR_MISSING");
  return `Position ${anchor.anchor_order}`;
}

function formatSentenceAnswer(
  sentences: Map<string, ReadingCorrectionSentenceRow>,
  sentenceId: string,
  missingCode: string
) {
  const sentence = requiredMapValue(sentences, sentenceId, missingCode);
  return `Sentence ${sentence.sentence_order}`;
}

function buildCtwStudentWord(displayText: string, prefix: string, studentMissingText: string) {
  const fromPattern = fillCtwPattern(displayText, Array.from(studentMissingText));
  return fromPattern ?? `${prefix}${studentMissingText}`;
}

function buildCtwCorrectAnswerParts(slot: ReadingCorrectionCtwSlotRow) {
  const answerCharacters = Array.from(slot.answer);
  const patternParts = mapCtwPattern(slot.display_text, answerCharacters);
  if (patternParts) return mergeAdjacentParts(patternParts);

  const prefixCharacters = Array.from(slot.prefix);
  const missingCharacters = Array.from(slot.missing_text);
  if (`${slot.prefix}${slot.missing_text}` === slot.answer) {
    return mergeAdjacentParts([
      { emphasized: false, text: prefixCharacters.join("") },
      { emphasized: true, text: missingCharacters.join("") }
    ]);
  }
  throw new Error("READING_CORRECTION_RESULT_CTW_PATTERN_INVALID");
}

function fillCtwPattern(displayText: string, missingCharacters: string[]) {
  let missingIndex = 0;
  let result = "";
  for (const character of Array.from(displayText)) {
    if (character === "_") {
      result += missingCharacters[missingIndex] ?? "";
      missingIndex += 1;
    } else if (!isBlankSeparator(character)) {
      result += character;
    }
  }
  return missingIndex === missingCharacters.length ? result : null;
}

function mapCtwPattern(displayText: string, answerCharacters: string[]) {
  const parts: ReadingCorrectionAnswerPart[] = [];
  let answerIndex = 0;
  for (const character of Array.from(displayText)) {
    if (isBlankSeparator(character)) continue;
    const answerCharacter = answerCharacters[answerIndex];
    if (answerCharacter === undefined) return null;
    if (character !== "_" && character !== answerCharacter) return null;
    parts.push({ emphasized: character === "_", text: answerCharacter });
    answerIndex += 1;
  }
  return answerIndex === answerCharacters.length ? parts : null;
}

function isBlankSeparator(character: string) {
  return /\s/.test(character);
}

function mergeAdjacentParts(parts: ReadingCorrectionAnswerPart[]) {
  return parts.reduce<ReadingCorrectionAnswerPart[]>((merged, part) => {
    if (!part.text) return merged;
    const previous = merged.at(-1);
    if (previous?.emphasized === part.emphasized) {
      previous.text += part.text;
    } else {
      merged.push({ ...part });
    }
    return merged;
  }, []);
}

function groupBy<T>(values: T[], keyFor: (value: T) => string) {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    groups.set(key, [...(groups.get(key) ?? []), value]);
  }
  return groups;
}

function requiredMapValue<T>(map: Map<string, T>, key: string, errorCode: string) {
  const value = map.get(key);
  if (value === undefined) throw new Error(errorCode);
  return value;
}
