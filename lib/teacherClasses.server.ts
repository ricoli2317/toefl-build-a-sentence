import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllSupabaseRows } from "@/lib/supabasePagination";
import {
  computeClassCompletions,
  normalizeClassSubjects,
  type ClassCompletionCounts,
  type ClassDuplicateMemberIssue,
  type ClassMemberInput,
  type ClassStudentCandidate,
  type TeacherClassDetail,
  type TeacherClassMember,
  type TeacherClassReviewSummary,
  type TeacherClassSummary
} from "@/lib/teacherClasses";
import { accountAutoSuffixAllowed } from "@/lib/studentAccountSuggestion";
import { listVisibleStudentIds, type AccountActor } from "@/lib/accountAccess";
import type { StudentBindingDomain } from "@/lib/studentBindings";
import { createTeacherStudentAccount } from "@/lib/teacherStudentAccount.server";
import { loadTeacherScope } from "@/lib/teacherScope.server";
import {
  chunkValues,
  listTeacherClasses,
  loadTeacherClassRow,
  searchTeacherClasses,
  toTeacherClassSummary,
  type TeacherClassRow
} from "@/lib/teacherClassSharing.server";
import {
  buildStudentBindingCandidates,
  findActiveStudentsByName,
  rollbackCreatedStudentAccount
} from "@/lib/teacherStudentBindings";
import { getPreferredUserDisplayName } from "@/lib/userDisplayName";
import type { createServiceSupabase } from "@/lib/supabase/server";

type Db = ReturnType<typeof createServiceSupabase>;

type ClassRow = TeacherClassRow;

export type TeacherClassActionResult =
  | { ok: true; class: TeacherClassSummary }
  | {
      ok: false;
      status: number;
      code?: string;
      error: string;
      member_index?: number;
      members?: ClassDuplicateMemberIssue[];
    };

export {
  bindTeacherToClass,
  listTeacherClasses,
  loadTeacherClassRow,
  searchTeacherClasses
} from "@/lib/teacherClassSharing.server";

