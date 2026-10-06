import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllSupabaseRows } from "./supabasePagination.ts";
import { loadTeacherScope } from "./teacherScope.server.ts";
import type { UserRole } from "./types.ts";
import type {
  WritingReviewModerationAction,
  WritingReviewModerationReason,
  WritingReviewModerationResult
} from "./writingReviewModeration.ts";

export type WritingReviewModerationActor = {
  userId: string;
  role: UserRole;
};

type ModerationAttemptRow = {
  attempt_id: string;
  assignment_id: string | null;
  user_id: string;
  status: string;
};

type ActiveStudentRow = {
  id: string;
};

/**
 * One batch 退回 / 忽略 request.
 *
 * The route owns authentication; this module re-applies exactly the same
 * teaching scope as the Writing Review list (own assignments for assignment
 * attempts, writing-bound active students for self practice, everything for
 * admin) and only hands authorized attempts to the transactional
 * moderate_teacher_writing_attempts RPC, which re-validates the live attempt
 * status and review state under a row lock.
 */
export async function moderateWritingReviewAttempts(
  supabase: SupabaseClient,
  input: {
    action: WritingReviewModerationAction;
    attemptIds: string[];
    actor: WritingReviewModerationActor;
  }
): Promise<WritingReviewModerationResult[]> {
  const resultsById = new Map<string, WritingReviewModerationResult>();
  const deny = (attemptId: string) => {
    // A manual request for an attempt outside the teacher's scope must look
    // exactly like a missing attempt.
    resultsById.set(attemptId, {
      attemptId,
      outcome: "skipped",
      reason: "not_found"
    });
  };

  const attemptResult = await readAllSupabaseRows<ModerationAttemptRow>(
    (from, to) =>
      supabase
        .from("writing_attempts")
        .select("attempt_id,assignment_id,user_id,status")
        .in("attempt_id", input.attemptIds)
        .order("attempt_id", { ascending: true })
        .range(from, to)
  );
  if (attemptResult.error) throw new Error(attemptResult.error.message);
  const attemptById = new Map(
    (attemptResult.data ?? []).map((attempt) => [String(attempt.attempt_id), attempt])
  );

  const assignmentIds = unique(
    (attemptResult.data ?? [])
      .map((attempt) => attempt.assignment_id)
      .filter((value): value is string => Boolean(value))
  );
  const studentIds = unique(
    (attemptResult.data ?? []).map((attempt) => String(attempt.user_id))
  );
  const isAdmin = input.actor.role === "admin";

  const [assignmentResult, scope, activeStudentResult] = await Promise.all([
    assignmentIds.length > 0
      ? readAllSupabaseRows<{ assignment_id: string; teacher_id: string }>((from, to) =>
          supabase
            .from("writing_assignments")
            .select("assignment_id,teacher_id")
            .in("assignment_id", assignmentIds)
            .order("assignment_id", { ascending: true })
            .range(from, to)
        )
      : Promise.resolve({ data: [] as Array<{ assignment_id: string; teacher_id: string }>, error: null }),
    isAdmin
      ? Promise.resolve(null)
      : loadTeacherScope(supabase, {
          userId: input.actor.userId,
          role: input.actor.role
        }),
    isAdmin
      ? readAllSupabaseRows<ActiveStudentRow>((from, to) =>
          supabase
            .from("profiles")
            .select("id")
            .eq("role", "student")
            .eq("is_active", true)
            .in("id", studentIds)
            .order("id", { ascending: true })
            .range(from, to)
        )
      : Promise.resolve({ data: [] as ActiveStudentRow[], error: null })
  ]);
  if (assignmentResult.error) throw new Error(assignmentResult.error.message);
  if (activeStudentResult.error) throw new Error(activeStudentResult.error.message);

  const assignmentTeacherById = new Map(
    (assignmentResult.data ?? []).map((assignment) => [
      String(assignment.assignment_id),
      String(assignment.teacher_id)
    ])
  );
  const writingStudentIdSet = new Set(scope?.writingStudentIds ?? []);
  const activeStudentIdSet = new Set(
    (activeStudentResult.data ?? []).map((student) => String(student.id))
  );

  function authorized(attempt: ModerationAttemptRow) {
    if (isAdmin) {
      const userId = String(attempt.user_id);
      return userId === input.actor.userId || activeStudentIdSet.has(userId);
    }
    if (attempt.assignment_id) {
      return (
        assignmentTeacherById.get(String(attempt.assignment_id)) ===
        input.actor.userId
      );
    }
    return writingStudentIdSet.has(String(attempt.user_id));
  }

  const authorizedIds: string[] = [];
  for (const attemptId of input.attemptIds) {
    const attempt = attemptById.get(attemptId);
    if (!attempt || !authorized(attempt)) {
      deny(attemptId);
      continue;
    }
    authorizedIds.push(attemptId);
  }

  if (authorizedIds.length > 0) {
    const { data, error } = await supabase.rpc(
      "moderate_teacher_writing_attempts",
      {
        p_action: input.action,
        p_attempt_ids: authorizedIds
      }
    );
    if (error) {
      throw new Error(`Writing review moderation failed: ${error.message}`);
    }
    const rows = Array.isArray(data) ? data : [];
    for (const row of rows) {
      const result = parseRpcResult(row);
      if (result && authorizedIds.includes(result.attemptId)) {
        resultsById.set(result.attemptId, result);
      }
    }
  }

  return input.attemptIds.map(
    (attemptId) =>
      resultsById.get(attemptId) ?? {
        attemptId,
        outcome: "skipped" as const,
        reason: "failed" as WritingReviewModerationReason
      }
  );
}

function parseRpcResult(value: unknown): WritingReviewModerationResult | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const attemptId =
    typeof record.attempt_id === "string" ? record.attempt_id.toLowerCase() : "";
  if (!attemptId) return null;
  if (record.outcome === "returned" || record.outcome === "ignored") {
    return { attemptId, outcome: record.outcome, reason: null };
  }
  if (record.outcome === "skipped") {
    const reason: WritingReviewModerationReason =
      record.reason === "not_found" ||
      record.reason === "not_submitted" ||
      record.reason === "already_reviewed" ||
      record.reason === "draft_exists"
        ? record.reason
        : "failed";
    return { attemptId, outcome: "skipped", reason };
  }
  return null;
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}
