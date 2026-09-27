"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  TEACHER_CLASSES_CACHE_KEY,
  TEACHER_CLASS_DETAIL_CACHE_PREFIX,
  TEACHER_CLASS_STUDENTS_CACHE_KEY,
  TEACHER_STATS_CACHE_KEY,
  TEACHER_WRITING_ASSIGNMENT_STUDENTS_CACHE_KEY,
  useTeacherCachedData,
  useTeacherDataCache
} from "@/components/TeacherDataCache";
import { TeacherSubjectFieldset } from "@/components/teacher/TeacherSubjectFieldset";
import {
  TeacherClassMemberEditor,
  applyDuplicateMemberIssues,
  type ClassMemberDraft
} from "@/components/teacher/TeacherClassMemberEditor";
import { publishCacheInvalidation } from "@/lib/cacheInvalidation";
import { teacherApiFetch } from "@/lib/teacherClientApi";
import type { StudentBindingDomain } from "@/lib/studentBindings";
import type { ClassStudentCandidate, TeacherClassSummary } from "@/lib/teacherClasses";

type CreateClassResponse = {
  class?: TeacherClassSummary;
  error?: string;
  code?: string;
  memberIndex?: number;
  members?: Array<{
    member_index: number;
    student_name: string;
    candidates: Array<{ id: string; displayName: string; email: string }>;
  }>;
};

/**
 * 新增班级 page body. Visual system and field styling copy the existing
 * 新增学生 page; the member editor mixes new accounts and already-bound
 * students and resolves same-name students inline.
 */
export function TeacherCreateClass() {
  const router = useRouter();
  const cache = useTeacherDataCache();
  const [name, setName] = useState("");
  const [subjects, setSubjects] = useState<StudentBindingDomain[]>([]);
  const [drafts, setDrafts] = useState<ClassMemberDraft[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const candidatesState = useTeacherCachedData<{ students: ClassStudentCandidate[] }>(
    TEACHER_CLASS_STUDENTS_CACHE_KEY,
    () => teacherApiFetch("/api/teacher/classes/students")
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    if (!name.trim()) return setError("请填写班级名称。");
    if (subjects.length === 0) return setError("请至少选择一个授课科目。");
    for (const draft of drafts) {
      if (draft.kind !== "new") continue;
      if (!draft.student_name.trim()) return setError("请填写新学生的姓名。");
      if (!draft.account.trim()) return setError("请填写新学生的账号。");
    }

    setSubmitting(true);
    try {
      const payload = await teacherApiFetch<CreateClassResponse>("/api/teacher/classes", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          subjects,
          members: drafts.map((draft) =>
            draft.kind === "existing"
              ? { kind: "existing", student_id: draft.student_id }
              : {
                  kind: "new",
                  student_name: draft.student_name.trim(),
                  account: draft.account.trim(),
                  account_edited: draft.account_edited,
                  confirm_duplicate_name: draft.confirmed_new === true
                }
          )
        })
      });

      const createdNewStudents = drafts.some((draft) => draft.kind === "new");
      cache.invalidate(TEACHER_CLASSES_CACHE_KEY);
      cache.invalidate(TEACHER_CLASS_DETAIL_CACHE_PREFIX);
      cache.invalidate(TEACHER_CLASS_STUDENTS_CACHE_KEY);
      if (createdNewStudents) {
        cache.invalidate(TEACHER_STATS_CACHE_KEY);
        cache.invalidate(TEACHER_WRITING_ASSIGNMENT_STUDENTS_CACHE_KEY);
        publishCacheInvalidation({ type: "TEACHER_BINDING_UPDATED" });
      }
      publishCacheInvalidation({ type: "CLASS_UPDATED" });
      router.push(`/teacher/classes/${encodeURIComponent(payload.class?.class_id ?? "")}`);
      router.refresh();
    } catch (submitError) {
      handleSubmitError(submitError);
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmitError(submitError: unknown) {
    const payload = extractErrorPayload(submitError);
    if (payload?.code === "DUPLICATE_MEMBERS" && (payload.members?.length ?? 0) > 0) {
      setDrafts((current) => applyDuplicateMemberIssues(current, payload.members ?? []));
      setError("已存在同名学生，请选择“绑定已有学生”或“继续新增”。");
      return;
    }
    setError(localizeClassError(payload?.error ?? (submitError instanceof Error ? submitError.message : "")));
  }

  return (
    <form className="teacher-card p-6 sm:p-8" onSubmit={submit}>
      <h2 className="text-xl font-bold text-student-text">创建班级</h2>
      <div className="mt-7 grid gap-6">
        <label className="grid gap-2.5 text-sm font-semibold text-student-text" htmlFor="class-name">
          班级名称
          <input
            className="h-14 w-full rounded-xl border border-student-border bg-white px-4 font-normal text-student-text placeholder:text-student-muted focus:border-student-primary"
            id="class-name"
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：周六写作班"
            required
            value={name}
          />
        </label>

        <TeacherSubjectFieldset onChange={setSubjects} value={subjects} />

        <div className="grid gap-3">
          <p className="text-sm font-semibold text-student-text">学生</p>
          <p className="text-sm text-student-muted">
            可以添加新学生，也可以选择已经绑定的学生，两种方式可以混合使用。
          </p>
          <TeacherClassMemberEditor
            candidates={candidatesState.data?.students ?? []}
            candidatesError={candidatesState.error ? localizeClassError(candidatesState.error) : ""}
            candidatesLoading={candidatesState.loading}
            disabled={submitting}
            drafts={drafts}
            onChange={setDrafts}
          />
        </div>
      </div>

      {error ? <p className="teacher-error mt-5">{error}</p> : null}

      <div className="mt-8 flex flex-wrap gap-3">
        <button className="teacher-button-primary min-w-36" disabled={submitting} type="submit">
          {submitting ? "正在创建..." : "创建班级"}
        </button>
        <Link className="teacher-button-secondary min-w-32" href="/teacher/dashboard">
          取消
        </Link>
      </div>
    </form>
  );
}

function extractErrorPayload(error: unknown) {
  if (!(error instanceof Error)) return null;
  // teacherApiFetch throws with the localized message only; the structured
  // payload is attached by the fetch helper when available.
  const payload = (error as Error & { payload?: CreateClassResponse }).payload;
  return payload ?? null;
}

function localizeClassError(message?: string) {
  if (!message) return "操作失败，请稍后重试。";
  if (/unauthorized|not authenticated/i.test(message)) return "登录状态已失效，请重新登录。";
  if (/forbidden|teacher role required/i.test(message)) return "当前账号没有教师端访问权限。";
  return /[\u3400-\u9fff]/.test(message) ? message : "操作失败，请稍后重试。";
}
