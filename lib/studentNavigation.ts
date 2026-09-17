import { STUDENT_UI_TEXT } from "./studentUiText.ts";

export const STUDENT_ROUTES = {
  home: "/student/sets",
  buildASentence: "/student/practice-sets",
  writeEmail: "/student/write-email",
  academicDiscussion: "/student/academic-discussion",
  assignments: "/student/assignments",
  writingReviews: "/student/writing-reviews",
  practiceSets: "/student/practice-sets",
  practiceHistory: "/student/practice-history",
  readingHistory: "/student/reading/history",
  readingCtw: "/student/reading/ctw",
  readingRdl: "/student/reading/rdl",
  readingRap: "/student/reading/rap",
  readingFullSets: "/student/reading/full-sets",
  grammarPractice: "/student/grammar-practice",
  wrongQuestions: "/student/wrong-questions"
} as const;

export type StudentBreadcrumbItem = {
  href?: string;
  label: string;
};

export type ReadingResultSource = "practice-history";

const READING_RESULT_DESTINATIONS = {
  ctw: { href: STUDENT_ROUTES.readingCtw, label: "Complete the Words" },
  rdl: { href: STUDENT_ROUTES.readingRdl, label: "Read in Daily Life" },
  rap: { href: STUDENT_ROUTES.readingRap, label: "Read an Academic Passage" }
} as const;

export function parseReadingResultSource(
  value: string | string[] | undefined
): ReadingResultSource | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate === "practice-history" ? candidate : undefined;
}

export function withReadingResultSource(href: string, source?: ReadingResultSource) {
  if (!source) return href;
  const separator = href.includes("?") ? "&" : "?";
  return `${href}${separator}source=${encodeURIComponent(source)}`;
}

export function readingResultHref(attemptId: string, source?: ReadingResultSource) {
  return withReadingResultSource(
    `/student/reading/results/${encodeURIComponent(attemptId)}`,
    source
  );
}

export function readingFullSetResultHref(
  fullSetId: string,
  attemptId: string,
  source?: ReadingResultSource
) {
  return withReadingResultSource(
    `${STUDENT_ROUTES.readingFullSets}/${encodeURIComponent(fullSetId)}/result/${encodeURIComponent(attemptId)}`,
    source
  );
}

export function getReadingResultNavigation(
  taskType: keyof typeof READING_RESULT_DESTINATIONS,
  source?: ReadingResultSource
): { backHref: string; crumbs: StudentBreadcrumbItem[] } {
  const rootCrumb = { label: STUDENT_UI_TEXT.studentHome, href: STUDENT_ROUTES.home };
  if (source === "practice-history") {
    return {
      backHref: STUDENT_ROUTES.practiceHistory,
      crumbs: [
        rootCrumb,
        { label: STUDENT_UI_TEXT.practiceHistory, href: STUDENT_ROUTES.practiceHistory },
        { label: "查看结果" }
      ]
    };
  }
  const destination = READING_RESULT_DESTINATIONS[taskType];
  return {
    backHref: destination.href,
    crumbs: [
      rootCrumb,
      { label: destination.label, href: destination.href },
      { label: STUDENT_UI_TEXT.result }
    ]
  };
}

export function getReadingFullSetResultNavigation(
  title: string,
  source?: ReadingResultSource
): { backHref: string; crumbs: StudentBreadcrumbItem[] } {
  const rootCrumb = { label: STUDENT_UI_TEXT.studentHome, href: STUDENT_ROUTES.home };
  if (source === "practice-history") {
    return {
      backHref: STUDENT_ROUTES.practiceHistory,
      crumbs: [
        rootCrumb,
        { label: STUDENT_UI_TEXT.practiceHistory, href: STUDENT_ROUTES.practiceHistory },
        { label: title }
      ]
    };
  }
  return {
    backHref: STUDENT_ROUTES.readingFullSets,
    crumbs: [
      rootCrumb,
      { label: "Full Set Practice", href: STUDENT_ROUTES.readingFullSets },
      { label: title }
    ]
  };
}

export function safeStudentReturnTo(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || candidate.includes("\\")) return undefined;
  try {
    const base = "https://tps.local";
    const parsed = new URL(candidate, base);
    return parsed.origin === base && parsed.pathname.startsWith("/student/")
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : undefined;
  } catch {
    return undefined;
  }
}

export function writingReviewResultHref(attemptId: string, returnTo: string) {
  const params = new URLSearchParams({ returnTo: safeWritingReviewReturnTo(returnTo) });
  return `${STUDENT_ROUTES.writingReviews}/${encodeURIComponent(attemptId)}?${params}`;
}

export function safeWritingReviewReturnTo(value: string | string[] | undefined) {
  return safeStudentReturnTo(value) ?? STUDENT_ROUTES.writingReviews;
}

export function writingSubmissionResultHref(
  taskType: "email" | "academic_discussion",
  attemptId: string,
  returnTo?: string
) {
  const section = taskType === "email" ? "write-email" : "academic-discussion";
  const href = `/student/${section}/submission/${encodeURIComponent(attemptId)}`;
  const safeReturnTo = safeStudentReturnTo(returnTo);
  return safeReturnTo
    ? `${href}?${new URLSearchParams({ returnTo: safeReturnTo })}`
    : href;
}

