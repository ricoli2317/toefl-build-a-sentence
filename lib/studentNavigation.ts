import { STUDENT_UI_TEXT } from "./studentUiText.ts";

export const STUDENT_ROUTES = {
  home: "/student/sets",
  buildASentence: "/student/practice-sets",
  buildASentencePractice: "/student/practice",
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
  source?: ReadingResultSource,
  returnTo?: string | string[]
): { backHref: string; crumbs: StudentBreadcrumbItem[] } {
  const rootCrumb = { label: STUDENT_UI_TEXT.studentHome, href: STUDENT_ROUTES.home };
  const safeReturnTo = safeStudentReturnTo(returnTo);
  if (safeReturnTo) {
    if (isPracticeHistoryReturnTo(safeReturnTo)) {
      return practiceHistoryReturnNavigation(safeReturnTo);
    }
    if (
      safeReturnTo.startsWith(STUDENT_ROUTES.wrongQuestions)
      || safeReturnTo.startsWith("/student/reading/wrongbook-results/")
    ) {
      return {
        backHref: safeReturnTo,
        crumbs: [
          rootCrumb,
          { label: STUDENT_UI_TEXT.wrongQuestions, href: STUDENT_ROUTES.wrongQuestions },
          { label: STUDENT_UI_TEXT.result }
        ]
      };
    }
    const origin = resolveEntryCorrectionOrigin(safeReturnTo);
    if (origin.kind === "reading-result" || origin.kind === "full-set-result") {
      const originSource = parseReadingResultSource(
        new URL(origin.href, "https://tps.local").searchParams.get("source") ?? undefined
      );
      const chainCrumb: StudentBreadcrumbItem = originSource === "practice-history"
        ? { label: STUDENT_UI_TEXT.practiceHistory, href: STUDENT_ROUTES.practiceHistory }
        : origin.kind === "full-set-result"
          ? { label: "Full Set Practice", href: STUDENT_ROUTES.readingFullSets }
          : {
              label: READING_RESULT_DESTINATIONS[taskType].label,
              href: READING_RESULT_DESTINATIONS[taskType].href
            };
      return {
        backHref: safeReturnTo,
        crumbs: [
          rootCrumb,
          chainCrumb,
          { label: "查看结果", href: origin.href },
          { label: STUDENT_UI_TEXT.result }
        ]
      };
    }
    return assignmentResultNavigation(safeReturnTo);
  }
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
  source?: ReadingResultSource,
  returnTo?: string | string[]
): { backHref: string; crumbs: StudentBreadcrumbItem[] } {
  const safeReturnTo = safeStudentReturnTo(returnTo);
  if (safeReturnTo) {
    if (isPracticeHistoryReturnTo(safeReturnTo)) {
      return practiceHistoryReturnNavigation(safeReturnTo, title);
    }
    return assignmentResultNavigation(safeReturnTo);
  }
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

/** Exact practice-history page (with its date / range / filter params). */
function isPracticeHistoryReturnTo(safeReturnTo: string) {
  try {
    return new URL(safeReturnTo, "https://tps.local").pathname
      === STUDENT_ROUTES.practiceHistory;
  } catch {
    return false;
  }
}

/**
 * A result opened from practice history keeps that exact state as its back
 * target (date, task filter and active range), with the ordinary history
 * breadcrumb instead of the Assignment chain.
 */
function practiceHistoryReturnNavigation(
  returnTo: string,
  lastLabel = "查看结果"
): { backHref: string; crumbs: StudentBreadcrumbItem[] } {
  return {
    backHref: returnTo,
    crumbs: [
      { label: STUDENT_UI_TEXT.studentHome, href: STUDENT_ROUTES.home },
      { label: STUDENT_UI_TEXT.practiceHistory, href: STUDENT_ROUTES.practiceHistory },
      { label: lastLabel }
    ]
  };
}

/**
 * The one safe origin-aware link helper for Assignment-entered student routes.
 * `returnTo` is always a same-site `/student/...` path; anything else is
 * dropped, so an Assignment link can never become an open redirect and the
 * ordinary catalog links (no returnTo) keep their own back behavior.
 */
export function withStudentReturnTo(href: string, returnTo?: string | string[] | null) {
  const safeReturnTo = safeStudentReturnTo(returnTo ?? undefined);
  if (!safeReturnTo) return href;
  const separator = href.includes("?") ? "&" : "?";
  return `${href}${separator}returnTo=${encodeURIComponent(safeReturnTo)}`;
}

export function writingReviewResultHref(attemptId: string, returnTo: string) {
  const params = new URLSearchParams({ returnTo: safeWritingReviewReturnTo(returnTo) });
  return `${STUDENT_ROUTES.writingReviews}/${encodeURIComponent(attemptId)}?${params}`;
}

/**
 * The one shared back navigation for any student route entered from an
 * Assignment (practice or result): the Assignment Detail is restored exactly,
 * including its own returnTo, while the ordinary catalog flow (no returnTo)
 * keeps its default destination.
 */
export function assignmentResultNavigation(returnTo: string): {
  backHref: string;
  crumbs: StudentBreadcrumbItem[];
} {
  return {
    backHref: returnTo,
    crumbs: [
      { label: STUDENT_UI_TEXT.studentHome, href: STUDENT_ROUTES.home },
      { label: "我的作业", href: STUDENT_ROUTES.assignments },
      { label: STUDENT_UI_TEXT.result }
    ]
  };
}

type EntryCorrectionOrigin =
  | { href: string; kind: "assignments" | "full-set-result" | "reading-result" | "unknown" | "wrong-questions" };

/**
 * Resolves the true entry origin of an entry-level correction from the one
 * validated `returnTo` chain. Nested correction results / read-only review
 * links embed their own returnTo, so the chain is followed (with a depth limit)
 * until a terminal page type is found. Only same-site `/student/...` links are
 * ever followed, so an invalid or external target can never influence the
 * derived navigation.
 */
function resolveEntryCorrectionOrigin(safeReturnTo: string, depth = 0): EntryCorrectionOrigin {
  if (depth > 4) return { href: safeReturnTo, kind: "unknown" };
  let parsed: URL;
  try {
    parsed = new URL(safeReturnTo, "https://tps.local");
  } catch {
    return { href: safeReturnTo, kind: "unknown" };
  }
  const pathname = parsed.pathname;
  if (pathname.startsWith(STUDENT_ROUTES.wrongQuestions)) {
    return { href: safeReturnTo, kind: "wrong-questions" };
  }
  // Single-item practice surfaces: the result page and its read-only review
  // (result chips link to `.../questions/{index}`). Both are the "单项练习"
  // origin for an entry correction.
  if (/^\/student\/reading\/results\/[^/]+(?:\/questions\/[^/]+)?\/?$/.test(pathname)) {
    return { href: safeReturnTo, kind: "reading-result" };
  }
  if (/^\/student\/reading\/full-sets\/[^/]+\/result\/[^/]+\/?$/.test(pathname)) {
    return { href: safeReturnTo, kind: "full-set-result" };
  }
  if (pathname.startsWith(STUDENT_ROUTES.assignments)) {
    return { href: safeReturnTo, kind: "assignments" };
  }
  if (pathname.startsWith("/student/reading/wrongbook-results/")) {
    const nested = safeStudentReturnTo(parsed.searchParams.get("returnTo") ?? undefined);
    if (nested) return resolveEntryCorrectionOrigin(nested, depth + 1);
    // A read-only review questions link has no embedded origin: its own result
    // page is one level up, but that page's origin stays unknown.
    const resultPath = pathname.replace(/\/questions(?:\/[^/]*)?$/, "");
    if (resultPath !== pathname) return { href: resultPath, kind: "unknown" };
    return { href: safeReturnTo, kind: "unknown" };
  }
  return { href: safeReturnTo, kind: "unknown" };
}

function correctionOriginChainCrumb(
  origin: EntryCorrectionOrigin,
  taskType?: "ctw" | "full_set" | "rdl" | "rap" | null
): StudentBreadcrumbItem {
  const originSource = parseReadingResultSource(
    new URL(origin.href, "https://tps.local").searchParams.get("source") ?? undefined
  );
  if (originSource === "practice-history") {
    return { label: STUDENT_UI_TEXT.practiceHistory, href: STUDENT_ROUTES.practiceHistory };
  }
  if (origin.kind === "full-set-result") {
    return { label: "Full Set Practice", href: STUDENT_ROUTES.readingFullSets };
  }
  if (taskType && taskType in READING_RESULT_DESTINATIONS) {
    const destination = READING_RESULT_DESTINATIONS[taskType as keyof typeof READING_RESULT_DESTINATIONS];
    return { label: destination.label, href: destination.href };
  }
  return { label: STUDENT_UI_TEXT.practiceSets, href: STUDENT_ROUTES.buildASentence };
}

/**
 * Entry-correction result ("订正结果") navigation. The parent levels are always
 * derived from the validated `returnTo` chain: a correction started from a
 * Reading / Full Set / BAS practice result keeps that practice chain, while a
 * correction started inside the wrong-question bank keeps the 错题集 chain.
 * Only the last level is plain text; every parent level is a working link.
 */
export function getReadingCorrectionResultNavigation(
  returnTo?: string | string[] | null,
  taskType?: "ctw" | "full_set" | "rdl" | "rap" | null
): { backHref: string; crumbs: StudentBreadcrumbItem[] } {
  const rootCrumb = { label: STUDENT_UI_TEXT.studentHome, href: STUDENT_ROUTES.home };
  const wrongQuestionsCrumb = {
    label: STUDENT_UI_TEXT.wrongQuestions,
    href: STUDENT_ROUTES.wrongQuestions
  };
  const safeReturnTo = safeStudentReturnTo(returnTo ?? undefined);
  if (!safeReturnTo) {
    return {
      backHref: STUDENT_ROUTES.wrongQuestions,
      crumbs: [rootCrumb, wrongQuestionsCrumb, { label: "订正结果" }]
    };
  }
  const origin = resolveEntryCorrectionOrigin(safeReturnTo);
  if (origin.kind === "reading-result") {
    // A correction started from a single-item practice — its result page or its
    // read-only review — returns to the task-type catalog after finishing, and
    // its breadcrumb shows that same practice chain instead of 错题集.
    const destination = taskType && taskType !== "full_set"
      ? READING_RESULT_DESTINATIONS[taskType]
      : null;
    if (destination) {
      return {
        backHref: destination.href,
        crumbs: [
          rootCrumb,
          { label: destination.label, href: destination.href },
          { label: "订正结果" }
        ]
      };
    }
    return {
      backHref: safeReturnTo,
      crumbs: [
        rootCrumb,
        correctionOriginChainCrumb(origin, taskType),
        { label: "查看结果", href: origin.href },
        { label: "订正结果" }
      ]
    };
  }
  if (origin.kind === "full-set-result") {
    return {
      backHref: safeReturnTo,
      crumbs: [
        rootCrumb,
        correctionOriginChainCrumb(origin, taskType),
        { label: "查看结果", href: origin.href },
        { label: "订正结果" }
      ]
    };
  }
  if (origin.kind === "assignments") {
    return {
      backHref: safeReturnTo,
      crumbs: [
        rootCrumb,
        { label: "我的作业", href: STUDENT_ROUTES.assignments },
        { label: "订正结果" }
      ]
    };
  }
  // Wrong-question origins (错题集 / session / nested corrections whose chain
  // ends in the bank) keep the 错题集 breadcrumb.
  return {
    backHref: safeReturnTo,
    crumbs: [rootCrumb, wrongQuestionsCrumb, { label: "订正结果" }]
  };
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
  options?: { historySetId?: string; returnTo?: string | string[]; source?: StudentResultSource }
): {
  backHref: string;
  crumbs: StudentBreadcrumbItem[];
} {
  const rootCrumb = { label: STUDENT_UI_TEXT.studentHome, href: STUDENT_ROUTES.home };
  const wrongQuestionsCrumb = {
    label: STUDENT_UI_TEXT.wrongQuestions,
    href: STUDENT_ROUTES.wrongQuestions
  };
  const safeReturnTo = safeStudentReturnTo(options?.returnTo);
  if (safeReturnTo) {
    if (isPracticeHistoryReturnTo(safeReturnTo)) {
      return practiceHistoryReturnNavigation(safeReturnTo);
    }
    // Wrong-question origins (result / read-only review / history practice
    // result) keep their own crumbs while still returning to that exact page.
    if (
      safeReturnTo.startsWith(STUDENT_ROUTES.wrongQuestions)
      || safeReturnTo.startsWith("/student/reading/wrongbook-results/")
    ) {
      return {
        backHref: safeReturnTo,
        crumbs: [rootCrumb, wrongQuestionsCrumb, { label: STUDENT_UI_TEXT.result }]
      };
    }
    // A BAS entry correction starts from a single-item practice result page;
    // after it is finished the correction result returns to the BAS catalog.
    // Normal BAS results (retakes) keep returning to their own origin.
    if (isWrongQuestionsSetId(setId)) {
      return {
        backHref: STUDENT_ROUTES.buildASentence,
        crumbs: [
          rootCrumb,
          { label: STUDENT_UI_TEXT.practiceSets, href: STUDENT_ROUTES.buildASentence },
          { label: STUDENT_UI_TEXT.result }
        ]
      };
    }
    // A previous BAS practice result (retake) keeps the BAS practice chain
    // instead of pretending to come from the Assignment list.
    const origin = resolveEntryCorrectionOrigin(safeReturnTo);
    if (origin.kind === "reading-result" || origin.kind === "full-set-result") {
      return {
        backHref: safeReturnTo,
        crumbs: [
          rootCrumb,
          correctionOriginChainCrumb(origin, null),
          { label: "查看结果", href: origin.href },
          { label: STUDENT_UI_TEXT.result }
        ]
      };
    }
    if (/^\/student\/results\/[^/]+\/?$/.test(new URL(safeReturnTo, "https://tps.local").pathname)) {
      return {
        backHref: safeReturnTo,
        crumbs: [
          rootCrumb,
          { label: STUDENT_UI_TEXT.practiceSets, href: STUDENT_ROUTES.buildASentence },
          { label: "查看结果", href: safeReturnTo },
          { label: STUDENT_UI_TEXT.result }
        ]
      };
    }
    return assignmentResultNavigation(safeReturnTo);
  }

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
