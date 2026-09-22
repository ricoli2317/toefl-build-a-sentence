import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { getPreferredUserDisplayName } from "@/lib/userDisplayName";
import { loadWritingAssignmentDisplayNames } from "@/lib/historicalPracticeDisplay";
import {
  buildCustomWritingQuestionSnapshot,
  calculateWritingAssignmentStudentStatus,
  earliestWritingAssignmentSubmission,
  isLaterWritingAssignmentSubmission,
  writingAssignmentTitle,
  type WritingAssignmentDetail
} from "@/lib/writingAssignments";
import {
  chunkValues,
  prepareWritingAssignmentMembership,
  prepareWritingAssignmentMutation,
  requireWritingAssignmentTeacher,
  writingAssignmentJson
} from "@/lib/writingAssignmentsServer";

export const dynamic = "force-dynamic";

type MemberRow = { student_id: string; assigned_at: string };
type ProfileRow = { id: string; email: string | null; full_name: string | null };
type AttemptRow = { attempt_id: string; user_id: string; status: string; submitted_at: string | null };
type ReviewRow = { attempt_id: string; status: string; published_at: string | null };

const ASSIGNMENT_FIELDS =
  "assignment_id,group_id,group_position,task_type,question_source,question_id,question_snapshot,status,deleted_at,due_at,created_at,updated_at";

