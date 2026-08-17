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
  grammarPractice: "/student/grammar-practice",
  wrongQuestions: "/student/wrong-questions"
} as const;

export type StudentBreadcrumbItem = {
  href?: string;
  label: string;
};

export function writingReviewResultHref(attemptId: string, returnTo: string) {
  const params = new URLSearchParams({ returnTo: safeWritingReviewReturnTo(returnTo) });
  return `${STUDENT_ROUTES.writingReviews}/${encodeURIComponent(attemptId)}?${params}`;
}

export function safeWritingReviewReturnTo(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || candidate.includes("\\")) return STUDENT_ROUTES.writingReviews;
  try {
    const base = "https://tps.local";
    const parsed = new URL(candidate, base);
    return parsed.origin === base && parsed.pathname.startsWith("/student/")
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : STUDENT_ROUTES.writingReviews;
  } catch {
    return STUDENT_ROUTES.writingReviews;
  }
}

export function writingSubmissionHistoryHref(
  taskType: "email" | "academic_discussion",
  questionId: string
) {
  const section = taskType === "email" ? "write-email" : "academic-discussion";
  return `/student/${section}/submissions/${encodeURIComponent(questionId)}`;
}

export type StudentResultSource =
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

  const monthKey = getPracticeMonthKey(setId);
  const practiceSetsCrumb = {
    label: STUDENT_UI_TEXT.practiceSets,
    href: STUDENT_ROUTES.practiceSets
  };
  if (!monthKey) {
    return {
      backHref: STUDENT_ROUTES.practiceSets,
      crumbs: [rootCrumb, practiceSetsCrumb, { label: STUDENT_UI_TEXT.result }]
    };
  }

  const monthHref = `${STUDENT_ROUTES.practiceSets}/${encodeURIComponent(monthKey)}`;
  return {
    backHref: monthHref,
    crumbs: [
      rootCrumb,
      practiceSetsCrumb,
      { label: formatPracticeMonthLabel(monthKey), href: monthHref },
      { label: STUDENT_UI_TEXT.result }
    ]
  };
}
