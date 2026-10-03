"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Search, UserRound, UsersRound } from "lucide-react";
import clsx from "clsx";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { publishCacheInvalidation } from "@/lib/cacheInvalidation";
import { useCurrentAccount } from "@/components/RoleGate";
import {
  TeacherCard,
  TeacherEmptyState,
  TeacherSectionTitle
} from "@/components/teacher/TeacherUI";
import { formatAccountForDisplay } from "@/lib/accountIdentifier";
import {
  STUDENT_BINDING_DOMAINS,
  STUDENT_BINDING_DOMAIN_LABELS,
  formatBindingDomainList,
  normalizeBindingDomains,
  type StudentBindingDomain
} from "@/lib/studentBindings";
import type { TeacherClassSearchResult } from "@/lib/teacherClasses";
import type { StudentBindingCandidate } from "@/lib/teacherStudentBindings";

type SearchResponse = {
  students?: StudentBindingCandidate[];
  classes?: TeacherClassSearchResult[];
  message?: string;
};
type BindResponse = {
  created?: StudentBindingDomain[];
  alreadyBound?: StudentBindingDomain[];
  message?: string;
  code?: string;
};
type ClassBindResponse = {
  classId?: string;
  alreadyBound?: boolean;
  createdBindingCount?: number;
  message?: string;
  code?: string;
};

type Selection = { kind: "student"; id: string } | { kind: "class"; id: string };