async function readRowsByIds<T extends Record<string, unknown>>(
  db: Db,
  table: string,
  fields: string,
  ids: string[],
  column: string
): Promise<T[]> {
  const rows: T[] = [];
  for (const batch of chunkValues(ids)) {
    if (batch.length === 0) continue;
    const result = await readAllSupabaseRows<T>((from, to) =>
      db
        .from(table)
        .select(fields)
        .in(column, batch)
        .order(column, { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: T[] | null;
        error: { message: string } | null;
      }>
    );
    if (result.error) throw result.error;
    rows.push(...(result.data ?? []));
  }
  return rows;
}

const mapClassSummary = toTeacherClassSummary;

/**
 * Class detail: members + per-student completion over the class's own
 * assignment items. Direct (one-to-one) assignments and other classes are
 * never part of the query set.
 */
export async function loadTeacherClassDetail(
  db: Db,
  teacherId: string,
  classId: string
): Promise<TeacherClassDetail | null> {
  const classRow = await loadTeacherClassRow(db, teacherId, classId);
  if (!classRow) return null;

  const membersResult = await readAllSupabaseRows<{ student_id: string; joined_at: string }>(
    (from, to) =>
      db
        .from("class_members")
        .select("student_id,joined_at")
        .eq("class_id", classId)
        .order("joined_at", { ascending: true })
        .order("student_id", { ascending: true })
        .range(from, to)
  );
  if (membersResult.error) throw membersResult.error;
  const membershipRows = membersResult.data ?? [];
  const memberIds = membershipRows.map((row) => String(row.student_id));

  const [profileRows, completion] = await Promise.all([
    readRowsByIds<{ id: string; email: string | null; full_name: string | null }>(
      db,
      "profiles",
      "id,email,full_name",
      memberIds,
      "id"
    ),
    loadClassCompletionCounts(db, teacherId, classId)
  ]);
  const profileById = new Map(profileRows.map((profile) => [String(profile.id), profile]));

  const members: TeacherClassMember[] = membershipRows.map((row) => {
    const studentId = String(row.student_id);
    const profile = profileById.get(studentId);
    const counts = completion.get(studentId);
    return {
      student_id: studentId,
      student_name:
        getPreferredUserDisplayName({
          email: profile?.email,
          profileFullName: profile?.full_name
        }) || "未命名学生",
      joined_at: row.joined_at,
      completed_count: counts?.completed ?? 0,
      total_count: counts?.total ?? 0
    };
  });

  return {
    class: mapClassSummary(classRow, members.length),
    members
  };
}

/**
 * Completion counts are scoped to the ACTING teacher's own assignment items
 * for the class. A shared class may carry another teacher's groups; those are
 * never counted or exposed here.
 */
async function loadClassCompletionCounts(
  db: Db,
  teacherId: string,
  classId: string
): Promise<Map<string, ClassCompletionCounts>> {
  const groupsResult = await readAllSupabaseRows<{ group_id: string }>((from, to) =>
    db
      .from("writing_assignment_groups")
      .select("group_id")
      .eq("class_id", classId)
      .eq("teacher_id", teacherId)
      .order("group_id", { ascending: true })
      .range(from, to)
  );
  if (groupsResult.error) throw groupsResult.error;
  const groupIds = (groupsResult.data ?? []).map((row) => String(row.group_id));
  if (groupIds.length === 0) return new Map();

  const items: Array<{ assignment_id: string; recipient_student_ids: string[] }> = [];
  const assignmentIds: string[] = [];
  const recipientRows: Array<{ assignment_id: string; student_id: string }> = [];
  for (const batch of chunkValues(groupIds)) {
    const itemResult = await readAllSupabaseRows<{ assignment_id: string }>((from, to) =>
      db
        .from("writing_assignments")
        .select("assignment_id")
        .in("group_id", batch)
        .is("deleted_at", null)
        .neq("status", "withdrawn")
        .order("assignment_id", { ascending: true })
        .range(from, to)
    );
    if (itemResult.error) throw itemResult.error;
    for (const row of itemResult.data ?? []) assignmentIds.push(String(row.assignment_id));
  }
  if (assignmentIds.length === 0) return new Map();

  for (const batch of chunkValues(assignmentIds)) {
    const recipientResult = await readAllSupabaseRows<{ assignment_id: string; student_id: string }>(
      (from, to) =>
        db
          .from("writing_assignment_students")
          .select("assignment_id,student_id")
          .in("assignment_id", batch)
          .order("assignment_id", { ascending: true })
          .order("student_id", { ascending: true })
          .range(from, to)
    );
    if (recipientResult.error) throw recipientResult.error;
    recipientRows.push(
      ...(recipientResult.data ?? []).map((row) => ({
        assignment_id: String(row.assignment_id),
        student_id: String(row.student_id)
      }))
    );
  }
  const recipientsByAssignment = new Map<string, string[]>();
  for (const row of recipientRows) {
    recipientsByAssignment.set(row.assignment_id, [
      ...(recipientsByAssignment.get(row.assignment_id) ?? []),
      row.student_id
    ]);
  }
  for (const assignmentId of assignmentIds) {
    items.push({
      assignment_id: assignmentId,
      recipient_student_ids: recipientsByAssignment.get(assignmentId) ?? []
    });
  }

  const submissionRows = await readRowsByIds<{
    assignment_id: string;
    user_id: string;
    submitted_at: string | null;
  }>(db, "writing_attempts", "assignment_id,user_id,submitted_at", assignmentIds, "assignment_id");
  const submissions = submissionRows
    .filter((row) => row.assignment_id && row.user_id && row.submitted_at)
    .map((row) => ({
      assignment_id: String(row.assignment_id),
      student_id: String(row.user_id)
    }));

  return computeClassCompletions({ items, submissions });
}

/**
 * Existing-student picker for the class forms: only students the teacher
 * already has a teaching relation with (any subject), with their current
 * subject relations so the form can show what will be added automatically.
 */
export async function listClassStudentCandidates(
  db: Db,
  teacherId: string
): Promise<ClassStudentCandidate[]> {
  const scope = await loadTeacherScope(db, { userId: teacherId, role: "teacher" });
  return Array.from(scope.studentProfiles.values()).map((profile) => ({
    student_id: profile.studentId,
    student_name: profile.displayName || "未命名学生",
    student_email: profile.email,
    domains: scope.studentDomains.get(profile.studentId) ?? []
  }));
}

async function collectDuplicateMemberIssues(
  db: Db,
  members: ClassMemberInput[]
): Promise<ClassDuplicateMemberIssue[]> {
  const issues: ClassDuplicateMemberIssue[] = [];
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index];
    if (member.kind !== "new" || member.confirm_duplicate_name) continue;
    const sameNameStudents = await findActiveStudentsByName(db, member.student_name);
    if (sameNameStudents.length === 0) continue;
    const candidates = await buildStudentBindingCandidates(db, sameNameStudents);
    issues.push({
      member_index: index,
      student_name: member.student_name.trim(),
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        displayName: candidate.displayName,
        email: candidate.email
      }))
    });
  }
  return issues;
}

