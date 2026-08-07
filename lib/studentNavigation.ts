export const STUDENT_ROUTES = {
  home: "/student/sets",
  practiceSets: "/student/practice-sets",
  practiceHistory: "/student/practice-history",
  grammarPractice: "/student/grammar-practice",
  wrongQuestions: "/student/wrong-questions",
  wrongQuestionsHistory: "/student/wrong-questions/history",
  wrongQuestionsToday: "/student/wrong-questions/today"
} as const;

export type StudentBreadcrumbItem = {
  href?: string;
  label: string;
};

export type StudentResultSource =
  | "practice-history-history"
  | "practice-history-today";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];

export function formatPracticeMonthLabel(monthKey: string) {
  const month = Number(monthKey.slice(4, 6));
  if (!/^\d{6}$/.test(monthKey) || month < 1 || month > 12) return monthKey;
  return MONTH_NAMES[month - 1];
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
  const rootCrumb = { label: "Student Home", href: STUDENT_ROUTES.home };
  const wrongQuestionsCrumb = {
    label: "Wrong Questions",
    href: STUDENT_ROUTES.wrongQuestions
  };

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
        { label: "Practice History", href: historyHomeHref },
        { label: scopeLabel, href: historySetsHref },
        { label: reliableSetId, href: setAttemptsHref },
        { label: "View Result" }
      ]
    };
  }

  if (setId.startsWith("wrongbook-today-")) {
    return {
      backHref: STUDENT_ROUTES.wrongQuestionsToday,
      crumbs: [
        rootCrumb,
        wrongQuestionsCrumb,
        {
          label: "Today's Wrong Questions",
          href: STUDENT_ROUTES.wrongQuestionsToday
        },
        { label: "Result" }
      ]
    };
  }

  if (setId.startsWith("wrongbook-all-") || setId.startsWith("wrongbook-random-")) {
    return {
      backHref: STUDENT_ROUTES.wrongQuestionsHistory,
      crumbs: [
        rootCrumb,
        wrongQuestionsCrumb,
        {
          label: "History Wrong Questions",
          href: STUDENT_ROUTES.wrongQuestionsHistory
        },
        { label: "Result" }
      ]
    };
  }

  if (setId.startsWith("wrongbook-")) {
    return {
      backHref: STUDENT_ROUTES.wrongQuestions,
      crumbs: [rootCrumb, wrongQuestionsCrumb, { label: "Result" }]
    };
  }

  if (isGrammarPracticeSetId(setId)) {
    return {
      backHref: STUDENT_ROUTES.grammarPractice,
      crumbs: [
        rootCrumb,
        { label: "Grammar Practice", href: STUDENT_ROUTES.grammarPractice },
        { label: "Result" }
      ]
    };
  }

  const monthKey = getPracticeMonthKey(setId);
  const practiceSetsCrumb = {
    label: "Practice Sets",
    href: STUDENT_ROUTES.practiceSets
  };
  if (!monthKey) {
    return {
      backHref: STUDENT_ROUTES.practiceSets,
      crumbs: [rootCrumb, practiceSetsCrumb, { label: "Result" }]
    };
  }

  const monthHref = `${STUDENT_ROUTES.practiceSets}/${encodeURIComponent(monthKey)}`;
  return {
    backHref: monthHref,
    crumbs: [
      rootCrumb,
      practiceSetsCrumb,
      { label: formatPracticeMonthLabel(monthKey), href: monthHref },
      { label: "Result" }
    ]
  };
}
