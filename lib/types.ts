export type UserRole = "student" | "teacher";

export type PracticeSet = {
  set_id: string;
  set_title: string;
  question_count: number;
  completed: boolean;
  latest_attempt_id: string | null;
  description?: string | null;
  level?: string | null;
  is_active?: boolean;
};

export type PracticeMonth = {
  month_key: string;
  month_label: string;
  set_count: number;
  question_count: number;
};

export type Question = {
  question_id: string;
  set_id: string;
  set_title: string;
  question_order: number;
  prompt: string;
  sentence_template: string;
  blank_count: number;
  options_text: string;
  correct_order_text: string;
  distractors_text: string | null;
  final_sentence: string;
  grammar_tags_text: string | null;
};

export type PublicQuestion = Omit<Question, "correct_order_text" | "final_sentence">;

export type AnswerResult = {
  questionId: string;
  submittedOrderText: string;
  isCorrect: boolean;
};

export type SubmitResponse = {
  attemptId: string;
  correctCount: number;
  total: number;
  accuracy: number;
  timeSpentSeconds: number;
  results: AnswerResult[];
};