async function rollbackCreatedStudents(db: Db, studentIds: readonly string[]) {
  for (const studentId of studentIds) {
    await rollbackCreatedStudentAccount(db, {
      userId: studentId,
      deleteAuthUser: (userId) => db.auth.admin.deleteUser(userId)
    });
  }
}

/**
 * Existing members must already be visible to the teacher (the picker only
 * offers bound students). A forged student id can never pull an unrelated
 * student into a class.
 */
async function findInvisibleExistingMember(
  db: Db,
  teacherId: string,
  members: readonly ClassMemberInput[]
): Promise<number | null> {
  const existing = members
    .map((member, index) =>
      member.kind === "existing" ? { index, studentId: member.student_id } : null
    )
    .filter((entry): entry is { index: number; studentId: string } => entry !== null);
  if (existing.length === 0) return null;
  const actor: AccountActor = { userId: teacherId, role: "teacher" };
  const visible = new Set(await listVisibleStudentIds(db, actor));
  const invisible = existing.find((entry) => !visible.has(entry.studentId));
  return invisible ? invisible.index : null;
}

async function createNewClassMembers(
  db: Db,
  teacherId: string,
  subjects: readonly StudentBindingDomain[],
  members: readonly ClassMemberInput[],
  startIndex: number
): Promise<
  | { ok: true; studentIds: string[] }
  | { ok: false; status: number; code?: string; error: string; member_index: number }
> {
  const createdIds: string[] = [];
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index];
    if (member.kind !== "new") continue;
    const created = await createTeacherStudentAccount(db, {
      actorId: teacherId,
      actorRole: "teacher",
      account: member.account,
      studentName: member.student_name,
      domains: subjects,
      confirmDuplicateName: true,
      autoSuffix: accountAutoSuffixAllowed(member.account_edited)
    });
    if (!created.ok) {
      await rollbackCreatedStudents(db, createdIds);
      return {
        ok: false,
        status: created.status,
        code: created.code,
        error: created.error,
        member_index: startIndex + index
      };
    }
    createdIds.push(created.student.id);
  }
  return { ok: true, studentIds: createdIds };
}

