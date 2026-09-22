"use client";

import Link from "next/link";
import { CalendarClock, ChevronRight, ClipboardPenLine, GraduationCap, Users } from "lucide-react";
import clsx from "clsx";
import { createBrowserSupabase } from "@/lib/supabase/client";
import {
  TEACHER_DASHBOARD_CACHE_KEY,
  TEACHER_INACTIVE_STUDENTS_CACHE_KEY,
  useTeacherCachedData
} from "@/components/TeacherDataCache";
import {
  TeacherCard,
  TeacherDataError,
  TeacherEmptyState,
  TeacherLoadingRegion,
  TeacherSectionTitle,
  TeacherSkeleton
} from "@/components/teacher/TeacherUI";
import type {
  TeacherDashboardInactiveStudent,
  TeacherDashboardPayload,
  TeacherDashboardStudentReminder,
  TeacherDashboardAssignmentReminderStatus
} from "@/lib/teacherDashboard";
import { loadTeacherDashboardPayload } from "@/lib/teacherDashboardClient";

type InactiveStudentsPayload = {
  students: Array<{
    studentId: string;
    studentName: string;
    lastActivityAt: string | null;
  }>;
};

/**
 * Teacher home: a compact work overview plus the two things a teacher should
 * act on (students needing attention, recent activity). It deliberately does
 * not host statistics or navigation cards.
 */
