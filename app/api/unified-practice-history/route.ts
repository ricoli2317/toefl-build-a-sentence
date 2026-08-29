import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildUnifiedPracticeHistory,
  isUnifiedHistoryCategory,
  isUnifiedHistoryTaskType,
  type UnifiedBasAttemptRow,
  type UnifiedReadingAttemptRow,
  type UnifiedWritingAssignmentSummary,
  type UnifiedWritingAttemptRow,
  type UnifiedWritingReviewSummary
} from "@/lib/unifiedPracticeHistory";
import {
  loadBuildSentenceHistoricalPracticeDisplayResolver,
  loadWritingHistoricalPracticeDisplayResolver
} from "@/lib/historicalPracticeDisplay";
import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { createServiceSupabase } from "@/lib/supabase/server";
import { createStudentPerformanceTrace } from "@/lib/studentPerformance.server";
import { requireWritingStudent, writingJson } from "@/lib/writingServer";

type WritingQuestionTitleRow = {
  question_id: string;
  set_title: string | null;
};

type ReadingTitleRow = {
  logical_item_id: string;
  title: string | null;
};

type WritingReviewRow = {
  attempt_id: string;
  official_score: string | number | null;
  published_at: string | null;
  status: string;
};

type WritingAssignmentRow = {
  assignment_id: string;
  question_source: "custom" | "question_bank";
  set_title: string | null;
};

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const timing = createStudentPerformanceTrace("/api/unified-practice-history");
  const respond = (data: unknown, init?: ResponseInit) => writingJson(data, init, timing);
  try {
    const auth = await requireWritingStudent(request, timing);
    if (auth.error) return auth.error;
    if (!auth.supabase || !auth.userId) {
      return respond({ error: "Unauthorized" }, { status: 401 });
    }

    const url = new URL(request.url);
    const categoryValue = url.searchParams.get("category") ?? "all";
    const taskTypeValue = url.searchParams.get("taskType") ?? "all";
    if (!isUnifiedHistoryCategory(categoryValue)) {
      return respond({ error: "Invalid history category" }, { status: 400 });
    }
    if (taskTypeValue !== "all" && !isUnifiedHistoryTaskType(taskTypeValue)) {
      return respond({ error: "Invalid history task type" }, { status: 400 });
    }
    const limit = parseInteger(url.searchParams.get("limit"), 20);
    const offset = parseInteger(url.searchParams.get("offset"), 0);
    const fallbackStart = startOfServerLocalDay();
    const todayStart = parseDateBoundary(url.searchParams.get("todayStart"), fallbackStart);
    const todayEnd = parseDateBoundary(
      url.searchParams.get("todayEnd"),
      fallbackStart + 24 * 60 * 60 * 1000
    );

    const [basResult, writingResult, readingResult] = await Promise.all([
      timing.measure("database", "unified_history_bas_attempts", () =>
        readAllSupabaseRows<UnifiedBasAttemptRow>((from, to) =>
          auth.supabase!
            .from("attempts")
            .select("attempt_id,set_id,set_title,correct_count,total_questions,time_spent_seconds,submitted_at")
            .eq("student_id", auth.userId!)
            .not("submitted_at", "is", null)
            .order("submitted_at", { ascending: false })
            .order("attempt_id", { ascending: false })
            .range(from, to)
        )
      ),
      timing.measure("database", "unified_history_writing_attempts", () =>
        readAllSupabaseRows<UnifiedWritingAttemptRow>((from, to) =>
          auth.supabase!
            .from("writing_attempts")
            .select("attempt_id,assignment_id,task_type,question_id,word_count,status,elapsed_seconds,submitted_at")
            .eq("user_id", auth.userId!)
            .eq("status", "submitted")
            .not("submitted_at", "is", null)
            .order("submitted_at", { ascending: false })
            .order("attempt_id", { ascending: false })
            .range(from, to)
        )
      ),
      timing.measure("database", "unified_history_reading_attempts", () =>
        readAllSupabaseRows<UnifiedReadingAttemptRow>((from, to) =>
          auth.supabase!
            .from("reading_attempts")
            .select("attempt_id,logical_item_id,task_type,status,elapsed_seconds,submitted_at,total_points,correct_points")
            .eq("status", "submitted")
            .not("submitted_at", "is", null)
            .order("submitted_at", { ascending: false })
            .order("attempt_id", { ascending: false })
            .range(from, to)
        )
      )
    ]);
    const attemptError = basResult.error ?? writingResult.error ?? readingResult.error;
    if (attemptError) throw new Error(attemptError.message);

    const basAttempts = basResult.data ?? [];
    const writingAttempts = writingResult.data ?? [];
    const readingAttempts = readingResult.data ?? [];
    const pageSkeleton = timing.measureSync("processing", "paginate_unified_practice_history", () =>
      buildUnifiedPracticeHistory({
        basAttempts,
        category: categoryValue,
        limit,
        offset,
        readingAttempts,
        taskType: taskTypeValue,
        todayEnd,
        todayStart,
        writingAttempts
      })
    );
    const visibleRecordKeys = new Set(
      pageSkeleton.records.map((record) => `${record.taskType}:${record.attemptId}`)
    );
    const visibleBasAttempts = basAttempts.filter((attempt) =>
      visibleRecordKeys.has(`build_sentence:${attempt.attempt_id}`)
    );
    const visibleWritingAttempts = writingAttempts.filter((attempt) =>
      visibleRecordKeys.has(`${attempt.task_type}:${attempt.attempt_id}`)
    );
    const visibleReadingAttempts = readingAttempts.filter((attempt) =>
      visibleRecordKeys.has(`${attempt.task_type}:${attempt.attempt_id}`)
    );
    const service = createServiceSupabase();
    const emailIds = distinct(
      visibleWritingAttempts.filter((attempt) => attempt.task_type === "email").map((attempt) => attempt.question_id)
    );
    const discussionIds = distinct(
      visibleWritingAttempts
        .filter((attempt) => attempt.task_type === "academic_discussion")
        .map((attempt) => attempt.question_id)
    );
    const assignmentIds = distinct(
      visibleWritingAttempts.flatMap((attempt) => attempt.assignment_id ? [attempt.assignment_id] : [])
    );
    const writingAttemptIds = visibleWritingAttempts.map((attempt) => attempt.attempt_id);
    const readingItemIds = distinct(visibleReadingAttempts.map((attempt) => attempt.logical_item_id));
    const basSetIds = distinct(visibleBasAttempts.map((attempt) => attempt.set_id));

    const [
      emailTitles,
      discussionTitles,
      readingTitles,
      reviewRows,
      assignmentRows,
      basDisplayResolver,
      emailDisplayResolver,
      discussionDisplayResolver
    ] = await Promise.all([
      readRowsInBatches<WritingQuestionTitleRow>(service, "email_questions", "question_id,set_title", "question_id", emailIds),
      readRowsInBatches<WritingQuestionTitleRow>(service, "academic_discussion_questions", "question_id,set_title", "question_id", discussionIds),
      readRowsInBatches<ReadingTitleRow>(service, "reading_logical_items", "logical_item_id,title", "logical_item_id", readingItemIds),
      loadReviewRows(service, writingAttemptIds),
      loadAssignmentRows(service, assignmentIds),
      loadBuildSentenceHistoricalPracticeDisplayResolver(service, basSetIds, timing),
      loadWritingHistoricalPracticeDisplayResolver(service, "email", emailIds, timing),
      loadWritingHistoricalPracticeDisplayResolver(service, "academic_discussion", discussionIds, timing)
    ]);

    const writingTitles = new Map<string, string>();
    for (const question of emailTitles) {
      const fallback = question.set_title?.trim() || question.question_id;
      writingTitles.set(
        `email:${question.question_id}`,
        emailDisplayResolver.resolveWritingAttempt({
          assignmentId: null,
          fallbackDisplayName: fallback,
          rawQuestionId: question.question_id,
          taskType: "email"
        }).displayName
      );
    }
    for (const question of discussionTitles) {
      const fallback = question.set_title?.trim() || question.question_id;
      writingTitles.set(
        `academic_discussion:${question.question_id}`,
        discussionDisplayResolver.resolveWritingAttempt({
          assignmentId: null,
          fallbackDisplayName: fallback,
          rawQuestionId: question.question_id,
          taskType: "academic_discussion"
        }).displayName
      );
    }
    const basTitles = new Map(
      visibleBasAttempts.map((attempt) => [
        attempt.set_id,
        basDisplayResolver.resolveBuildSentence({
          fallbackDisplayName: attempt.set_title?.trim() || attempt.set_id,
          rawSetId: attempt.set_id
        }).displayName
      ])
    );
    const reviewByAttempt = new Map<string, UnifiedWritingReviewSummary>();
    for (const review of reviewRows) {
      const score = Number(review.official_score);
      if (
        review.status === "published"
        && review.published_at
        && Number.isFinite(score)
        && score >= 0
        && score <= 5
      ) {
        reviewByAttempt.set(review.attempt_id, { officialScore: score });
      }
    }
    const assignments = new Map<string, UnifiedWritingAssignmentSummary>(
      assignmentRows.map((assignment) => [
        assignment.assignment_id,
        { questionSource: assignment.question_source, title: assignment.set_title }
      ])
    );

    return respond(timing.measureSync("processing", "build_unified_practice_history", () =>
      buildUnifiedPracticeHistory({
        basAttempts,
        basTitles,
        category: categoryValue,
        limit,
        offset,
        readingAttempts,
        readingTitles: new Map(readingTitles.map((item) => [item.logical_item_id, item.title?.trim() || ""])),
        taskType: taskTypeValue,
        todayEnd,
        todayStart,
        writingAssignments: assignments,
        writingAttempts,
        writingReviews: reviewByAttempt,
        writingTitles
      })
    ));
  } catch (error) {
    console.error("Unified practice history load failed", {
      message: error instanceof Error ? error.message : "unknown"
    });
    return respond({ error: "练习历史加载失败，请稍后重试。" }, { status: 500 });
  }
}

