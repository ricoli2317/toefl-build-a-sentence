"use client";

import Link from "next/link";
import { useState } from "react";
import { AlertTriangle, ArrowRight, CalendarClock, ChevronDown, Files, Pencil, RotateCcw, Trash2, Undo2, Users } from "lucide-react";
import {
  TEACHER_WRITING_ASSIGNMENTS_CACHE_PREFIX,
  useTeacherDataCache
} from "@/components/TeacherDataCache";
import {
  TeacherCard,
  TeacherDataError,
  TeacherEmptyState,
  TeacherLoadingRegion,
  TeacherSkeleton
} from "@/components/teacher/TeacherUI";
import { TeacherPopover } from "@/components/teacher/TeacherPopover";
import { teacherApiFetch } from "@/lib/teacherClientApi";
import {
  getWritingAssignmentReviewAction,
  getWritingAssignmentProgress,
  groupTeacherWritingAssignments,
  teacherWritingAssignmentCardActions,
  writingAssignmentTaskTypeBadges,
  writingAssignmentTitle,
  type TeacherWritingAssignmentListEntry,
  type WritingAssignmentRecipient,
  type WritingAssignmentSummary
} from "@/lib/writingAssignments";
import { teacherWritingReviewWorkspaceHref } from "@/lib/teacherWritingReviewNavigation";
import { publishCacheInvalidation } from "@/lib/cacheInvalidation";

const WITHDRAW_CONFIRM = "确认撤回这项作业？\n\n撤回后，学生将不能再通过该作业开始或继续未提交的练习。\n已经提交的作业和批改记录不会受到影响。";
const DELETE_CONFIRM = "确认删除这项作业？\n\n删除后，该作业将不再显示在正常作业列表中。\n学生已有提交和批改记录不会被删除。";

/**
 * Purely presentational list: the page loads the full assignment set once and
 * performs the student filtering locally, so switching the filter never asks
 * the server for anything.
 */
