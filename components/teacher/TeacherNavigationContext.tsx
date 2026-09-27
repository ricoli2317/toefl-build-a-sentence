"use client";

import {
  TEACHER_CLASSES_CACHE_KEY,
  useTeacherCachedData
} from "@/components/TeacherDataCache";
import { teacherApiFetch } from "@/lib/teacherClientApi";
import type { TeacherClassSummary } from "@/lib/teacherClasses";

/**
 * Resolves the class name for a class-context breadcrumb (student detail and
 * its drill-down pages). The classes list is the same cached payload the home
 * class tab uses, so opening a student from a class never triggers a per-class
 * request; a direct URL with class context loads the list once.
 */
export function useTeacherClassDisplayName(classId: string) {
  const enabled = classId !== "";
  const { data } = useTeacherCachedData<{ classes: TeacherClassSummary[] }>(
    TEACHER_CLASSES_CACHE_KEY,
    () => teacherApiFetch("/api/teacher/classes"),
    { enabled }
  );
  if (!enabled) return "";
  return data?.classes.find((entry) => entry.class_id === classId)?.name?.trim() ?? "";
}