export async function createTeacherClass(
  db: Db,
  teacherId: string,
  input: {
    name: string;
    subjects: StudentBindingDomain[];
    members: ClassMemberInput[];
  }
): Promise<TeacherClassActionResult> {
  // Same-name students are resolved by the teacher before any write happens.
  const duplicateIssues = await collectDuplicateMemberIssues(db, input.members);
  if (duplicateIssues.length > 0) {
    return {
      ok: false,
      status: 409,
      code: "DUPLICATE_MEMBERS",
      error: "已存在同名学生，请选择绑定已有学生或继续新增。",
      members: duplicateIssues
    };
  }
  const invisibleIndex = await findInvisibleExistingMember(db, teacherId, input.members);
  if (invisibleIndex !== null) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_CLASS",
      error: "所选学生中包含无效账号。",
      member_index: invisibleIndex
    };
  }

  const insertResult = await db
    .from("teacher_classes")
    .insert({ teacher_id: teacherId, name: input.name, subjects: input.subjects })
    .select("class_id,name,subjects,created_at")
    .single();
  if (insertResult.error) throw insertResult.error;
  const classRow = insertResult.data as ClassRow;
  const classId = String(classRow.class_id);

  const created = await createNewClassMembers(db, teacherId, input.subjects, input.members, 0);
  if (!created.ok) {
    await db.from("teacher_classes").delete().eq("class_id", classId);
    return {
      ok: false,
      status: created.status,
      code: created.code,
      error: created.error,
      member_index: created.member_index
    };
  }

  const existingIds = input.members
    .filter((member): member is Extract<ClassMemberInput, { kind: "existing" }> => member.kind === "existing")
    .map((member) => member.student_id);
  const memberIds = Array.from(new Set([...existingIds, ...created.studentIds]));

  const memberCount = await syncClassMembers(db, teacherId, classId, memberIds);
  if (memberCount === null) {
    await rollbackCreatedStudents(db, created.studentIds);
    await db.from("teacher_classes").delete().eq("class_id", classId);
    return { ok: false, status: 500, error: "班级创建失败，请稍后重试。" };
  }

  return { ok: true, class: mapClassSummary(classRow, memberCount) };
}

export async function addTeacherClassMembers(
  db: Db,
  teacherId: string,
  classId: string,
  members: ClassMemberInput[]
): Promise<TeacherClassActionResult> {
  const classRow = await loadTeacherClassRow(db, teacherId, classId);
  if (!classRow) return { ok: false, status: 404, error: "班级不存在或无权操作。" };
  const subjects = normalizeClassSubjects(classRow.subjects);

  const duplicateIssues = await collectDuplicateMemberIssues(db, members);
  if (duplicateIssues.length > 0) {
    return {
      ok: false,
      status: 409,
      code: "DUPLICATE_MEMBERS",
      error: "已存在同名学生，请选择绑定已有学生或继续新增。",
      members: duplicateIssues
    };
  }
  const invisibleIndex = await findInvisibleExistingMember(db, teacherId, members);
  if (invisibleIndex !== null) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_CLASS",
      error: "所选学生中包含无效账号。",
      member_index: invisibleIndex
    };
  }

  const created = await createNewClassMembers(db, teacherId, subjects, members, 0);
  if (!created.ok) {
    return {
      ok: false,
      status: created.status,
      code: created.code,
      error: created.error,
      member_index: created.member_index
    };
  }

  const existingIds = members
    .filter((member): member is Extract<ClassMemberInput, { kind: "existing" }> => member.kind === "existing")
    .map((member) => member.student_id);
  const memberIds = Array.from(new Set([...existingIds, ...created.studentIds]));
  if (memberIds.length === 0) return { ok: false, status: 400, error: "请至少添加一名学生。" };

  const memberCount = await syncClassMembers(db, teacherId, classId, memberIds);
  if (memberCount === null) {
    await rollbackCreatedStudents(db, created.studentIds);
    return { ok: false, status: 500, error: "添加学生失败，请稍后重试。" };
  }

  return { ok: true, class: mapClassSummary(classRow, memberCount) };
}

