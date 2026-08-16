"use client";

import Link from "next/link";
import { useState } from "react";
import { AlertTriangle, ArrowRight, CalendarClock, Pencil, RotateCcw, Trash2, Undo2, Users } from "lucide-react";
import {
  TEACHER_WRITING_ASSIGNMENTS_CACHE_KEY,
  TEACHER_WRITING_ASSIGNMENTS_CACHE_PREFIX,
  useTeacherCachedData,
  useTeacherDataCache
} from "@/components/TeacherDataCache";
import {
  TeacherCard,
  TeacherDataError,
  TeacherEmptyState,
  TeacherLoadingRegion,
  TeacherSkeleton
} from "@/components/teacher/TeacherUI";
import { teacherApiFetch } from "@/lib/teacherClientApi";
import { WRITING_TASK_CONFIG } from "@/lib/writing";
import {
  writingAssignmentTitle,
  type WritingAssignmentSummary
} from "@/lib/writingAssignments";

const WITHDRAW_CONFIRM = "确认撤回这项作业？\n\n撤回后，学生将不能再通过该作业开始或继续未提交的练习。\n已经提交的作业和批改记录不会受到影响。";
const DELETE_CONFIRM = "确认删除这项作业？\n\n删除后，该作业将不再显示在正常作业列表中。\n学生已有提交和批改记录不会被删除。";

export function TeacherWritingAssignmentList() {
  const cache = useTeacherDataCache();
  const [pendingId, setPendingId] = useState("");
  const [mutationError, setMutationError] = useState("");
  const { data, error, loading } = useTeacherCachedData<{ assignments: WritingAssignmentSummary[] }>(
    TEACHER_WRITING_ASSIGNMENTS_CACHE_KEY,
    () => teacherApiFetch("/api/teacher/writing/assignments")
  );

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
    } catch (mutation) {
      setMutationError(mutation instanceof Error ? mutation.message : "作业操作失败。");
    } finally {
      setPendingId("");
    }
  }

  if (loading) {
    return <div className="grid gap-3" aria-busy="true"><TeacherLoadingRegion label="正在加载作业列表" />{[1, 2, 3].map((item) => <TeacherSkeleton className="h-32 w-full rounded-2xl" key={item} />)}</div>;
  }
  if (error) return <TeacherDataError text={error} />;
  if (!data?.assignments.length) {
    return <TeacherCard className="p-5"><TeacherEmptyState text="还没有写作作业。点击右上角“布置作业”开始。" /></TeacherCard>;
  }

  return (
    <div className="grid gap-3">
      {mutationError ? <TeacherDataError text={mutationError} /> : null}
      {data.assignments.map((assignment) => {
        const pending = pendingId === assignment.assignment_id;
        const detailHref = `/teacher/writing/assignments/${assignment.assignment_id}`;
        return (
          <article className="teacher-card flex flex-wrap items-center gap-5 p-5" key={assignment.assignment_id}>
            <Link className="group min-w-0 flex-1" href={detailHref}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-student-primary-soft px-3 py-1 text-xs font-bold text-student-primary">{WRITING_TASK_CONFIG[assignment.task_type].label}</span>
                <span className="rounded-full border border-student-border px-3 py-1 text-xs font-semibold text-student-muted">{assignment.question_source === "custom" ? "自定义" : "题库"}</span>
                <LifecycleBadge status={assignment.status} />
                {assignment.has_overdue_students ? <span className="inline-flex items-center gap-1 rounded-full bg-student-error-soft px-3 py-1 text-xs font-semibold text-student-error"><AlertTriangle aria-hidden="true" size={13} />存在逾期未完成</span> : null}
              </div>
              <h2 className="mt-3 truncate text-lg font-bold text-student-text">{writingAssignmentTitle(assignment.question_snapshot)}</h2>
              <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-student-muted">
                <span className="inline-flex items-center gap-2"><Users aria-hidden="true" size={16} />{assignment.assigned_count} 名学生 · {assignment.completed_count} 人已完成</span>
                <span className="inline-flex items-center gap-2"><CalendarClock aria-hidden="true" size={16} />截止：{formatDateTime(assignment.due_at, "无")}</span>
                <span>布置：{formatDateTime(assignment.created_at, "—")}</span>
              </div>
            </Link>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {assignment.status === "active" ? (
                <button className="teacher-button-secondary" disabled={pending} onClick={() => void mutate(assignment.assignment_id, "withdraw")} type="button"><Undo2 aria-hidden="true" size={16} />撤回</button>
              ) : (
                <>
                  <Link className="teacher-button-secondary" href={`${detailHref}/edit`}><Pencil aria-hidden="true" size={16} />编辑作业</Link>
                  <button className="teacher-button-primary" disabled={pending} onClick={() => void mutate(assignment.assignment_id, "reactivate")} type="button"><RotateCcw aria-hidden="true" size={16} />重新布置</button>
                  <button className="teacher-button-secondary text-student-error" disabled={pending} onClick={() => void mutate(assignment.assignment_id, "soft_delete")} type="button"><Trash2 aria-hidden="true" size={16} />删除作业</button>
                </>
              )}
              <Link aria-label="查看作业详情" className="teacher-button-secondary px-3" href={detailHref}><ArrowRight aria-hidden="true" size={18} /></Link>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function LifecycleBadge({ status }: { status: WritingAssignmentSummary["status"] }) {
  return <span className={`rounded-full px-3 py-1 text-xs font-bold ${status === "active" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>{status === "active" ? "进行中" : "已撤回"}</span>;
}

function formatDateTime(value: string | null, fallback: string) {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}
