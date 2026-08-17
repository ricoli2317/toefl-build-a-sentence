"use client";

import clsx from "clsx";
import {
  CalendarClock,
  Eye,
  FileCheck2,
  FilePenLine,
  Mail,
  MessageCircleMore,
  Play,
  RotateCcw
} from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import {
  STUDENT_WRITING_ASSIGNMENTS_CACHE_KEY,
  useStudentCachedData,
  useStudentDataCache,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import {
  StudentEmptyState,
  StudentErrorState,
  StudentLoadingState,
  StudentNavigation
} from "@/components/student/StudentUI";
import { WritingPractice } from "@/components/writing/WritingPractice";
import { STUDENT_ROUTES, writingReviewResultHref } from "@/lib/studentNavigation";
import { WRITING_TASK_CONFIG } from "@/lib/writing";
import type {
  StudentWritingAssignmentSummary,
  StudentWritingAssignmentsPayload
} from "@/lib/writingAssignments";

export function StudentWritingAssignmentList() {
  const { refresh } = useStudentDataCache();
  const {
    data,
    error,
    loading: initialLoading,
    refreshing: backgroundRefreshing
  } = useStudentCachedData<StudentWritingAssignmentsPayload>(
    STUDENT_WRITING_ASSIGNMENTS_CACHE_KEY,
    loadStudentWritingAssignments
  );

  useEffect(() => {
    const refreshAssignments = () =>
      void refresh(
        STUDENT_WRITING_ASSIGNMENTS_CACHE_KEY,
        loadStudentWritingAssignments
      );
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshAssignments();
    };
    refreshAssignments();
    window.addEventListener("focus", refreshAssignments);
    document.addEventListener("visibilitychange", onVisibilityChange);
    const timer = window.setInterval(refreshAssignments, 30_000);
    return () => {
      window.removeEventListener("focus", refreshAssignments);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.clearInterval(timer);
    };
  }, [refresh]);

  if (initialLoading) return <StudentLoadingState text="正在加载我的作业..." />;
  if (error || !data) {
    return <StudentErrorState text="加载我的作业失败，请稍后重试。" />;
  }

  return (
    <div aria-busy={backgroundRefreshing} className="grid gap-5">
      {backgroundRefreshing ? <span className="sr-only">正在后台刷新我的作业</span> : null}
      <StudentNavigation
        backHref={STUDENT_ROUTES.home}
        crumbs={[
          { label: "学生首页", href: STUDENT_ROUTES.home },
          { label: "我的作业" }
        ]}
      />
      {data.assignments.length === 0 ? (
        <StudentEmptyState text="目前没有写作作业。" />
      ) : (
        <div className="grid gap-3">
          {data.assignments.map((assignment) => (
            <StudentWritingAssignmentCard
              assignment={assignment}
              key={assignment.assignment_id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function StudentWritingAssignmentEntry({
  assignmentId,
  attemptId,
  forceNew
}: {
  assignmentId: string;
  attemptId?: string;
  forceNew?: boolean;
}) {
  const state = useStudentCachedData<StudentWritingAssignmentsPayload>(
    STUDENT_WRITING_ASSIGNMENTS_CACHE_KEY,
    loadStudentWritingAssignments
  );
  if (state.loading) return <AssignmentEntryMessage text="正在准备写作作业..." />;
  const assignment = state.data?.assignments.find(
    (candidate) => candidate.assignment_id === assignmentId
  );
  if (state.error || !assignment) {
    return <AssignmentEntryMessage text="未找到这项写作作业。" />;
  }
  if (assignment.status === "withdrawn" && !attemptId) {
    return <AssignmentEntryMessage text="该作业已被教师撤回。" />;
  }
  return (
    <WritingPractice
      assignmentId={assignment.assignment_id}
      attemptId={attemptId}
      forceNew={forceNew}
      questionId={assignment.question_id}
      taskType={assignment.task_type}
    />
  );
}

function StudentWritingAssignmentCard({
  assignment
}: {
  assignment: StudentWritingAssignmentSummary;
}) {
  const config = WRITING_TASK_CONFIG[assignment.task_type];
  const TaskIcon = assignment.task_type === "email" ? Mail : MessageCircleMore;
  const entryHref = `${STUDENT_ROUTES.assignments}/${encodeURIComponent(
    assignment.assignment_id
  )}`;
  const submissionHref = assignment.latest_submitted_attempt_id
    ? `${config.submissionHref}/${encodeURIComponent(
        assignment.latest_submitted_attempt_id
      )}`
    : null;
  const reviewHref = assignment.published_review_attempt_id
    ? writingReviewResultHref(
        assignment.published_review_attempt_id,
        STUDENT_ROUTES.assignments
      )
    : null;
  const withdrawnWithoutSubmission =
    assignment.status === "withdrawn" && !assignment.latest_submitted_attempt_id;

  return (
    <article className="student-card grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-5">
      <div className="flex min-w-0 items-start gap-3.5">
        <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-student-primary-soft text-student-primary">
          <TaskIcon aria-hidden="true" size={22} />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold text-student-primary">{config.label}</span>
            <AssignmentStatusChip assignment={assignment} />
            {assignment.status === "withdrawn" ? (
              <span className="rounded-full bg-student-bg px-2.5 py-1 text-[11px] font-bold text-student-muted">
                已撤回
              </span>
            ) : null}
          </div>
          <h2 className="mt-1.5 truncate text-lg font-bold text-student-text">
            {assignment.question_snapshot.set_title}
          </h2>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-student-muted">
            <span>布置于 {formatDateTime(assignment.assigned_at)}</span>
            <span className="inline-flex items-center gap-1.5">
              <CalendarClock aria-hidden="true" size={14} />
              {assignment.due_at
                ? `截止 ${formatDateTime(assignment.due_at)}`
                : "无截止时间"}
            </span>
            {assignment.draft_attempt_id ? (
              <span className="font-semibold text-student-primary">
                已保存{assignment.draft_writing_mode === "practice" ? "练习模式" : "模考模式"}草稿
              </span>
            ) : null}
          </div>
          {withdrawnWithoutSubmission ? (
            <p className="mt-2 text-sm font-semibold text-student-muted">
              该作业已被教师撤回。
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap justify-start gap-2 sm:max-w-[390px] sm:justify-end">
        {assignment.status === "active" && assignment.draft_attempt_id ? (
          <AssignmentAction
            href={`${entryHref}?attempt=${encodeURIComponent(assignment.draft_attempt_id)}`}
            icon={FilePenLine}
            label="继续作答"
            primary
          />
        ) : null}
        {submissionHref ? (
          <AssignmentAction href={submissionHref} icon={Eye} label="查看提交" />
        ) : null}
        {reviewHref ? (
          <AssignmentAction href={reviewHref} icon={FileCheck2} label="查看批改" primary />
        ) : null}
        {assignment.status === "active" && !assignment.draft_attempt_id ? (
          <AssignmentAction
            href={assignment.latest_submitted_attempt_id ? `${entryHref}?new=1` : entryHref}
            icon={assignment.latest_submitted_attempt_id ? RotateCcw : Play}
            label={assignment.latest_submitted_attempt_id ? "重新作答" : "开始作业"}
            primary={!reviewHref}
          />
        ) : null}
      </div>
    </article>
  );
}

function AssignmentStatusChip({
  assignment
}: {
  assignment: StudentWritingAssignmentSummary;
}) {
  const overdue = assignment.student_status === "overdue";
  const label = assignment.student_status === "completed"
    ? "已完成"
    : assignment.student_status === "late_completed"
      ? "已完成 · 逾期提交"
      : overdue
        ? "已逾期"
        : "未完成";
  return (
    <span
      className={clsx(
        "rounded-full px-2.5 py-1 text-[11px] font-bold",
        overdue
          ? "bg-student-error-soft text-student-error"
          : assignment.student_status === "pending"
            ? "bg-amber-50 text-amber-700"
            : "bg-emerald-50 text-emerald-700"
      )}
    >
      {label}
    </span>
  );
}

function AssignmentAction({
  href,
  icon: Icon,
  label,
  primary = false
}: {
  href: string;
  icon: typeof Play;
  label: string;
  primary?: boolean;
}) {
  return (
    <Link
      className={primary ? "student-button-primary" : "student-button-secondary"}
      href={href}
    >
      <Icon aria-hidden="true" size={17} />
      {label}
    </Link>
  );
}

function AssignmentEntryMessage({ text }: { text: string }) {
  return (
    <div className="grid min-h-[100dvh] place-items-center bg-[#fbfbfe] px-5">
      <div className="student-card max-w-md text-center">
        <h1 className="text-xl font-bold text-student-text">我的作业</h1>
        <p className="mt-2 text-sm text-student-muted">{text}</p>
      </div>
    </div>
  );
}

async function loadStudentWritingAssignments(session: StudentCacheSession) {
  const response = await fetch("/api/writing/assignments", {
    cache: "no-store",
    headers: { Authorization: `Bearer ${session.accessToken}` }
  });
  const payload = (await response.json()) as StudentWritingAssignmentsPayload;
  if (!response.ok || payload.error) {
    throw new Error(payload.error ?? "无法加载我的作业。");
  }
  return payload;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}