/** Returns the class member count, or null when the RPC failed. */
async function syncClassMembers(
  db: Db,
  teacherId: string,
  classId: string,
  memberIds: string[]
): Promise<number | null> {
  if (memberIds.length === 0) return 0;
  const { data, error } = await db.rpc("sync_class_members", {
    p_teacher_id: teacherId,
    p_class_id: classId,
    p_student_ids: memberIds
  });
  if (error) {
    console.error("[teacher-classes] sync_class_members_failed", error.message);
    return null;
  }
  if (data && typeof data === "object" && "member_count" in (data as Record<string, unknown>)) {
    return Number((data as Record<string, unknown>).member_count ?? 0);
  }
  return memberIds.length;
}

export async function renameTeacherClass(
  db: Db,
  teacherId: string,
  classId: string,
  name: string
): Promise<TeacherClassActionResult> {
  // Owner or bound teacher: the shared class keeps one name for all teachers.
  const authorized = await loadTeacherClassRow(db, teacherId, classId);
  if (!authorized) return { ok: false, status: 404, error: "班级不存在或无权操作。" };
  const result = await db
    .from("teacher_classes")
    .update({ name })
    .eq("class_id", classId)
    .select("class_id,teacher_id,name,subjects,created_at")
    .maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) return { ok: false, status: 404, error: "班级不存在或无权操作。" };
  const row = result.data as ClassRow;
  return { ok: true, class: mapClassSummary(row, await classMemberCount(db, classId)) };
}

/**
 * Updates only the class's own subject set and backfills the bindings the new
 * subjects require for the current members. Removing a subject from a class
 * NEVER releases a member's binding: the RPC's legacy p_remove_writing
 * parameter is always sent as false, so a member keeps reading/writing
 * bindings the teacher holds even when the class no longer teaches them.
 */
export async function updateTeacherClassSubjects(
  db: Db,
  teacherId: string,
  classId: string,
  subjects: StudentBindingDomain[]
): Promise<TeacherClassActionResult> {
  const { error } = await db.rpc("update_class_subjects", {
    p_teacher_id: teacherId,
    p_class_id: classId,
    p_subjects: subjects,
    p_remove_writing: false
  });
  if (error) {
    if (/CLASS_NOT_FOUND/.test(error.message)) {
      return { ok: false, status: 404, error: "班级不存在或无权操作。" };
    }
    console.error("[teacher-classes] update_class_subjects_failed", error.message);
    return { ok: false, status: 500, error: "保存失败，请稍后重试。" };
  }

  const classRow = await loadTeacherClassRow(db, teacherId, classId);
  if (!classRow) return { ok: false, status: 404, error: "班级不存在或无权操作。" };
  return { ok: true, class: mapClassSummary(classRow, await classMemberCount(db, classId)) };
}

/**
 * Removes only the class membership. The teacher's reading/writing bindings
 * for that student are never released by leaving a class (p_remove_writing is
 * always false); releasing a subject is only possible through the per-student
 * binding entry points.
 */
export async function removeTeacherClassMember(
  db: Db,
  teacherId: string,
  classId: string,
  studentId: string
): Promise<TeacherClassActionResult> {
  const { error } = await db.rpc("remove_class_member", {
    p_teacher_id: teacherId,
    p_class_id: classId,
    p_student_id: studentId,
    p_remove_writing: false
  });
  if (error) {
    if (/CLASS_NOT_FOUND/.test(error.message)) {
      return { ok: false, status: 404, error: "班级不存在或无权操作。" };
    }
    if (/MEMBER_NOT_FOUND/.test(error.message)) {
      return { ok: false, status: 404, error: "该学生已不在班级中。" };
    }
    console.error("[teacher-classes] remove_class_member_failed", error.message);
    return { ok: false, status: 500, error: "移除学生失败，请稍后重试。" };
  }

  const classRow = await loadTeacherClassRow(db, teacherId, classId);
  if (!classRow) return { ok: false, status: 404, error: "班级不存在或无权操作。" };
  return { ok: true, class: mapClassSummary(classRow, await classMemberCount(db, classId)) };
}

async function classMemberCount(db: Db, classId: string) {
  const result = await db
    .from("class_members")
    .select("student_id", { count: "exact", head: true })
    .eq("class_id", classId);
  if (result.error) throw result.error;
  return result.count ?? 0;
}

