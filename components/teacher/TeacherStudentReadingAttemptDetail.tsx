"use client";

import { useRouter } from "next/navigation";
import {
  TEACHER_STUDENT_READING_CACHE_PREFIX,
  useTeacherCachedData
} from "@/components/TeacherDataCache";
import { PracticeResultSummary } from "@/components/PracticeResult";
import {
  ReadingFullSetReviewShell,
  ReadingPracticeMessage,
  ReadingReadonlyReviewShell
} from "@/components/reading/ReadingPractice";
import { ReadingFullSetQuestionNavigator } from "@/components/reading/ReadingFullSetQuestionNavigator";
import { ReadingQuestionStatusChips } from "@/components/reading/ReadingQuestionStatusChips";
import { createBrowserSupabase } from "@/lib/supabase/client";
import {
  safeTeacherReturnTo,
  teacherReturnToHref,
  teacherStudentDetailHref
} from "@/lib/teacherNavigation";
import type { ReadingFullSetReviewPayload } from "@/lib/reading/fullSetReview";
import { readingLookupEnabled } from "@/lib/reading/lookupCapabilities";
import type { ReadingWrongbookSessionReviewPayload } from "@/lib/reading/wrongbookSession";
import type {
  TeacherReadingAttemptReviewPayload,
  TeacherReadingMultiSourceDetail,
  TeacherReadingResultSummary
} from "@/lib/teacherStudentPractice";

export type TeacherReadingAttemptDetailKind = "attempt" | "wrongbook" | "full-set" | "category";

type ReadingAttemptDetailPayload =
  | TeacherReadingAttemptReviewPayload
  | { sessionDetail: TeacherReadingMultiSourceDetail<ReadingWrongbookSessionReviewPayload> }
  | { sessionIncomplete: true }
  | TeacherReadingMultiSourceDetail<ReadingFullSetReviewPayload>;

/**
 * Teacher drill-down for one Reading record. Every record opens the attempt's
 * RESULT view first — the same summary and question chips the student sees
 * after finishing — and a question chip opens the read-only question page.
 *
 * The payload is fetched only after a record is opened, keyed by the attempt
 * id, and cached in the existing TeacherDataCache, so the result view and its
 * question pages share one request.
 */
export function TeacherStudentReadingAttemptDetail({
  attemptId,
  kind,
  questionIndex,
  returnTo,
  studentId
}: {
  attemptId: string;
  kind: TeacherReadingAttemptDetailKind;
  /** 0-based review position / source answer index of the read-only question. */
  questionIndex?: number;
  returnTo?: string;
  studentId: string;
}) {
  const router = useRouter();
  const backHref = safeTeacherReturnTo(returnTo, teacherStudentDetailHref(studentId));
  const state = useTeacherCachedData<ReadingAttemptDetailPayload>(
    `${TEACHER_STUDENT_READING_CACHE_PREFIX}:${kind}:${studentId}:${attemptId}${kind === "category" ? `:${questionIndex ?? "result"}` : ""}`,
    () => loadReadingAttemptDetail(kind, studentId, attemptId, questionIndex)
  );
  const selfHref = teacherReturnToHref(readingDetailHref(kind, studentId, attemptId), returnTo);

  if (state.loading) {
    return (
      <ReadingPracticeMessage
        description="正在加载这次练习的作答与题目内容..."
        title="正在准备阅读作答"
      />
    );
  }
  if (state.error || !state.data) {
    return (
      <ReadingPracticeMessage
        description={toReadingDetailErrorMessage(state.error)}
        leaveLabel="返回学生详情"
        onLeave={() => router.push(backHref)}
        title="无法打开阅读作答"
      />
    );
  }

  // The record exists only for finished sessions; an old link to an unfinished
  // one must not degrade into a single-material read-only page.
  if ("sessionIncomplete" in state.data) {
    return (
      <ReadingPracticeMessage
        description="这次练习还没有完成。"
        leaveLabel="返回学生详情"
        onLeave={() => router.push(backHref)}
        title="无法打开练习结果"
      />
    );
  }

  const view = resolveReadingDetailView(kind, state.data);
  const onBackToResult = () => router.push(selfHref);

  // Question page: the same read-only shells the student review uses, opened at
  // the selected question.
  if (questionIndex !== undefined) {
    if (view.mode === "single") {
      return (
        <ReadingReadonlyReviewShell
          teacherReadonly
          lexicalAccess={{ kind: kind === "wrongbook" ? "reading_wrongbook" : "reading", attemptId, studentId }}
          answers={view.review.answers}
          initialReviewIndex={questionIndex}
          lookupEnabled={readingLookupEnabled("submitted_review", view.review.practice.item.module)}
          onBack={onBackToResult}
          practice={view.review.practice}
          reviewDisclosures={view.review.disclosures}
          reviewItems={view.review.reviewItems}
          title={view.review.practice.item.title}
        />
      );
    }
    return (
      <ReadingFullSetReviewShell
        teacherStudentId={studentId}
        lexicalAccess={kind === "category" ? { kind: "reading_category", attemptId, studentId } : undefined}
        initialSourceAnswerIndex={questionIndex}
        onBack={onBackToResult}
        payload={view.review}
        variant={view.mode === "session" ? "session" : "full_set"}
        onRequestItem={kind === "category" ? (item) => router.push(teacherReturnToHref(
          `${readingDetailHref(kind, studentId, attemptId)}?question=${item.sourceAnswerIndex}`, returnTo
        )) : undefined}
      />
    );
  }

  return (
    <TeacherReadingResultView
      onBack={() => router.push(backHref)}
      questionHrefBase={readingDetailHref(kind, studentId, attemptId)}
      returnTo={returnTo}
      summary={view.summary}
      view={view}
    />
  );
}

