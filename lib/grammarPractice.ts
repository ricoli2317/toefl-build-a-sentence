import type { PublicQuestion } from "@/lib/types";

export type GrammarQuestionRow = PublicQuestion & {
  final_sentence: string | null;
};

export type GrammarTagSummary = {
  tag: string;
  questionCount: number;
};

export const GRAMMAR_PRACTICE_QUESTION_LIMIT = 10;
export const GRAMMAR_PRACTICE_TIME_SECONDS = 6 * 60 + 50;

export type GrammarPracticeMode = "all" | "random";

export function normalizeGrammarPracticeMode(value: unknown): GrammarPracticeMode {
  return value === "random" ? "random" : "all";
}

/**
 * Server-side BAS mode policy. A Student may still preview random questions
 * with the GET endpoint, but may not create a new unlimited `all` practice
 * when enforcement is ON. Teacher/Admin keep the existing all-mode behavior.
 */
export function grammarPracticeModePolicy(input: {
  role: string;
  enforcementEnabled: boolean;
  mode: GrammarPracticeMode;
}): { allowed: boolean; message?: string } {
  if (
    input.role === "student" &&
    input.enforcementEnabled &&
    input.mode === "all"
  ) {
    return {
      allowed: false,
      message: "学生端暂只支持随机计时练习，请从语法分类选择随机练习。"
    };
  }
  return { allowed: true };
}

export type GrammarPracticeDraft = {
  answers: Record<string, string[]>;
  questionTimes: Record<string, number>;
  currentIndex: number;
  elapsedSeconds: number;
  paused?: boolean;
  revision: number;
};

export type GrammarPracticeSessionCategory = {
  category: string;
  count: number;
};

export type GrammarPracticeSession = {
  sessionId: string;
  category: string;
  mode: "random" | "assignment";
  origin: "self_practice" | "teacher_assigned";
  assignmentId?: string | null;
  status: "active" | "completed";
  questions: PublicQuestion[];
  categories?: GrammarPracticeSessionCategory[];
  draft: Partial<GrammarPracticeDraft>;
  startedAt: string;
  completedAt: string | null;
  elapsedSeconds: number;
  totalQuestions: number;
  correctCount: number;
  attemptId: string | null;
};

export type GrammarPracticeSessionPayload = {
  session: GrammarPracticeSession;
  created?: boolean;
};

export function parseGrammarTags(value: string | null | undefined) {
  const normalized = value?.trim() ?? "";
  if (!normalized || normalized === "[]") return [];

  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    try {
      const parsed = JSON.parse(normalized) as unknown;
      if (Array.isArray(parsed)) {
        return uniqueTags(parsed.map((tag) => String(tag)));
      }
    } catch {
      return [];
    }
  }

  return uniqueTags(normalized.split(";"));
}

export function normalizeFinalSentence(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function compareGrammarQuestions(
  left: Pick<GrammarQuestionRow, "set_id" | "question_order" | "question_id">,
  right: Pick<GrammarQuestionRow, "set_id" | "question_order" | "question_id">
) {
  return (
    left.set_id.localeCompare(right.set_id) ||
    left.question_order - right.question_order ||
    left.question_id.localeCompare(right.question_id)
  );
}

export function dedupeGrammarQuestions(questions: GrammarQuestionRow[]) {
  const uniqueBySentence = new Map<string, GrammarQuestionRow>();

  for (const question of [...questions].sort(compareGrammarQuestions)) {
    const sentence = normalizeFinalSentence(question.final_sentence);
    const key = sentence
      ? `sentence:${sentence}`
      : `question:${question.question_id}`;
    if (!uniqueBySentence.has(key)) uniqueBySentence.set(key, question);
  }

  return Array.from(uniqueBySentence.values());
}

export function getGrammarTagSummaries(questions: GrammarQuestionRow[]) {
  const questionsByTag = new Map<string, GrammarQuestionRow[]>();

  for (const question of questions) {
    for (const tag of parseGrammarTags(question.grammar_tags_text)) {
      questionsByTag.set(tag, [...(questionsByTag.get(tag) ?? []), question]);
    }
  }

  return Array.from(questionsByTag, ([tag, taggedQuestions]) => ({
    tag,
    questionCount: dedupeGrammarQuestions(taggedQuestions).length
  })).sort((left, right) => left.tag.localeCompare(right.tag));
}

export function questionHasGrammarTag(
  question: Pick<GrammarQuestionRow, "grammar_tags_text">,
  selectedTag: string
) {
  return parseGrammarTags(question.grammar_tags_text).includes(selectedTag);
}

export function shuffleQuestions<T>(questions: T[]) {
  const shuffled = [...questions];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function uniqueTags(tags: string[]) {
  return Array.from(
    new Set(tags.map((tag) => tag.replace(/\s+/g, " ").trim()).filter(Boolean))
  );
}
