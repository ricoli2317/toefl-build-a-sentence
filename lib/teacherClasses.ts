import { assignmentDateKey, defaultWritingAssignmentTitle, normalizeAssignmentText, writingAssignmentAutoTitleSequence } from "./writingAssignments.ts";
import { assignmentSubjectLabel, type AssignmentSubject } from "./assignmentCatalog.ts";
import {
  STUDENT_BINDING_DOMAINS,
  normalizeBindingDomains,
  type StudentBindingDomain
} from "./studentBindings.ts";

/**
 * Shared Teacher-Class model (client + server safe).
 *
 * A class organizes students across one or more teachers. Each teacher has
 * their OWN subject set for the class: the owner's set lives on
 * teacher_classes.subjects, a bound teacher's set on
 * teacher_class_bindings.subjects. Teaching access to a student's learning
 * data still comes exclusively from teacher_student_bindings, backfilled only
 * from the acting teacher's own subjects.
 */

export const MAX_TEACHER_CLASS_NAME_LENGTH = 60;

/** Frozen default password for student accounts created from the class page. */
export const DEFAULT_STUDENT_PASSWORD = "123456";

export type TeacherClassSummary = {
  class_id: string;
  name: string;
  /** 当前查看教师在这个班级负责的科目（owner: 班级科目；绑定教师: 自己的科目）。 */
  subjects: StudentBindingDomain[];
  member_count: number;
  created_at: string;
};

export type TeacherClassMember = {
  student_id: string;
  student_name: string;
  joined_at: string;
  completed_count: number;
  total_count: number;
};

export type TeacherClassDetail = {
  class: TeacherClassSummary;
  members: TeacherClassMember[];
};

export type ClassStudentCandidate = {
  student_id: string;
  student_name: string;
  student_email: string;
  domains: StudentBindingDomain[];
};

/**
 * One row of the 绑定学生/班级 class search result. Deliberately minimal: a
 * class name match never exposes the member list, only the count and whether
 * the searching teacher can already manage the class. `subjects` is the
 * class-wide union (info only); `bound_subjects` is what the SEARCHING teacher
 * already teaches in this class and therefore cannot bind again.
 */
export type TeacherClassSearchResult = {
  class_id: string;
  name: string;
  subjects: StudentBindingDomain[];
  bound_subjects: StudentBindingDomain[];
  member_count: number;
  bound: boolean;
};

/**
 * One "student source" row of the class member editor: either an existing
 * teacher-bound student or a new student account created together with the
 * class.
 */
export type ClassMemberInput =
  | { kind: "existing"; student_id: string }
  | {
      kind: "new";
      student_name: string;
      account: string;
      /** True when the teacher edited the auto-suggested account by hand. */
      account_edited: boolean;
      /** Set after the teacher confirmed "继续新增" for a same-name student. */
      confirm_duplicate_name?: boolean;
    };

export type ClassDuplicateMemberIssue = {
  member_index: number;
  student_name: string;
  candidates: Array<{ id: string; displayName: string; email: string }>;
};

export type ClassCompletionCounts = { total: number; completed: number };

export type ClassCompletionItem = {
  assignment_id: string;
  recipient_student_ids: readonly string[];
};

export type ClassCompletionSubmission = {
  assignment_id: string;
  student_id: string;
};

export type TeacherClassReviewSummary = TeacherClassSummary & {
  pending_count: number;
  reviewing_count: number;
  published_count: number;
};

export function classIncludesWriting(subjects: readonly StudentBindingDomain[]) {
  return subjects.includes("writing");
}

export function classIncludesReading(subjects: readonly StudentBindingDomain[]) {
  return subjects.includes("reading");
}

export function classSubjectsLabel(subjects: readonly StudentBindingDomain[]) {
  return STUDENT_BINDING_DOMAINS.filter((domain) => subjects.includes(domain))
    .map((domain) => (domain === "reading" ? "阅读" : "写作"))
    .join("、");
}

export function normalizeClassSubjects(input: unknown): StudentBindingDomain[] {
  return normalizeBindingDomains(input);
}

/**
 * The subjects the acting teacher can still bind for a class: every subject
 * they have NOT already bound there. The 绑定班级 picker uses this so a
 * teacher already bound to Reading can still add Writing, and vice versa; a
 * subject already bound by the teacher is never offered for a duplicate.
 */
export function selectableClassSubjects(
  boundSubjects: readonly StudentBindingDomain[]
): StudentBindingDomain[] {
  return STUDENT_BINDING_DOMAINS.filter((domain) => !boundSubjects.includes(domain));
}

export function validateClassName(
  input: unknown
): { ok: true; name: string } | { ok: false; error: string } {
  const name = typeof input === "string" ? input.trim().replace(/\s+/g, " ") : "";
  if (!name) return { ok: false, error: "请填写班级名称。" };
  if (name.length > MAX_TEACHER_CLASS_NAME_LENGTH) {
    return { ok: false, error: `班级名称不能超过 ${MAX_TEACHER_CLASS_NAME_LENGTH} 个字。` };
  }
  return { ok: true, name };
}