export async function GET(
  request: Request,
  { params }: { params: { assignmentId: string } }
) {
  try {
    const auth = await requireWritingAssignmentTeacher(request);
    if (auth.error) return auth.error;
    if (!auth.supabase || !auth.teacherId) return unauthorized();
    const { data: assignment, error: assignmentError } = await auth.supabase
      .from("writing_assignments")
      .select(ASSIGNMENT_FIELDS)
      .eq("assignment_id", params.assignmentId)
      .eq("teacher_id", auth.teacherId)
      .is("deleted_at", null)
      .maybeSingle();
    if (assignmentError) throw assignmentError;
    if (!assignment) return notFound();

    const snapshotTitle = writingAssignmentTitle(assignment.question_snapshot);
    const [membersResult, displayNames] = await Promise.all([
      readAllSupabaseRows<MemberRow>((from, to) =>
        auth.supabase!
          .from("writing_assignment_students")
          .select("student_id,assigned_at")
          .eq("assignment_id", params.assignmentId)
          .order("assigned_at", { ascending: true })
          .order("student_id", { ascending: true })
          .range(from, to)
      ),
      loadWritingAssignmentDisplayNames(auth.supabase, [{
        assignmentId: String(assignment.assignment_id),
        fallbackDisplayName: snapshotTitle,
        questionId: assignment.question_id,
        questionSource: assignment.question_source,
        taskType: assignment.task_type
      }])
    ]);
    if (membersResult.error) throw membersResult.error;
    const members = membersResult.data ?? [];
    const studentIds = members.map((member) => member.student_id);
    const [profiles, attempts] = await Promise.all([
      readProfiles(auth.supabase, studentIds),
      readAllSupabaseRows<AttemptRow>((from, to) =>
        auth.supabase!
          .from("writing_attempts")
          .select("attempt_id,user_id,status,submitted_at")
          .eq("assignment_id", params.assignmentId)
          .order("submitted_at", { ascending: true, nullsFirst: false })
          .order("attempt_id", { ascending: true })
          .range(from, to)
      )
    ]);
    if (attempts.error) throw attempts.error;
    const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
    const attemptStudents = new Set<string>();
    const submissionsByStudent = new Map<string, string[]>();
    const latestSubmissionByStudent = new Map<string, AttemptRow>();
    for (const attempt of attempts.data ?? []) {
      attemptStudents.add(attempt.user_id);
      if (attempt.status !== "submitted" || !attempt.submitted_at) continue;
      submissionsByStudent.set(attempt.user_id, [
        ...(submissionsByStudent.get(attempt.user_id) ?? []),
        attempt.submitted_at
      ]);
      const current = latestSubmissionByStudent.get(attempt.user_id);
      if (!current || isLaterWritingAssignmentSubmission(attempt, current)) {
        latestSubmissionByStudent.set(attempt.user_id, attempt);
      }
    }

    const latestAttemptIds = Array.from(
      latestSubmissionByStudent.values(),
      (attempt) => attempt.attempt_id
    );
    const reviewStatusByAttemptId = new Map<string, "reviewing" | "published">();
    if (latestAttemptIds.length > 0) {
      const reviews = await readAllSupabaseRows<ReviewRow>((from, to) =>
        auth.supabase!
          .from("writing_reviews")
          .select("attempt_id,status,published_at")
          .in("attempt_id", latestAttemptIds)
          .range(from, to)
      );
      if (reviews.error) throw reviews.error;
      for (const review of reviews.data ?? []) {
        reviewStatusByAttemptId.set(
          review.attempt_id,
          review.status === "published" && review.published_at
            ? "published"
            : "reviewing"
        );
      }
    }

    const students = members.map((member) => {
      const profile = profileById.get(member.student_id);
      const firstSubmittedAt = earliestWritingAssignmentSubmission(
        submissionsByStudent.get(member.student_id) ?? []
      );
      const latestSubmission = latestSubmissionByStudent.get(member.student_id);
      return {
        student_id: member.student_id,
        student_name: getPreferredUserDisplayName({
          email: profile?.email,
          profileFullName: profile?.full_name
        }),
        student_email: profile?.email ?? "",
        assigned_at: member.assigned_at,
        first_submitted_at: firstSubmittedAt,
        has_attempt: attemptStudents.has(member.student_id),
        latest_submitted_attempt_id: latestSubmission?.attempt_id ?? null,
        latest_review_status: latestSubmission
          ? reviewStatusByAttemptId.get(latestSubmission.attempt_id) ?? null
          : null,
        status: calculateWritingAssignmentStudentStatus({
          dueAt: assignment.due_at,
          firstSubmittedAt
        })
      };
    });
    const completedCount = students.filter((student) => student.first_submitted_at).length;
    const publishedCount = students.filter(
      (student) => student.latest_review_status === "published"
    ).length;

    const detail: WritingAssignmentDetail = {
      assignment_id: String(assignment.assignment_id),
      group_id: assignment.group_id,
      group_position: assignment.group_position,
      task_type: assignment.task_type,
      question_source: assignment.question_source,
      question_id: assignment.question_id,
      question_snapshot: assignment.question_snapshot,
      display_name: displayNames.get(String(assignment.assignment_id)) ?? snapshotTitle,
      status: assignment.status,
      due_at: assignment.due_at,
      created_at: assignment.created_at,
      updated_at: assignment.updated_at,
      assigned_count: members.length,
      completed_count: completedCount,
      published_count: publishedCount,
      has_attempts: attemptStudents.size > 0,
      has_submitted_attempts: Array.from(submissionsByStudent.values()).some(
        (values) => values.length > 0
      ),
      students
    };
    return writingAssignmentJson({ assignment: detail });
  } catch (error) {
    console.error("[writing-assignments] detail_load_failed", error);
    return writingAssignmentJson(
      { code: "ASSIGNMENT_LOAD_FAILED", message: "作业详情加载失败，请稍后重试。" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: { assignmentId: string } }
) {
  try {
    const auth = await requireWritingAssignmentTeacher(request);
    if (auth.error) return auth.error;
    if (!auth.supabase || !auth.teacherId) return unauthorized();
    const body = await request.json() as Record<string, unknown>;
    const action = body.action;
    const { data: assignment, error: assignmentError } = await auth.supabase
      .from("writing_assignments")
      .select(ASSIGNMENT_FIELDS)
      .eq("assignment_id", params.assignmentId)
      .eq("teacher_id", auth.teacherId)
      .is("deleted_at", null)
      .maybeSingle();
    if (assignmentError) throw assignmentError;
    if (!assignment) return notFound();

    if (action === "withdraw") {
      if (assignment.status !== "active") return invalidState("只有进行中的作业可以撤回。");
      if (assignment.group_id) {
        // The whole group is withdrawn in one database transaction: locks,
        // "all active" and "no attempt" checks and the update share the same
        // transaction, so no half-withdrawn group and no application-level
        // restore step exist.
        const { error: groupWithdrawError } = await auth.supabase.rpc(
          "withdraw_writing_assignment_group",
          {
            p_teacher_id: auth.teacherId,
            p_group_id: assignment.group_id
          }
        );
        if (groupWithdrawError) {
          const groupWithdrawMessage = errorMessage(groupWithdrawError);
          if (groupWithdrawMessage.includes("ASSIGNMENT_GROUP_HAS_ATTEMPT")) {
            return invalidState("已有学生开始作答，该作业不能撤回。");
          }
          if (groupWithdrawMessage.includes("ASSIGNMENT_GROUP_NOT_ACTIVE")) {
            return invalidState("作业状态已经发生变化，请刷新后重试。");
          }
          if (groupWithdrawMessage.includes("ASSIGNMENT_GROUP_NOT_FOUND")) {
            return notFound();
          }
          throw groupWithdrawError;
        }
        return writingAssignmentJson({
          assignmentId: params.assignmentId,
          status: "withdrawn"
        });
      }
      // Historical assignments without a group keep the original per-item RPC.
      const withdrawResult = await withdrawSingleWritingAssignment(
        auth.supabase,
        params.assignmentId,
        auth.teacherId
      );
      if (withdrawResult.errorResponse) return withdrawResult.errorResponse;
      return writingAssignmentJson({
        assignmentId: params.assignmentId,
        status: "withdrawn"
      });
    }
    if (action === "reactivate") {
      if (assignment.status !== "withdrawn") return invalidState("只有已撤回的作业可以重新布置。");
      return await updateLifecycle(auth.supabase, params.assignmentId, auth.teacherId, "withdrawn", {
        status: "active"
      });
    }
    if (action === "soft_delete") {
      if (assignment.status !== "withdrawn") return invalidState("请先撤回作业，再进行删除。");
      return await updateLifecycle(auth.supabase, params.assignmentId, auth.teacherId, "withdrawn", {
        deleted_at: new Date().toISOString()
      });
    }
    if (action !== "edit") {
      return writingAssignmentJson({ code: "INVALID_ACTION", message: "无效的作业操作。" }, { status: 400 });
    }
    if (assignment.status !== "withdrawn") {
      return invalidState("只有已撤回的作业可以编辑。");
    }

    const { data: submittedAttempt, error: attemptError } = await auth.supabase
      .from("writing_attempts")
      .select("attempt_id")
      .eq("assignment_id", params.assignmentId)
      .eq("status", "submitted")
      .limit(1)
      .maybeSingle();
    if (attemptError) throw attemptError;

    if (submittedAttempt) assertLockedQuestionInput(body, assignment);
    const prepared = submittedAttempt
      ? {
          ...(await prepareWritingAssignmentMembership(auth.supabase, body, auth.actor ?? undefined)),
          taskType: assignment.task_type,
          questionSource: assignment.question_source,
          questionId: assignment.question_id,
          questionSnapshot: assignment.question_snapshot
        }
      : await prepareWritingAssignmentMutation(auth.supabase, body, { actor: auth.actor ?? undefined });
    const { error: updateError } = await auth.supabase.rpc(
      "update_withdrawn_writing_assignment",
      {
        p_assignment_id: params.assignmentId,
        p_teacher_id: auth.teacherId,
        p_task_type: prepared.taskType,
        p_question_source: prepared.questionSource,
        p_question_id: prepared.questionId,
        p_question_snapshot: prepared.questionSnapshot,
        p_due_at: prepared.dueAt,
        p_student_ids: prepared.studentIds,
        p_reactivate: body.reactivate === true
      }
    );
    if (updateError) throw updateError;
    return writingAssignmentJson({
      assignmentId: params.assignmentId,
      status: body.reactivate === true ? "active" : "withdrawn"
    });
  } catch (error) {
    const message = errorMessage(error);
    if (message.includes("QUESTION_LOCKED_AFTER_SUBMISSION")) {
      return invalidState("已有学生提交，题型和题目内容不能修改。");
    }
    if (message.includes("STUDENT_HAS_ATTEMPT")) {
      return invalidState("已有草稿或提交记录的学生不能移除。");
    }
    if (message.includes("ASSIGNMENT_NOT_WITHDRAWN")) {
      return invalidState("只有已撤回的作业可以编辑或重新布置。");
    }
    if (/^(请选择|请至少|请填写|请输入|所选|截止)/.test(message)) {
      return writingAssignmentJson({ code: "INVALID_ASSIGNMENT", message }, { status: 400 });
    }
    console.error("[writing-assignments] mutation_failed", error);
    return writingAssignmentJson(
      { code: "ASSIGNMENT_UPDATE_FAILED", message: "作业更新失败，请稍后重试。" },
      { status: 500 }
    );
  }
}

function assertLockedQuestionInput(
  body: Record<string, unknown>,
  assignment: {
    task_type: "email" | "academic_discussion";
    question_source: "question_bank" | "custom";
    question_id: string | null;
    question_snapshot: Record<string, unknown>;
  }
) {
  if (body.taskType !== assignment.task_type || body.questionSource !== assignment.question_source) {
    throw new Error("QUESTION_LOCKED_AFTER_SUBMISSION");
  }
  if (assignment.question_source === "question_bank") {
    if (body.questionId !== assignment.question_id) throw new Error("QUESTION_LOCKED_AFTER_SUBMISSION");
    return;
  }
  try {
    const candidate = buildCustomWritingQuestionSnapshot({
      taskType: assignment.task_type,
      fields: isRecord(body.customQuestion) ? body.customQuestion : {},
      id: "locked-comparison"
    });
    const fields = assignment.task_type === "email"
      ? ["set_title", "scenario", "task_instruction", "requirement_1", "requirement_2", "requirement_3", "closing_instruction", "recipient", "subject"]
      : [
          "set_title", "professor_name", "professor_prompt", "student_1_name",
          "student_1_response", "student_2_name", "student_2_response",
          ...["professor_avatar_type", "student_1_avatar_type", "student_2_avatar_type"]
            .filter((field) => assignment.question_snapshot[field] !== undefined)
        ];
    if (fields.some((field) => candidate[field as keyof typeof candidate] !== assignment.question_snapshot[field])) {
      throw new Error("QUESTION_LOCKED_AFTER_SUBMISSION");
    }
  } catch {
    throw new Error("QUESTION_LOCKED_AFTER_SUBMISSION");
  }
}

async function withdrawSingleWritingAssignment(
  supabase: NonNullable<Awaited<ReturnType<typeof requireWritingAssignmentTeacher>>["supabase"]>,
  assignmentId: string,
  teacherId: string
): Promise<{ errorResponse?: Response }> {
  const { error } = await supabase.rpc("withdraw_writing_assignment", {
    p_assignment_id: assignmentId,
    p_teacher_id: teacherId
  });
  if (!error) return {};
  const message = errorMessage(error);
  if (message.includes("ASSIGNMENT_HAS_ATTEMPT")) {
    return { errorResponse: invalidState("已有学生开始作答，该作业不能撤回。") };
  }
  if (message.includes("ASSIGNMENT_NOT_ACTIVE")) {
    return { errorResponse: invalidState("作业状态已经发生变化，请刷新后重试。") };
  }
  throw error;
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function updateLifecycle(
  supabase: NonNullable<Awaited<ReturnType<typeof requireWritingAssignmentTeacher>>["supabase"]>,
  assignmentId: string,
  teacherId: string,
  expectedStatus: "active" | "withdrawn",
  values: { status?: "active" | "withdrawn"; deleted_at?: string }
) {
  const { data, error } = await supabase
    .from("writing_assignments")
    .update(values)
    .eq("assignment_id", assignmentId)
    .eq("teacher_id", teacherId)
    .eq("status", expectedStatus)
    .is("deleted_at", null)
    .select("assignment_id,status")
    .maybeSingle();
  if (error) throw error;
  if (!data) return invalidState("作业状态已经发生变化，请刷新后重试。");
  return writingAssignmentJson({ assignmentId, status: data.status });
}

function unauthorized() {
  return writingAssignmentJson({ message: "无权访问教师端作业数据。" }, { status: 401 });
}

function notFound() {
  return writingAssignmentJson(
    { code: "ASSIGNMENT_NOT_FOUND", message: "未找到这项作业。" },
    { status: 404 }
  );
}

function invalidState(message: string) {
  return writingAssignmentJson({ code: "INVALID_ASSIGNMENT_STATE", message }, { status: 409 });
}

async function readProfiles(
  supabase: NonNullable<Awaited<ReturnType<typeof requireWritingAssignmentTeacher>>["supabase"]>,
  studentIds: string[]
) {
  const rows: ProfileRow[] = [];
  for (const batch of chunkValues(studentIds)) {
    const result = await readAllSupabaseRows<ProfileRow>((from, to) =>
      supabase
        .from("profiles")
        .select("id,email,full_name")
        .in("id", batch)
        .order("id", { ascending: true })
        .range(from, to)
    );
    if (result.error) throw result.error;
    rows.push(...(result.data ?? []));
  }
  return rows;
}