/**
 * Assignment creation guard: the class must belong to the teacher and include
 * the Assignment subject (写作 / 阅读). Returns null when either check fails.
 */
export async function loadWritingClassForAssignment(db: Db, teacherId: string, classId: string) {
  return loadTeacherClassForAssignment(db, teacherId, classId, "writing");
}

export async function loadTeacherClassForAssignment(
  db: Db,
  teacherId: string,
  classId: string,
  subject: "writing" | "reading"
) {
  const row = await loadTeacherClassRow(db, teacherId, classId);
  if (!row) return null;
  const subjects = normalizeClassSubjects(row.subjects);
  if (!subjects.includes(subject)) return null;
  return mapClassSummary(row, 0);
}

/**
 * The review page class tab: per-class submitted/pending/published counts over
 * the class's own assignment items only.
 */
export async function listClassReviewSummaries(
  db: Db,
  teacherId: string
): Promise<TeacherClassReviewSummary[]> {
  const classes = (await listTeacherClasses(db, teacherId)).filter((entry) =>
    entry.subjects.includes("writing")
  );
  if (classes.length === 0) return [];
  const classIds = classes.map((entry) => entry.class_id);

  const groupRows: Array<{ group_id: string; class_id: string | null }> = [];
  for (const batch of chunkValues(classIds)) {
    const groupResult = await readAllSupabaseRows<{ group_id: string; class_id: string | null }>(
      (from, to) =>
        db
          .from("writing_assignment_groups")
          .select("group_id,class_id")
          .in("class_id", batch)
          .eq("teacher_id", teacherId)
          .order("group_id", { ascending: true })
          .range(from, to)
    );
    if (groupResult.error) throw groupResult.error;
    groupRows.push(...(groupResult.data ?? []));
  }
  const groupToClass = new Map(
    groupRows.map((row) => [String(row.group_id), String(row.class_id)])
  );
  if (groupToClass.size === 0) {
    return classes.map((entry) => ({
      ...entry,
      pending_count: 0,
      reviewing_count: 0,
      published_count: 0
    }));
  }

  const assignmentRows = await readRowsByIds<{ assignment_id: string; group_id: string | null }>(
    db,
    "writing_assignments",
    "assignment_id,group_id",
    Array.from(groupToClass.keys()),
    "group_id"
  );
  const assignmentToClass = new Map<string, string>();
  for (const row of assignmentRows) {
    const classId = row.group_id ? groupToClass.get(String(row.group_id)) : undefined;
    if (classId) assignmentToClass.set(String(row.assignment_id), classId);
  }
  if (assignmentToClass.size === 0) {
    return classes.map((entry) => ({
      ...entry,
      pending_count: 0,
      reviewing_count: 0,
      published_count: 0
    }));
  }

  const attemptRows = await readRowsByIds<{
    attempt_id: string;
    assignment_id: string | null;
    status: string;
  }>(
    db,
    "writing_attempts",
    "attempt_id,assignment_id,status",
    Array.from(assignmentToClass.keys()),
    "assignment_id"
  );
  const submittedAttempts = attemptRows.filter((row) => row.status === "submitted");
  const attemptIds = submittedAttempts.map((row) => String(row.attempt_id));
  const reviewRows =
    attemptIds.length > 0
      ? await readRowsByIds<{ attempt_id: string; status: string | null; published_at: string | null }>(
          db,
          "writing_reviews",
          "attempt_id,status,published_at",
          attemptIds,
          "attempt_id"
        )
      : [];
  const reviewByAttempt = new Map(reviewRows.map((row) => [String(row.attempt_id), row]));

  const countsByClass = new Map<
    string,
    { pending: number; reviewing: number; published: number }
  >();
  for (const attempt of submittedAttempts) {
    const classId = attempt.assignment_id
      ? assignmentToClass.get(String(attempt.assignment_id))
      : undefined;
    if (!classId) continue;
    const counts = countsByClass.get(classId) ?? { pending: 0, reviewing: 0, published: 0 };
    const review = reviewByAttempt.get(String(attempt.attempt_id));
    if (!review) counts.pending += 1;
    else if (review.status === "published" && review.published_at) counts.published += 1;
    // 已忽略 belongs to neither the 待批改 / 批改中 / 已发布 buckets; it has
    // its own list filter and is never reported as 批改中.
    else if (review.status !== "ignored") counts.reviewing += 1;
    countsByClass.set(classId, counts);
  }

  return classes.map((entry) => {
    const counts = countsByClass.get(entry.class_id) ?? { pending: 0, reviewing: 0, published: 0 };
    return {
      ...entry,
      pending_count: counts.pending,
      reviewing_count: counts.reviewing,
      published_count: counts.published
    };
  });
}

