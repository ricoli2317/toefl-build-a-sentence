"use client";

import { teacherApiFetch } from "@/lib/teacherClientApi";
import type { StudentBindingDomain } from "@/lib/studentBindings";

/**
 * Shared client requests for the two per-student binding entry points: the
 * student detail 「修改授课科目」 dialog and the home student list badges.
 * Both go through the same API routes, so the mutation always targets the
 * authenticated teacher's own teacher_student_bindings row.
 */

export type StudentBindingMutationPayload = {
  studentId?: string;
  created?: StudentBindingDomain[];
  alreadyBound?: StudentBindingDomain[];
  domain?: StudentBindingDomain;
  removed?: boolean;
  message?: string;
  code?: string;
};

export async function addStudentBindingDomains(
  studentId: string,
  domains: readonly StudentBindingDomain[]
) {
  return teacherApiFetch<StudentBindingMutationPayload>("/api/teacher/student-bindings", {
    method: "POST",
    body: JSON.stringify({ studentId, domains })
  });
}

export async function removeStudentBindingDomain(
  studentId: string,
  domain: StudentBindingDomain
) {
  const params = new URLSearchParams({ studentId, domain });
  return teacherApiFetch<StudentBindingMutationPayload>(
    `/api/teacher/student-bindings?${params.toString()}`,
    { method: "DELETE" }
  );
}

export function studentBindingErrorMessage(error: unknown, fallback: string) {
  const message =
    error instanceof Error
      ? error.message
      : "";
  if (!message) return fallback;
  if (/unauthorized|not authenticated/i.test(message)) return "登录状态已失效，请重新登录。";
  if (/forbidden|teacher role required/i.test(message)) return "当前账号没有教师端访问权限。";
  if (/已绑定/.test(message)) return "该科目已经绑定。";
  return /[\u3400-\u9fff]/.test(message) ? message : fallback;
}
