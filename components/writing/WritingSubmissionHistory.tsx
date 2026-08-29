"use client";

import { Eye, FileCheck2 } from "lucide-react";
import Link from "next/link";
import {
  STUDENT_WRITING_SUBMISSION_HISTORY_CACHE_PREFIX,
  useStudentCachedData,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import {
  StudentEmptyState,
  StudentErrorState,
  StudentLoadingState,
  StudentNavigation
} from "@/components/student/StudentUI";
import {
  STUDENT_ROUTES,
  writingReviewResultHref,
  writingSubmissionHistoryHref
} from "@/lib/studentNavigation";
import {
  WRITING_TASK_CONFIG,
  formatWritingAttemptSummary,
  type WritingTaskType
} from "@/lib/writing";
import type {
  SubmittedWritingAttemptSummary,
  WritingSubmissionQuestionSummary
} from "@/lib/writingSubmissionHistory";
import {
  PracticeSubmissionHistoryHeader,
  PracticeSubmissionHistoryList
} from "@/components/shared/PracticeHistoryCards";
import {
  measureStudentRequest,
  useStudentPagePerformance
} from "@/lib/studentPerformance.client";

type SubmissionHistoryPayload = {
  attempts: SubmittedWritingAttemptSummary[];
  question: WritingSubmissionQuestionSummary;
  error?: string;
};

export function WritingSubmissionHistory({
  questionId,
  taskType
}: {
  questionId: string;
  taskType: WritingTaskType;
}) {
  const state = useStudentCachedData<SubmissionHistoryPayload>(
    `${STUDENT_WRITING_SUBMISSION_HISTORY_CACHE_PREFIX}:${taskType}:${questionId}`,
    (session) => loadSubmissionHistory(taskType, questionId, session),
    { refreshOnMount: true }
  );
  useStudentPagePerformance({
    errors: [state.error],
    loading: state.loading,
    route: writingSubmissionHistoryHref(taskType, questionId)
  });
  if (state.loading) return <StudentLoadingState text="正在加载提交记录..." />;
  if (state.error || !state.data) {
    return <StudentErrorState text="加载提交记录失败，请稍后重试。" />;
  }
  const { attempts, question } = state.data;
  const config = WRITING_TASK_CONFIG[taskType];
  const listHref = config.listHref;
  const historyHref = writingSubmissionHistoryHref(taskType, questionId);
  const questionDisplayName = question.display_name ?? question.set_title;

  return (
    <div className="grid gap-5">
      <StudentNavigation
        backHref={listHref}
        crumbs={[
          { label: "学生首页", href: STUDENT_ROUTES.home },
          { label: config.label, href: config.listHref },
          { label: questionDisplayName, href: listHref },
          { label: "提交记录" }
        ]}
      />
      <PracticeSubmissionHistoryHeader
        description={`共 ${attempts.length} 次提交，最新提交显示在最上方。`}
        eyebrow={config.label}
        title={questionDisplayName}
      />
      <PracticeSubmissionHistoryList
        emptyState={<StudentEmptyState text="这道题还没有已提交的写作记录。" />}
        items={attempts.map((attempt, index) => {
            const submissionNumber = attempts.length - index;
            const submissionHref = `${config.submissionHref}/${encodeURIComponent(attempt.attempt_id)}`;
            return {
              id: attempt.attempt_id,
              title: `提交 ${submissionNumber}`,
              submittedAt: formatDateTime(attempt.submitted_at),
              badge: (
                <span className={attempt.has_published_review ? "student-chip" : "text-xs font-semibold text-student-muted"}>
                  {attempt.has_published_review ? "批改已发布" : "等待批改"}
                </span>
              ),
              details: (
                <>
                  <p className="text-sm font-semibold text-student-text">{attempt.word_count} words</p>
                  <p className="mt-1 text-xs font-semibold text-student-primary">
                    {formatWritingAttemptSummary(attempt.writing_mode, attempt.elapsed_seconds)}
                  </p>
                </>
              ),
              actions: (
                <>
                  <Link className="student-button-secondary" href={submissionHref}>
                    <Eye aria-hidden="true" size={17} />查看提交
                  </Link>
                  {attempt.has_published_review ? (
                    <Link
                      className="student-button-primary"
                      href={writingReviewResultHref(attempt.attempt_id, historyHref)}
                    >
                      <FileCheck2 aria-hidden="true" size={17} />查看批改
                    </Link>
                  ) : null}
                </>
              )
            };
          })}
      />
    </div>
  );
}

async function loadSubmissionHistory(
  taskType: WritingTaskType,
  questionId: string,
  session: StudentCacheSession
) {
  const params = new URLSearchParams({ taskType, questionId });
  const url = `/api/writing/submissions?${params}`;
  return measureStudentRequest(`GET ${url}`, async (captureResponse) => {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${session.accessToken}` }
    });
    captureResponse(response);
    const payload = (await response.json()) as SubmissionHistoryPayload;
    if (!response.ok || payload.error) {
      throw new Error(payload.error ?? "无法加载提交记录。");
    }
    return payload;
  });
}

function formatDateTime(value: string | null) {
  if (!value) return "提交时间未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}
