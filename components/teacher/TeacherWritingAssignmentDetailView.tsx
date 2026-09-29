"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Pencil, RotateCcw, Trash2, Undo2 } from "lucide-react";
import {
  TEACHER_WRITING_ASSIGNMENTS_CACHE_PREFIX,
  useTeacherCachedData,
  useTeacherDataCache
} from "@/components/TeacherDataCache";
import {
  TeacherDataError,
  TeacherLoadingRegion,
  TeacherSkeleton
} from "@/components/teacher/TeacherUI";
import { TeacherWritingAssignmentDetailBody } from "@/components/teacher/TeacherWritingAssignmentDetailBody";
import { teacherApiFetch } from "@/lib/teacherClientApi";
import {
  writingAssignmentTitle,
  type WritingAssignmentDetail
} from "@/lib/writingAssignments";
import {
  teacherAssignmentDetailHref,
  teacherReturnToHref,
  TEACHER_ASSIGNMENTS_HREF
} from "@/lib/teacherNavigation";
import { publishCacheInvalidation } from "@/lib/cacheInvalidation";

/**
 * Legacy single-assignment detail. It renders the exact same body as the
 * Assignment Group detail: the Assignment header card plus one student
 * completion card per recipient, and keeps only its assignment-level lifecycle
 * actions on top of that shared structure.
 */
export function TeacherWritingAssignmentDetailView({
  assignmentId,
  returnTo
}: {
  assignmentId: string;
  returnTo?: string;
}) {
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
  const assignmentDetailHref = teacherReturnToHref(
    teacherAssignmentDetailHref(assignmentId),
    returnTo
  );
  const assignmentTitle = assignment.group_title?.trim()
    || assignment.display_name || writingAssignmentTitle(assignment.question_snapshot);

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
      publishCacheInvalidation({
        type: "ASSIGNMENT_UPDATED",
        assignmentId,
        assignmentQuestionSource: assignment.question_source
      });
      if (action === "soft_delete") {
        router.push(returnTo || TEACHER_ASSIGNMENTS_HREF);
        router.refresh();
      }
    } catch (mutation) {
      setMutationError(mutation instanceof Error ? mutation.message : "作业操作失败。");
    } finally {
      setMutating(false);
    }
  }

  return (
    <TeacherWritingAssignmentDetailBody
      actions={
        <>
          {assignment.status === "active" ? (!assignment.has_attempts ? <button className="teacher-button-secondary" disabled={mutating} onClick={() => void mutate("withdraw")} type="button"><Undo2 aria-hidden="true" size={16} />撤回</button> : null) : <><Link className="teacher-button-secondary" href={teacherReturnToHref(`${teacherAssignmentDetailHref(assignmentId)}/edit`, returnTo)}><Pencil aria-hidden="true" size={16} />编辑作业</Link><button className="teacher-button-primary" disabled={mutating} onClick={() => void mutate("reactivate")} type="button"><RotateCcw aria-hidden="true" size={16} />重新布置</button><button className="teacher-button-secondary text-student-error" disabled={mutating} onClick={() => void mutate("soft_delete")} type="button"><Trash2 aria-hidden="true" size={16} />删除作业</button></>}
        </>
      }
      assignments={[assignment]}
      completedCount={assignment.completed_count}
      createdAt={assignment.created_at}
      dueAt={assignment.due_at}
      errorText={mutationError}
      lifecycleStatus={assignment.status}
      onRefresh={() => cache.invalidate(cacheKey)}
      refreshing={mutating}
      returnTo={assignmentDetailHref}
      title={assignmentTitle}
      totalCount={assignment.assigned_count}
    />
  );
}
