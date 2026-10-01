/**
 * Teacher drill-down navigation context.
 *
 * Teacher detail pages (student / class / assignment / review / question) can
 * be opened from more than one place, so they accept an optional
 * `?returnTo=<internal path>` search param. The value is validated here and is
 * used only for navigation targets:
 *
 * - the parent breadcrumb href, and
 * - explicit back links (for example the writing review workspace toolbar).
 *
 * Rules:
 * - only same-origin `/teacher/...` paths of known teacher entry points are
 *   accepted; external URLs, protocol tricks, `//` hosts and unknown roots fall
 *   back to the page's canonical parent, so a refreshed or shared detail URL
 *   always keeps a usable breadcrumb.
 * - callers always have a fallback, so a missing context never disables
 *   navigation.
 */

export type TeacherNavCrumb = { href?: string; label: string };

export const TEACHER_HOME_HREF = "/teacher/dashboard";
export const TEACHER_HOME_CLASSES_HREF = "/teacher/dashboard?tab=classes";
export const TEACHER_STUDENTS_HREF = "/teacher/students";
export const TEACHER_ASSIGNMENTS_HREF = "/teacher/writing/assignments";
export const TEACHER_REVIEWS_HREF = "/teacher/writing/reviews";
export const TEACHER_REVIEW_LOGS_HREF = "/teacher/writing/reviews/logs";

/**
 * Known teacher roots that may appear as a returnTo parent. Anything else
 * (including `/student/...`, `/admin/...`, external origins) is rejected.
 */
const TEACHER_RETURN_ROOTS = [
  "/teacher/dashboard",
  "/teacher/students",
  "/teacher/classes",
  "/teacher/writing/assignments",
  "/teacher/writing/reviews",
  "/teacher/question-bank",
  "/teacher/sets",
  "/teacher/reading",
  "/teacher/accounts",
  "/teacher/import",
  "/teacher/inactive-students"
];

export function firstSearchParamValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0]?.trim() ?? "";
  return value?.trim() ?? "";
}

/**
 * Review position of a teacher Reading question page (`?question=N`). Invalid
 * or absent values simply open the result view instead of a question.
 */
export function teacherReadingQuestionIndex(value: string | string[] | undefined) {
  const raw = firstSearchParamValue(value);
  if (!raw) return undefined;
  const numeric = Number(raw);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : undefined;
}

/**
 * Normalizes an untrusted `returnTo` value to an internal teacher path (path +
 * query, never a hash). Returns `fallback` for anything that is not a known
 * teacher route.
 */
export function safeTeacherReturnTo(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const raw = value.trim();
  if (!raw.startsWith("/teacher/") || raw.startsWith("//") || raw.includes("\\")) {
    return fallback;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw, "https://teacher.internal.invalid");
  } catch {
    return fallback;
  }
  if (parsed.origin !== "https://teacher.internal.invalid") return fallback;
  const allowed = TEACHER_RETURN_ROOTS.some(
    (root) => parsed.pathname === root || parsed.pathname.startsWith(`${root}/`)
  );
  if (!allowed) return fallback;
  return `${parsed.pathname}${parsed.search}`;
}

/**
 * Appends a validated `returnTo` to a drill-down href. Invalid or empty values
 * leave the href untouched (the target page then uses its own canonical
 * parent); a self-referencing value is ignored as well.
 */
export function teacherReturnToHref(href: string, returnTo: unknown): string {
  const safe = typeof returnTo === "string" && returnTo
    ? safeTeacherReturnTo(returnTo, "")
    : "";
  if (!safe || safe === href) return href;
  const separator = href.includes("?") ? "&" : "?";
  return `${href}${separator}returnTo=${encodeURIComponent(safe)}`;
}

export function teacherStudentDetailHref(studentId: string) {
  return `${TEACHER_STUDENTS_HREF}/${encodeURIComponent(studentId)}`;
}

export function teacherClassDetailHref(classId: string) {
  return `/teacher/classes/${encodeURIComponent(classId)}`;
}

export function teacherStudentSetDetailsHref(studentId: string, setId: string) {
  return `${teacherStudentDetailHref(studentId)}/details/${encodeURIComponent(setId)}`;
}

export function teacherAssignmentDetailHref(assignmentId: string) {
  return `${TEACHER_ASSIGNMENTS_HREF}/${encodeURIComponent(assignmentId)}`;
}

export function teacherAssignmentBatchDetailHref(batchId: string) {
  return `/teacher/writing/assignments/batches/${encodeURIComponent(batchId)}`;
}

export function teacherAssignmentsListHref(input: {
  view: "students" | "class";
  studentId?: string;
  classId?: string;
}) {
  const params = new URLSearchParams();
  if (input.view === "class") {
    params.set("view", "class");
    if (input.classId) params.set("classId", input.classId);
  } else if (input.studentId) {
    params.set("studentId", input.studentId);
  }
  const query = params.toString();
  return query ? `${TEACHER_ASSIGNMENTS_HREF}?${query}` : TEACHER_ASSIGNMENTS_HREF;
}

/**
 * Builds the current URL with updated query params (client only). Callers pass
 * the result to `router.replace` so the router cache also records the context
 * (browser Back then restores the same tab / filter state).
 */
export function teacherQueryUrl(
  updates: Record<string, string | null | undefined>
) {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined || value === "") {
      url.searchParams.delete(key);
    } else {
      url.searchParams.set(key, value);
    }
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Class id when the parent context is a class detail page. */
export function teacherClassIdFromReturnTo(value: unknown) {
  const safe = safeTeacherReturnTo(value, "");
  if (!safe) return "";
  const path = safe.split("?")[0];
  const match = /^\/teacher\/classes\/([^/]+)$/.exec(path);
  return match ? decodeURIComponent(match[1]) : "";
}