/**
 * Assignment ids that belong to one class (used to scope the class review
 * list). Returns null when the class does not belong to the teacher.
 */
export async function listClassAssignmentIds(
  db: Db,
  teacherId: string,
  classId: string
): Promise<string[] | null> {
  const classRow = await loadTeacherClassRow(db, teacherId, classId);
  if (!classRow) return null;

  const groupResult = await readAllSupabaseRows<{ group_id: string }>((from, to) =>
    db
      .from("writing_assignment_groups")
      .select("group_id")
      .eq("class_id", classId)
      .eq("teacher_id", teacherId)
      .order("group_id", { ascending: true })
      .range(from, to)
  );
  if (groupResult.error) throw groupResult.error;
  const groupIds = (groupResult.data ?? []).map((row) => String(row.group_id));
  if (groupIds.length === 0) return [];

  const assignmentIds: string[] = [];
  for (const batch of chunkValues(groupIds)) {
    const assignmentResult = await readAllSupabaseRows<{ assignment_id: string }>((from, to) =>
      db
        .from("writing_assignments")
        .select("assignment_id")
        .in("group_id", batch)
        .is("deleted_at", null)
        .order("assignment_id", { ascending: true })
        .range(from, to)
    );
    if (assignmentResult.error) throw assignmentResult.error;
    for (const row of assignmentResult.data ?? []) assignmentIds.push(String(row.assignment_id));
  }
  return assignmentIds;
}

/** Class reference for the assignment cards (id + display name). Degrades to
 * an empty map before the class migration is applied so the student-mode list
 * keeps working. */
export async function loadWritingAssignmentClassRefs(
  db: Db,
  groupIds: readonly string[]
): Promise<Map<string, { class_id: string; class_name: string }>> {
  const ids = Array.from(new Set(groupIds.filter(Boolean)));
  if (ids.length === 0) return new Map();
  try {
    const groupRows = await readRowsByIds<{ group_id: string; class_id: string | null }>(
      db,
      "writing_assignment_groups",
      "group_id,class_id",
      ids,
      "group_id"
    );
    const classIds = Array.from(
      new Set(groupRows.map((row) => row.class_id).filter((value): value is string => Boolean(value)))
    );
    if (classIds.length === 0) return new Map();
    const classRows = await readRowsByIds<{ class_id: string; name: string }>(
      db,
      "teacher_classes",
      "class_id,name",
      classIds,
      "class_id"
    );
    const classNames = new Map(classRows.map((row) => [String(row.class_id), String(row.name)]));
    const result = new Map<string, { class_id: string; class_name: string }>();
    for (const row of groupRows) {
      if (!row.class_id) continue;
      const name = classNames.get(String(row.class_id));
      if (name) {
        result.set(String(row.group_id), { class_id: String(row.class_id), class_name: name });
      }
    }
    return result;
  } catch (error) {
    console.error(
      "[teacher-classes] assignment_class_lookup_failed",
      error instanceof Error ? error.message : String(error)
    );
    return new Map();
  }
}
