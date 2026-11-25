import { NextResponse } from "next/server";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { getPreferredUserDisplayName } from "@/lib/userDisplayName";
import { isWritingTaskType, type WritingTaskType } from "@/lib/writing";
import {
  loadWritingHistoricalPracticeDisplayResolver,
  logHistoricalPracticeDisplayWarnings,
  type HistoricalPracticeDisplay,
  type HistoricalPracticeDisplayResolver
} from "@/lib/historicalPracticeDisplay";
import { loadTeacherScope } from "@/lib/teacherScope.server";
import { listClassAssignmentIds } from "@/lib/teacherClasses.server";
import {
  clampTeacherListLimit,
  submittedAtKeysetFilter,
  type TeacherListCursor
} from "@/lib/teacherListPagination";
import {
  encodeReviewPageCursor,
  parseReviewPageCursor,
  scanTeacherReviewPage,
  type ReviewPageCursor,
  type ReviewScanRow
} from "@/lib/teacherReviewScan";
import {
  isWritingReviewStatusFilter,
  isWritingReviewTaskTypeFilter,
  matchesWritingReviewStatusFilter,
  type WritingReviewListStatus,
  type WritingReviewStatusFilter,
  type WritingReviewTaskTypeFilter
} from "@/lib/teacherWritingReviewList";

export const dynamic = "force-dynamic";

type AttemptRow = {
  attempt_kind: "original" | "correction";
  original_attempt_id: string | null;
  correction_source_snapshot: { question?: { set_title?: string }; question_source?: "custom" | "question_bank" } | null;
  attempt_id: string;
  assignment_id: string | null;
  user_id: string;
  task_type: string;
  question_id: string;
  set_id: string;
  word_count: number | null;
  submitted_at: string | null;
};

type ProfileRow = {
  id: string;
  email: string | null;
  full_name: string | null;
};

type QuestionRow = {
  question_id: string;
  set_title: string | null;
};

type ReviewRow = {
  attempt_id: string;
  status: string | null;
};

type AssignmentRow = {
  assignment_id: string;
  question_source: "question_bank" | "custom";
  question_snapshot: { set_title?: unknown } | null;
};

type PageError = { message: string };

const QUERY_BATCH_SIZE = 100;
/**
 * 全部 / 待批改 are resolved in memory (pending has no review row and PostgREST
 * cannot express an anti-join). They are common filters, so a small batch is
 * enough for a normal page; the bounded scanner can continue later without
 * skipping a row.
 */
const IN_MEMORY_BATCH_SIZE = 40;
const IN_MEMORY_MAX_BATCHES = 40;
/** Published / reviewing / ignored are filtered by the database itself. */
const STATUS_FILTERED_MAX_BATCHES = 64;

const ATTEMPT_FIELDS =
  "attempt_id,attempt_kind,original_attempt_id,correction_source_snapshot,assignment_id,user_id,task_type,question_id,set_id,word_count,submitted_at";

function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });
}