export type TeacherStudentReturnToContext = {
  studentId: string;
  /** Validated student detail URL, including its own nested class context. */
  studentHref: string;
  classId: string;
  classHref: string;
};

function contextFromStudentHref(studentHref: string): TeacherStudentReturnToContext | null {
  const queryIndex = studentHref.indexOf("?");
  const path = queryIndex === -1 ? studentHref : studentHref.slice(0, queryIndex);
  const match = /^\/teacher\/students\/([^/]+)$/.exec(path);
  if (!match) return null;
  const studentId = decodeURIComponent(match[1]);
  const nested = queryIndex === -1
    ? ""
    : new URLSearchParams(studentHref.slice(queryIndex + 1)).get("returnTo") ?? "";
  const classId = teacherClassIdFromReturnTo(nested);
  return {
    studentId,
    studentHref,
    classId,
    classHref: classId ? teacherClassDetailHref(classId) : ""
  };
}

/**
 * Parses a returnTo that points directly at a student detail page, for example
 * `/teacher/students/<id>?returnTo=%2Fteacher%2Fclasses%2F<c-id>`. The nested
 * class context keeps the full chain 首页 / 班级 / 学生 intact.
 */
export function parseTeacherStudentReturnTo(
  value: unknown
): TeacherStudentReturnToContext | null {
  return contextFromStudentHref(safeTeacherReturnTo(value, ""));
}

/**
 * Parses a returnTo for the student drill-down pages (套题 / 答题). It accepts
 * both a student detail page and a set-details page that itself carries the
 * student page in its `returnTo`, so the chain survives every hop.
 */
export function parseTeacherStudentChildReturnTo(
  value: unknown
): TeacherStudentReturnToContext | null {
  const safe = safeTeacherReturnTo(value, "");
  if (!safe) return null;
  const direct = contextFromStudentHref(safe);
  if (direct) return direct;
  const queryIndex = safe.indexOf("?");
  const path = queryIndex === -1 ? safe : safe.slice(0, queryIndex);
  const match = /^\/teacher\/students\/([^/]+)\/details\//.exec(path);
  if (!match) return null;
  const studentId = decodeURIComponent(match[1]);
  const nested = queryIndex === -1
    ? ""
    : new URLSearchParams(safe.slice(queryIndex + 1)).get("returnTo") ?? "";
  const nestedContext = contextFromStudentHref(safeTeacherReturnTo(nested, ""));
  if (nestedContext && nestedContext.studentId === studentId) return nestedContext;
  return {
    studentId,
    studentHref: teacherStudentDetailHref(studentId),
    classId: "",
    classHref: ""
  };
}

/**
 * The 套题 crumb of a 答题 page returns to the set-details page it was opened
 * from; anything else falls back to the canonical set-details URL.
 */
export function teacherSetDetailsReturnHref(
  returnTo: unknown,
  studentId: string,
  setId: string
) {
  const safe = safeTeacherReturnTo(returnTo, "");
  if (safe) {
    const path = safe.split("?")[0];
    if (/^\/teacher\/students\/[^/]+\/details\/[^/]+$/.test(path)) return safe;
  }
  return teacherStudentSetDetailsHref(studentId, setId);
}

function pathOf(href: string) {
  const queryIndex = href.indexOf("?");
  return queryIndex === -1 ? href : href.slice(0, queryIndex);
}

/**
 * Breadcrumbs of the student detail page itself:
 * 首页 / (班级名称) / 学生姓名 when opened from a class,
 * 首页 / 学生 / 学生姓名 when opened from the student account list,
 * 首页 / 学生姓名 otherwise (home or a direct URL).
 */
export function teacherStudentDetailCrumbs(input: {
  className?: string;
  returnTo: string;
  studentName: string;
}): TeacherNavCrumb[] {
  const crumbs: TeacherNavCrumb[] = [{ label: "首页", href: TEACHER_HOME_HREF }];
  const classId = teacherClassIdFromReturnTo(input.returnTo);
  const path = pathOf(input.returnTo);
  if (classId) {
    crumbs.push({
      label: input.className?.trim() || "班级",
      href: input.returnTo
    });
  } else if (path === TEACHER_STUDENTS_HREF) {
    crumbs.push({ label: "学生", href: TEACHER_STUDENTS_HREF });
  } else if (path.startsWith("/teacher/accounts/teachers/")) {
    crumbs.push({ label: "教师详情", href: input.returnTo });
  }
  crumbs.push({ label: input.studentName });
  return crumbs;
}

/**
 * Breadcrumbs of a student drill-down page (套题 / 单题 records): the parent
 * chain is 首页 / (班级名称) / 学生姓名 and the page appends its own tail.
 */
export function teacherStudentChildCrumbs(input: {
  className?: string;
  studentContext: TeacherStudentReturnToContext | null;
  studentId: string;
  studentName: string;
  tail?: TeacherNavCrumb[];
}): TeacherNavCrumb[] {
  const crumbs: TeacherNavCrumb[] = [{ label: "首页", href: TEACHER_HOME_HREF }];
  if (input.studentContext?.classHref) {
    crumbs.push({
      label: input.className?.trim() || "班级",
      href: input.studentContext.classHref
    });
  }
  crumbs.push({
    label: input.studentName,
    href: input.studentContext?.studentHref || teacherStudentDetailHref(input.studentId)
  });
  crumbs.push(...(input.tail ?? []));
  return crumbs;
}