async function authorizedFetch(input: string, init?: RequestInit) {
  const supabase = createBrowserSupabase();
  const { data: { session } } = await supabase.auth.getSession();
  return fetch(input, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.access_token ?? ""}`,
      ...init?.headers
    },
    cache: "no-store"
  });
}

/**
 * Teacher self-service binding for an existing student or class. The current
 * binding teachers and subjects shown here come exclusively from
 * teacher_student_bindings joined to the teacher profile; the legacy account
 * ownership column is never used. Classes are bound through
 * teacher_class_bindings + the bind_teacher_to_class RPC, which links the
 * class and backfills only the caller's missing subject bindings.
 */
export function TeacherBindStudent({
  initialDomains = [],
  initialQuery = "",
  initialStudentId = ""
}: {
  initialDomains?: StudentBindingDomain[];
  initialQuery?: string;
  initialStudentId?: string;
}) {
  const { userId } = useCurrentAccount();
  const [query, setQuery] = useState(initialQuery);
  const [students, setStudents] = useState<StudentBindingCandidate[]>([]);
  const [classes, setClasses] = useState<TeacherClassSearchResult[]>([]);
  const [selection, setSelection] = useState<Selection | null>(
    initialStudentId ? { kind: "student", id: initialStudentId } : null
  );
  const [selectedDomains, setSelectedDomains] = useState<StudentBindingDomain[]>(
    normalizeBindingDomains(initialDomains)
  );
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [searched, setSearched] = useState(false);
  const lastSearchRef = useRef<{ q: string; studentId: string }>({
    q: initialQuery,
    studentId: initialStudentId
  });
  const selectionRef = useRef<Selection | null>(
    initialStudentId ? { kind: "student", id: initialStudentId } : null
  );
  const preferredDomainsRef = useRef<StudentBindingDomain[]>(
    normalizeBindingDomains(initialDomains)
  );

  const selectedStudent = useMemo(
    () =>
      selection?.kind === "student"
        ? students.find((student) => student.id === selection.id) ?? null
        : null,
    [students, selection]
  );
  const selectedClass = useMemo(
    () =>
      selection?.kind === "class"
        ? classes.find((entry) => entry.class_id === selection.id) ?? null
        : null,
    [classes, selection]
  );

  const boundDomains = useMemo(() => {
    if (!selectedStudent) return [] as StudentBindingDomain[];
    const bound = new Set<StudentBindingDomain>();
    for (const binding of selectedStudent.bindings) {
      if (binding.teacherId !== userId) continue;
      for (const domain of binding.domains) bound.add(domain);
    }
    return STUDENT_BINDING_DOMAINS.filter((domain) => bound.has(domain));
  }, [selectedStudent, userId]);

  const clearSelection = useCallback(() => {
    selectionRef.current = null;
    setSelection(null);
  }, []);

  const selectStudent = useCallback((student: StudentBindingCandidate) => {
    const next: Selection = { kind: "student", id: student.id };
    selectionRef.current = next;
    setSelection(next);
    setNotice("");
    setError("");
    const bound = new Set<StudentBindingDomain>();
    for (const binding of student.bindings) {
      if (binding.teacherId !== userId) continue;
      for (const domain of binding.domains) bound.add(domain);
    }
    setSelectedDomains(
      preferredDomainsRef.current.filter((domain) => !bound.has(domain))
    );
  }, [userId]);

  const selectClass = useCallback((entry: TeacherClassSearchResult) => {
    const next: Selection = { kind: "class", id: entry.class_id };
    selectionRef.current = next;
    setSelection(next);
    setNotice("");
    setError("");
  }, []);

  const search = useCallback(async (request: { q: string; studentId: string }, keepSelection = false) => {
    const trimmedQuery = request.q.trim();
    const studentId = request.studentId.trim();
    lastSearchRef.current = { q: trimmedQuery, studentId };
    if (!trimmedQuery && !studentId) {
      setStudents([]);
      setClasses([]);
      clearSelection();
      setSearched(false);
      return;
    }
    setSearching(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (trimmedQuery) params.set("q", trimmedQuery);
      if (studentId) params.set("studentId", studentId);
      const response = await authorizedFetch(`/api/teacher/students/search?${params.toString()}`);
      const payload = await response.json().catch(() => ({})) as SearchResponse;
      if (!response.ok) {
        setError(payload.message ?? "搜索失败，请稍后重试。");
        setStudents([]);
        setClasses([]);
        return;
      }
      const studentResults = payload.students ?? [];
      const classResults = payload.classes ?? [];
      setStudents(studentResults);
      setClasses(classResults);
      setSearched(true);

      const current = selectionRef.current;
      if (studentId) {
        const target = studentResults.find((student) => student.id === studentId);
        if (target) selectStudent(target);
        else clearSelection();
      } else if (studentResults.length === 1 && classResults.length === 0) {
        selectStudent(studentResults[0]);
      } else if (keepSelection && current) {
        if (current.kind === "student") {
          const keep = studentResults.find((student) => student.id === current.id);
          if (keep) selectStudent(keep);
          else clearSelection();
        } else {
          const keep = classResults.find((entry) => entry.class_id === current.id);
          if (keep) selectClass(keep);
          else clearSelection();
        }
      } else {
        clearSelection();
      }
    } catch {
      setError("搜索失败，请稍后重试。");
      setStudents([]);
      setClasses([]);
    } finally {
      setSearching(false);
    }
  }, [clearSelection, selectClass, selectStudent]);

  useEffect(() => {
    if (initialStudentId || initialQuery) {
      void search({ q: initialQuery, studentId: initialStudentId });
    }
    // The initial search runs once for the URL-provided search context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submitStudentBinding() {
    if (!selectedStudent || submitting) return;
    const domains = selectedDomains.filter((domain) => !boundDomains.includes(domain));
    if (domains.length === 0) return;
    setSubmitting(true);
    setError("");
    setNotice("");
    try {
      const response = await authorizedFetch("/api/teacher/student-bindings", {
        method: "POST",
        body: JSON.stringify({ studentId: selectedStudent.id, domains })
      });
      const payload = await response.json().catch(() => ({})) as BindResponse;
      if (!response.ok) {
        setError(payload.message ?? "绑定失败，请稍后重试。");
        return;
      }
      setNotice(
        `已为 ${selectedStudent.displayName} 绑定${formatBindingDomainList(payload.created ?? domains)}。`
      );
      preferredDomainsRef.current = [];
      publishCacheInvalidation({ type: "TEACHER_BINDING_UPDATED" });
      await search(lastSearchRef.current, true);
    } catch {
      setError("绑定失败，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitClassBinding() {
    if (!selectedClass || selectedClass.bound || submitting) return;
    setSubmitting(true);
    setError("");
    setNotice("");
    try {
      const response = await authorizedFetch("/api/teacher/class-bindings", {
        method: "POST",
        body: JSON.stringify({ classId: selectedClass.class_id })
      });
      const payload = await response.json().catch(() => ({})) as ClassBindResponse;
      if (!response.ok) {
        setError(payload.message ?? "绑定失败，请稍后重试。");
        return;
      }
      setNotice(
        payload.alreadyBound
          ? `班级「${selectedClass.name}」已绑定。`
          : `已为班级「${selectedClass.name}」建立授课绑定。`
      );
      publishCacheInvalidation({ type: "TEACHER_BINDING_UPDATED" });
      await search(lastSearchRef.current, true);
    } catch {
      setError("绑定失败，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  const allDomainsBound = Boolean(selectedStudent) && boundDomains.length === STUDENT_BINDING_DOMAINS.length;
  const pendingDomains = selectedDomains.filter((domain) => !boundDomains.includes(domain));
  const canSubmitStudent =
    Boolean(selectedStudent) && !allDomainsBound && pendingDomains.length > 0 && !submitting;
  const resultCount = students.length + classes.length;

  return (
    <div className="grid gap-6">
      <TeacherCard className="p-5 sm:p-6">
        <TeacherSectionTitle>绑定已有学生/班级</TeacherSectionTitle>
        <p className="mt-2 text-sm text-student-muted">
          按学生姓名、账号或班级名称搜索，找到学生或班级后建立相应授课绑定。绑定不会改变学生的账号归属，也不占用新增学生额度。
        </p>
        <div className="mt-5 flex flex-wrap items-end gap-3">
          <label className="relative block w-full max-w-[520px]" htmlFor="bind-student-query">
            <span className="sr-only">搜索学生或班级</span>
            <Search
              aria-hidden="true"
              className="absolute left-4 top-1/2 -translate-y-1/2 text-student-muted"
              size={20}
              strokeWidth={1.9}
            />
            <input
              className="h-12 w-full rounded-xl border border-student-border bg-white pl-12 pr-4 text-sm text-student-text placeholder:text-student-muted focus:border-student-primary"
              id="bind-student-query"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void search({ q: query, studentId: "" });
                }
              }}
              placeholder="输入学生姓名、账号或班级名称"
              value={query}
            />
          </label>
          <button
            className="teacher-button-primary min-w-28"
            disabled={searching || !query.trim()}
            onClick={() => void search({ q: query, studentId: "" })}
            type="button"
          >
            {searching ? "搜索中..." : "搜索"}
          </button>
        </div>
      </TeacherCard>

      {error ? <p className="teacher-error">{error}</p> : null}
      {notice ? (
        <p className="rounded-xl border border-student-primary-border bg-student-primary-soft p-4 text-sm font-semibold text-student-primary">
          {notice}
        </p>
      ) : null}

      {searching ? <p className="text-sm text-student-muted">正在搜索学生或班级...</p> : null}

      {!searching && searched && resultCount === 0 ? (
        <TeacherCard className="p-6">
          <TeacherEmptyState text="没有找到匹配的学生或班级。" />
        </TeacherCard>
      ) : null}

      {resultCount > 0 ? (
        <TeacherCard className="p-5 sm:p-6">
          <TeacherSectionTitle>搜索结果</TeacherSectionTitle>
          <div className="mt-4 grid gap-3">
            {students.map((student) => (
              <button
                className={clsx(
                  "w-full rounded-xl border p-4 text-left transition",
                  selection?.kind === "student" && student.id === selection.id
                    ? "border-student-primary bg-student-primary-soft/60"
                    : "border-student-border bg-white hover:border-student-primary/60"
                )}
                key={`student:${student.id}`}
                onClick={() => selectStudent(student)}
                type="button"
              >
                <span className="flex items-center gap-3">
                  <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-student-primary-soft text-student-primary">
                    <UserRound aria-hidden="true" size={20} strokeWidth={1.9} />
                  </span>
                  <span className="min-w-0">
                    <span className="block font-semibold text-student-text">{student.displayName}</span>
                    <span className="mt-0.5 block text-sm text-student-muted">
                      账号：{formatAccountForDisplay(student.email) || "—"}
                    </span>
                  </span>
                </span>
                <span className="mt-3 block text-sm text-student-muted">
                  <span className="font-semibold text-student-text">当前绑定：</span>
                  {student.bindings.length === 0 ? (
                    "暂无"
                  ) : (
                    <span className="mt-1 grid gap-1">
                      {student.bindings.map((binding) => (
                        <span className="block" key={binding.teacherId}>
                          {binding.teacherName} · {formatBindingDomainList(binding.domains)}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
              </button>
            ))}

            {classes.map((entry) => (
              <button
                className={clsx(
                  "w-full rounded-xl border p-4 text-left transition",
                  selection?.kind === "class" && entry.class_id === selection.id
                    ? "border-student-primary bg-student-primary-soft/60"
                    : "border-student-border bg-white hover:border-student-primary/60"
                )}
                key={`class:${entry.class_id}`}
                onClick={() => selectClass(entry)}
                type="button"
              >
                <span className="flex items-center gap-3">
                  <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-student-primary-soft text-student-primary">
                    <UsersRound aria-hidden="true" size={20} strokeWidth={1.9} />
                  </span>
                  <span className="min-w-0">
                    <span className="block font-semibold text-student-text">{entry.name}</span>
                    <span className="mt-0.5 block text-sm text-student-muted">
                      授课科目：{formatBindingDomainList(entry.subjects) || "—"} · {entry.member_count} 人
                    </span>
                  </span>
                </span>
                <span className="mt-3 block text-sm text-student-muted">
                  <span className="font-semibold text-student-text">当前状态：</span>
                  {entry.bound ? "已绑定" : "未绑定"}
                </span>
              </button>
            ))}
          </div>
        </TeacherCard>
      ) : null}

      {selectedStudent ? (
        <TeacherCard className="p-5 sm:p-6">
          <TeacherSectionTitle>授课科目</TeacherSectionTitle>
          <p className="mt-2 text-sm text-student-muted">
            为 {selectedStudent.displayName}（账号：
            {formatAccountForDisplay(selectedStudent.email) || "—"}）选择要绑定的授课科目。
          </p>
          <div className="mt-5 grid gap-2.5">
            {STUDENT_BINDING_DOMAINS.map((domain) => {
              const bound = boundDomains.includes(domain);
              const checked = bound || selectedDomains.includes(domain);
              return (
                <label
                  className={clsx(
                    "flex items-center gap-3 rounded-xl border px-4 py-3 text-sm font-semibold",
                    bound
                      ? "border-student-primary-border bg-student-primary-soft/50 text-student-primary"
                      : "border-student-border bg-white text-student-text"
                  )}
                  key={domain}
                >
                  <input
                    checked={checked}
                    disabled={bound}
                    onChange={(event) => {
                      setSelectedDomains((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(domain);
                        else next.delete(domain);
                        return STUDENT_BINDING_DOMAINS.filter((item) => next.has(item));
                      });
                    }}
                    type="checkbox"
                  />
                  {bound
                    ? `✓ ${STUDENT_BINDING_DOMAIN_LABELS[domain]}（已绑定）`
                    : STUDENT_BINDING_DOMAIN_LABELS[domain]}
                </label>
              );
            })}
          </div>

          {allDomainsBound ? (
            <p className="mt-4 text-sm font-semibold text-student-primary">
              该学生已绑定全部授课科目。
            </p>
          ) : pendingDomains.length === 0 ? (
            <p className="mt-4 text-sm text-student-muted">请至少选择一个授课科目。</p>
          ) : null}

          <div className="mt-6 flex flex-wrap gap-3">
            <button
              className="teacher-button-primary min-w-32"
              disabled={!canSubmitStudent}
              onClick={() => void submitStudentBinding()}
              type="button"
            >
              {submitting ? "正在绑定..." : "确认绑定"}
            </button>
            <Link className="teacher-button-secondary min-w-24" href="/teacher/students">
              返回
            </Link>
          </div>
        </TeacherCard>
      ) : null}

      {selectedClass ? (
        <TeacherCard className="p-5 sm:p-6">
          <TeacherSectionTitle>授课科目</TeacherSectionTitle>
          <p className="mt-2 text-sm text-student-muted">
            绑定班级「{selectedClass.name}」后，将按班级当前授课科目为该班全部成员建立授课绑定；已有绑定不会重复创建。
          </p>
          <div className="mt-5 grid gap-2.5">
            {STUDENT_BINDING_DOMAINS.map((domain) => {
              if (!selectedClass.subjects.includes(domain)) return null;
              return (
                <label
                  className="flex items-center gap-3 rounded-xl border border-student-primary-border bg-student-primary-soft/50 px-4 py-3 text-sm font-semibold text-student-primary"
                  key={domain}
                >
                  <input checked disabled readOnly type="checkbox" />
                  ✓ {STUDENT_BINDING_DOMAIN_LABELS[domain]}（班级授课科目）
                </label>
              );
            })}
          </div>

          {selectedClass.bound ? (
            <p className="mt-4 text-sm font-semibold text-student-primary">
              该班级已绑定。
            </p>
          ) : null}

          <div className="mt-6 flex flex-wrap gap-3">
            <button
              className="teacher-button-primary min-w-32"
              disabled={selectedClass.bound || submitting}
              onClick={() => void submitClassBinding()}
              type="button"
            >
              {submitting ? "正在绑定..." : "确认绑定"}
            </button>
            <Link className="teacher-button-secondary min-w-24" href="/teacher/students">
              返回
            </Link>
          </div>
        </TeacherCard>
      ) : null}
    </div>
  );
}
