export type WritingTaskType = "email" | "academic_discussion";
export type WritingAttemptStatus = "draft" | "submitted";
export type WritingMode = "exam" | "practice";
export type WritingOvertimeRange = { start: number; end: number };

export const WRITING_TASK_CONFIG = {
  email: {
    label: "Write an Email",
    listHref: "/student/write-email",
    practiceHref: "/student/write-email/practice",
    submissionHref: "/student/write-email/submission",
    questionTable: "email_questions",
    timeLimitSeconds: 420
  },
  academic_discussion: {
    label: "Academic Discussion",
    listHref: "/student/academic-discussion",
    practiceHref: "/student/academic-discussion/practice",
    submissionHref: "/student/academic-discussion/submission",
    questionTable: "academic_discussion_questions",
    timeLimitSeconds: 600
  }
} as const;

export type EmailQuestion = {
  question_id: string;
  set_id: string;
  set_title: string;
  year_month: string;
  source_labels: string;
  scenario: string;
  task_instruction: string;
  requirement_1: string;
  requirement_2: string;
  requirement_3: string;
  closing_instruction: string;
  recipient: string;
  subject: string;
};

export type AcademicDiscussionQuestion = {
  question_id: string;
  set_id: string;
  set_title: string;
  year_month: string;
  source_labels: string;
  professor_name: string;
  professor_prompt: string;
  student_1_name: string;
  student_1_response: string;
  student_2_name: string;
  student_2_response: string;
};

export type WritingQuestion = EmailQuestion | AcademicDiscussionQuestion;

export type WritingAttempt = {
  attempt_id: string;
  user_id: string;
  task_type: WritingTaskType;
  question_id: string;
  set_id: string;
  response_text: string;
  word_count: number;
  status: WritingAttemptStatus;
  time_limit_seconds: number;
  remaining_seconds: number;
  writing_mode: WritingMode | null;
  elapsed_seconds: number | null;
  overtime_ranges: WritingOvertimeRange[] | null;
  started_at: string;
  saved_at: string | null;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type WritingCatalogMonth = {
  month_key: string;
  month_label: string;
  set_count: number;
};

export type WritingCatalogSet = {
  question_id: string;
  set_id: string;
  set_title: string;
  year_month: string;
  status: "not_started" | WritingAttemptStatus;
  draft_attempt_id: string | null;
  draft_word_count: number | null;
  draft_saved_at: string | null;
  submitted_attempt_id: string | null;
  submitted_at: string | null;
  submitted_attempt_count: number;
  published_review_attempt_id: string | null;
};

export type WritingCatalogPayload = {
  months: WritingCatalogMonth[];
  sets: WritingCatalogSet[];
  latestDraft: WritingCatalogSet | null;
  error?: string;
};

export type WritingOverviewPayload = {
  submittedCount: number;
  currentMonthCount: number;
  learningDates: string[];
  pendingFeedbackCount: number;
  error?: string;
};

export function formatWritingMonthLabel(monthKey: string) {
  if (!/^\d{6}$/.test(monthKey)) return monthKey;
  const month = Number(monthKey.slice(4, 6));
  if (month < 1 || month > 12) return monthKey;
  return `${monthKey.slice(0, 4)}年${month}月`;
}

export function compareWritingSetTitles(left: string, right: string) {
  const leftKey = writingSetSortKey(left);
  const rightKey = writingSetSortKey(right);
  return (
    leftKey.month - rightKey.month ||
    leftKey.day - rightKey.day ||
    leftKey.variant.localeCompare(rightKey.variant) ||
    left.localeCompare(right)
  );
}

function writingSetSortKey(title: string) {
  const match = title.trim().match(/^(\d{1,2})\.(\d{1,2})(.*)$/);
  return {
    month: match ? Number(match[1]) : Number.MAX_SAFE_INTEGER,
    day: match ? Number(match[2]) : Number.MAX_SAFE_INTEGER,
    variant: match?.[3]?.trim() ?? title
  };
}

export function countEnglishWords(text: string) {
  return text.match(/[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*/g)?.length ?? 0;
}

export function formatWritingTimer(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(
    seconds % 60
  ).padStart(2, "0")}`;
}

export const formatElapsedWritingTime = formatWritingTimer;

export function isWritingMode(value: unknown): value is WritingMode {
  return value === "exam" || value === "practice";
}

export function formatWritingAttemptSummary(
  mode: WritingMode | null | undefined,
  elapsedSeconds: number | null | undefined
) {
  if (!mode || !Number.isFinite(elapsedSeconds)) return "—";
  return `${mode === "exam" ? "模考模式" : "练习模式"} ｜ ${formatElapsedWritingTime(
    elapsedSeconds as number
  )}`;
}

export function writingElapsedSeconds(startedAt: string, now = Date.now()) {
  const started = Date.parse(startedAt);
  return Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 1000)) : 0;
}

export function isWritingTaskType(value: unknown): value is WritingTaskType {
  return value === "email" || value === "academic_discussion";
}

export function buildWritingAttemptUpdate({
  action,
  now,
  elapsedSeconds,
  overtimeRanges,
  remainingSeconds,
  responseText
}: {
  action: "sync" | "save" | "submit";
  now: string;
  elapsedSeconds: number;
  overtimeRanges: WritingOvertimeRange[];
  remainingSeconds: number;
  responseText?: unknown;
}) {
  const update: Record<string, unknown> = {
    elapsed_seconds: Math.max(0, Math.floor(elapsedSeconds)),
    overtime_ranges: overtimeRanges,
    remaining_seconds: remainingSeconds
  };

  if (responseText !== undefined) {
    if (typeof responseText !== "string") return null;
    update.response_text = responseText;
    update.word_count = countEnglishWords(responseText);
    update.saved_at = now;
  } else if (action === "save" || action === "submit") {
    return null;
  }

  if (action === "submit") {
    update.status = "submitted";
    update.submitted_at = now;
  }

  return update;
}
