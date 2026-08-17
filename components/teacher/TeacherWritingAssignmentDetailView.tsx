"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Pencil, RefreshCw, RotateCcw, Trash2, Undo2 } from "lucide-react";
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
import { WritingAssignmentQuestionPreview } from "@/components/teacher/WritingAssignmentQuestionPreview";
import { teacherApiFetch } from "@/lib/teacherClientApi";
import { WRITING_TASK_CONFIG } from "@/lib/writing";
import {
  getWritingAssignmentReviewAction,
  getWritingAssignmentProgress,
  writingAssignmentStatusLabel,
  writingAssignmentTitle,
  type WritingAssignmentDetail,
  type WritingAssignmentStudentDetail,
  type WritingAssignmentStudentStatus
} from "@/lib/writingAssignments";
import { teacherWritingReviewWorkspaceHref } from "@/lib/teacherWritingReviewNavigation";

export function TeacherWritingAssignmentDetailView({ assignmentId }: { assignmentId: string }) {
  const router = useRouter();
  const cache = useTeacherDataCache();
  const [mutating, setMutating] = useState(false);
  const [mutationError, setMutationError] = useState("");
  const cacheKey = `${TEACHER_WRITING_ASSIGNMENTS_CACHE_PREFIX}:detail:${assignmentId}`;
  const { data, error, loading } = useTeacherCachedData<{ assignment: WritingAssignmentDetail }>(
    cacheKey,
    () => teacherApiFetch(`/api/teacher/writing/assignments/${encodeURIComponent(assignmentId)}`)
  );

  if (loading) {
    return <div className="grid gap-4" aria-busy="true"><TeacherLoadingRegion label="正在加载作业详情" /><TeacherSkeleton className="h-36 w-full rounded-2xl" /><TeacherSkeleton className="h-80 w-full rounded-2xl" /></div>;
  }
  if (error || !data) return <TeacherDataError text={error || "无法加载作业详情。"} />;
  const assignment = data.assignment;
  const assignmentDetailHref = `/teacher/writing/assignments/${assignmentId}`;
  const assignmentProgress = getWritingAssignmentProgress({
    assignedCount: assignment.assigned_count,
    lifecycleStatus: assignment.status,
    publishedCount: assignment.published_count,
    submittedCount: assignment.completed_count
  });

  async function mutate(action: "withdraw" | "reactivate" | "soft_delete") {
    if (action === "withdraw" && !window.confirm("确认撤回这项作业？\n\n撤回后，学生将不能再通过该作业开始或继续未提交的练习。\n已经提交的作业和批改记录不会受到影响。")) return;
    if (action === "soft_delete" && !window.confirm("确认删除这项作业？\n\n删除后，该作业将不再显示在正常作业列表中。\n学生已有提交和批改记录不会被删除。")) return;
    setMutating(true);
    setMutationError("");
    try {
      await teacherApiFetch(`/api/teacher/writing/assignments/${encodeURIComponent(assignmentId)}`, {
        method: "PATCH",
        body: JSON.stringify({ action })
      });
      cache.invalidate(TEACHER_WRITING_ASSIGNMENTS_CACHE_PREFIX);
      if (action === "soft_delete") {
        router.push("/teacher/writing/assignments");
        router.refresh();
      }
    } catch (mutation) {
      setMutationError(mutation instanceof Error ? mutation.message : "作业操作失败。");
      cache.invalidate(TEACHER_WRITING_ASSIGNMENTS_CACHE_PREFIX);
    } finally {
      setMutating(false);
    }
  }

  return (
    <div className="grid gap-5">
      <TeacherCard className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap gap-2">
              <span className="rounded-full bg-student-primary-soft px-3 py-1 text-xs font-bold text-student-primary">{WRITING_TASK_CONFIG[assignment.task_type].label}</span>
              <span className="rounded-full border border-student-border px-3 py-1 text-xs font-semibold text-student-muted">{assignment.question_source === "custom" ? "自定义题目" : "题库题目"}</span>
              <span className={`rounded-full px-3 py-1 text-xs font-bold ${assignmentProgress.progress === "completed" ? "bg-emerald-50 text-emerald-700" : assignmentProgress.progress === "withdrawn" ? "bg-slate-100 text-slate-600" : assignmentProgress.progress === "ongoing" ? "bg-student-primary-soft text-student-primary" : "bg-amber-50 text-amber-700"}`}>{assignmentProgress.label}</span>
            </div>
            <h2 className="mt-3 text-xl font-bold text-student-text">{writingAssignmentTitle(assignment.question_snapshot)}</h2>
            <p className="mt-2 text-sm text-student-muted">布置：{formatDate(assignment.created_at)} · 截止：{assignment.due_at ? formatDate(assignment.due_at) : "无"} · {assignment.completed_count}/{assignment.assigned_count} 已提交 · {assignment.published_count}/{assignment.assigned_count} 已发布</p>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {assignment.status === "active" ? (!assignment.has_attempts ? <button className="teacher-button-secondary" disabled={mutating} onClick={() => void mutate("withdraw")} type="button"><Undo2 aria-hidden="true" size={16} />撤回</button> : null) : <><Link className="teacher-button-secondary" href={`/teacher/writing/assignments/${assignmentId}/edit`}><Pencil aria-hidden="true" size={16} />编辑作业</Link><button className="teacher-button-primary" disabled={mutating} onClick={() => void mutate("reactivate")} type="button"><RotateCcw aria-hidden="true" size={16} />重新布置</button><button className="teacher-button-secondary text-student-error" disabled={mutating} onClick={() => void mutate("soft_delete")} type="button"><Trash2 aria-hidden="true" size={16} />删除作业</button></>}
            <button className="teacher-button-secondary" disabled={mutating} onClick={() => cache.invalidate(cacheKey)} type="button"><RefreshCw aria-hidden="true" size={16} />刷新状态</button>
          </div>
        </div>
      </TeacherCard>

      {mutationError ? <TeacherDataError text={mutationError} /> : null}

      <TeacherCard className="grid gap-4 p-5">
        <TeacherSectionTitle>题目预览</TeacherSectionTitle>
        <WritingAssignmentQuestionPreview question={assignment.question_snapshot} questionSource={assignment.question_source} taskType={assignment.task_type} />
      </TeacherCard>

      <TeacherCard className="grid gap-4 p-5">
        <div className="flex items-center justify-between gap-3"><TeacherSectionTitle>学生完成情况</TeacherSectionTitle><span className="text-sm font-medium text-student-muted">共 {assignment.students.length} 人</span></div>
        <div className="overflow-x-auto rounded-xl border border-student-border">
          <table className="w-full min-w-[760px] border-collapse text-left text-sm">
            <thead className="bg-student-bg text-student-muted"><tr><th className="px-4 py-3 font-semibold">学生姓名</th><th className="px-4 py-3 font-semibold">账号</th><th className="px-4 py-3 font-semibold">状态</th><th className="px-4 py-3 font-semibold">首次提交时间</th><th className="px-4 py-3 text-right font-semibold">操作</th></tr></thead>
            <tbody className="divide-y divide-student-border">
              {assignment.students.map((student) => (
                <tr key={student.student_id}>
                  <td className="px-4 py-3 font-semibold text-student-text">{student.student_name}</td>
                  <td className="px-4 py-3 text-student-muted">{student.student_email || "—"}</td>
                  <td className="px-4 py-3"><StatusBadge status={student.status} /></td>
                  <td className="px-4 py-3 text-student-muted">{student.first_submitted_at ? formatDate(student.first_submitted_at) : "—"}</td>
                  <td className="px-4 py-3 text-right"><StudentReviewAction returnTo={assignmentDetailHref} student={student} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </TeacherCard>
    </div>
  );
}

function StudentReviewAction({
  returnTo,
  student
}: {
  returnTo: string;
  student: WritingAssignmentStudentDetail;
}) {
  const action = getWritingAssignmentReviewAction({
    latestSubmittedAttemptId: student.latest_submitted_attempt_id,
    latestReviewStatus: student.latest_review_status
  });
  if (!action) return <span className="text-student-muted">—</span>;
  return (
    <Link
      className="text-sm font-semibold leading-6 text-student-primary underline-offset-4 hover:text-student-primary-hover hover:underline"
      href={teacherWritingReviewWorkspaceHref(action.attemptId, returnTo)}
    >
      {action.label}
    </Link>
  );
}

function StatusBadge({ status }: { status: WritingAssignmentStudentStatus }) {
  const className = status === "completed"
    ? "bg-emerald-50 text-emerald-700"
    : status === "pending"
      ? "bg-student-primary-soft text-student-primary"
      : "bg-student-error-soft text-student-error";
  return <span className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ${className}`}>{writingAssignmentStatusLabel(status)}</span>;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}