export async function GET(request: Request) {
  try {
    const auth = await requireTeacherOnly(bearerToken(request));
    if (auth.error || !auth.userId) {
      const status = auth.error === "Forbidden" ? 403 : 401;
      return json(
        { code: "UNAUTHORIZED", message: auth.error ?? "Unauthorized" },
        { status }
      );
    }

    const params = new URL(request.url).searchParams;
    const requestedAttemptId = params.get("attemptId")?.trim();
    const requestedClassId = params.get("classId")?.trim() ?? "";
    const requestedStudentId = params.get("studentId")?.trim() ?? "";
    const statusParam = params.get("status");
    const taskTypeParam = params.get("taskType");
    const filters = {
      studentId: requestedStudentId,
      status: (isWritingReviewStatusFilter(statusParam) ? statusParam : "all") as WritingReviewStatusFilter,
      taskType: (isWritingReviewTaskTypeFilter(taskTypeParam) ? taskTypeParam : "all") as WritingReviewTaskTypeFilter
    };
    const cursor = parseReviewPageCursor(params.get("cursor"));
    const limit = requestedAttemptId ? 1 : clampTeacherListLimit(params.get("limit"));

    const supabase = createServiceSupabase();
    // The teaching scope and the teacher's own assignment ids are independent,
    // so both resolve in one round trip instead of two.
    const [scope, hasOwnAssignments, classAssignmentIds] = await Promise.all([
      loadTeacherScope(supabase, { userId: auth.userId, role: auth.role! }),
      auth.role === "admin" || requestedClassId
        ? Promise.resolve(true)
        : teacherHasAssignments(supabase, auth.userId),
      requestedClassId && auth.role !== "admin"
        ? listClassAssignmentIds(supabase, auth.userId, requestedClassId)
        : Promise.resolve(null)
    ]);
    if (requestedClassId && auth.role !== "admin" && classAssignmentIds === null) {
      return json(
        { code: "CLASS_NOT_FOUND", message: "班级不存在或无权查看。" },
        { status: 404 }
      );
    }

    const page = await loadReviewableAttemptPage(supabase, {
      admin: auth.role === "admin",
      classAssignmentIds,
      cursor,
      filters,
      hasOwnAssignments,
      limit,
      requestedAttemptId,
      requestedClassId,
      teacherId: auth.userId,
      writingStudentIds: scope.writingStudentIds
    });
    if (page.error) {
      return json(
        { code: "WRITING_REVIEWS_LOAD_FAILED", message: "无法加载写作提交。" },
        { status: 500 }
      );
    }

    const attempts = page.rows;
    const nextCursor = encodeReviewPageCursor(page.nextCursor);
    if (attempts.length === 0) {
      return json({ attempts: [], hasMore: page.hasMore, nextCursor });
    }

    const enrichedAttempts = await enrichReviewAttempts(supabase, attempts);
    return json({
      attempts: enrichedAttempts,
      hasMore: page.hasMore,
      nextCursor
    });
  } catch (error) {
    console.error("Unexpected writing review list error", {
      error: error instanceof Error ? error.message : "Unknown error"
    });
    return json(
      { code: "WRITING_REVIEWS_LOAD_FAILED", message: "无法加载写作批改列表。" },
      { status: 500 }
    );
  }
}

/**
 * Cursor page of reviewable submissions.
 *
 * 全部 / 待批改 are merged from the two sources with a bounded in-memory status
 * scan (pending has no review row, so it cannot be pushed into PostgREST).
 * Published / reviewing / ignored are filtered by the database per review
 * table and attempt kind, so a sparse status never scans unrelated history.
 *
 * Each stream keeps its own cursor; the shared scanner merges them in
 * `(submitted_at DESC, attempt_id DESC)` order. When a bounded scan stops
 * before exhausting a stream, its cursor is carried in the opaque page cursor,
 * so the rest of the history is neither skipped nor reported as finished.
 */
