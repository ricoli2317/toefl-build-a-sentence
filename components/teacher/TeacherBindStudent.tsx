"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Search, UserRound } from "lucide-react";
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
import type { StudentBindingCandidate } from "@/lib/teacherStudentBindings";

type SearchResponse = { students?: StudentBindingCandidate[]; message?: string };
type BindResponse = {
  created?: StudentBindingDomain[];
  alreadyBound?: StudentBindingDomain[];
  message?: string;
  code?: string;
};

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
 * Teacher self-service binding for an existing student. The current binding
 * teachers and subjects shown here come exclusively from
 * teacher_student_bindings joined to the teacher profile; the legacy account
 * ownership column is never used.
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
  const [selectedId, setSelectedId] = useState("");
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
  const selectedIdRef = useRef("");
  const preferredDomainsRef = useRef<StudentBindingDomain[]>(
    normalizeBindingDomains(initialDomains)
  );

  const selectedStudent = useMemo(
    () => students.find((student) => student.id === selectedId) ?? null,
    [students, selectedId]
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

  const selectStudent = useCallback((student: StudentBindingCandidate) => {
    selectedIdRef.current = student.id;
    setSelectedId(student.id);
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

  const search = useCallback(async (request: { q: string; studentId: string }, keepSelection = false) => {
    const trimmedQuery = request.q.trim();
    const studentId = request.studentId.trim();
    lastSearchRef.current = { q: trimmedQuery, studentId };
    if (!trimmedQuery && !studentId) {
      setStudents([]);
      setSelectedId("");
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
        setError(payload.message ?? "学生搜索失败，请稍后重试。");
        setStudents([]);
        return;
      }
      const results = payload.students ?? [];
      setStudents(results);
      setSearched(true);
      const target = studentId
        ? results.find((student) => student.id === studentId)
        : results.length === 1
          ? results[0]
          : keepSelection
            ? results.find((student) => student.id === selectedIdRef.current)
            : null;
      if (target) {
        selectStudent(target);
      } else {
        setSelectedId("");
      }
    } catch {
      setError("学生搜索失败，请稍后重试。");
      setStudents([]);
    } finally {
      setSearching(false);
    }
  }, [selectStudent]);

  useEffect(() => {
    if (initialStudentId || initialQuery) {
      void search({ q: initialQuery, studentId: initialStudentId });
    }
    // The initial search runs once for the URL-provided search context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submitBinding() {
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

  const allDomainsBound = Boolean(selectedStudent) && boundDomains.length === STUDENT_BINDING_DOMAINS.length;
  const pendingDomains = selectedDomains.filter((domain) => !boundDomains.includes(domain));
  const canSubmit = Boolean(selectedStudent) && !allDomainsBound && pendingDomains.length > 0 && !submitting;

  return (
    <div className="grid gap-6">
      <TeacherCard className="p-5 sm:p-6">
        <TeacherSectionTitle>绑定已有学生</TeacherSectionTitle>
        <p className="mt-2 text-sm text-student-muted">
          按学生姓名或学生账号搜索，找到学生后为其选择授课科目。绑定不会改变学生的账号归属，也不占用新增学生额度。
        </p>
        <div className="mt-5 flex flex-wrap items-end gap-3">
          <label className="relative block w-full max-w-[520px]" htmlFor="bind-student-query">
            <span className="sr-only">搜索学生姓名或账号</span>
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
              placeholder="输入学生姓名或学生账号"
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

      {searching ? <p className="text-sm text-student-muted">正在搜索学生...</p> : null}

      {!searching && searched && students.length === 0 ? (
        <TeacherCard className="p-6">
          <TeacherEmptyState text="没有找到匹配的学生。" />
        </TeacherCard>
      ) : null}

      {students.length > 0 ? (
        <TeacherCard className="p-5 sm:p-6">
          <TeacherSectionTitle>搜索结果</TeacherSectionTitle>
          <div className="mt-4 grid gap-3">
            {students.map((student) => (
              <button
                className={clsx(
                  "w-full rounded-xl border p-4 text-left transition",
                  student.id === selectedId
                    ? "border-student-primary bg-student-primary-soft/60"
                    : "border-student-border bg-white hover:border-student-primary/60"
                )}
                key={student.id}
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
              disabled={!canSubmit}
              onClick={() => void submitBinding()}
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
