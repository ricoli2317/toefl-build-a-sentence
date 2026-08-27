"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { useCurrentAccount } from "@/components/RoleGate";
import { TeacherCard, TeacherEmptyState, TeacherSectionTitle } from "@/components/teacher/TeacherUI";
import {
  formatAccountForDisplay,
  formatManagedAccountName,
  normalizeNewAccountInput,
  prepareNewAccount
} from "@/lib/accountIdentifier";

type TeacherSummary = {
  id: string;
  email: string;
  displayName: string;
  studentCount: number;
  studentAccountLimit: number;
};

async function authorizedFetch(input: string, init?: RequestInit) {
  const supabase = createBrowserSupabase();
  const { data: { session } } = await supabase.auth.getSession();
  return fetch(input, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token ?? ""}`, ...init?.headers },
    cache: "no-store"
  });
}

export function AccountTabs({ active }: { active: "students" | "teachers" }) {
  const { role } = useCurrentAccount();
  if (role !== "admin") return null;
  return (
    <nav aria-label="账号类型" className="flex gap-2 border-b border-student-border">
      {([{ key: "students", label: "学生", href: "/teacher/students" }, { key: "teachers", label: "教师", href: "/teacher/accounts/teachers" }] as const).map((tab) => (
        <Link className={`border-b-2 px-5 py-3 text-sm font-bold ${active === tab.key ? "border-student-primary text-student-primary" : "border-transparent text-student-muted hover:text-student-text"}`} href={tab.href} key={tab.key}>{tab.label}</Link>
      ))}
    </nav>
  );
}

export function AdminTeachersList() {
  const [teachers, setTeachers] = useState<TeacherSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [bulkLimit, setBulkLimit] = useState("20");
  const load = useCallback(async () => {
    setLoading(true);
    const res = await authorizedFetch("/api/admin/teachers");
    const payload = await res.json().catch(() => ({})) as { teachers?: TeacherSummary[]; message?: string };
    setLoading(false);
    if (!res.ok) return setError(payload.message ?? "教师列表加载失败。");
    setError("");
    setTeachers(payload.teachers ?? []);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function updateAll(event: FormEvent) {
    event.preventDefault();
    const limit = Number(bulkLimit);
    const res = await authorizedFetch("/api/admin/teachers", { method: "PATCH", body: JSON.stringify({ studentAccountLimit: limit }) });
    const payload = await res.json().catch(() => ({})) as { message?: string };
    if (!res.ok) return setError(payload.message ?? "统一额度调整失败。");
    await load();
  }

  return (
    <div className="grid gap-6">
      <AccountTabs active="teachers" />
      <TeacherCard className="p-5 sm:p-6">
        <TeacherSectionTitle>统一额度调整</TeacherSectionTitle>
        <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={updateAll}>
          <label className="grid gap-2 text-sm font-semibold text-student-text">将所有教师学生账号额度统一调整为
            <input className="h-11 w-44 rounded-xl border border-student-border px-4" min={1} onChange={(e) => setBulkLimit(e.target.value)} required type="number" value={bulkLimit} />
          </label>
          <button className="teacher-button-primary" type="submit">统一调整</button>
        </form>
        <p className="mt-3 text-sm text-student-muted">仅影响当前已有教师；新建教师默认额度仍为 20。</p>
      </TeacherCard>
      {error ? <p className="teacher-error">{error}</p> : null}
      <TeacherCard className="overflow-hidden p-0">
        <div className="px-6 pt-6"><TeacherSectionTitle>教师列表</TeacherSectionTitle></div>
        {loading ? <p className="p-6 text-sm text-student-muted">正在加载...</p> : teachers.length === 0 ? <div className="p-6"><TeacherEmptyState text="暂无教师账号。" /></div> : (
          <div className="overflow-x-auto px-6 pb-6 pt-4"><table className="w-full min-w-[720px] text-left text-sm"><thead><tr className="border-b border-student-border text-student-muted"><th className="px-3 py-3">教师</th><th className="px-3 py-3">当前学生</th><th className="px-3 py-3">账号额度</th><th className="px-3 py-3">额度状态</th></tr></thead><tbody>
            {teachers.map((teacher) => <tr className="border-b border-student-border last:border-0" key={teacher.id}><td className="px-3 py-4"><Link className="flex items-center gap-3 font-semibold text-student-primary hover:underline" href={`/teacher/accounts/teachers/${teacher.id}`}><UserRound size={20} />{formatManagedAccountName(teacher.displayName, teacher.email)}</Link><span className="ml-8 text-xs text-student-muted">账号：{formatAccountForDisplay(teacher.email)}</span></td><td className="px-3 py-4">{teacher.studentCount}</td><td className="px-3 py-4">{teacher.studentAccountLimit}</td><td className="px-3 py-4 font-semibold">{quotaStatus(teacher.studentCount, teacher.studentAccountLimit)}</td></tr>)}
          </tbody></table></div>
        )}
      </TeacherCard>
    </div>
  );
}

export function CreateTeacherForm() {
  const [fullName, setFullName] = useState("");
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [limit, setLimit] = useState("20");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(""); setMessage("");
    const preparedAccount = prepareNewAccount(account);
    if (!preparedAccount.ok) return setError(preparedAccount.error);
    const res = await authorizedFetch("/api/admin/teachers", { method: "POST", body: JSON.stringify({ fullName, account: preparedAccount.account, password, studentAccountLimit: Number(limit) }) });
    const payload = await res.json().catch(() => ({})) as { message?: string; teacher?: { displayName?: string } };
    if (!res.ok) return setError(payload.message ?? "教师账号创建失败。");
    setMessage(`已创建教师：${payload.teacher?.displayName ?? fullName}`); setFullName(""); setAccount(""); setPassword(""); setLimit("20");
  }
  return <form className="teacher-card p-6 sm:p-8" onSubmit={submit}><h2 className="text-xl font-bold text-student-text">创建教师账号</h2><div className="mt-7 grid gap-6">
    <label className="grid gap-2.5 text-sm font-semibold text-student-text" htmlFor="teacher-name">教师姓名<input className="h-14 rounded-xl border border-student-border px-4 font-normal" id="teacher-name" onChange={(event) => setFullName(event.target.value)} required type="text" value={fullName} /></label>
    <label className="grid gap-2.5 text-sm font-semibold text-student-text" htmlFor="teacher-account">账号<input autoComplete="username" className="h-14 rounded-xl border border-student-border px-4 font-normal" id="teacher-account" onBlur={() => setAccount(normalizeNewAccountInput(account))} onChange={(event) => setAccount(event.target.value)} placeholder="仅限英文字母和数字" required type="text" value={account} /></label>
    <label className="grid gap-2.5 text-sm font-semibold text-student-text" htmlFor="teacher-password">初始密码<input className="h-14 rounded-xl border border-student-border px-4 font-normal" id="teacher-password" minLength={6} onChange={(event) => setPassword(event.target.value)} required type="password" value={password} /></label>
    <label className="grid gap-2.5 text-sm font-semibold text-student-text" htmlFor="teacher-limit">学生账号额度<input className="h-14 rounded-xl border border-student-border px-4 font-normal" id="teacher-limit" min={1} onChange={(event) => setLimit(event.target.value)} required type="number" value={limit} /></label>
  </div>{error ? <p className="teacher-error mt-5">{error}</p> : null}{message ? <p className="mt-5 text-sm font-semibold text-student-primary">{message}</p> : null}<div className="mt-8 flex gap-3"><button className="teacher-button-primary" type="submit">创建教师</button><Link className="teacher-button-secondary" href="/teacher/accounts/teachers">取消</Link></div></form>;
}

export function TeacherAccountDetail({ teacherId }: { teacherId: string }) {
  const [teacher, setTeacher] = useState<(TeacherSummary & { students: Array<{ id: string; displayName: string; email: string }> }) | null>(null);
  const [limit, setLimit] = useState(""); const [error, setError] = useState("");
  const load = useCallback(async () => { const res = await authorizedFetch(`/api/admin/teachers/${teacherId}`); const p = await res.json().catch(() => ({})) as { teacher?: typeof teacher; message?: string }; if (!res.ok) return setError(p.message ?? "教师详情加载失败。"); setTeacher(p.teacher ?? null); setLimit(String(p.teacher?.studentAccountLimit ?? "")); }, [teacherId]);
  useEffect(() => { void load(); }, [load]);
  async function update(event: FormEvent) { event.preventDefault(); const res = await authorizedFetch(`/api/admin/teachers/${teacherId}`, { method: "PATCH", body: JSON.stringify({ studentAccountLimit: Number(limit) }) }); const p = await res.json().catch(() => ({})) as { message?: string }; if (!res.ok) return setError(p.message ?? "额度调整失败。"); await load(); }
  if (error) return <p className="teacher-error">{error}</p>;
  if (!teacher) return <p className="text-sm text-student-muted">正在加载...</p>;
  return <div className="grid gap-6"><TeacherCard className="p-6"><h2 className="text-xl font-bold">{formatManagedAccountName(teacher.displayName, teacher.email)}</h2><p className="mt-2 text-sm text-student-muted">账号：{formatAccountForDisplay(teacher.email)}</p><div className="mt-5 grid gap-4 sm:grid-cols-3"><Info label="当前学生" value={teacher.studentCount} /><Info label="账号额度" value={teacher.studentAccountLimit} /><Info label="额度状态" value={quotaStatus(teacher.studentCount, teacher.studentAccountLimit)} /></div><form className="mt-6 flex flex-wrap items-end gap-3" onSubmit={update}><label className="grid gap-2 text-sm font-semibold">单独修改该教师额度<input className="h-11 w-40 rounded-xl border border-student-border px-4" min={1} onChange={(e) => setLimit(e.target.value)} required type="number" value={limit} /></label><button className="teacher-button-primary" type="submit">保存额度</button></form></TeacherCard><TeacherCard className="p-6"><TeacherSectionTitle>名下学生</TeacherSectionTitle><div className="mt-4 divide-y divide-student-border">{teacher.students.length ? teacher.students.map((student) => <Link className="flex justify-between py-3 text-sm hover:text-student-primary" href={`/teacher/students/${student.id}`} key={student.id}><span className="font-semibold">{formatManagedAccountName(student.displayName, student.email)}</span><span className="text-student-muted">账号：{formatAccountForDisplay(student.email)}</span></Link>) : <TeacherEmptyState text="该教师名下暂无学生。" />}</div></TeacherCard></div>;
}

function Info({ label, value }: { label: string; value: string | number }) { return <div className="rounded-xl bg-student-bg p-4"><p className="text-xs text-student-muted">{label}</p><p className="mt-1 font-bold text-student-text">{value}</p></div>; }
function quotaStatus(count: number, limit: number) { return count > limit ? "已超出上限" : count === limit ? "已达上限" : `剩余 ${limit - count}`; }