async function loadReviewableAttemptPage(
  supabase: ReturnType<typeof createServiceSupabase>,
  options: {
    admin: boolean;
    classAssignmentIds: string[] | null;
    cursor: ReviewPageCursor | null;
    filters: {
      studentId: string;
      status: WritingReviewStatusFilter;
      taskType: WritingReviewTaskTypeFilter;
    };
    hasOwnAssignments: boolean;
    limit: number;
    requestedAttemptId: string | undefined;
    requestedClassId: string;
    teacherId: string;
    writingStudentIds: string[];
  }
): Promise<{
  rows: ReviewAttemptRow[];
  error: PageError | null;
  hasMore: boolean;
  nextCursor: ReviewPageCursor | null;
}> {
  // A class-scoped list only contains submissions of that class's assignments;
  // self-practice and other assignments can never leak in.
  const scopeIsEmpty =
    options.classAssignmentIds !== null && options.classAssignmentIds.length === 0;
  const selfEnabled =
    options.classAssignmentIds === null && options.writingStudentIds.length > 0;
  const assignmentEnabled =
    !scopeIsEmpty &&
    (options.admin ||
      (options.classAssignmentIds !== null
        ? options.classAssignmentIds.length > 0
        : options.hasOwnAssignments));
  const sources = [
    { source: "self" as const, enabled: selfEnabled },
    { source: "assignment" as const, enabled: assignmentEnabled }
  ].filter((entry) => entry.enabled);

  if (sources.length === 0) {
    return { rows: [], error: null, hasMore: false, nextCursor: null };
  }

  try {
    if (isDatabaseFilteredReviewStatus(options.filters.status)) {
      const status = options.filters.status;
      const streams = sources.flatMap(({ source }) =>
        (["original", "correction"] as const).map((kind) => ({
          id: `${source}:${kind}`,
          enabled: true,
          load: async (cursor: TeacherListCursor | null, limit: number) => {
            const result = await readStatusFilteredAttemptPage(
              supabase,
              source,
              kind,
              status,
              options,
              cursor,
              limit
            );
            if (result.error) throw new Error(result.error.message);
            return result.data ?? [];
          }
        }))
      );
      const page = await scanTeacherReviewPage({
        streams,
        cursor: options.cursor,
        limit: options.limit,
        batchSize: Math.max(2, options.limit + 1),
        maxBatches: STATUS_FILTERED_MAX_BATCHES,
        matches: (row) => matchesReviewFilters(row, options.filters)
      });
      return {
        rows: page.rows,
        error: null,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor
      };
    }

    const streams = sources.map(({ source }) => ({
      id: source,
      enabled: true,
      load: async (cursor: TeacherListCursor | null, limit: number) => {
        const result = await readAttemptSourcePage(
          supabase,
          source,
          options,
          cursor,
          limit
        );
        if (result.error) throw new Error(result.error.message);
        const rows = result.data ?? [];
        const statuses = await loadReviewStatusMap(supabase, rows);
        return rows.map((attempt) => ({
          ...attempt,
          review_status:
            statuses.get(String(attempt.attempt_id)) ?? ("pending" as const)
        }));
      }
    }));
    const page = await scanTeacherReviewPage({
      streams,
      cursor: options.cursor,
      limit: options.limit,
      batchSize: IN_MEMORY_BATCH_SIZE,
      maxBatches: IN_MEMORY_MAX_BATCHES,
      matches: (row) => matchesReviewFilters(row, options.filters)
    });
    return {
      rows: page.rows,
      error: null,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor
    };
  } catch (error) {
    return {
      rows: [],
      error: { message: error instanceof Error ? error.message : "review_scan_failed" },
      hasMore: false,
      nextCursor: null
    };
  }
}

type ReviewAttemptRow = AttemptRow & ReviewScanRow;

function isDatabaseFilteredReviewStatus(
  status: WritingReviewStatusFilter
): status is "published" | "reviewing" | "ignored" {
  return status === "published" || status === "reviewing" || status === "ignored";
}

function matchesReviewFilters(
  attempt: ReviewAttemptRow,
  filters: {
    studentId: string;
    status: WritingReviewStatusFilter;
    taskType: WritingReviewTaskTypeFilter;
  }
) {
  if (filters.studentId && String(attempt.user_id) !== filters.studentId) return false;
  if (!isWritingTaskType(attempt.task_type)) return false;
  if (filters.taskType !== "all" && attempt.task_type !== filters.taskType) return false;
  return matchesWritingReviewStatusFilter(attempt.review_status, filters.status);
}

/**
 * One source's next in-memory scan batch (全部 / 待批改). Student and task type
 * filters are applied by the database; the cursor is the shared
 * `(submitted_at DESC, attempt_id DESC)` keyset.
 */
