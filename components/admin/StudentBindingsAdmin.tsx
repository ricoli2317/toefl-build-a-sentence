"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Check, Plus, Search, Trash2, UserRound, X } from "lucide-react";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { TeacherCard, TeacherEmptyState, TeacherSectionTitle } from "@/components/teacher/TeacherUI";
import { formatAccountForDisplay } from "@/lib/accountIdentifier";
import {
  STUDENT_BINDING_DOMAINS,
  bindingExists,
  type StudentBindingDomain
} from "@/lib/studentBindings";

type StudentRow = { id: string; displayName: string; email: string };
type TeacherRow = { id: string; displayName: string; email: string };
type BindingRow = {
  bindingId: string;
  domain: StudentBindingDomain;
  teacherId: string;
  teacherName: string;
  teacherEmail: string;
  studentId: string;
  studentName: string;
  studentEmail: string;
};
type ListPayload = { students: StudentRow[]; teachers: TeacherRow[]; bindings: BindingRow[] };

const DOMAIN_LABELS: Record<StudentBindingDomain, string> = {
  reading: "Reading",
  writing: "Writing"
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

export function StudentBindingsAdmin() {
  const [payload, setPayload] = useState<ListPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [managingStudentId, setManagingStudentId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await authorizedFetch("/api/admin/student-bindings");
    const data = await res.json().catch(() => ({})) as Partial<ListPayload> & { message?: string };
    setLoading(false);
    if (!res.ok) {
      setError(data.message ?? "教师绑定数据加载失败。");
      return;
    }
    setError("");
    setPayload({ students: data.students ?? [], teachers: data.teachers ?? [], bindings: data.bindings ?? [] });
  }, []);
  useEffect(() => { void load(); }, [load]);

  const students = useMemo(() => {
    const trimmed = query.trim().toLocaleLowerCase();
    if (!trimmed) return payload?.students ?? [];
    return (payload?.students ?? []).filter(
      (student) =>
        student.displayName.toLocaleLowerCase().includes(trimmed) ||
        student.email.toLocaleLowerCase().includes(trimmed)
    );
  }, [payload, query]);

  const bindingsFor = useCallback(
    (studentId: string, domain: StudentBindingDomain) =>
      (payload?.bindings ?? []).filter(
        (binding) => binding.studentId === studentId && binding.domain === domain
      ),
    [payload]
  );

  if (loading) return <p className="text-sm text-student-muted">正在加载...</p>;
  if (error) return <p className="teacher-error">{error}</p>;
  if (!payload || students.length === 0) {
    return (
      <div className="grid gap-6">
        {payload ? <BindingSearch query={query} onQueryChange={setQuery} /> : null}
        <TeacherCard className="p-6">
          <TeacherEmptyState text={query.trim() ? "没有找到匹配的学生。" : "暂无学生。"} />
        </TeacherCard>
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      {notice ? <p className="text-sm font-semibold text-student-primary">{notice}</p> : null}
      <BindingSearch query={query} onQueryChange={setQuery} />
      <TeacherCard className="overflow-hidden p-0">
        <div className="px-6 pt-6">
          <TeacherSectionTitle>学生教师绑定</TeacherSectionTitle>
          <p className="mt-2 text-sm text-student-muted">共 {students.length} 名学生；同一学生可绑定多位教师，同一教师可同时负责 Reading 和 Writing。</p>
        </div>
        <div className="overflow-x-auto px-6 pb-6 pt-4">
          <table className="w-full min-w-[860px] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-student-border text-student-muted">
                <th className="px-3 py-3 font-medium">学生</th>
                <th className="px-3 py-3 font-medium">Reading 教师</th>
                <th className="px-3 py-3 font-medium">Writing 教师</th>
                <th className="px-3 py-3 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {students.map((student) => {
                const reading = bindingsFor(student.id, "reading");
                const writing = bindingsFor(student.id, "writing");
                const managing = managingStudentId === student.id;
                return (
                  <BindingRowGroup
                    binding={{ reading, writing }}
                    key={student.id}
                    managing={managing}
                    onAdd={async (teacherId, domain) => {
                      setNotice("");
                      const res = await authorizedFetch("/api/admin/student-bindings", {
                        method: "POST",
                        body: JSON.stringify({ teacherId, studentId: student.id, domain })
                      });
                      const data = await res.json().catch(() => ({})) as { message?: string };
                      if (!res.ok) {
                        return { ok: false as const, message: data.message ?? "绑定新增失败。" };
                      }
                      await load();
                      return { ok: true as const, message: "" };
                    }}
                    onDelete={async (binding) => {
                      const label = DOMAIN_LABELS[binding.domain];
                      if (!window.confirm(`确认删除${binding.teacherName || "该教师"}负责该学生的 ${label} 绑定吗？`)) return;
                      const res = await authorizedFetch(`/api/admin/student-bindings/${binding.bindingId}`, { method: "DELETE" });
                      const data = await res.json().catch(() => ({})) as { message?: string };
                      if (!res.ok) {
                        setNotice("");
                        setError(data.message ?? "绑定删除失败。");
                        return;
                      }
                      setError("");
                      setNotice(`已删除${binding.teacherName || "该教师"}的 ${label} 绑定。`);
                      await load();
                    }}
                    onToggleManage={() => {
                      setNotice("");
                      setManagingStudentId(managing ? null : student.id);
                    }}
                    student={student}
                    teachers={payload.teachers}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      </TeacherCard>
    </div>
  );
}

function BindingSearch({ query, onQueryChange }: { query: string; onQueryChange: (value: string) => void }) {
  return (
    <TeacherCard className="p-5 sm:p-6">
      <label className="relative block w-full max-w-[560px]">
        <Search
          aria-hidden="true"
          className="absolute left-4 top-1/2 -translate-y-1/2 text-student-muted"
          size={20}
          strokeWidth={1.9}
        />
        <input
          className="h-12 w-full rounded-xl border border-student-border bg-white pl-12 pr-4 text-sm text-student-text placeholder:text-student-muted focus:border-student-primary"
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索学生姓名 / 账号"
          type="search"
          value={query}
        />
      </label>
      <p className="mt-3 text-sm text-student-muted">支持按学生姓名或账号搜索。</p>
    </TeacherCard>
  );
}

function BindingRowGroup({
  binding,
  managing,
  onAdd,
  onDelete,
  onToggleManage,
  student,
  teachers
}: {
  binding: { reading: BindingRow[]; writing: BindingRow[] };
  managing: boolean;
  onAdd: (teacherId: string, domain: StudentBindingDomain) => Promise<{ ok: boolean; message: string }>;
  onDelete: (binding: BindingRow) => Promise<void>;
  onToggleManage: () => void;
  student: StudentRow;
  teachers: TeacherRow[];
}) {
  const existing = useMemo(
    () => [...binding.reading.map((row) => ({ teacherId: row.teacherId, studentId: student.id, domain: row.domain })), ...binding.writing.map((row) => ({ teacherId: row.teacherId, studentId: student.id, domain: row.domain }))],
    [binding, student.id]
  );
  return (
    <>
      <tr className="border-b border-student-border transition last:border-b-0 hover:bg-student-primary-soft/45">
        <td className="px-3 py-4 align-top">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-student-primary-soft text-student-primary">
              <UserRound aria-hidden="true" size={20} strokeWidth={1.9} />
            </span>
            <div className="min-w-0">
              <p className="font-semibold text-student-text">{formatStudentName(student)}</p>
              <p className="text-xs text-student-muted">账号：{formatAccountForDisplay(student.email)}</p>
            </div>
          </div>
        </td>
        <BindingCell bindings={binding.reading} onDelete={onDelete} />
        <BindingCell bindings={binding.writing} onDelete={onDelete} />
        <td className="px-3 py-4 align-top">
          <button className="teacher-button-secondary" onClick={onToggleManage} type="button">
            {managing ? <X aria-hidden="true" size={16} /> : <Plus aria-hidden="true" size={16} />}
            {managing ? "取消" : "管理"}
          </button>
        </td>
      </tr>
      {managing ? <AddBindingRow existing={existing} onAdd={onAdd} student={student} teachers={teachers} /> : null}
    </>
  );
}

function BindingCell({ bindings, onDelete }: { bindings: BindingRow[]; onDelete: (binding: BindingRow) => Promise<void> }) {
  if (bindings.length === 0) return <td className="px-3 py-4 align-top text-student-muted">—</td>;
  return (
    <td className="px-3 py-4 align-top">
      <ul className="grid gap-2">
        {bindings.map((binding) => {
          const name = binding.teacherName || formatAccountForDisplay(binding.teacherEmail) || "未命名教师";
          return (
            <li
              className="flex w-max min-w-[160px] items-center justify-between gap-3 rounded-lg bg-student-bg px-3 py-2"
              key={binding.bindingId}
            >
              <span className="font-semibold text-student-text">{name}</span>
              <button
                aria-label={`删除 ${name}`}
                className="text-student-muted transition hover:text-student-error"
                onClick={() => void onDelete(binding)}
                title="删除绑定"
                type="button"
              >
                <Trash2 aria-hidden="true" size={16} strokeWidth={2} />
              </button>
            </li>
          );
        })}
      </ul>
    </td>
  );
}

function AddBindingRow({
  existing,
  onAdd,
  student,
  teachers
}: {
  existing: Array<{ teacherId: string; studentId: string; domain: string }>;
  onAdd: (teacherId: string, domain: StudentBindingDomain) => Promise<{ ok: boolean; message: string }>;
  student: StudentRow;
  teachers: TeacherRow[];
}) {
  const [teacherId, setTeacherId] = useState("");
  const [domain, setDomain] = useState<StudentBindingDomain | "">("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const duplicate =
    teacherId && domain ? bindingExists(existing, { teacherId, studentId: student.id, domain }) : false;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!teacherId || !domain || duplicate) return;
    setSubmitting(true);
    setMessage("");
    setError("");
    const result = await onAdd(teacherId, domain);
    setSubmitting(false);
    if (!result.ok) {
      setError(result.message);
      setMessage("");
      return;
    }
    setMessage(`已添加${DOMAIN_LABELS[domain]}绑定。`);
    setTeacherId("");
    setDomain("");
  }

  return (
    <tr className="border-b border-student-border bg-student-primary-soft/25">
      <td className="px-3 py-4" colSpan={4}>
        <form className="flex flex-wrap items-end gap-4" onSubmit={submit}>
          <label className="grid gap-2 text-sm font-semibold text-student-text">
            为 {formatStudentName(student)} 选择教师
            <select
              className="h-11 min-w-[240px] rounded-xl border border-student-border bg-white px-3"
              onChange={(event) => setTeacherId(event.target.value)}
              value={teacherId}
            >
              <option value="">请选择教师</option>
              {teachers.map((teacher) => (
                <option key={teacher.id} value={teacher.id}>
                  {teacher.displayName || formatAccountForDisplay(teacher.email)}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="grid gap-2 text-sm font-semibold text-student-text">
            <legend>教学领域</legend>
            <div className="flex flex-wrap gap-2">
              {STUDENT_BINDING_DOMAINS.map((value) => (
                <label
                  className={`flex cursor-pointer items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-semibold transition ${
                    domain === value
                      ? "border-student-primary bg-student-primary-soft text-student-primary"
                      : "border-student-border bg-white text-student-text"
                  }`}
                  key={value}
                >
                  <input
                    checked={domain === value}
                    className="sr-only"
                    name={`bind-domain-${student.id}`}
                    onChange={() => setDomain(value)}
                    type="radio"
                    value={value}
                  />
                  {DOMAIN_LABELS[value]}
                </label>
              ))}
            </div>
          </fieldset>
          <button
            className="teacher-button-primary"
            disabled={!teacherId || !domain || duplicate || submitting}
            type="submit"
          >
            {submitting ? "正在添加..." : <Check aria-hidden="true" size={16} strokeWidth={2} />}
            {submitting ? "" : "添加"}
          </button>
        </form>
        {duplicate ? <p className="mt-3 text-sm font-medium text-student-error">该教师与领域已存在于该学生的绑定中，无需重复添加。</p> : null}
        {error ? <p className="teacher-error mt-3">{error}</p> : null}
        {message ? <p className="mt-3 text-sm font-semibold text-student-primary">{message}</p> : null}
      </td>
    </tr>
  );
}

function formatStudentName(student: StudentRow) {
  return student.displayName || formatAccountForDisplay(student.email) || "未命名学生";
}