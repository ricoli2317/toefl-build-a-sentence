import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllSupabaseRows } from "./supabasePagination.ts";
import { getPreferredUserDisplayName } from "./userDisplayName.ts";

/**
 * Admin-only platform tooling that moves historical Writing Assignment
 * ownership from Admin accounts to active ordinary teachers.
 *
 * The transfer changes writing_assignments.teacher_id (and
 * writing_assignment_groups.teacher_id for grouped assignments) only. Attempts,
 * reviews, and AI logs keep their rows and follow the assignment owner through
 * the existing Phase 2 permission chain.
 */

export type WritingTransferUnitType = "assignment" | "group";
export type WritingTransferTaskType = "email" | "academic_discussion";

export type WritingTransferTeacher = {
  id: string;
  displayName: string;
  email: string;
};

export type WritingTransferRecipient = {
  id: string;
  displayName: string;
  email: string;
};

export type WritingTransferAssignmentSummary = {
  assignmentId: string;
  groupPosition: number | null;
  taskType: WritingTransferTaskType;
  status: "active" | "withdrawn";
  deleted: boolean;
  createdAt: string;
  displayTitle: string;
};

export type WritingTransferTeacherCompatibility = {
  eligible: boolean;
  missingStudents: WritingTransferRecipient[];
};

export type WritingAssignmentTransferUnit = {
  unitType: WritingTransferUnitType;
  unitId: string;
  ownerId: string;
  ownerName: string;
  createdAt: string;
  title: string;
  taskTypes: WritingTransferTaskType[];
  assignments: WritingTransferAssignmentSummary[];
  recipients: WritingTransferRecipient[];
  submittedAttemptCount: number;
  publishedReviewCount: number;
  hasSubmittedAttempt: boolean;
  hasPublishedReview: boolean;
  compatibility: Record<string, WritingTransferTeacherCompatibility>;
};

export type WritingAssignmentTransferBoard = {
  units: WritingAssignmentTransferUnit[];
  teachers: WritingTransferTeacher[];
};

export type WritingTransferBinding = {
  teacherId: string;
  studentId: string;
  domain: string;
};

export type WritingAssignmentTransferResult = {
  unitType: WritingTransferUnitType;
  unitId: string;
  targetTeacherId: string;
  assignmentIds: string[];
};

export class WritingAssignmentTransferError extends Error {
  code: string;
  status: number;
  missingStudents?: WritingTransferRecipient[];

  constructor(
    code: string,
    message: string,
    status: number,
    options?: { missingStudents?: WritingTransferRecipient[] }
  ) {
    super(message);
    this.name = "WritingAssignmentTransferError";
    this.code = code;
    this.status = status;
    this.missingStudents = options?.missingStudents;
  }
}

const TRANSFER_ASSIGNMENT_FIELDS =
  "assignment_id,teacher_id,group_id,group_position,task_type,question_source,question_id,question_snapshot,status,deleted_at,created_at";

type ProfileRow = {
  id: string;
  email: string | null;
  full_name: string | null;
  role?: string | null;
  is_active?: boolean | null;
};

type AssignmentRow = {
  assignment_id: string;
  teacher_id: string;
  group_id: string | null;
  group_position: number | null;
  task_type: WritingTransferTaskType;
  question_source: string;
  question_id: string | null;
  question_snapshot: { set_title?: unknown } | null;
  status: string;
  deleted_at: string | null;
  created_at: string;
};

type GroupRow = {
  group_id: string;
  teacher_id: string;
  created_at: string;
};

type MemberRow = { assignment_id: string; student_id: string };
type AttemptRow = { attempt_id: string; assignment_id: string | null };
type ReviewRow = { attempt_id: string; status: string | null; published_at: string | null };
type BindingRow = { teacher_id: string; student_id: string; domain: string };

export function isWritingTransferUnitType(value: unknown): value is WritingTransferUnitType {
  return value === "assignment" || value === "group";
}

export function isEligibleWritingTransferTeacher(
  profile: { role?: string | null; is_active?: boolean | null } | null | undefined
) {
  return profile?.role === "teacher" && profile.is_active === true;
}

