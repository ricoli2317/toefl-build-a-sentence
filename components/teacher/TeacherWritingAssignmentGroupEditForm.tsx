"use client";

import {
  TEACHER_WRITING_ASSIGNMENTS_CACHE_PREFIX,
  useTeacherCachedData
} from "@/components/TeacherDataCache";
import {
  TeacherDataError,
  TeacherLoadingRegion,
  TeacherSkeleton
} from "@/components/teacher/TeacherUI";
import { TeacherWritingAssignmentForm } from "@/components/teacher/TeacherWritingAssignmentForm";
import { teacherApiFetch } from "@/lib/teacherClientApi";
import type { WritingAssignmentCollectionDetail } from "@/lib/writingAssignments";

/**
 * Whole-group edit for a withdrawn Assignment Group.
 *
 * There is deliberately no second edit UI: the loader only resolves the
 * persisted group and hands it to the one shared Assignment wizard, which is
 * seeded with the original items, recipients, title and deadline. 撤回 already
 * guarantees the group has no attempt at all, so the wizard keeps its full
 * power (add / remove / re-type items, change students or class).
 */
export function TeacherWritingAssignmentGroupEditForm({
  batchId,
  returnTo
}: {
  batchId: string;
  returnTo?: string;
}) {
  const cacheKey = `${TEACHER_WRITING_ASSIGNMENTS_CACHE_PREFIX}:collection:${batchId}`;
  const state = useTeacherCachedData<{ collection: WritingAssignmentCollectionDetail }>(
    cacheKey,
    () => teacherApiFetch(`/api/teacher/writing/assignments/batches/${encodeURIComponent(batchId)}`),
    { refreshOnMount: true }
  );

  if (state.loading) {
    return (
      <div className="grid gap-4" aria-busy="true">
        <TeacherLoadingRegion label="正在加载作业组" />
        <TeacherSkeleton className="h-40 w-full rounded-2xl" />
        <TeacherSkeleton className="h-80 w-full rounded-2xl" />
      </div>
    );
  }
  if (state.error || !state.data?.collection?.assignments?.length) {
    return <TeacherDataError text={state.error || "未找到这项写作作业。"} />;
  }
  if (state.data.collection.assignments.some((assignment) => assignment.status !== "withdrawn")) {
    return <TeacherDataError text="只有已撤回的作业可以编辑。" />;
  }
  return (
    <TeacherWritingAssignmentForm
      initialCollection={state.data.collection}
      returnTo={returnTo}
    />
  );
}