export function validateClassSubjects(
  input: unknown
): { ok: true; subjects: StudentBindingDomain[] } | { ok: false; error: string } {
  const subjects = normalizeClassSubjects(input);
  if (subjects.length === 0) return { ok: false, error: "请至少选择一个授课科目。" };
  return { ok: true, subjects };
}

/**
 * Class-mode automatic Assignment title base:
 * `班级名称 写作 YYYY-MM-DD` / `班级名称 阅读 YYYY-MM-DD`.
 * The date reuses the shared assignment date rule (Asia/Shanghai), and the RPC
 * appends the same-day `(2)`, `(3)` sequence on top of this base.
 */
export function classAssignmentTitleBase(
  className: string,
  assignedAt: Date | string,
  subject: AssignmentSubject = "writing"
) {
  const name = className.trim().replace(/\s+/g, " ");
  if (!name) throw new Error("请先选择班级。");
  const dateKey = assignmentDateKey(assignedAt);
  if (!dateKey) throw new Error("作业布置日期无效。");
  return `${name} ${assignmentSubjectLabel(subject)} ${dateKey}`;
}

/**
 * The automatic title base a seed would use: 班级名称 when the group belongs
 * to a class, otherwise 学生姓名(等). Returns "" when the seed cannot form a
 * base (no date, no name).
 */
export function seededAssignmentTitleBase(input: {
  assignedAt: Date | string | null | undefined;
  className?: string | null;
  firstStudentName?: string | null;
  studentCount?: number;
  subject?: AssignmentSubject;
}): string {
  if (!input.assignedAt) return "";
  const subject = input.subject ?? "writing";
  const className = normalizeAssignmentText(input.className ?? "");
  if (className) {
    try {
      return classAssignmentTitleBase(className, input.assignedAt, subject);
    } catch {
      return "";
    }
  }
  const firstStudentName = normalizeAssignmentText(input.firstStudentName ?? "");
  if (!firstStudentName) return "";
  try {
    return defaultWritingAssignmentTitle({
      assignedAt: input.assignedAt,
      firstStudentName,
      studentCount: Math.max(1, Math.trunc(input.studentCount ?? 1)),
      subject
    });
  } catch {
    return "";
  }
}

/**
 * True when a persisted Assignment Group title is one the shared wizard would
 * itself have generated for this seed: `学生姓名/班级名称 写作/阅读 YYYY-MM-DD`
 * with the optional same-day `(n)` sequence. Only such a title may keep being
 * regenerated on a withdrawn edit; anything else (teacher-written text, a
 * renamed class, a changed date) is treated as a manual title and is never
 * overwritten.
 */
export function isAutomaticWritingAssignmentTitle(input: {
  assignedAt: Date | string | null | undefined;
  className?: string | null;
  firstStudentName?: string | null;
  studentCount?: number;
  subject?: AssignmentSubject;
  title: string;
}) {
  const title = normalizeAssignmentText(input.title);
  if (!title || !input.assignedAt) return false;
  if (Number.isNaN(new Date(input.assignedAt).getTime())) return false;
  const bases = Array.from(new Set([
    seededAssignmentTitleBase(input),
    seededAssignmentTitleBase({ ...input, className: null }),
    seededAssignmentTitleBase({ ...input, className: null, studentCount: 1 })
  ])).filter(Boolean);
  return bases.some(
    (base) => writingAssignmentAutoTitleSequence(title, base) !== null
  );
}

/**
 * Per-student completion over exactly the supplied class items. Callers pass
 * only the items of one class, so direct (one-to-one) assignments and other
 * classes can never leak into the rate.
 */
export function computeClassCompletions(input: {
  items: readonly ClassCompletionItem[];
  submissions: readonly ClassCompletionSubmission[];
}): Map<string, ClassCompletionCounts> {
  const submitted = new Set(
    input.submissions.map((entry) => `${entry.assignment_id}:${entry.student_id}`)
  );
  const counts = new Map<string, ClassCompletionCounts>();
  for (const item of input.items) {
    for (const studentId of Array.from(new Set(item.recipient_student_ids))) {
      const current = counts.get(studentId) ?? { total: 0, completed: 0 };
      current.total += 1;
      if (submitted.has(`${item.assignment_id}:${studentId}`)) current.completed += 1;
      counts.set(studentId, current);
    }
  }
  return counts;
}

/** `已完成 / 总数` teacher-facing text; `—` when the class has no assignment. */
export function formatClassCompletion(counts: ClassCompletionCounts | undefined) {
  if (!counts || counts.total <= 0) return "—";
  return `${counts.completed} / ${counts.total}`;
}

