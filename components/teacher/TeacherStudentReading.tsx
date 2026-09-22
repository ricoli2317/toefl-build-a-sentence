"use client";

import { BookOpenCheck, Clock3, Target, TrendingUp } from "lucide-react";
import {
  TEACHER_STUDENT_READING_CACHE_PREFIX,
  useTeacherCachedData
} from "@/components/TeacherDataCache";
import {
  TeacherAccuracyBar,
  TeacherCard,
  TeacherDataError,
  TeacherEmptyState,
  TeacherLoadingRegion,
  TeacherMetricCard,
  TeacherSectionTitle,
  TeacherSkeleton
} from "@/components/teacher/TeacherUI";
import type { TeacherStudentReadingDetailPayload } from "@/lib/reading/teacherStats";
import type { ReadingModule } from "@/lib/reading/types";
import { createBrowserSupabase } from "@/lib/supabase/client";

const TASK_LABELS: Record<ReadingModule, string> = {
  ctw: "Complete the Words",
  rdl: "Read in Daily Life",
  rap: "Read an Academic Passage"
};
const TASK_SHORT_LABELS: Record<ReadingModule, string> = {
  ctw: "CTW",
  rdl: "RDL",
  rap: "RAP"
};
const TASKS: ReadingModule[] = ["ctw", "rdl", "rap"];

export function TeacherStudentReadingSection({ studentId }: { studentId: string }) {
  const state = useTeacherCachedData<TeacherStudentReadingDetailPayload>(
    `${TEACHER_STUDENT_READING_CACHE_PREFIX}:${studentId}`,
    () => loadTeacherStudentReading(studentId)
  );
  const detail = state.data;

  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <TeacherSectionTitle>Reading 练习</TeacherSectionTitle>
        <DomainChip domain="reading" />
      </div>
      {state.loading ? <TeacherLoadingRegion label="正在加载阅读学习数据" /> : null}
      {state.error ? <TeacherDataError text={toReadingErrorMessage(state.error)} /> : null}
      {!state.loading && !state.error && detail ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <TeacherMetricCard
              icon={BookOpenCheck}
              label="已完成练习"
              value={String(detail.summary.completedAttempts)}
            />
            <TeacherMetricCard
              icon={Target}
              label="正确率"
              value={formatPercent(detail.summary.accuracy)}
            />
            <TeacherMetricCard
              icon={TrendingUp}
              label="得分"
              value={`${detail.summary.correctPoints}/${detail.summary.totalPoints}`}
            />
            <TeacherMetricCard
              icon={Clock3}
              label="练习时长"
              value={formatDuration(detail.summary.totalPracticeSeconds)}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {TASKS.map((taskType) => {
              const task = detail.summary.byTask[taskType];
              return (
                <TeacherCard className="p-4" key={taskType}>
                  <p className="text-sm font-semibold text-student-text">
                    {TASK_LABELS[taskType]}
                  </p>
                  <p className="mt-2 text-sm text-student-muted">
                    {task.completedAttempts} 次 · {formatPercent(task.accuracy)}
                  </p>
                </TeacherCard>
              );
            })}
          </div>
          <TeacherCard className="overflow-hidden p-0">
            <div className="px-5 pt-5">
              <TeacherSectionTitle>阅读练习记录</TeacherSectionTitle>
            </div>
            {detail.attempts.length === 0 ? (
              <div className="p-5">
                <TeacherEmptyState text="该学生还没有完成阅读练习。" />
              </div>
            ) : (
              <div className="divide-y divide-student-border px-5 pb-4 pt-2">
                {detail.attempts.map((attempt) => (
                  <div
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                    key={`${attempt.kind}:${attempt.attemptId}`}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-student-text">
                        <span className="mr-2 inline-flex rounded-full bg-[#eef6ff] px-2 py-0.5 text-xs font-semibold text-[#347fdc]">
                          {attempt.kind === "wrongbook" ? "错题订正" : TASK_SHORT_LABELS[attempt.taskType]}
                        </span>
                        {attempt.itemDisplayName}
                      </p>
                      <p className="mt-1 text-xs text-student-muted">
                        {TASK_LABELS[attempt.taskType]}
                        {attempt.scope ? ` · ${attempt.scope === "today" ? "今日错题" : "历史错题"}` : ""}
                        {" · "}
                        {formatCompactDateTime(attempt.submittedAt)}
                      </p>
                    </div>
                    <div className="flex min-w-[180px] items-center justify-end gap-3">
                      <span className="text-xs tabular-nums text-student-muted">
                        {attempt.correctPoints}/{attempt.totalPoints}
                      </span>
                      <TeacherAccuracyBar value={attempt.accuracy} />
                      <span className="w-16 text-right text-xs tabular-nums text-student-muted">
                        {formatDuration(attempt.elapsedSeconds)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </TeacherCard>
        </>
      ) : null}
    </section>
  );
}

export function DomainChip({ domain }: { domain: "reading" | "writing" }) {
  if (domain === "reading") {
    return (
      <span className="rounded-full border border-[#cfe3f8] bg-[#eef6ff] px-2.5 py-0.5 text-xs font-semibold text-[#347fdc]">
        Reading
      </span>
    );
  }
  return (
    <span className="rounded-full border border-student-primary-border bg-student-primary-soft px-2.5 py-0.5 text-xs font-semibold text-student-primary">
      Writing
    </span>
  );
}

function toReadingErrorMessage(message: string) {
  if (/无权|forbidden/i.test(message)) return "无权查看该学生的阅读数据。";
  return /[\u3400-\u9fff]/.test(message) ? message : "阅读数据加载失败，请稍后重试。";
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatDuration(value: number) {
  const seconds = Math.max(0, Math.round(value));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours}小时${minutes % 60 ? `${minutes % 60}分钟` : ""}`;
}

function formatCompactDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

async function loadTeacherStudentReading(studentId: string) {
  const {
    data: { session }
  } = await createBrowserSupabase().auth.getSession();
  const response = await fetch(
    `/api/teacher/students/${encodeURIComponent(studentId)}/reading`,
    {
      cache: "no-store",
      headers: { Authorization: `Bearer ${session?.access_token ?? ""}` }
    }
  );
  const payload = (await response.json().catch(() => ({}))) as
    | TeacherStudentReadingDetailPayload
    | { error?: string };
  if (!response.ok || "error" in payload) {
    const message = "error" in payload ? payload.error : null;
    throw new Error(message || "学生阅读数据加载失败。");
  }
  return payload as TeacherStudentReadingDetailPayload;
}
