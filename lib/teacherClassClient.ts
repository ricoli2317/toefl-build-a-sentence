"use client";

import {
  TEACHER_CLASS_DETAIL_CACHE_PREFIX,
  TEACHER_CLASSES_CACHE_KEY
} from "@/components/TeacherDataCache";
import { publishCacheInvalidation } from "@/lib/cacheInvalidation";
import type { StudentBindingDomain } from "@/lib/studentBindings";
import type { TeacherClassDetail, TeacherClassSummary } from "@/lib/teacherClasses";
import { teacherApiFetch } from "@/lib/teacherClientApi";

/**
 * Shared client helper for the class subject entry points: the class detail
 * 「修改授课科目」 modal and the home class list quick badges. Both send the
 * same PATCH request, so the mutation always goes through the same
 * updateTeacherClassSubjects server helper (class subjects only; removing a
 * subject never releases a member's binding).
 */

export type TeacherClassMutationPayload = {
  class?: TeacherClassSummary;
  detail?: TeacherClassDetail;
  error?: string;
  code?: string;
  memberIndex?: number;
  members?: Array<{
    member_index: number;
    student_name: string;
    candidates: Array<{ id: string; displayName: string; email: string }>;
  }>;
};

/** Minimal view of the shared teacher data cache this helper mutates. */
export type TeacherClassCacheWriter = {
  getEntry: (key: string) => { status: string; data?: unknown } | undefined;
  set: <T>(key: string, data: T) => void;
};

export async function updateTeacherClassSubjectsRequest(
  classId: string,
  subjects: readonly StudentBindingDomain[]
) {
  return teacherApiFetch<TeacherClassMutationPayload>(
    `/api/teacher/classes/${encodeURIComponent(classId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ subjects })
    }
  );
}

/**
 * Applies a class subject mutation to the local caches: dependent surfaces
 * (class reviews, assignment cards, binding-derived lists) are invalidated,
 * then the class list row and the class detail entry are re-seeded with the
 * response so the current screen updates without a loading flash.
 */
export function applyClassSubjectsMutation(
  cache: TeacherClassCacheWriter,
  payload: TeacherClassMutationPayload
) {
  const detail = payload.detail;
  const summary = detail?.class ?? payload.class;
  if (!summary) return;

  const listEntry = cache.getEntry(TEACHER_CLASSES_CACHE_KEY);
  const listData =
    (listEntry?.status === "success" || listEntry?.status === "refreshing") &&
    listEntry.data &&
    typeof listEntry.data === "object" &&
    "classes" in listEntry.data
      ? (listEntry.data as { classes: TeacherClassSummary[] })
      : null;

  publishCacheInvalidation({ type: "CLASS_UPDATED" });
  // A subject addition backfills member bindings, so binding-derived surfaces
  // must refresh too.
  publishCacheInvalidation({ type: "TEACHER_BINDING_UPDATED" });

  if (listData) {
    cache.set<{ classes: TeacherClassSummary[] }>(TEACHER_CLASSES_CACHE_KEY, {
      ...listData,
      classes: listData.classes.map((entry) =>
        entry.class_id === summary.class_id ? summary : entry
      )
    });
  }
  if (detail) {
    cache.set<{ detail: TeacherClassDetail }>(
      `${TEACHER_CLASS_DETAIL_CACHE_PREFIX}:${summary.class_id}`,
      { detail }
    );
  }
}