export function TeacherWritingAssignmentList({
  assignments,
  error,
  filterStudent,
  loading,
  onClearFilter
}: {
  assignments: WritingAssignmentSummary[];
  error: string;
  filterStudent: WritingAssignmentRecipient | null;
  loading: boolean;
  onClearFilter: () => void;
}) {
  const cache = useTeacherDataCache();
  const [pendingId, setPendingId] = useState("");
  const [mutationError, setMutationError] = useState("");

  async function mutate(assignmentId: string, action: "withdraw" | "reactivate" | "soft_delete") {
    if (action === "withdraw" && !window.confirm(WITHDRAW_CONFIRM)) return;
    if (action === "soft_delete" && !window.confirm(DELETE_CONFIRM)) return;
    setPendingId(assignmentId);
    setMutationError("");
    try {
      await teacherApiFetch(`/api/teacher/writing/assignments/${encodeURIComponent(assignmentId)}`, {
        method: "PATCH",
        body: JSON.stringify({ action })
      });
      cache.invalidate(TEACHER_WRITING_ASSIGNMENTS_CACHE_PREFIX);
      publishCacheInvalidation({ type: "ASSIGNMENT_UPDATED", assignmentId });
    } catch (mutation) {
      setMutationError(mutation instanceof Error ? mutation.message : "作业操作失败。");
    } finally {
      setPendingId("");
    }
  }

  const studentFilterBanner = filterStudent ? (
    <TeacherCard className="flex flex-wrap items-center justify-between gap-3 p-4">
      <p className="text-sm text-student-muted">
        当前仅显示 {filterStudent.student_name} 的写作作业。
      </p>
      <button className="teacher-button-secondary" onClick={onClearFilter} type="button">
        查看全部作业
      </button>
    </TeacherCard>
  ) : null;

  if (loading) {
    return <div className="grid gap-3" aria-busy="true">{studentFilterBanner}<TeacherLoadingRegion label="正在加载作业列表" />{[1, 2, 3].map((item) => <TeacherSkeleton className="h-32 w-full rounded-2xl" key={item} />)}</div>;
  }
  if (error) return <div className="grid gap-3">{studentFilterBanner}<TeacherDataError text={error} /></div>;
  if (!assignments.length) {
    return (
      <div className="grid gap-3">
        {studentFilterBanner}
        <TeacherCard className="p-5">
          <TeacherEmptyState text={filterStudent ? "该学生还没有写作作业。" : "还没有写作作业。点击右上角“布置作业”开始。"} />
        </TeacherCard>
      </div>
    );
  }
  const entries = groupTeacherWritingAssignments(assignments);

  return (
    <div className="grid gap-3">
      {studentFilterBanner}
      {mutationError ? <TeacherDataError text={mutationError} /> : null}
      {entries.map((entry) => {
        if (entry.kind === "collection") {
          return (
            <TeacherWritingAssignmentCollectionCard
              entry={entry}
              key={entry.collection_id}
              onReactivate={(assignmentId) => void mutate(assignmentId, "reactivate")}
              onSoftDelete={(assignmentId) => void mutate(assignmentId, "soft_delete")}
              onWithdraw={(assignmentId) => void mutate(assignmentId, "withdraw")}
              pending={pendingId === entry.assignments[0].assignment_id}
            />
          );
        }
        const assignment = entry.assignment;
        const pending = pendingId === assignment.assignment_id;
        const detailHref = `/teacher/writing/assignments/${assignment.assignment_id}`;
        const reviewAction = assignment.assigned_count === 1
          ? getWritingAssignmentReviewAction({
              latestSubmittedAttemptId:
                assignment.single_student_latest_submitted_attempt_id,
              latestReviewStatus: assignment.single_student_latest_review_status
            })
          : null;
        const actions = teacherWritingAssignmentCardActions({
          status: assignment.status,
          hasAttempts: assignment.has_attempts
        });
        return (
          <article className="teacher-card flex flex-wrap items-center gap-5 p-5" key={assignment.assignment_id}>
            <div className="min-w-0 flex-1">
              <Link className="group block" href={detailHref}>
                <div className="flex flex-wrap items-center gap-2">
                  {writingAssignmentTaskTypeBadges([assignment.task_type]).map((label) => <span className="rounded-full bg-student-primary-soft px-3 py-1 text-xs font-bold text-student-primary" key={label}>{label}</span>)}
                  <span className="rounded-full border border-student-border px-3 py-1 text-xs font-semibold text-student-muted">{assignment.question_source === "custom" ? "自定义" : "题库"}</span>
                  <AssignmentProgressBadge assignment={assignment} />
                  {assignment.has_overdue_students ? <span className="inline-flex items-center gap-1 rounded-full bg-student-error-soft px-3 py-1 text-xs font-semibold text-student-error"><AlertTriangle aria-hidden="true" size={13} />存在逾期未完成</span> : null}
                </div>
                <h2 className="mt-3 truncate text-lg font-bold text-student-text">{assignment.group_title?.trim() || assignment.display_name || writingAssignmentTitle(assignment.question_snapshot)}</h2>
              </Link>
              <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-student-muted">
                <span className="inline-flex items-center gap-2"><Users aria-hidden="true" size={16} /><AssignmentRecipientNames recipients={assignment.recipients ?? []} /></span>
                <span>{assignment.completed_count} 人已提交 · {assignment.published_count} 人已发布</span>
                <span className="inline-flex items-center gap-2"><CalendarClock aria-hidden="true" size={16} />截止：{formatDateTime(assignment.due_at, "无")}</span>
                <span>布置：{formatDateTime(assignment.created_at, "—")}</span>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {reviewAction ? (
                <Link
                  className="teacher-button-secondary"
                  href={teacherWritingReviewWorkspaceHref(
                    reviewAction.attemptId,
                    "/teacher/writing/assignments"
                  )}
                >
                  {reviewAction.label}
                </Link>
              ) : null}
              {actions.canWithdraw ? (
                <button
                  className="teacher-button-secondary"
                  disabled={pending}
                  onClick={() => void mutate(assignment.assignment_id, "withdraw")}
                  type="button"
                ><Undo2 aria-hidden="true" size={16} />撤回</button>
              ) : null}
              {actions.canEdit ? (
                <Link className="teacher-button-secondary" href={`${detailHref}/edit`}><Pencil aria-hidden="true" size={16} />编辑作业</Link>
              ) : null}
              {actions.canReactivate ? (
                <button className="teacher-button-primary" disabled={pending} onClick={() => void mutate(assignment.assignment_id, "reactivate")} type="button"><RotateCcw aria-hidden="true" size={16} />重新布置</button>
              ) : null}
              {actions.canSoftDelete ? (
                <button className="teacher-button-secondary text-student-error" disabled={pending} onClick={() => void mutate(assignment.assignment_id, "soft_delete")} type="button"><Trash2 aria-hidden="true" size={16} />删除作业</button>
              ) : null}
              <Link aria-label="查看作业详情" className="teacher-button-secondary px-3" href={detailHref}><ArrowRight aria-hidden="true" size={18} /></Link>
            </div>
          </article>
        );
      })}
    </div>
  );
}

