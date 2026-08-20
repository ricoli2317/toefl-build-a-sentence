"use client";

import Link from "next/link";
import { CalendarClock, CheckCircle2, Clock3, FilePenLine, RefreshCw } from "lucide-react";
import {
  TEACHER_WRITING_ASSIGNMENTS_CACHE_PREFIX,
  useTeacherCachedData,
  useTeacherDataCache
} from "@/components/TeacherDataCache";
import {
  TeacherCard,
  TeacherDataError,
  TeacherLoadingRegion,
  TeacherSectionTitle,
  TeacherSkeleton
} from "@/components/teacher/TeacherUI";
import { teacherApiFetch } from "@/lib/teacherClientApi";
import { WRITING_TASK_CONFIG } from "@/lib/writing";
import {
  getWritingAssignmentReviewAction,
  writingAssignmentTitle,
  type WritingAssignmentCollectionDetail,
  type WritingAssignmentDetail,
  type WritingAssignmentStudentDetail
} from "@/lib/writingAssignments";
import { teacherWritingReviewWorkspaceHref } from "@/lib/teacherWritingReviewNavigation";

export function TeacherWritingAssignmentCollectionDetailView({
  collectionId
}: {
  collectionId: string;
}) {
  const cache = useTeacherDataCache();
  const cacheKey = `${TEACHER_WRITING_ASSIGNMENTS_CACHE_PREFIX}:collection:${collectionId}`;
  const { data, error, loading, refreshing } = useTeacherCachedData<{
    collection: WritingAssignmentCollectionDetail;
  }>(
    cacheKey,
    () => teacherApiFetch(
      `/api/teacher/writing/assignments/batches/${encodeURIComponent(collectionId)}`
    ),
    { refreshOnMount: true }
  );
  if (loading) {
    return (
      <div className="grid gap-4" aria-busy="true">
        <TeacherLoadingRegion label="正在加载作业进度" />
        <TeacherSkeleton className="h-36 w-full rounded-2xl" />
        <TeacherSkeleton className="h-80 w-full rounded-2xl" />
      </div>
    );
  }
  if (error || !data) return <TeacherDataError text={error || "无法加载作业详情。"} />;
  const collection = data.collection;
  const students = collectStudents(collection.assignments);
  const detailHref = `/teacher/writing/assignments/batches/${collectionId}`;
  const overallLabel = collection.published_count >= collection.total_count
    ? "已完成"
    : collection.completed_count >= collection.total_count
      ? "全部已提交"
      : collection.completed_count > 0
        ? "部分已提交"
        : "进行中";

  return (
    <div className="grid gap-5" aria-busy={refreshing}>
      <TeacherCard className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap gap-2">
              <span className="rounded-full bg-student-primary-soft px-3 py-1 text-xs font-bold text-student-primary">
                写作作业 · {collection.assignments.length} 篇
              </span>
              <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-bold text-amber-700">
                {overallLabel}
              </span>
            </div>
            <h2 className="mt-3 text-xl font-bold text-student-text">
              {collection.assigned_count} 名学生的写作进度
            </h2>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-student-muted">
              <span className="font-semibold text-student-text">
                {collection.completed_count} / {collection.total_count} 已提交
              </span>
              <span className={collection.pending_review_count ? "font-semibold text-amber-700" : ""}>
                {collection.pending_review_count} 篇待批改
              </span>
              <span>{collection.published_count} 篇已发布</span>
              <span>布置：{formatDate(collection.created_at)}</span>
            </div>
          </div>
          <button
            className="teacher-button-secondary"
            disabled={refreshing}
            onClick={() => cache.invalidate(cacheKey)}
            type="button"
          >
            <RefreshCw aria-hidden="true" size={16} />刷新状态
          </button>
        </div>
      </TeacherCard>

      <TeacherCard className="grid gap-4 p-5">
        <TeacherSectionTitle>题目进度</TeacherSectionTitle>
        <div className="grid gap-3 sm:grid-cols-2">
          {collection.assignments.map((assignment, index) => (
            <div className="rounded-xl border border-student-border p-4" key={assignment.assignment_id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-bold text-student-primary">
                  第 {index + 1} 篇 · {WRITING_TASK_CONFIG[assignment.task_type].label}
                </span>
                <span className="text-xs font-semibold text-student-muted">
                  {assignment.completed_count} / {assignment.assigned_count} 已提交
                </span>
              </div>
              <p className="mt-2 line-clamp-2 font-bold text-student-text">
                {writingAssignmentTitle(assignment.question_snapshot)}
              </p>
              <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-student-muted">
                <CalendarClock aria-hidden="true" size={14} />
                截止：{assignment.due_at ? formatDate(assignment.due_at) : "无"}
              </p>
            </div>
          ))}
        </div>
      </TeacherCard>

      <div className="grid gap-4">
        {students.map((student) => {
          const submittedCount = student.assignments.filter(
            ({ progress }) => progress.latest_submitted_attempt_id
          ).length;
          return (
            <TeacherCard className="grid gap-4 p-5" key={student.student_id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-bold text-student-text">{student.student_name}</h3>
                  <p className="mt-1 text-xs text-student-muted">{student.student_email || "—"}</p>
                </div>
                <span className="rounded-full bg-student-bg px-3 py-1 text-xs font-bold text-student-muted">
                  {submittedCount} / {collection.assignments.length} 已提交
                </span>
              </div>
              <div className="overflow-x-auto rounded-xl border border-student-border">
                <table className="w-full min-w-[720px] border-collapse text-left text-sm">
                  <thead className="bg-student-bg text-student-muted">
                    <tr>
                      <th className="px-4 py-3 font-semibold">题目</th>
                      <th className="px-4 py-3 font-semibold">截止时间</th>
                      <th className="px-4 py-3 font-semibold">状态</th>
                      <th className="px-4 py-3 text-right font-semibold">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-student-border">
                    {student.assignments.map(({ assignment, progress }, index) => (
                      <tr key={assignment.assignment_id}>
                        <td className="px-4 py-3">
                          <span className="block text-xs font-bold text-student-primary">
                            第 {index + 1} 篇 · {WRITING_TASK_CONFIG[assignment.task_type].label}
                          </span>
                          <span className="mt-1 block font-semibold text-student-text">
                            {writingAssignmentTitle(assignment.question_snapshot)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-student-muted">
                          {assignment.due_at ? formatDate(assignment.due_at) : "无"}
                        </td>
                        <td className="px-4 py-3">
                          <StudentWritingProgressBadge progress={progress} />
                        </td>
                        <td className="px-4 py-3 text-right">
                          <StudentWritingReviewAction
                            progress={progress}
                            returnTo={detailHref}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </TeacherCard>
          );
        })}
      </div>
    </div>
  );
}

function StudentWritingProgressBadge({
  progress
}: {
  progress: WritingAssignmentStudentDetail;
}) {
  const published = progress.latest_review_status === "published";
  const submitted = Boolean(progress.latest_submitted_attempt_id);
  const label = published
    ? "已完成"
    : submitted
      ? "已提交"
      : progress.has_attempt
        ? "进行中"
        : progress.status === "overdue"
          ? "已逾期"
          : "等待";
  const className = published
    ? "bg-emerald-50 text-emerald-700"
    : submitted
      ? "bg-amber-50 text-amber-700"
      : progress.status === "overdue"
        ? "bg-student-error-soft text-student-error"
        : "bg-student-primary-soft text-student-primary";
  const Icon = published ? CheckCircle2 : submitted ? FilePenLine : Clock3;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ${className}`}>
      <Icon aria-hidden="true" size={13} />{label}
    </span>
  );
}

function StudentWritingReviewAction({
  progress,
  returnTo
}: {
  progress: WritingAssignmentStudentDetail;
  returnTo: string;
}) {
  const action = getWritingAssignmentReviewAction({
    latestSubmittedAttemptId: progress.latest_submitted_attempt_id,
    latestReviewStatus: progress.latest_review_status
  });
  if (!action) return <span className="text-student-muted">等待提交</span>;
  return (
    <Link
      className="text-sm font-semibold text-student-primary underline-offset-4 hover:text-student-primary-hover hover:underline"
      href={teacherWritingReviewWorkspaceHref(action.attemptId, returnTo)}
    >
      {action.label}
    </Link>
  );
}

function collectStudents(assignments: WritingAssignmentDetail[]) {
  const students = new Map<string, {
    student_id: string;
    student_name: string;
    student_email: string;
  }>();
  for (const assignment of assignments) {
    for (const student of assignment.students) {
      students.set(student.student_id, {
        student_id: student.student_id,
        student_name: student.student_name,
        student_email: student.student_email
      });
    }
  }
  return Array.from(students.values()).map((student) => ({
    ...student,
    assignments: assignments.map((assignment) => ({
      assignment,
      progress: assignment.students.find(
        (candidate) => candidate.student_id === student.student_id
      ) ?? missingStudentProgress(student)
    }))
  }));
}

function missingStudentProgress(student: { student_id: string; student_name: string; student_email: string }): WritingAssignmentStudentDetail {
  return {
    ...student,
    assigned_at: "",
    first_submitted_at: null,
    has_attempt: false,
    latest_submitted_attempt_id: null,
    latest_review_status: null,
    status: "pending"
  };
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}