async function readAttemptSourcePage(
  supabase: ReturnType<typeof createServiceSupabase>,
  source: "self" | "assignment",
  options: {
    admin: boolean;
    classAssignmentIds: string[] | null;
    filters: {
      studentId: string;
      status: WritingReviewStatusFilter;
      taskType: WritingReviewTaskTypeFilter;
    };
    requestedAttemptId: string | undefined;
    requestedClassId: string;
    teacherId: string;
    writingStudentIds: string[];
  },
  cursor: TeacherListCursor | null,
  limit: number
): Promise<{ data: AttemptRow[] | null; error: PageError | null }> {
  const columns =
    source === "assignment" && !options.admin
      ? `${ATTEMPT_FIELDS},${assignmentScopeEmbed(options)}`
      : ATTEMPT_FIELDS;
  let query = supabase
    .from("writing_attempts")
    .select(columns)
    .eq("status", "submitted");
  query = applyAttemptSourceScope(query, source, options);
  if (options.requestedAttemptId) {
    query = query.eq("attempt_id", options.requestedAttemptId);
  }
  if (options.filters.studentId) {
    query = query.eq("user_id", options.filters.studentId);
  }
  if (options.filters.taskType !== "all") {
    query = query.eq("task_type", options.filters.taskType);
  }
  if (cursor) {
    query = query.or(submittedAtKeysetFilter(cursor));
  }
  const result = await query
    .order("submitted_at", { ascending: false, nullsFirst: false })
    .order("attempt_id", { ascending: false })
    .limit(limit);
  return {
    data: (result.data ?? []) as unknown as AttemptRow[],
    error: result.error
  };
}

/**
 * One database-filtered status stream (published / reviewing / ignored) for a
 * source and attempt kind. Only rows that already satisfy the filter are read,
 * and the review status is known from the stream itself.
 */
async function readStatusFilteredAttemptPage(
  supabase: ReturnType<typeof createServiceSupabase>,
  source: "self" | "assignment",
  kind: "original" | "correction",
  status: "published" | "reviewing" | "ignored",
  options: {
    admin: boolean;
    classAssignmentIds: string[] | null;
    filters: {
      studentId: string;
      status: WritingReviewStatusFilter;
      taskType: WritingReviewTaskTypeFilter;
    };
    requestedAttemptId: string | undefined;
    requestedClassId: string;
    teacherId: string;
    writingStudentIds: string[];
  },
  cursor: TeacherListCursor | null,
  limit: number
): Promise<{ data: ReviewAttemptRow[] | null; error: PageError | null }> {
  const reviewTable =
    kind === "correction" ? "writing_correction_reviews" : "writing_reviews";
  let columns =
    `${ATTEMPT_FIELDS},${reviewTable}!inner(attempt_id,status)`;
  if (source === "assignment" && !options.admin) {
    columns += `,${assignmentScopeEmbed(options)}`;
  }
  let query = supabase
    .from("writing_attempts")
    .select(columns)
    .eq("status", "submitted")
    .eq("attempt_kind", kind);
  query = applyAttemptSourceScope(query, source, options);
  query = applyReviewStatusFilter(query, reviewTable, status);
  if (options.requestedAttemptId) {
    query = query.eq("attempt_id", options.requestedAttemptId);
  }
  if (options.filters.studentId) {
    query = query.eq("user_id", options.filters.studentId);
  }
  if (options.filters.taskType !== "all") {
    query = query.eq("task_type", options.filters.taskType);
  }
  if (cursor) {
    query = query.or(submittedAtKeysetFilter(cursor));
  }
  const result = await query
    .order("submitted_at", { ascending: false, nullsFirst: false })
    .order("attempt_id", { ascending: false })
    .limit(limit);
  const rows = (result.data ?? []) as unknown as AttemptRow[];
  return {
    data: rows.map((row) => ({ ...row, review_status: status })),
    error: result.error
  };
}

function assignmentScopeEmbed(options: {
  classAssignmentIds: string[] | null;
}) {
  return options.classAssignmentIds !== null
    ? "assignment:writing_assignments!inner(teacher_id,deleted_at,group:writing_assignment_groups!inner(class_id,teacher_id))"
    : "assignment:writing_assignments!inner(teacher_id,deleted_at)";
}