export function getWritingResultNavigation(
  taskType: "email" | "academic_discussion",
  assignmentId?: string | null,
  returnTo?: string
): { backHref: string; backLabel: string } {
  const safeReturnTo = safeStudentReturnTo(returnTo);
  if (safeReturnTo) {
    return {
      backHref: safeReturnTo,
      backLabel: safeReturnTo.startsWith(STUDENT_ROUTES.practiceHistory)
        ? "返回练习历史"
        : safeReturnTo.includes("/submissions/")
          ? "返回提交记录"
          : "返回"
    };
  }
  if (assignmentId) {
    return { backHref: STUDENT_ROUTES.assignments, backLabel: "返回作业" };
  }
  const backHref = taskType === "email"
    ? STUDENT_ROUTES.writeEmail
    : STUDENT_ROUTES.academicDiscussion;
  return { backHref, backLabel: "返回题目列表" };
}

export function writingSubmissionHistoryHref(
  taskType: "email" | "academic_discussion",
  questionId: string
) {
  const section = taskType === "email" ? "write-email" : "academic-discussion";
  return `/student/${section}/submissions/${encodeURIComponent(questionId)}`;
}

export type StudentResultSource =
  | "practice-history"
  | "practice-history-history"
  | "practice-history-today";

export function formatPracticeMonthLabel(monthKey: string) {
  const month = Number(monthKey.slice(4, 6));
  if (!/^\d{6}$/.test(monthKey) || month < 1 || month > 12) return monthKey;
  return `${monthKey.slice(0, 4)}年${month}月`;
}

export function getPracticeMonthKey(setId: string) {
  const monthKey = setId.split("-")[0] ?? "";
  return /^\d{6}$/.test(monthKey) ? monthKey : "";
}

export function isWrongQuestionsSetId(setId: string) {
  return setId.startsWith("wrongbook-");
}

export function isGrammarPracticeSetId(setId: string) {
  return setId.startsWith("grammar-all-") || setId.startsWith("grammar-random-");
}

export function isVirtualPracticeSetId(setId: string) {
  return isWrongQuestionsSetId(setId) || isGrammarPracticeSetId(setId);
}

export function getStudentResultNavigation(
  setId: string,
  options?: { historySetId?: string; source?: StudentResultSource }
): {
  backHref: string;
  crumbs: StudentBreadcrumbItem[];
} {
  const rootCrumb = { label: STUDENT_UI_TEXT.studentHome, href: STUDENT_ROUTES.home };
  const wrongQuestionsCrumb = {
    label: STUDENT_UI_TEXT.wrongQuestions,
    href: STUDENT_ROUTES.wrongQuestions
  };

  if (isWrongQuestionsSetId(setId)) {
    return {
      backHref: STUDENT_ROUTES.wrongQuestions,
      crumbs: [
        { label: STUDENT_UI_TEXT.studentHome, href: "/student" },
        wrongQuestionsCrumb,
        { label: STUDENT_UI_TEXT.result }
      ]
    };
  }

  if (options?.source) {
    if (options.source === "practice-history") {
      return {
        backHref: STUDENT_ROUTES.practiceHistory,
        crumbs: [
          rootCrumb,
          { label: STUDENT_UI_TEXT.practiceHistory, href: STUDENT_ROUTES.practiceHistory },
          { label: "查看结果" }
        ]
      };
    }
    const scope = options.source === "practice-history-today" ? "today" : "history";
    const scopeLabel = scope === "today" ? "今日练习套题" : "历史练习套题";
    const historyHomeHref = `${STUDENT_ROUTES.practiceHistory}?tab=${scope}`;
    const historySetsHref = `${STUDENT_ROUTES.practiceHistory}/sets?scope=${scope}`;
    const reliableSetId =
      options.historySetId?.trim() === setId ? options.historySetId.trim() : setId;
    const setAttemptsHref = `${STUDENT_ROUTES.practiceHistory}/sets/${encodeURIComponent(
      reliableSetId
    )}?scope=${scope}`;

    return {
      backHref: setAttemptsHref,
      crumbs: [
        rootCrumb,
        { label: STUDENT_UI_TEXT.practiceHistory, href: historyHomeHref },
        { label: scopeLabel, href: historySetsHref },
        { label: reliableSetId, href: setAttemptsHref },
        { label: "查看结果" }
      ]
    };
  }

  if (isGrammarPracticeSetId(setId)) {
    return {
      backHref: STUDENT_ROUTES.grammarPractice,
      crumbs: [
        rootCrumb,
        { label: STUDENT_UI_TEXT.grammarPractice, href: STUDENT_ROUTES.grammarPractice },
        { label: STUDENT_UI_TEXT.result }
      ]
    };
  }

  const practiceSetsCrumb = {
    label: STUDENT_UI_TEXT.practiceSets,
    href: STUDENT_ROUTES.practiceSets
  };
  return {
    backHref: STUDENT_ROUTES.practiceSets,
    crumbs: [
      rootCrumb,
      practiceSetsCrumb,
      { label: STUDENT_UI_TEXT.result }
    ]
  };
}
