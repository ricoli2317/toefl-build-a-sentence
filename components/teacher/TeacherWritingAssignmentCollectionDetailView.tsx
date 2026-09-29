"use client";

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
  type WritingAssignmentCollectionDetail
} from "@/lib/writingAssignments";
import {
  teacherAssignmentBatchDetailHref,
  teacherReturnToHref
} from "@/lib/teacherNavigation";

/**
 * Assignment Group detail. It shares the exact body with the legacy single
 * detail: the Assignment header card plus one student completion card per
 * recipient, with one table row per assignment inside each card.
 */
export function TeacherWritingAssignmentCollectionDetailView({
  collectionId,
  returnTo
}: {
  collectionId: string;
  returnTo?: string;
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
  const detailHref = teacherReturnToHref(
    teacherAssignmentBatchDetailHref(collectionId),
    returnTo
  );
  const allWithdrawn = collection.assignments.every(
    (assignment) => assignment.status === "withdrawn"
  );
  const dueDates = collection.assignments
    .flatMap((assignment) => assignment.due_at ? [assignment.due_at] : [])
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  const collectionTitle = collection.title?.trim()
    || `${collection.assignments[0].display_name || writingAssignmentTitle(collection.assignments[0].question_snapshot)} 等 ${collection.assignments.length} 篇写作`;

  return (
    <TeacherWritingAssignmentDetailBody
      assignments={collection.assignments}
      completedCount={collection.completed_count}
      createdAt={collection.created_at}
      dueAt={dueDates[0] ?? null}
      lifecycleStatus={allWithdrawn ? "withdrawn" : "active"}
      onRefresh={() => cache.invalidate(cacheKey)}
      refreshing={refreshing}
      returnTo={detailHref}
      title={collectionTitle}
      totalCount={collection.total_count}
    />
  );
}