function applyAttemptSourceScope<T extends {
  is: (column: string, value: null) => T;
  in: (column: string, values: string[]) => T;
  not: (column: string, operator: "is", value: null) => T;
  eq: (column: string, value: string) => T;
}>(
  query: T,
  source: "self" | "assignment",
  options: {
    admin: boolean;
    classAssignmentIds: string[] | null;
    requestedClassId: string;
    teacherId: string;
    writingStudentIds: string[];
  }
): T {
  if (source === "self") {
    return query
      .is("assignment_id", null)
      .in("user_id", options.writingStudentIds);
  }
  if (options.admin) {
    return query.not("assignment_id", "is", null);
  }
  if (options.classAssignmentIds !== null) {
    // Class scope follows the class group's teacher (the old
    // listClassAssignmentIds contract), not the assignment row's creator.
    return query
      .eq("assignment.group.teacher_id", options.teacherId)
      .is("assignment.deleted_at", null)
      .eq("assignment.group.class_id", options.requestedClassId);
  }
  return query.eq("assignment.teacher_id", options.teacherId);
}

function applyReviewStatusFilter<T extends {
  eq: (column: string, value: string) => T;
  neq: (column: string, value: string) => T;
}>(
  query: T,
  reviewTable: string,
  status: "published" | "reviewing" | "ignored"
): T {
  if (status === "published") {
    return query.eq(`${reviewTable}.status`, "published");
  }
  if (status === "ignored") {
    return query.eq(`${reviewTable}.status`, "ignored");
  }
  return query
    .neq(`${reviewTable}.status`, "published")
    .neq(`${reviewTable}.status`, "ignored");
}

async function loadReviewStatusMap(
  supabase: ReturnType<typeof createServiceSupabase>,
  attempts: readonly AttemptRow[]
) {
  const statusById = new Map<string, WritingReviewListStatus>();
  const originalIds: string[] = [];
  const correctionIds: string[] = [];
  for (const attempt of attempts) {
    const attemptId = String(attempt.attempt_id);
    if (attempt.attempt_kind === "correction") correctionIds.push(attemptId);
    else originalIds.push(attemptId);
  }
  const [reviews, correctionReviews] = await Promise.all([
    readRowsByIds<ReviewRow>(unique(originalIds), (batch, from, to) =>
      supabase
        .from("writing_reviews")
        .select("attempt_id,status")
        .in("attempt_id", batch)
        .order("attempt_id", { ascending: true })
        .range(from, to)
    ),
    readRowsByIds<ReviewRow>(unique(correctionIds), (batch, from, to) =>
      supabase
        .from("writing_correction_reviews")
        .select("attempt_id,status")
        .in("attempt_id", batch)
        .order("attempt_id", { ascending: true })
        .range(from, to)
    )
  ]);
  if (reviews.error) throw new Error(reviews.error.message);
  if (correctionReviews.error) throw new Error(correctionReviews.error.message);
  for (const review of reviews.data ?? []) {
    statusById.set(String(review.attempt_id), toReviewStatus(review));
  }
  for (const review of correctionReviews.data ?? []) {
    statusById.set(String(review.attempt_id), toReviewStatus(review));
  }
  return statusById;
}

/**
 * Detail payload of the emitted page only (names, questions, assignments,
 * review status). The scan above already decided membership, so this never
 * reads the rest of the history.
 */