export function TeacherOverview() {
  const { data, error, loading } = useTeacherCachedData<TeacherDashboardPayload>(
    TEACHER_DASHBOARD_CACHE_KEY,
    loadTeacherDashboardPayload
  );
  const dashboard = data;

  return (
    <div className="grid gap-4">
      {loading ? <TeacherLoadingRegion label="正在加载教师首页数据" /> : null}

      <TeacherCard className="grid grid-cols-2 p-0">
        <div className="flex items-center justify-center px-4 py-3.5 sm:px-6">
          <OverviewMetric
            icon={Users}
            label="总学生数"
            value={
              loading
                ? <TeacherSkeleton className="h-8 w-12" />
                : error
                  ? "—"
                  : String(dashboard?.studentCount ?? 0)
            }
          />
        </div>
        <div className="flex items-center justify-center border-l border-student-border px-4 py-3.5 sm:px-6">
          <OverviewMetric
            icon={ClipboardPenLine}
            label="待批改"
            tone={!loading && !error && (dashboard?.pendingReviewCount ?? 0) > 0 ? "warning" : "default"}
            value={
              loading
                ? <TeacherSkeleton className="h-8 w-12" />
                : error
                  ? "—"
                  : String(dashboard?.pendingReviewCount ?? 0)
            }
          />
        </div>
      </TeacherCard>

      <div className="grid gap-4 xl:grid-cols-2">
        <TeacherCard className="flex flex-col p-5 sm:p-6">
          <TeacherSectionTitle>需要关注</TeacherSectionTitle>
          {error ? (
            <div className="mt-4"><TeacherDataError text={toTeacherErrorMessage(error)} /></div>
          ) : loading ? (
            <AttentionSkeleton />
          ) : (
            <>
              <section className="mt-3">
                <h3 className="text-sm font-semibold text-student-text">作业提醒</h3>
                {dashboard && dashboard.assignmentReminders.length > 0 ? (
                  <ul className="mt-1">
                    {dashboard.assignmentReminders.map((reminder) => (
                      <ReminderRow
                        key={`${reminder.studentId}:${reminder.status}`}
                        reminder={reminder}
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-student-muted">暂无需要关注的作业提醒。</p>
                )}
              </section>

              <section className="mt-5 flex-1 border-t border-student-border pt-4">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold text-student-text">近 3 天未活跃学生</h3>
                  <Link
                    className="inline-flex items-center gap-0.5 text-sm font-semibold text-student-primary hover:underline"
                    href="/teacher/inactive-students"
                  >
                    查看全部
                    <ChevronRight aria-hidden="true" size={16} strokeWidth={2.1} />
                  </Link>
                </div>
                <InactiveStudentNames students={dashboard?.inactiveStudents ?? []} />
              </section>
            </>
          )}
        </TeacherCard>

        <TeacherCard className="p-5 sm:p-6">
          <TeacherSectionTitle>近期动态</TeacherSectionTitle>
          {error ? (
            <div className="mt-4"><TeacherDataError text={toTeacherErrorMessage(error)} /></div>
          ) : loading ? (
            <RecentActivitySkeleton />
          ) : dashboard && dashboard.recentActivity.length > 0 ? (
            <div className="mt-2 divide-y divide-student-border">
              {dashboard.recentActivity.map((activity) => (
                <div
                  className="flex items-center justify-between gap-4 py-2.5 first:pt-1.5 last:pb-0"
                  key={activity.activityId}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-student-primary-soft text-student-primary">
                      <GraduationCap aria-hidden="true" size={17} strokeWidth={1.9} />
                    </span>
                    <p className="truncate text-sm text-student-text">
                      <span className="font-semibold">{activity.studentName}</span>
                      {" 完成了 "}
                      <span className="font-medium">{activity.domainLabel} · {activity.taskLabel}</span>
                      <span className="text-student-muted"> {activity.title}</span>
                    </p>
                  </div>
                  <time className="shrink-0 text-xs text-student-muted">
                    {formatActivityTime(activity.submittedAt)}
                  </time>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-4"><TeacherEmptyState text="暂无近期动态。" /></div>
          )}
        </TeacherCard>
      </div>
    </div>
  );
}

export function TeacherInactiveStudents() {
  const { data, error, loading } = useTeacherCachedData<InactiveStudentsPayload>(
    TEACHER_INACTIVE_STUDENTS_CACHE_KEY,
    loadInactiveStudentsPayload
  );

  return (
    <div className="grid gap-4">
      {loading ? <TeacherLoadingRegion label="正在加载未活跃学生名单" /> : null}
      <TeacherCard className="overflow-hidden p-0">
        {loading ? (
          <div className="grid gap-2 p-5 sm:p-6">
            {Array.from({ length: 6 }, (_, index) => (
              <TeacherSkeleton className="h-10 w-full" key={index} />
            ))}
          </div>
        ) : error ? (
          <div className="p-5 sm:p-6"><TeacherDataError text={toTeacherErrorMessage(error)} /></div>
        ) : data && data.students.length > 0 ? (
          <table className="w-full border-separate border-spacing-0 text-left text-sm">
            <thead className="bg-student-primary-soft/55">
              <tr className="text-student-text">
                <th className="px-5 py-3 font-semibold sm:px-6">学生姓名</th>
                <th className="px-5 py-3 font-semibold sm:px-6">最近一次练习时间</th>
              </tr>
            </thead>
            <tbody>
              {data.students.map((student) => (
                <tr className="border-t border-student-border" key={student.studentId}>
                  <td className="border-t border-student-border px-5 py-3 font-semibold text-student-text sm:px-6">
                    {student.studentName}
                  </td>
                  <td className="border-t border-student-border px-5 py-3 text-student-muted sm:px-6">
                    {student.lastActivityAt
                      ? formatDateTime(student.lastActivityAt)
                      : "暂无练习记录"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="p-5 sm:p-6">
            <TeacherEmptyState text="近 3 天所有学生都有练习活动。" />
          </div>
        )}
      </TeacherCard>
    </div>
  );
}

function OverviewMetric({
  icon: Icon,
  label,
  tone = "default",
  value
}: {
  icon: typeof Users;
  label: string;
  tone?: "default" | "warning";
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3.5">
      <span
        className={clsx(
          "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl",
          tone === "warning"
            ? "bg-student-error-soft text-student-error"
            : "bg-student-primary-soft text-student-primary"
        )}
      >
        <Icon aria-hidden="true" size={22} strokeWidth={1.9} />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-student-muted">{label}</p>
        <p
          className={clsx(
            "mt-0.5 text-[1.9rem] font-bold leading-none tracking-tight",
            tone === "warning" ? "text-student-error" : "text-student-text"
          )}
        >
          {value}
        </p>
      </div>
    </div>
  );
}

function ReminderRow({ reminder }: { reminder: TeacherDashboardStudentReminder }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-1.5">
      <span className="truncate text-sm font-semibold text-student-text">
        {reminder.studentName}
      </span>
      <span className="flex shrink-0 items-center gap-3">
        <span className="inline-flex items-center gap-1.5 text-xs text-student-muted">
          <CalendarClock aria-hidden="true" size={14} />
          {formatDueTime(reminder.dueAt)}
        </span>
        <ReminderStatusBadge status={reminder.status} />
      </span>
    </li>
  );
}

function ReminderStatusBadge({ status }: { status: TeacherDashboardAssignmentReminderStatus }) {  return (
    <span
      className={clsx(
        "inline-flex h-7 min-w-[64px] items-center justify-center rounded-full border px-2.5 text-xs font-semibold leading-none",
        status === "overdue"
          ? "border-student-error-border bg-student-error-soft text-student-error"
          : "border-amber-200 bg-amber-50 text-amber-700"
      )}
    >
      {status === "overdue" ? "已逾期" : "即将到期"}
    </span>
  );
}

function InactiveStudentNames({ students }: { students: TeacherDashboardInactiveStudent[] }) {
  if (students.length === 0) {
    return <p className="mt-2 text-sm text-student-muted">近 3 天所有学生都有练习活动。</p>;
  }
  // At most three chip rows at every width: six names on the two-column
  // mobile grid, up to twelve on the four-column desktop grid. The standalone
  // page lists everyone; the backend already caps the payload at ten names.
  const visible = students.slice(0, 12);
  return (
    <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {visible.map((student, index) => (
        <li
          className={clsx(
            "truncate rounded-full bg-student-primary-soft px-3 py-1 text-sm font-medium text-student-text",
            index >= 6 && "hidden sm:block"
          )}
          key={student.studentId}
        >
          {student.studentName}
        </li>
      ))}
    </ul>
  );
}

function AttentionSkeleton() {
  return (
    <div className="mt-4 grid gap-2.5">
      {Array.from({ length: 5 }, (_, index) => (
        <div className="flex items-center justify-between gap-3" key={index}>
          <TeacherSkeleton className="h-4 w-24" />
          <TeacherSkeleton className="h-6 w-36" />
        </div>
      ))}
    </div>
  );
}

function RecentActivitySkeleton() {
  return (
    <div className="mt-3 grid gap-3">
      {Array.from({ length: 4 }, (_, index) => (
        <div className="flex items-center gap-3 py-1" key={index}>
          <TeacherSkeleton className="h-9 w-9 shrink-0 rounded-full" />
          <TeacherSkeleton className="h-4 flex-1" />
          <TeacherSkeleton className="h-4 w-20 shrink-0" />
        </div>
      ))}
    </div>
  );
}

async function loadInactiveStudentsPayload(): Promise<InactiveStudentsPayload> {
  const supabase = createBrowserSupabase();
  const {
    data: { session }
  } = await supabase.auth.getSession();
  const response = await fetch("/api/teacher/inactive-students", {
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${session?.access_token ?? ""}`
    }
  });
  const payload = (await response.json().catch(() => ({}))) as
    | InactiveStudentsPayload
    | { error?: string };
  if (!response.ok || "error" in payload) {
    const message = "error" in payload ? payload.error : null;
    throw new Error(message || "无法加载未活跃学生名单。");
  }
  return payload as InactiveStudentsPayload;
}

function isToday(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

function formatActivityTime(value: string | null) {
  if (!value) return "时间未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (isToday(value)) return `今天 ${time}`;
  if (
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  ) {
    return `昨天 ${time}`;
  }
  return formatDateTime(value);
}

function formatDueTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function toTeacherErrorMessage(message: string) {
  if (/unauthorized|not authenticated/i.test(message)) return "登录状态已失效，请重新登录。";
  if (/forbidden|teacher role required/i.test(message)) return "当前账号没有教师端访问权限。";
  return /[\u3400-\u9fff]/.test(message) ? message : "数据加载失败，请稍后重试。";
}