type TeacherReadingDetailView =
  | { mode: "single"; review: TeacherReadingAttemptReviewPayload; summary: TeacherReadingResultSummary }
  | { mode: "session"; review: ReadingWrongbookSessionReviewPayload; summary: TeacherReadingResultSummary }
  | { mode: "full-set"; review: ReadingFullSetReviewPayload; summary: TeacherReadingResultSummary };

/**
 * Normalizes the three record kinds into one result view model. Single-attempt
 * records (practice attempts, entry corrections) carry their own result numbers;
 * sessions and Full Sets carry the student-shaped summary from the server.
 */
function resolveReadingDetailView(
  kind: TeacherReadingAttemptDetailKind,
  payload: ReadingAttemptDetailPayload
): TeacherReadingDetailView {
  if ((kind === "wrongbook" || kind === "category") && "sessionDetail" in payload) {
    return {
      mode: "session",
      review: payload.sessionDetail.review,
      summary: payload.sessionDetail.summary
    };
  }
  if (kind === "full-set") {
    const detail = payload as TeacherReadingMultiSourceDetail<ReadingFullSetReviewPayload>;
    return { mode: "full-set", review: detail.review, summary: detail.summary };
  }
  const review = payload as TeacherReadingAttemptReviewPayload;
  return {
    mode: "single",
    review,
    summary: {
      correctPoints: review.attempt.correctPoints,
      elapsedSeconds: review.attempt.elapsedSeconds,
      submittedAt: review.attempt.submittedAt,
      title: kind === "wrongbook" ? "订正结果" : "练习结果",
      totalPoints: review.attempt.totalPoints
    }
  };
}

/**
 * The student-shaped result view: the same summary card and question chips the
 * student sees after finishing the attempt. Every chip opens the read-only
 * question page.
 */
