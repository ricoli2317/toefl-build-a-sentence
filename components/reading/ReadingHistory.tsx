"use client";

import Link from "next/link";
import { Eye } from "lucide-react";
import {
  STUDENT_READING_HISTORY_CACHE_PREFIX,
  useStudentCachedData,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import {
  PracticeSubmissionHistoryHeader,
  PracticeSubmissionHistoryList
} from "@/components/shared/PracticeHistoryCards";
import {
  StudentEmptyState,
  StudentErrorState,
  StudentLoadingState,
  StudentNavigation
} from "@/components/student/StudentUI";
import type { ReadingHistoryPayload } from "@/lib/reading/history";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import { ReadingRetakeButton } from "./ReadingRetakeButton";

export function ReadingHistory() {
  const state = useStudentCachedData<ReadingHistoryPayload>(
    STUDENT_READING_HISTORY_CACHE_PREFIX,
    loadReadingHistory,
    { refreshOnMount: true }
  );
  if (state.loading) return <StudentLoadingState text="正在加载阅读历史..." />;
  if (state.error || !state.data) return <StudentErrorState text="阅读历史加载失败，请稍后重试。" />;
  const attempts = state.data.attempts;
  return (
    <div className="grid gap-5">
      <StudentNavigation
        backHref={STUDENT_ROUTES.home}
        crumbs={[
          { label: "学生首页", href: STUDENT_ROUTES.home },
          { label: "阅读历史" }
        ]}
      />
      <PracticeSubmissionHistoryHeader
        description={`共 ${attempts.length} 次提交，最新提交显示在最上方。`}
        eyebrow="Reading"
        title="阅读练习历史"
      />
      <PracticeSubmissionHistoryList
        emptyState={<StudentEmptyState text="还没有已提交的阅读练习记录。" />}
        items={attempts.map((attempt) => ({
          id: attempt.attemptId,
          title: attempt.itemTitle,
          submittedAt: formatDateTime(attempt.submittedAt),
          badge: <span className="student-chip">{attempt.taskName}</span>,
          details: (
            <p className="text-sm font-semibold text-student-text">
              得分 {attempt.correctPoints}/{attempt.totalPoints} · 正确率 {Math.round(attempt.accuracy * 100)}% · 用时 {formatDuration(attempt.elapsedSeconds)}
            </p>
          ),
          actions: (
            <>
              <Link className="student-button-secondary" href={`/student/reading/results/${encodeURIComponent(attempt.attemptId)}`}>
                <Eye aria-hidden="true" size={17} />查看结果
              </Link>
              <ReadingRetakeButton attemptId={attempt.attemptId} />
            </>
          )
        }))}
      />
    </div>
  );
}

async function loadReadingHistory(session: StudentCacheSession) {
  const response = await fetch("/api/reading/history", {
    cache: "no-store",
    headers: { Authorization: `Bearer ${session.accessToken}` }
  });
  const payload = await response.json().catch(() => ({})) as ReadingHistoryPayload & { error?: string };
  if (!response.ok || payload.error) throw new Error(payload.error ?? "阅读历史加载失败。");
  return payload;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "提交时间未知"
    : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatDuration(value: number) {
  const seconds = Math.max(0, Math.round(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