export function classCompletionPercent(counts: ClassCompletionCounts | undefined) {
  if (!counts || counts.total <= 0) return null;
  return Math.round((counts.completed / counts.total) * 100);
}

/**
 * List filters: the 学生作业 tab shows direct assignments only, the 班级作业
 * tab shows the groups permanently associated with a class.
 */
export function isClassWritingAssignment(assignment: { class_id?: string | null }) {
  return Boolean(assignment.class_id);
}

export function filterDirectWritingAssignments<T extends { class_id?: string | null }>(
  assignments: readonly T[]
) {
  return assignments.filter((assignment) => !isClassWritingAssignment(assignment));
}

export function filterWritingAssignmentsByClass<T extends { class_id?: string | null }>(
  assignments: readonly T[],
  classId: string
) {
  const normalized = classId.trim();
  if (!normalized) return Array.from(assignments).filter(isClassWritingAssignment);
  return assignments.filter((assignment) => assignment.class_id === normalized);
}

export function writingClassesOnly<T extends { subjects: readonly StudentBindingDomain[] }>(
  classes: readonly T[]
) {
  return classes.filter((entry) => classIncludesWriting(entry.subjects));
}

/**
 * Reading Assignment classes: the same membership rule as 写作, only the
 * subject guard differs. A class that does not include 阅读 can never receive a
 * Reading Assignment.
 */
export function readingClassesOnly<T extends { subjects: readonly StudentBindingDomain[] }>(
  classes: readonly T[]
) {
  return classes.filter((entry) => classIncludesReading(entry.subjects));
}

export function classesForAssignmentSubject<T extends { subjects: readonly StudentBindingDomain[] }>(
  classes: readonly T[],
  subject: AssignmentSubject
) {
  return subject === "reading" ? readingClassesOnly(classes) : writingClassesOnly(classes);
}

/**
 * The class member picker can only offer students the teacher already has a
 * teaching relation with (any subject). Reuses the binding domain arrays the
 * teacher scope already computes.
 */
export function sortClassStudentCandidates(candidates: readonly ClassStudentCandidate[]) {
  const collator = new Intl.Collator("zh-Hans-CN");
  return [...candidates].sort(
    (left, right) =>
      collator.compare(left.student_name, right.student_name)
      || left.student_id.localeCompare(right.student_id)
  );
}

/** Client-side class-name search over the loaded class list. */
export function filterClassSummariesByName<T extends { name: string }>(
  classes: readonly T[],
  query: string
) {
  const collator = new Intl.Collator("zh-Hans-CN");
  const sorted = [...classes].sort(
    (left, right) => collator.compare(left.name, right.name) || left.name.localeCompare(right.name)
  );
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return sorted;
  return sorted.filter((entry) => entry.name.toLocaleLowerCase().includes(needle));
}

export type ParsedClassMemberInputs =
  | { ok: true; members: ClassMemberInput[] }
  | { ok: false; error: string; member_index?: number };

/** Validates the raw `members` payload of the class create/add requests. */
export function parseClassMemberInputs(value: unknown): ParsedClassMemberInputs {
  if (value === undefined || value === null) return { ok: true, members: [] };
  if (!Array.isArray(value)) return { ok: false, error: "学生数据格式无效。" };
  const members: ClassMemberInput[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const row = value[index];
    if (typeof row !== "object" || row === null) {
      return { ok: false, error: "学生数据格式无效。", member_index: index };
    }
    const record = row as Record<string, unknown>;
    if (record.kind === "existing") {
      const studentId = typeof record.student_id === "string" ? record.student_id.trim() : "";
      if (!studentId) return { ok: false, error: "请选择学生。", member_index: index };
      members.push({ kind: "existing", student_id: studentId });
      continue;
    }
    if (record.kind === "new") {
      const studentName =
        typeof record.student_name === "string" ? record.student_name.trim() : "";
      if (!studentName) return { ok: false, error: "请填写学生姓名。", member_index: index };
      if (studentName.length > MAX_TEACHER_CLASS_NAME_LENGTH) {
        return { ok: false, error: "学生姓名过长。", member_index: index };
      }
      const account = typeof record.account === "string" ? record.account.trim() : "";
      if (!account) return { ok: false, error: "请填写学生账号。", member_index: index };
      members.push({
        kind: "new",
        student_name: studentName,
        account,
        account_edited: record.account_edited === true,
        confirm_duplicate_name: record.confirm_duplicate_name === true
      });
      continue;
    }
    return { ok: false, error: "学生数据格式无效。", member_index: index };
  }
  const seen = new Set<string>();
  for (const member of members) {
    if (member.kind !== "existing") continue;
    if (seen.has(member.student_id)) {
      return { ok: false, error: "同一名学生不能重复添加。" };
    }
    seen.add(member.student_id);
  }
  return { ok: true, members };
}