export function AssignmentRecipientNames({
  recipients
}: {
  recipients: WritingAssignmentRecipient[];
}) {
  if (!recipients.length) return <span>未指定学生</span>;
  const first = recipients[0];
  if (recipients.length === 1) {
    return <span className="font-semibold text-student-text">{first.student_name}</span>;
  }
  return (
    <>
      <span className="font-semibold text-student-text">{first.student_name}等</span>
      <TeacherPopover
        buttonClassName="inline-flex min-h-7 items-center gap-1 rounded-full border border-student-primary-border bg-white px-2.5 text-xs font-semibold text-student-primary transition hover:border-student-primary hover:bg-student-primary-soft"
        buttonContent={<>更多<ChevronDown aria-hidden="true" size={13} /></>}
        menuClassName="min-w-[13rem]"
      >
        {() => (
          <ul className="grid max-h-64 gap-0.5 overflow-y-auto">
            {recipients.map((recipient) => (
              <li className="truncate rounded-lg px-3 py-1.5 text-sm font-medium text-student-text" key={recipient.student_id}>
                {recipient.student_name}
              </li>
            ))}
          </ul>
        )}
      </TeacherPopover>
    </>
  );
}

function TeacherWritingAssignmentCollectionCard({
  entry,
  onReactivate,
  onSoftDelete,
  onWithdraw,
  pending
}: {
  entry: Extract<TeacherWritingAssignmentListEntry, { kind: "collection" }>;
  onReactivate: (assignmentId: string) => void;
  onSoftDelete: (assignmentId: string) => void;
  onWithdraw: (assignmentId: string) => void;
  pending: boolean;
}) {
  const detailHref = `/teacher/writing/assignments/batches/${entry.collection_id}`;
  const editHref = `${detailHref}/edit`;
  // Same action rule as a legacy single card, aggregated over the group: the
  // whole group is one business object.
  const allWithdrawn = entry.assignments.every(
    (assignment) => assignment.status === "withdrawn"
  );
  const actions = teacherWritingAssignmentCardActions({
    status: allWithdrawn ? "withdrawn" : "active",
    hasAttempts: entry.assignments.some((assignment) => assignment.has_attempts)
  });
  const actionAssignmentId = entry.assignments[0].assignment_id;
  const progress = allWithdrawn
    ? "已撤回"
    : entry.published_count >= entry.total_count
      ? "已完成"
      : entry.completed_count >= entry.total_count
        ? "全部已提交"
        : entry.completed_count > 0
          ? "部分已提交"
          : "进行中";
  const progressClassName = allWithdrawn
    ? "bg-slate-100 text-slate-600"
    : "bg-amber-50 text-amber-700";
  const dueDates = entry.assignments
    .flatMap((assignment) => assignment.due_at ? [assignment.due_at] : [])
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  const taskTypeBadges = writingAssignmentTaskTypeBadges(
    entry.assignments.map((assignment) => assignment.task_type)
  );
  const fallbackTitle = `${entry.assignments[0].display_name || writingAssignmentTitle(entry.assignments[0].question_snapshot)} 等 ${entry.assignments.length} 篇写作`;

  return (
    <article className="teacher-card flex flex-wrap items-center gap-5 p-5">
      <div className="min-w-0 flex-1">
        <Link className="group block" href={detailHref}>
          <div className="flex flex-wrap items-center gap-2">
            {taskTypeBadges.map((label, index) => (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-student-primary-soft px-3 py-1 text-xs font-bold text-student-primary" key={label}>
                {index === 0 ? <Files aria-hidden="true" size={13} /> : null}{label}
              </span>
            ))}
            <span className={`rounded-full px-3 py-1 text-xs font-bold ${progressClassName}`}>
              {progress}
            </span>
            {entry.has_overdue_students ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-student-error-soft px-3 py-1 text-xs font-semibold text-student-error">
                <AlertTriangle aria-hidden="true" size={13} />存在逾期未完成
              </span>
            ) : null}
          </div>
          <h2 className="mt-3 truncate text-lg font-bold text-student-text">
            {entry.title || fallbackTitle}
          </h2>
        </Link>
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-student-muted">
          <span className="inline-flex items-center gap-2">
            <Users aria-hidden="true" size={16} /><AssignmentRecipientNames recipients={entry.recipients} />
          </span>
          <span className="font-semibold text-student-text">
            {entry.completed_count} / {entry.total_count} 已提交
          </span>
          <span className={entry.pending_review_count ? "font-semibold text-amber-700" : ""}>
            {entry.pending_review_count} 篇待批改
          </span>
          <span className="inline-flex items-center gap-2">
            <CalendarClock aria-hidden="true" size={16} />最近截止：{formatDateTime(dueDates[0] ?? null, "无")}
          </span>
          <span>布置：{formatDateTime(entry.created_at, "—")}</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {actions.canWithdraw ? (
          <button
            className="teacher-button-secondary"
            disabled={pending}
            onClick={() => onWithdraw(actionAssignmentId)}
            type="button"
          ><Undo2 aria-hidden="true" size={16} />撤回</button>
        ) : null}
        {actions.canEdit ? (
          <Link className="teacher-button-secondary" href={editHref}><Pencil aria-hidden="true" size={16} />编辑作业</Link>
        ) : null}
        {actions.canReactivate ? (
          <button className="teacher-button-primary" disabled={pending} onClick={() => onReactivate(actionAssignmentId)} type="button"><RotateCcw aria-hidden="true" size={16} />重新布置</button>
        ) : null}
        {actions.canSoftDelete ? (
          <button className="teacher-button-secondary text-student-error" disabled={pending} onClick={() => onSoftDelete(actionAssignmentId)} type="button"><Trash2 aria-hidden="true" size={16} />删除作业</button>
        ) : null}
        {actions.canEdit ? (
          <Link aria-label="查看作业详情" className="teacher-button-secondary px-3" href={detailHref}><ArrowRight aria-hidden="true" size={18} /></Link>
        ) : (
          <Link className="teacher-button-secondary" href={detailHref}>
            查看进度<ArrowRight aria-hidden="true" size={18} />
          </Link>
        )}
      </div>
    </article>
  );
}

function AssignmentProgressBadge({ assignment }: { assignment: WritingAssignmentSummary }) {
  const progress = getWritingAssignmentProgress({
    assignedCount: assignment.assigned_count,
    lifecycleStatus: assignment.status,
    publishedCount: assignment.published_count,
    submittedCount: assignment.completed_count
  });
  const className = progress.progress === "completed"
    ? "bg-emerald-50 text-emerald-700"
    : progress.progress === "withdrawn"
      ? "bg-slate-100 text-slate-600"
      : progress.progress === "ongoing"
        ? "bg-student-primary-soft text-student-primary"
        : "bg-amber-50 text-amber-700";
  return <span className={`rounded-full px-3 py-1 text-xs font-bold ${className}`}>{progress.label}</span>;
}

function formatDateTime(value: string | null, fallback: string) {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}