export function missingWritingBindingRecipients(
  recipients: readonly WritingTransferRecipient[],
  targetTeacherId: string,
  bindings: readonly WritingTransferBinding[]
): WritingTransferRecipient[] {
  const boundStudentIds = new Set(
    bindings
      .filter(
        (binding) =>
          binding.teacherId === targetTeacherId && binding.domain === "writing"
      )
      .map((binding) => binding.studentId)
  );
  return recipients.filter((recipient) => !boundStudentIds.has(recipient.id));
}

export function writingTransferDisplayTitle(
  snapshot: { set_title?: unknown } | null | undefined,
  fallbackId?: string | null
) {
  const title =
    typeof snapshot?.set_title === "string" ? snapshot.set_title.trim() : "";
  if (title) return title;
  const fallback = typeof fallbackId === "string" ? fallbackId.trim() : "";
  return fallback || "自定义题目";
}

export function transferRecipientName(
  profile: { email?: string | null; full_name?: string | null } | null | undefined
) {
  return (
    getPreferredUserDisplayName({
      email: profile?.email,
      profileFullName: profile?.full_name
    }) || ""
  );
}

export function buildWritingAssignmentTransferUnits(input: {
  admins: ProfileRow[];
  teachers: WritingTransferTeacher[];
  assignments: AssignmentRow[];
  groups: GroupRow[];
  members: MemberRow[];
  submittedAttempts: AttemptRow[];
  reviews: ReviewRow[];
  recipientProfiles: ProfileRow[];
  bindings: WritingTransferBinding[];
}): WritingAssignmentTransferUnit[] {
  const adminNameById = new Map(
    input.admins.map((admin) => [
      String(admin.id),
      transferRecipientName(admin) || "Admin"
    ])
  );
  const recipientById = new Map(
    input.recipientProfiles.map((profile) => [String(profile.id), profile])
  );
  const membersByAssignment = new Map<string, Set<string>>();
  for (const member of input.members) {
    const assignmentId = String(member.assignment_id);
    const students = membersByAssignment.get(assignmentId) ?? new Set<string>();
    students.add(String(member.student_id));
    membersByAssignment.set(assignmentId, students);
  }
  const submittedAttemptsByAssignment = new Map<string, number>();
  for (const attempt of input.submittedAttempts) {
    const assignmentId = attempt.assignment_id ? String(attempt.assignment_id) : "";
    if (!assignmentId) continue;
    submittedAttemptsByAssignment.set(
      assignmentId,
      (submittedAttemptsByAssignment.get(assignmentId) ?? 0) + 1
    );
  }
  const publishedReviewsByAttempt = new Set(
    input.reviews
      .filter(
        (review) => review.status === "published" && Boolean(review.published_at)
      )
      .map((review) => String(review.attempt_id))
  );
  const attemptsByAssignment = new Map<string, string[]>();
  for (const attempt of input.submittedAttempts) {
    const assignmentId = attempt.assignment_id ? String(attempt.assignment_id) : "";
    if (!assignmentId) continue;
    attemptsByAssignment.set(assignmentId, [
      ...(attemptsByAssignment.get(assignmentId) ?? []),
      String(attempt.attempt_id)
    ]);
  }

  const byGroupId = new Map<string, AssignmentRow[]>();
  const standalone: AssignmentRow[] = [];
  for (const assignment of input.assignments) {
    const groupId = assignment.group_id ? String(assignment.group_id) : null;
    if (!groupId) {
      standalone.push(assignment);
      continue;
    }
    byGroupId.set(groupId, [...(byGroupId.get(groupId) ?? []), assignment]);
  }

  const unitDrafts: Array<{
    unitType: WritingTransferUnitType;
    unitId: string;
    ownerId: string;
    createdAt: string;
    assignments: AssignmentRow[];
  }> = standalone.map((assignment) => ({
    unitType: "assignment" as const,
    unitId: String(assignment.assignment_id),
    ownerId: String(assignment.teacher_id),
    createdAt: assignment.created_at,
    assignments: [assignment]
  }));

  for (const group of input.groups) {
    const groupId = String(group.group_id);
    const groupAssignments = (byGroupId.get(groupId) ?? []).slice().sort(
      (left, right) => (left.group_position ?? 0) - (right.group_position ?? 0)
    );
    unitDrafts.push({
      unitType: "group",
      unitId: groupId,
      ownerId: String(group.teacher_id),
      createdAt: group.created_at,
      assignments: groupAssignments
    });
  }

  return unitDrafts
    .filter((draft) => draft.assignments.length > 0)
    .map((draft) => {
      const recipientIds = Array.from(
        new Set(
          draft.assignments.flatMap((assignment) =>
            Array.from(membersByAssignment.get(String(assignment.assignment_id)) ?? [])
          )
        )
      );
      const recipients: WritingTransferRecipient[] = recipientIds.map((id) => {
        const profile = recipientById.get(id);
        return {
          id,
          displayName: transferRecipientName(profile) || "未命名学生",
          email: profile?.email ?? ""
        };
      });
      const submittedAttemptCount = draft.assignments.reduce(
        (count, assignment) =>
          count +
          (submittedAttemptsByAssignment.get(String(assignment.assignment_id)) ?? 0),
        0
      );
      const publishedReviewCount = draft.assignments.reduce((count, assignment) => {
        const attempts = attemptsByAssignment.get(String(assignment.assignment_id)) ?? [];
        return count + attempts.filter((attemptId) => publishedReviewsByAttempt.has(attemptId)).length;
      }, 0);
      const compatibility: Record<string, WritingTransferTeacherCompatibility> = {};
      for (const teacher of input.teachers) {
        const missingStudents = missingWritingBindingRecipients(
          recipients,
          teacher.id,
          input.bindings
        );
        compatibility[teacher.id] = {
          eligible: missingStudents.length === 0,
          missingStudents
        };
      }
      const sortedAssignments = draft.assignments
        .slice()
        .sort((left, right) => (left.group_position ?? 0) - (right.group_position ?? 0));
      return {
        unitType: draft.unitType,
        unitId: draft.unitId,
        ownerId: draft.ownerId,
        ownerName: adminNameById.get(draft.ownerId) ?? "Admin",
        createdAt: draft.createdAt,
        title: writingTransferDisplayTitle(
          sortedAssignments[0]?.question_snapshot,
          sortedAssignments[0]?.question_id
        ),
        taskTypes: Array.from(
          new Set(sortedAssignments.map((assignment) => assignment.task_type))
        ),
        assignments: sortedAssignments.map((assignment) => ({
          assignmentId: String(assignment.assignment_id),
          groupPosition: assignment.group_position,
          taskType: assignment.task_type,
          status: assignment.status === "withdrawn" ? "withdrawn" : "active",
          deleted: Boolean(assignment.deleted_at),
          createdAt: assignment.created_at,
          displayTitle: writingTransferDisplayTitle(
            assignment.question_snapshot,
            assignment.question_id
          )
        })),
        recipients,
        submittedAttemptCount,
        publishedReviewCount,
        hasSubmittedAttempt: submittedAttemptCount > 0,
        hasPublishedReview: publishedReviewCount > 0,
        compatibility
      } satisfies WritingAssignmentTransferUnit;
    })
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

export async function loadWritingAssignmentTransferBoard(
  supabase: SupabaseClient
): Promise<WritingAssignmentTransferBoard> {
  const adminResult = await readAllSupabaseRows<ProfileRow>((from, to) =>
    supabase
      .from("profiles")
      .select("id,email,full_name")
      .eq("role", "admin")
      .order("id", { ascending: true })
      .range(from, to)
  );
  if (adminResult.error) throw adminResult.error;
  const admins = adminResult.data ?? [];
  const adminIds = admins.map((admin) => String(admin.id));
  if (adminIds.length === 0) return { units: [], teachers: [] };

  const [assignmentsResult, groupsResult, teachersResult] = await Promise.all([
    readAllSupabaseRows<AssignmentRow>((from, to) =>
      supabase
        .from("writing_assignments")
        .select(TRANSFER_ASSIGNMENT_FIELDS)
        .in("teacher_id", adminIds)
        .order("created_at", { ascending: false })
        .range(from, to)
    ),
    readAllSupabaseRows<GroupRow>((from, to) =>
      supabase
        .from("writing_assignment_groups")
        .select("group_id,teacher_id,created_at")
        .in("teacher_id", adminIds)
        .order("created_at", { ascending: false })
        .range(from, to)
    ),
    readAllSupabaseRows<ProfileRow>((from, to) =>
      supabase
        .from("profiles")
        .select("id,email,full_name,role,is_active")
        .eq("role", "teacher")
        .eq("is_active", true)
        .order("full_name", { ascending: true, nullsFirst: false })
        .order("id", { ascending: true })
        .range(from, to)
    )
  ]);
  if (assignmentsResult.error) throw assignmentsResult.error;
  if (groupsResult.error) throw groupsResult.error;
  if (teachersResult.error) throw teachersResult.error;

  const assignments = assignmentsResult.data ?? [];
  const groups = groupsResult.data ?? [];
  const teachers: WritingTransferTeacher[] = (teachersResult.data ?? []).map(
    (teacher) => ({
      id: String(teacher.id),
      displayName: transferRecipientName(teacher) || "未命名教师",
      email: teacher.email ?? ""
    })
  );
  if (assignments.length === 0) return { units: [], teachers };

  const assignmentIds = assignments.map((assignment) => String(assignment.assignment_id));
  const [membersResult, attemptsResult] = await Promise.all([
    readAllSupabaseRows<MemberRow>((from, to) =>
      supabase
        .from("writing_assignment_students")
        .select("assignment_id,student_id")
        .in("assignment_id", assignmentIds)
        .order("assignment_id", { ascending: true })
        .range(from, to)
    ),
    readAllSupabaseRows<AttemptRow>((from, to) =>
      supabase
        .from("writing_attempts")
        .select("attempt_id,assignment_id")
        .eq("status", "submitted")
        .in("assignment_id", assignmentIds)
        .order("attempt_id", { ascending: true })
        .range(from, to)
    )
  ]);
  if (membersResult.error) throw membersResult.error;
  if (attemptsResult.error) throw attemptsResult.error;

  const members = membersResult.data ?? [];
  const submittedAttempts = attemptsResult.data ?? [];
  const attemptIds = submittedAttempts.map((attempt) => String(attempt.attempt_id));
  const reviews = attemptIds.length > 0
    ? await readAllSupabaseRows<ReviewRow>((from, to) =>
        supabase
          .from("writing_reviews")
          .select("attempt_id,status,published_at")
          .in("attempt_id", attemptIds)
          .order("attempt_id", { ascending: true })
          .range(from, to)
      )
    : { data: [] as ReviewRow[], error: null };
  if (reviews.error) throw reviews.error;

  const recipientIds = Array.from(
    new Set(members.map((member) => String(member.student_id)))
  );
  const [recipientProfilesResult, bindingsResult] = await Promise.all([
    recipientIds.length > 0
      ? readAllSupabaseRows<ProfileRow>((from, to) =>
          supabase
            .from("profiles")
            .select("id,email,full_name")
            .in("id", recipientIds)
            .order("id", { ascending: true })
            .range(from, to)
        )
      : Promise.resolve({ data: [] as ProfileRow[], error: null }),
    recipientIds.length > 0
      ? readAllSupabaseRows<BindingRow>((from, to) =>
          supabase
            .from("teacher_student_bindings")
            .select("teacher_id,student_id,domain")
            .eq("domain", "writing")
            .in("student_id", recipientIds)
            .order("student_id", { ascending: true })
            .range(from, to)
        )
      : Promise.resolve({ data: [] as BindingRow[], error: null })
  ]);
  if (recipientProfilesResult.error) throw recipientProfilesResult.error;
  if (bindingsResult.error) throw bindingsResult.error;

  return {
    units: buildWritingAssignmentTransferUnits({
      admins,
      teachers,
      assignments,
      groups,
      members,
      submittedAttempts,
      reviews: reviews.data ?? [],
      recipientProfiles: recipientProfilesResult.data ?? [],
      bindings: (bindingsResult.data ?? []).map((binding) => ({
        teacherId: String(binding.teacher_id),
        studentId: String(binding.student_id),
        domain: String(binding.domain)
      }))
    }),
    teachers
  };
}

export async function runWritingAssignmentTransfer(
  supabase: SupabaseClient,
  input: { unitType: unknown; unitId: unknown; targetTeacherId: unknown }
): Promise<WritingAssignmentTransferResult> {
  const unitType = input.unitType;
  const unitId = typeof input.unitId === "string" ? input.unitId.trim() : "";
  const targetTeacherId =
    typeof input.targetTeacherId === "string" ? input.targetTeacherId.trim() : "";
  if (!isWritingTransferUnitType(unitType) || !unitId || !targetTeacherId) {
    throw new WritingAssignmentTransferError(
      "TRANSFER_INPUT_INVALID",
      "转移参数无效。",
      400
    );
  }

  const targetResult = await supabase
    .from("profiles")
    .select("id,role,is_active")
    .eq("id", targetTeacherId)
    .maybeSingle();
  if (targetResult.error) throw targetResult.error;
  if (!isEligibleWritingTransferTeacher(targetResult.data as ProfileRow | null)) {
    throw new WritingAssignmentTransferError(
      "INVALID_TARGET_TEACHER",
      "目标账号必须是启用的普通教师。",
      400
    );
  }

  let assignmentIds: string[] = [];
  let sourceTeacherId = "";
  if (unitType === "assignment") {
    const assignmentResult = await supabase
      .from("writing_assignments")
      .select("assignment_id,teacher_id,group_id")
      .eq("assignment_id", unitId)
      .maybeSingle();
    if (assignmentResult.error) throw assignmentResult.error;
    const assignment = assignmentResult.data as
      | { assignment_id: string; teacher_id: string; group_id: string | null }
      | null;
    if (!assignment) {
      throw new WritingAssignmentTransferError(
        "TRANSFER_UNIT_NOT_FOUND",
        "未找到这项历史作业。",
        404
      );
    }
    if (assignment.group_id) {
      throw new WritingAssignmentTransferError(
        "TRANSFER_GROUP_REQUIRED",
        "该作业属于作业组，请按作业组整体转移。",
        409
      );
    }
    assignmentIds = [String(assignment.assignment_id)];
    sourceTeacherId = String(assignment.teacher_id);
  } else {
    const groupResult = await supabase
      .from("writing_assignment_groups")
      .select("group_id,teacher_id")
      .eq("group_id", unitId)
      .maybeSingle();
    if (groupResult.error) throw groupResult.error;
    const group = groupResult.data as { group_id: string; teacher_id: string } | null;
    if (!group) {
      throw new WritingAssignmentTransferError(
        "TRANSFER_UNIT_NOT_FOUND",
        "未找到这个历史作业组。",
        404
      );
    }
    const childrenResult = await readAllSupabaseRows<{
      assignment_id: string;
      teacher_id: string;
    }>((from, to) =>
      supabase
        .from("writing_assignments")
        .select("assignment_id,teacher_id")
        .eq("group_id", unitId)
        .order("assignment_id", { ascending: true })
        .range(from, to)
    );
    if (childrenResult.error) throw childrenResult.error;
    const children = childrenResult.data ?? [];
    if (children.length === 0) {
      throw new WritingAssignmentTransferError(
        "TRANSFER_UNIT_NOT_FOUND",
        "未找到这个历史作业组。",
        404
      );
    }
    if (
      children.some(
        (child) => String(child.teacher_id) !== String(group.teacher_id)
      )
    ) {
      throw new WritingAssignmentTransferError(
        "TRANSFER_OWNER_MISMATCH",
        "作业组内存在归属不一致的作业，无法整体转移。",
        409
      );
    }
    assignmentIds = children.map((child) => String(child.assignment_id));
    sourceTeacherId = String(group.teacher_id);
  }

  const sourceResult = await supabase
    .from("profiles")
    .select("id,role")
    .eq("id", sourceTeacherId)
    .maybeSingle();
  if (sourceResult.error) throw sourceResult.error;
  if ((sourceResult.data as ProfileRow | null)?.role !== "admin") {
    throw new WritingAssignmentTransferError(
      "TRANSFER_SOURCE_NOT_ADMIN",
      "该作业当前不属于 Admin，可能已被转移。",
      409
    );
  }

  const membersResult = await readAllSupabaseRows<MemberRow>((from, to) =>
    supabase
      .from("writing_assignment_students")
      .select("assignment_id,student_id")
      .in("assignment_id", assignmentIds)
      .order("assignment_id", { ascending: true })
      .range(from, to)
  );
  if (membersResult.error) throw membersResult.error;
  const recipientIds = Array.from(
    new Set((membersResult.data ?? []).map((member) => String(member.student_id)))
  );
  if (recipientIds.length > 0) {
    const [recipientProfilesResult, bindingsResult] = await Promise.all([
      readAllSupabaseRows<ProfileRow>((from, to) =>
        supabase
          .from("profiles")
          .select("id,email,full_name")
          .in("id", recipientIds)
          .order("id", { ascending: true })
          .range(from, to)
      ),
      readAllSupabaseRows<BindingRow>((from, to) =>
        supabase
          .from("teacher_student_bindings")
          .select("teacher_id,student_id,domain")
          .eq("domain", "writing")
          .in("student_id", recipientIds)
          .order("student_id", { ascending: true })
          .range(from, to)
      )
    ]);
    if (recipientProfilesResult.error) throw recipientProfilesResult.error;
    if (bindingsResult.error) throw bindingsResult.error;
    const recipients: WritingTransferRecipient[] = recipientIds.map((id) => {
      const profile = (recipientProfilesResult.data ?? []).find(
        (row) => String(row.id) === id
      );
      return {
        id,
        displayName: transferRecipientName(profile) || "未命名学生",
        email: profile?.email ?? ""
      };
    });
    const missingStudents = missingWritingBindingRecipients(
      recipients,
      targetTeacherId,
      (bindingsResult.data ?? []).map((binding) => ({
        teacherId: String(binding.teacher_id),
        studentId: String(binding.student_id),
        domain: String(binding.domain)
      }))
    );
    if (missingStudents.length > 0) {
      throw new WritingAssignmentTransferError(
        "MISSING_WRITING_BINDING",
        `以下学生尚未绑定该 Writing Teacher：${missingStudents
          .map((student) => student.displayName)
          .join("、")}`,
        409,
        { missingStudents }
      );
    }
  }

  const { data, error } = await supabase.rpc("transfer_writing_assignment_ownership", {
    p_assignment_id: unitType === "assignment" ? unitId : null,
    p_group_id: unitType === "group" ? unitId : null,
    p_target_teacher_id: targetTeacherId
  });
  if (error) throw mapTransferRpcError(error.message);

  const resultAssignmentIds =
    data && typeof data === "object" && Array.isArray((data as { assignment_ids?: unknown }).assignment_ids)
      ? ((data as { assignment_ids: unknown[] }).assignment_ids).map(String)
      : assignmentIds;
  return {
    unitType,
    unitId,
    targetTeacherId,
    assignmentIds: resultAssignmentIds
  };
}

function mapTransferRpcError(message: string) {
  if (message.includes("INVALID_TARGET_TEACHER")) {
    return new WritingAssignmentTransferError(
      "INVALID_TARGET_TEACHER",
      "目标账号必须是启用的普通教师。",
      400
    );
  }
  if (message.includes("TRANSFER_UNIT_NOT_FOUND")) {
    return new WritingAssignmentTransferError(
      "TRANSFER_UNIT_NOT_FOUND",
      "未找到这项历史作业。",
      404
    );
  }
  if (message.includes("TRANSFER_GROUP_REQUIRED")) {
    return new WritingAssignmentTransferError(
      "TRANSFER_GROUP_REQUIRED",
      "该作业属于作业组，请按作业组整体转移。",
      409
    );
  }
  if (message.includes("TRANSFER_OWNER_MISMATCH")) {
    return new WritingAssignmentTransferError(
      "TRANSFER_OWNER_MISMATCH",
      "作业组内存在归属不一致的作业，无法整体转移。",
      409
    );
  }
  if (message.includes("TRANSFER_SOURCE_NOT_ADMIN")) {
    return new WritingAssignmentTransferError(
      "TRANSFER_SOURCE_NOT_ADMIN",
      "该作业当前不属于 Admin，可能已被转移。",
      409
    );
  }
  if (message.includes("TRANSFER_MISSING_WRITING_BINDING")) {
    return new WritingAssignmentTransferError(
      "MISSING_WRITING_BINDING",
      "部分学生尚未绑定该 Writing Teacher，请先完成教师绑定。",
      409
    );
  }
  return new WritingAssignmentTransferError(
    "TRANSFER_FAILED",
    "历史作业转移失败，请稍后重试。",
    500
  );
}