function TeacherReadingResultView({
  onBack,
  questionHrefBase,
  returnTo,
  summary,
  view
}: {
  onBack: () => void;
  questionHrefBase: string;
  returnTo?: string;
  summary: TeacherReadingResultSummary;
  view: TeacherReadingDetailView;
}) {
  // Full Set uses the student's module-grouped navigator; every other record
  // kind keeps the flat 1..N chips the student result pages use.
  const chips = view.mode === "single"
    ? view.review.reviewItems.map((item, index) => ({
        answerId: item.answerId,
        isAnswered: item.isAnswered,
        isCorrect: item.isCorrect,
        order: item.order,
        reviewIndex: index
      }))
    : view.mode === "session"
      ? view.review.reviewItems.map((item) => ({
          answerId: item.answerId,
          isAnswered: item.isAnswered,
          isCorrect: item.isCorrect,
          order: item.order,
          reviewIndex: item.sourceAnswerIndex
        }))
      : [];
  const fullSetItems = view.mode === "full-set"
    ? view.review.reviewItems.map((item) => ({
        ...item,
        href: teacherReturnToHref(`${questionHrefBase}?question=${item.sourceAnswerIndex}`, returnTo)
      }))
    : [];

  return (
    <div className="reading-theme min-h-[100dvh] bg-[#fbfbfe] px-4 py-5 text-student-text sm:px-7 lg:px-10" data-testid="teacher-reading-result">
      <div className="mx-auto grid max-w-[1100px] gap-5">
        <button
          className="student-button-secondary inline-flex min-h-10 w-fit items-center px-4"
          onClick={onBack}
          type="button"
        >
          返回
        </button>
        <PracticeResultSummary
          correctPoints={summary.correctPoints}
          elapsedSeconds={summary.elapsedSeconds}
          scoreComparison={null}
          scoreValue={summary.scoreDisplay}
          timeComparison={null}
          title={summary.title}
          totalPoints={summary.totalPoints}
        />
        <section className="student-card" data-testid="teacher-reading-result-detail">
          <div>
            <h2 className="text-xl font-bold text-student-text">作答详情</h2>
            <p className="mt-1 text-sm text-student-muted">
              提交于 {formatReadingDetailTime(summary.submittedAt)}
            </p>
          </div>
          {view.mode === "full-set" ? (
            <div className="mt-6">
              <ReadingFullSetQuestionNavigator items={fullSetItems} />
            </div>
          ) : (
            <ReadingQuestionStatusChips
              answers={chips}
              questionHref={(index) => teacherReturnToHref(`${questionHrefBase}?question=${index}`, returnTo)}
              questionHrefBase={questionHrefBase}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function readingDetailHref(
  kind: TeacherReadingAttemptDetailKind,
  studentId: string,
  attemptId: string
) {
  const segment = kind === "category" ? "category-sessions" : kind === "wrongbook"
    ? "wrongbook-attempts"
    : kind === "full-set"
      ? "full-set-attempts"
      : "attempts";
  return `/teacher/students/${encodeURIComponent(studentId)}/reading/${segment}/${encodeURIComponent(attemptId)}`;
}

function loadReadingAttemptDetail(
  kind: TeacherReadingAttemptDetailKind,
  studentId: string,
  attemptId: string,
  questionIndex?: number
) {
  if (kind === "full-set") {
    return loadTeacherStudentReadingJson<ReadingAttemptDetailPayload>(
      `/api/teacher/students/${encodeURIComponent(studentId)}/reading/full-set-attempts/${encodeURIComponent(attemptId)}`
    );
  }
  const segment = kind === "category" ? "category-sessions" : kind === "wrongbook" ? "wrongbook-attempts" : "attempts";
  return loadTeacherStudentReadingJson<ReadingAttemptDetailPayload>(
    `/api/teacher/students/${encodeURIComponent(studentId)}/reading/${segment}/${encodeURIComponent(attemptId)}${kind === "category" && questionIndex !== undefined ? `?question=${questionIndex}` : ""}`
  );
}

async function loadTeacherStudentReadingJson<T>(path: string): Promise<T> {
  const {
    data: { session }
  } = await createBrowserSupabase().auth.getSession();
  const response = await fetch(path, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${session?.access_token ?? ""}` }
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok || payload.error) {
    throw new Error(payload.error || "阅读作答加载失败，请稍后重试。");
  }
  return payload;
}

function formatReadingDetailTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "时间未知"
    : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function toReadingDetailErrorMessage(message: string) {
  if (/无权|forbidden/i.test(message)) return "无权查看该学生的阅读练习记录。";
  if (/未找到|not found/i.test(message)) return "没有找到这次阅读练习记录。";
  return /[\u3400-\u9fff]/.test(message) ? message : "阅读作答加载失败，请稍后重试。";
}