async function readRowsInBatches<T>(
  db: SupabaseClient,
  table: string,
  fields: string,
  idField: string,
  ids: string[]
): Promise<T[]> {
  if (ids.length === 0) return [];
  const results = await Promise.all(chunk(ids).map((batch) =>
    readAllSupabaseRows<T>((from, to) =>
      db.from(table).select(fields).in(idField, batch).range(from, to) as unknown as PromiseLike<{
        data: T[] | null;
        error: { message: string } | null;
      }>
    )
  ));
  const error = results.find((result) => result.error)?.error;
  if (error) throw new Error(error.message);
  return results.flatMap((result) => result.data ?? []);
}

function loadReviewRows(db: SupabaseClient, attemptIds: string[]) {
  return readRowsInBatches<WritingReviewRow>(
    db,
    "writing_reviews",
    "attempt_id,status,published_at,official_score:published_scores->official_score->>teacher_score",
    "attempt_id",
    attemptIds
  );
}

function loadAssignmentRows(db: SupabaseClient, assignmentIds: string[]) {
  return readRowsInBatches<WritingAssignmentRow>(
    db,
    "writing_assignments",
    "assignment_id,question_source,set_title:question_snapshot->>set_title",
    "assignment_id",
    assignmentIds
  );
}

function chunk<T>(values: T[], size = 100) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function distinct(values: string[]) {
  return Array.from(new Set(values.map((value) => String(value).trim()).filter(Boolean)));
}

function parseInteger(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function parseDateBoundary(value: string | null, fallback: number) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function startOfServerLocalDay() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.getTime();
}