async function enrichReviewAttempts(
  supabase: ReturnType<typeof createServiceSupabase>,
  attempts: AttemptRow[]
) {
  const attemptIds = unique(attempts.map((attempt) => String(attempt.attempt_id)));
  const assignmentIds = unique(
    attempts.map((attempt) => attempt.assignment_id ?? "").filter(Boolean)
  );
  const userIds = unique(attempts.map((attempt) => String(attempt.user_id)));
  const emailQuestionIds = unique(
    attempts
      .filter((attempt) => attempt.task_type === "email")
      .map((attempt) => String(attempt.question_id))
  );
  const discussionQuestionIds = unique(
    attempts
      .filter((attempt) => attempt.task_type === "academic_discussion")
      .map((attempt) => String(attempt.question_id))
  );

  const [
    profiles,
    emailQuestions,
    discussionQuestions,
    reviews,
    assignments,
    emailDisplayResolver,
    discussionDisplayResolver
  ] = await Promise.all([
    readRowsByIds<ProfileRow>(userIds, (batch, from, to) =>
      supabase
        .from("profiles")
        .select("id,email,full_name")
        .in("id", batch)
        .order("id", { ascending: true })
        .range(from, to)
    ),
    readRowsByIds<QuestionRow>(emailQuestionIds, (batch, from, to) =>
      supabase
        .from("email_questions")
        .select("question_id,set_title")
        .in("question_id", batch)
        .order("question_id", { ascending: true })
        .range(from, to)
    ),
    readRowsByIds<QuestionRow>(discussionQuestionIds, (batch, from, to) =>
      supabase
        .from("academic_discussion_questions")
        .select("question_id,set_title")
        .in("question_id", batch)
        .order("question_id", { ascending: true })
        .range(from, to)
    ),
    readRowsByIds<ReviewRow>(attemptIds, (batch, from, to) =>
      supabase
        .from("writing_reviews")
        .select("attempt_id,status")
        .in("attempt_id", batch)
        .order("attempt_id", { ascending: true })
        .range(from, to)
    ),
    readRowsByIds<AssignmentRow>(assignmentIds, (batch, from, to) =>
      supabase
        .from("writing_assignments")
        .select("assignment_id,question_source,question_snapshot")
        .in("assignment_id", batch)
        .order("assignment_id", { ascending: true })
        .range(from, to)
    ),
    loadWritingHistoricalPracticeDisplayResolver(supabase, "email", emailQuestionIds),
    loadWritingHistoricalPracticeDisplayResolver(
      supabase,
      "academic_discussion",
      discussionQuestionIds
    )
  ]);

  // Correction reviews use their own table, so their status is merged here
  // instead of being misread as "pending" forever. Ordinary rows are untouched.
  const correctionAttemptIds = attempts
    .filter((attempt) => attempt.attempt_kind === "correction")
    .map((attempt) => String(attempt.attempt_id));
  const correctionReviews = correctionAttemptIds.length > 0
    ? await readRowsByIds<ReviewRow>(correctionAttemptIds, (batch, from, to) =>
        supabase
          .from("writing_correction_reviews")
          .select("attempt_id,status")
          .in("attempt_id", batch)
          .order("attempt_id", { ascending: true })
          .range(from, to)
      )
    : { data: [] as ReviewRow[], error: null };

  const relatedError =
    profiles.error ?? emailQuestions.error ?? discussionQuestions.error ?? reviews.error ??
    assignments.error ?? correctionReviews.error;
  if (relatedError) {
    throw new Error(relatedError.message);
  }

  const profileById = new Map(
    (profiles.data ?? []).map((profile) => [String(profile.id), profile])
  );
  const emailQuestionById = new Map(
    (emailQuestions.data ?? []).map((question) => [String(question.question_id), question])
  );
  const discussionQuestionById = new Map(
    (discussionQuestions.data ?? []).map((question) => [
      String(question.question_id),
      question
    ])
  );
  const reviewByAttemptId = new Map(
    (reviews.data ?? []).map((review) => [String(review.attempt_id), review])
  );
  const correctionReviewByAttemptId = new Map(
    (correctionReviews.data ?? []).map((review) => [String(review.attempt_id), review])
  );
  const assignmentById = new Map(
    (assignments.data ?? []).map((assignment) => [String(assignment.assignment_id), assignment])
  );

  const displayResolverByTaskType: Record<WritingTaskType, HistoricalPracticeDisplayResolver> = {
    email: emailDisplayResolver,
    academic_discussion: discussionDisplayResolver
  };
  const resolvedDisplays: HistoricalPracticeDisplay[] = [];
  const enrichedAttempts = attempts.map((attempt) => {
    const correction = attempt.attempt_kind === "correction";
    const frozenTitle = correction ? attempt.correction_source_snapshot?.question?.set_title?.trim() : null;
    const taskType = attempt.task_type as WritingTaskType;
    const profile = profileById.get(String(attempt.user_id));
    const question =
      taskType === "email"
        ? emailQuestionById.get(String(attempt.question_id))
        : discussionQuestionById.get(String(attempt.question_id));
    const review = correction
      ? correctionReviewByAttemptId.get(String(attempt.attempt_id))
      : reviewByAttemptId.get(String(attempt.attempt_id));
    const assignment = attempt.assignment_id
      ? assignmentById.get(String(attempt.assignment_id))
      : undefined;
    const historicalDisplayResolver = displayResolverByTaskType[taskType];
    const assignmentTitle = typeof assignment?.question_snapshot?.set_title === "string"
      ? assignment.question_snapshot.set_title.trim()
      : "";
    const rawSetTitle = question?.set_title?.trim() || String(attempt.set_id);
    const display = historicalDisplayResolver.resolveWritingAttempt({
      assignmentId: attempt.assignment_id,
      assignmentDisplayName: correction ? frozenTitle || assignmentTitle : assignmentTitle,
      fallbackDisplayName: frozenTitle || assignmentTitle || rawSetTitle || String(attempt.question_id),
      questionSource: correction ? attempt.correction_source_snapshot?.question_source ?? null : assignment?.question_source ?? null,
      rawQuestionId: String(attempt.question_id),
      taskType
    });
    resolvedDisplays.push(display);

    return {
      attemptId: String(attempt.attempt_id),
      attemptKind: attempt.attempt_kind,
      originalAttemptId: attempt.original_attempt_id,
      attempt_kind: attempt.attempt_kind,
      original_attempt_id: attempt.original_attempt_id,
      correctionReviewSupported: correction,
      assignmentId: attempt.assignment_id ? String(attempt.assignment_id) : null,
      studentId: String(attempt.user_id),
      studentName: getPreferredUserDisplayName({
        email: profile?.email,
        profileFullName: profile?.full_name
      }),
      taskType,
      questionId: String(attempt.question_id),
      setId: String(attempt.set_id),
      setTitle: correction ? frozenTitle || "订正作文" : assignmentTitle || rawSetTitle,
      displayName: display.displayName,
      reviewContext: attempt.assignment_id
        ? assignment?.question_source === "custom"
          ? "assignment_custom"
          : "assignment_question_bank"
        : "free_practice",
      logicalDisplay: display.logicalDisplayName
        ? {
            itemId: display.itemId,
            displayNumber: display.displayNumber,
            displayTitle: display.displayTitle,
            displayName: display.logicalDisplayName
          }
        : null,
      wordCount: Math.max(0, Number(attempt.word_count) || 0),
      submittedAt: attempt.submitted_at,
      reviewStatus: toReviewStatus(review)
    };
  });
  logHistoricalPracticeDisplayWarnings(resolvedDisplays);
  return enrichedAttempts;
}

function toReviewStatus(review: ReviewRow | undefined): WritingReviewListStatus {
  if (!review) return "pending";
  if (review.status === "published") return "published";
  if (review.status === "ignored") return "ignored";
  return "reviewing";
}

async function readRowsByIds<T>(
  ids: string[],
  readPage: (
    ids: string[],
    from: number,
    to: number
  ) => PromiseLike<{ data: T[] | null; error: PageError | null }>
) {
  const rows: T[] = [];
  for (let index = 0; index < ids.length; index += QUERY_BATCH_SIZE) {
    const batch = ids.slice(index, index + QUERY_BATCH_SIZE);
    const result = await readAllSupabaseRows<T>((from, to) =>
      readPage(batch, from, to)
    );
    if (result.error) return { data: null, error: result.error };
    rows.push(...(result.data ?? []));
  }
  return { data: rows, error: null };
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}

async function teacherHasAssignments(
  supabase: ReturnType<typeof createServiceSupabase>,
  teacherId: string
) {
  const result = await supabase
    .from("writing_assignments")
    .select("assignment_id", { count: "exact", head: true })
    .eq("teacher_id", teacherId);
  if (result.error) throw result.error;
  return (result.count ?? 0) > 0;
}
