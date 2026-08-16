"use client";

import {
  TEACHER_WRITING_ASSIGNMENTS_CACHE_PREFIX,
  useTeacherCachedData
} from "@/components/TeacherDataCache";
import { TeacherDataError, TeacherLoadingRegion, TeacherSkeleton } from "@/components/teacher/TeacherUI";
import { TeacherWritingAssignmentForm } from "@/components/teacher/TeacherWritingAssignmentForm";
import { teacherApiFetch } from "@/lib/teacherClientApi";
import type { WritingAssignmentDetail } from "@/lib/writingAssignments";

export function TeacherWritingAssignmentEditForm({ assignmentId }: { assignmentId: string }) {
  const cacheKey = `${TEACHER_WRITING_ASSIGNMENTS_CACHE_PREFIX}:detail:${assignmentId}`;
  const { data, error, loading } = useTeacherCachedData<{ assignment: WritingAssignmentDetail }>(
    cacheKey,
    () => teacherApiFetch(`/api/teacher/writing/assignments/${encodeURIComponent(assignmentId)}`)
  );

  if (loading) {
    return <div className="grid gap-4" aria-busy="true"><TeacherLoadingRegion label="正在加载作业编辑器" /><TeacherSkeleton className="h-64 w-full rounded-2xl" /><TeacherSkeleton className="h-64 w-full rounded-2xl" /></div>;
  }
  if (error || !data) return <TeacherDataError text={error || "无法加载作业。"} />;
  if (data.assignment.status !== "withdrawn") {
    return <TeacherDataError text="只有已撤回的作业可以编辑。" />;
  }
  return <TeacherWritingAssignmentForm initialAssignment={data.assignment} />;
}
