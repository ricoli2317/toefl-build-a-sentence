"use client";

import Link from "next/link";
import { CheckCircle2, Clock3, FilePenLine, RefreshCw } from "lucide-react";
import {
  TeacherCard,
  TeacherDataError
} from "@/components/teacher/TeacherUI";
import { assignmentItemTypeLabel } from "@/lib/assignmentCatalog";
import {
  collectWritingAssignmentStudentProgress,
  isWritingReviewItemType,
  writingAssignmentProgressBadgeClass,
  writingAssignmentTaskTypeBadges,
  writingAssignmentTitle,
  type WritingAssignmentDetail,
  type WritingAssignmentProgress,
  type WritingAssignmentStudentDetail
} from "@/lib/writingAssignments";
import { teacherAssignmentItemAction } from "@/lib/teacherAssignmentItems";
import { formatAccountForDisplay, formatManagedAccountName } from "@/lib/accountIdentifier";

/**
 * One shared body for every teacher Writing Assignment Detail: the Assignment
 * header card followed by one student completion card per recipient, and one
 * table row per assignment inside each card. Legacy single assignments (direct
 * or class) and Assignment Groups render through this exact path, so the page
 * structure never depends on question count, student count or class linkage.
 */
export function TeacherWritingAssignmentDetailBody({
  actions,
  assignments,
  completedCount,
  createdAt,
  dueAt,
  errorText,
  onRefresh,
  pendingReviewCount,
  progress,
  publishedCount,
  refreshing = false,
  returnTo,
  title,
  totalCount
}: {
  /** Assignment-level actions (legacy single detail keeps its lifecycle buttons). */
  actions?: React.ReactNode;
  assignments: WritingAssignmentDetail[];
  completedCount: number;
  createdAt: string;
  dueAt: string | null;
  errorText?: string;
  onRefresh: () => void;
  pendingReviewCount: number;
  progress: { label: string; progress: WritingAssignmentProgress };
  publishedCount: number;
  refreshing?: boolean;
  returnTo: string;
  /** Assignment / Assignment Group title shown as the main heading. */
  title: string;
  totalCount: number;
}) {
  const students = collectWritingAssignmentStudentProgress(assignments);
  const reviewBased = assignments.some((assignment) =>
    isWritingReviewItemType(assignment.task_type)
  );
  return (
    <div className="grid gap-5" aria-busy={refreshing}>
      <TeacherCard className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap gap-2">
              {writingAssignmentTaskTypeBadges(assignments.map((assignment) => assignment.task_type)).map((label) => (
                <span className="rounded-full bg-student-primary-soft px-3 py-1 text-xs font-bold text-student-primary" key={label}>
                  {label}
                </span>
              ))}
              <span className={`rounded-full px-3 py-1 text-xs font-bold ${writingAssignmentProgressBadgeClass(progress.progress)}`}>
                {progress.label}
              </span>
            </div>
            <h2 className="mt-3 text-xl font-bold text-student-text">{title}</h2>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-student-muted">
              {reviewBased ? (
                <>
                  <span className="font-semibold text-student-text">
                    {completedCount} / {totalCount} 已提交
                  </span>
                  <span className={pendingReviewCount ? "font-semibold text-amber-700" : ""}>
                    {pendingReviewCount} 篇待批改
                  </span>
                  <span>{publishedCount} 篇已发布</span>
                </>
              ) : (
                <span className="font-semibold text-student-text">
                  {completedCount} / {totalCount} 已完成
                </span>
              )}
              <span>截止：{dueAt ? formatDate(dueAt) : "无"}</span>
              <span>布置：{formatDate(createdAt)}</span>
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {actions}
            <button
              className="teacher-button-secondary"
              disabled={refreshing}
              onClick={onRefresh}
              type="button"
            >
              <RefreshCw aria-hidden="true" size={16} />刷新状态
            </button>
          </div>
        </div>
      </TeacherCard>

      {errorText ? <TeacherDataError text={errorText} /> : null}

      <div className="grid gap-4">
        {students.map((student) => {
          const submittedCount = student.assignments.filter(
            ({ progress: studentProgress }) =>
              Boolean(studentProgress.completed || studentProgress.latest_submitted_attempt_id)
          ).length;
          return (
            <TeacherCard className="grid gap-4 p-5" key={student.student_id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-bold text-student-text">{formatManagedAccountName(student.student_name, student.student_email)}</h3>
                  <p className="mt-1 text-xs text-student-muted">账号：{formatAccountForDisplay(student.student_email) || "—"}</p>
                </div>
                <span className="rounded-full bg-student-bg px-3 py-1 text-xs font-bold text-student-muted">
                  {submittedCount} / {student.assignments.length} 已提交
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
                    {student.assignments.map(({ assignment, progress: studentProgress }, index) => (
                      <tr key={assignment.assignment_id}>
                        <td className="px-4 py-3">
                          <span className="block text-xs font-bold text-student-primary">
                            第 {index + 1} 篇 · {assignmentItemTypeLabel(assignment.task_type)}
                          </span>
                          <span className="mt-1 block font-semibold text-student-text">
                            {assignment.display_name || writingAssignmentTitle(assignment.question_snapshot)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-student-muted">
                          {assignment.due_at ? formatDate(assignment.due_at) : "无"}
                        </td>
                        <td className="px-4 py-3">
                          <StudentWritingProgressBadge progress={studentProgress} />
                        </td>
                        <td className="px-4 py-3 text-right">
                          <StudentWritingReviewAction
                            itemType={assignment.task_type}
                            progress={studentProgress}
                            returnTo={returnTo}
                            studentId={student.student_id}
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
  const completed = Boolean(progress.completed || published);
  const submitted = Boolean(progress.latest_submitted_attempt_id);
  const label = completed
    ? "已完成"
    : submitted
      ? "已提交"
      : progress.has_attempt
        ? "进行中"
        : progress.status === "overdue"
          ? "已逾期"
          : "等待";
  const className = completed
    ? "bg-emerald-50 text-emerald-700"
    : submitted
      ? "bg-amber-50 text-amber-700"
      : progress.status === "overdue"
        ? "bg-student-error-soft text-student-error"
        : "bg-student-primary-soft text-student-primary";
  const Icon = completed ? CheckCircle2 : submitted ? FilePenLine : Clock3;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ${className}`}>
      <Icon aria-hidden="true" size={13} />{label}
    </span>
  );
}

/**
 * One shared row action for every item type: WE / AD open the Writing Review
 * workspace (批改), while BAS / CTW / RDL / RAP / Full Set open the existing
 * teacher read-only result page (查看). An unfinished read-only item has no
 * action.
 */
function StudentWritingReviewAction({
  itemType,
  progress,
  returnTo,
  studentId
}: {
  itemType: WritingAssignmentDetail["task_type"];
  progress: WritingAssignmentStudentDetail;
  returnTo: string;
  studentId: string;
}) {
  const action = teacherAssignmentItemAction({
    itemType,
    returnTo,
    student: progress,
    studentId
  });
  if (!action) return <span className="text-student-muted">{progress.has_attempt ? "等待提交" : "—"}</span>;
  return (
    <Link
      className="text-sm font-semibold text-student-primary underline-offset-4 hover:text-student-primary-hover hover:underline"
      href={action.href}
    >
      {action.label}
    </Link>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}
