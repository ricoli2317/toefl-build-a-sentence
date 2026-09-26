"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { UserRound } from "lucide-react";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { useCurrentAccount } from "@/components/RoleGate";
import { TeacherCard, TeacherEmptyState, TeacherSectionTitle } from "@/components/teacher/TeacherUI";
import { AccountTabs } from "@/components/teacher/TeacherAccounts";
import { TeacherStudentOverviewList } from "@/components/teacher/TeacherStudentOverview";
import { InlineStudentNameEditor } from "@/components/shared/InlineStudentNameEditor";
import { AccountStatusControl } from "@/components/shared/AccountStatusControl";
import { publishCacheInvalidation } from "@/lib/cacheInvalidation";
import { formatAccountForDisplay, formatManagedAccountName } from "@/lib/accountIdentifier";

type StudentAccount = {
  id: string;
  email: string;
  displayName: string;
  isActive: boolean;
  createdAt: string | null;
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

export function StudentsAccountHome() {
  const { role } = useCurrentAccount();
  if (role === "teacher") return <TeacherStudentOverviewList />;
  return (
    <div className="grid gap-6">
      <AccountTabs active="students" />
      <AdminStudentsList />
    </div>
  );
}

export function AdminStudentsList() {
  const [students, setStudents] = useState<StudentAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const loadSequence = useRef(0);
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    const res = await authorizedFetch("/api/admin/students");
    const payload = await res.json().catch(() => ({})) as { students?: StudentAccount[]; error?: string };
    // A stale response may never overwrite a newer list or a status change
    // that already completed.
    if (sequence !== loadSequence.current) return;
    setLoading(false);
    if (!res.ok) return setError(payload.error ?? "学生列表加载失败。");
    setError("");
    setStudents(payload.students ?? []);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const updateStudentStatus = useCallback((studentId: string, isActive: boolean) => {
    setStudents((current) =>
      current.map((student) => (student.id === studentId ? { ...student, isActive } : student))
    );
  }, []);

  async function renameStudent(studentId: string, fullName: string) {
    const res = await authorizedFetch(`/api/admin/students/${encodeURIComponent(studentId)}`, {
      method: "PATCH",
      body: JSON.stringify({ fullName })
    });
    const payload = await res.json().catch(() => ({})) as {
      error?: string;
      message?: string;
      student?: { displayName?: string };
    };
    if (!res.ok) {
      throw new Error(payload.message ?? payload.error ?? "学生姓名更新失败，请稍后重试。");
    }
    await load();
    publishCacheInvalidation({ type: "TEACHER_BINDING_UPDATED" });
    return payload.student?.displayName ?? fullName;
  }

  return (
    <TeacherCard className="overflow-hidden p-0">
      <div className="px-6 pt-6">
        <TeacherSectionTitle>学生账号列表</TeacherSectionTitle>
        <p className="mt-2 text-sm text-student-muted">平台学生账号总览，不含教学统计数据。</p>
      </div>
      {loading ? (
        <p className="p-6 text-sm text-student-muted">正在加载...</p>
      ) : error ? (
        <p className="teacher-error m-6">{error}</p>
      ) : students.length === 0 ? (
        <div className="p-6"><TeacherEmptyState text="暂无学生账号。" /></div>
      ) : (
        <div className="overflow-x-auto px-6 pb-6 pt-4">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-student-border text-student-muted">
                <th className="px-3 py-3">学生</th>
                <th className="px-3 py-3">账号</th>
                <th className="px-3 py-3">状态</th>
              </tr>
            </thead>
            <tbody>
              {students.map((student) => (
                <tr className="border-b border-student-border last:border-0" key={student.id}>
                  <td className="px-3 py-4">
                    <div className="flex items-center gap-3">
                      <UserRound size={20} className="text-student-muted" />
                      <InlineStudentNameEditor
                        displayName={formatManagedAccountName(student.displayName, student.email)}
                        onSave={(fullName) => renameStudent(student.id, fullName)}
                      />
                    </div>
                  </td>
                  <td className="px-3 py-4 text-student-muted">账号：{formatAccountForDisplay(student.email)}</td>
                  <td className="px-3 py-4">
                    <AccountStatusControl
                      accountId={student.id}
                      isActive={student.isActive}
                      onChanged={(isActive) => updateStudentStatus(student.id, isActive)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </TeacherCard>
  );
}