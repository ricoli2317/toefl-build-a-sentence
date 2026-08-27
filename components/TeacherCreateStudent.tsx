"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { createBrowserSupabase } from "@/lib/supabase/client";
import {
  TEACHER_WRITING_ASSIGNMENT_STUDENTS_CACHE_KEY,
  TEACHER_STATS_CACHE_KEY,
  useTeacherDataCache
} from "@/components/TeacherDataCache";
import { normalizeNewAccountInput, prepareNewAccount } from "@/lib/accountIdentifier";

type CreateStudentResponse = {
  student?: {
    id: string;
    account: string;
    displayName: string;
  };
  error?: string;
};

export function TeacherCreateStudent() {
  const { invalidate } = useTeacherDataCache();
  const [studentName, setStudentName] = useState("");
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [quotaReached, setQuotaReached] = useState(false);

  useEffect(() => {
    let ignore = false;
    async function loadQuota() {
      const supabase = createBrowserSupabase();
      const { data: { session } } = await supabase.auth.getSession();
      const response = await fetch("/api/teacher/students", {
        headers: { Authorization: `Bearer ${session?.access_token ?? ""}` },
        cache: "no-store"
      });
      const payload = await response.json().catch(() => ({})) as {
        quota?: { limited?: boolean; count?: number; limit?: number };
      };
      if (!ignore && response.ok && payload.quota?.limited) {
        setQuotaReached((payload.quota.count ?? 0) >= (payload.quota.limit ?? 20));
      }
    }
    void loadQuota();
    return () => { ignore = true; };
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setSuccess("");

    const preparedAccount = prepareNewAccount(account);
    if (!preparedAccount.ok) {
      setError(preparedAccount.error);
      setLoading(false);
      return;
    }

    try {
      const supabase = createBrowserSupabase();
      const {
        data: { session }
      } = await supabase.auth.getSession();

      const response = await fetch("/api/teacher/students", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token ?? ""}`
        },
        body: JSON.stringify({
          account: preparedAccount.account,
          password,
          studentName
        })
      });
      const responseText = await response.text();
      let payload: CreateStudentResponse;
      try {
        payload = responseText
          ? JSON.parse(responseText)
          : { error: "创建学生服务返回了空响应。" };
      } catch {
        payload = { error: "创建学生服务返回的数据格式无效。" };
      }

      if (!response.ok) {
        setError(localizeCreateStudentError(payload.error));
        return;
      }

      setSuccess(`已创建学生：${payload.student?.displayName ?? studentName}`);
      setStudentName("");
      setAccount("");
      setPassword("");
      invalidate(TEACHER_STATS_CACHE_KEY);
      invalidate(TEACHER_WRITING_ASSIGNMENT_STUDENTS_CACHE_KEY);
    } catch (error) {
      setError(localizeCreateStudentError(error instanceof Error ? error.message : undefined));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="teacher-card p-6 sm:p-8" onSubmit={onSubmit}>
      <h2 className="text-xl font-bold text-student-text">创建学生账号</h2>
      {quotaReached ? (
        <p className="teacher-error mt-5">已达到学生账号数量上限，请联系管理员调整。</p>
      ) : null}
      <div className="mt-7 grid gap-6">
        <label className="grid gap-2.5 text-sm font-semibold text-student-text" htmlFor="student-name">
          学生姓名
          <input
            className="h-14 w-full rounded-xl border border-student-border bg-white px-4 font-normal text-student-text placeholder:text-student-muted focus:border-student-primary"
            id="student-name"
            onChange={(event) => setStudentName(event.target.value)}
            placeholder="请输入学生姓名"
            required
            value={studentName}
          />
        </label>

        <label className="grid gap-2.5 text-sm font-semibold text-student-text" htmlFor="student-account">
          账号
          <input
            autoComplete="username"
            className="h-14 w-full rounded-xl border border-student-border bg-white px-4 font-normal text-student-text placeholder:text-student-muted focus:border-student-primary"
            id="student-account"
            onBlur={() => setAccount(normalizeNewAccountInput(account))}
            onChange={(event) => setAccount(event.target.value)}
            placeholder="仅限英文字母和数字"
            required
            type="text"
            value={account}
          />
        </label>

        <label className="grid gap-2.5 text-sm font-semibold text-student-text" htmlFor="student-password">
          密码
          <input
            className="h-14 w-full rounded-xl border border-student-border bg-white px-4 font-normal text-student-text placeholder:text-student-muted focus:border-student-primary"
            id="student-password"
            minLength={6}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="请输入初始密码"
            required
            type="password"
            value={password}
          />
        </label>
      </div>

      {error ? <p className="teacher-error mt-5">{error}</p> : null}
      {success ? <p className="mt-5 rounded-xl border border-student-primary-border bg-student-primary-soft p-4 text-sm font-semibold text-student-primary">{success}</p> : null}

      <div className="mt-8 flex flex-wrap gap-3">
        <button className="teacher-button-primary min-w-36" disabled={loading || quotaReached} type="submit">
          {loading ? "正在创建..." : "创建学生"}
        </button>
        <Link className="teacher-button-secondary min-w-32" href="/teacher/students">
          取消
        </Link>
      </div>
    </form>
  );
}

function localizeCreateStudentError(message?: string) {
  if (!message) return "无法创建学生。";
  if (/unauthorized|not authenticated/i.test(message)) return "登录状态已失效，请重新登录。";
  if (/already (been )?registered|already exists|账号已存在/i.test(message)) return "该账号已存在。";
  if (/password must be at least 6 characters/i.test(message)) return "密码至少需要 6 个字符。";
  if (/account, password, and student name are required/i.test(message)) return "请填写账号、密码和学生姓名。";
  if (/profile save failed/i.test(message)) return "学生账号已创建，但学生资料保存失败。";
  if (/STUDENT_ACCOUNT_LIMIT_REACHED/i.test(message)) return "已达到学生账号数量上限，请联系管理员调整。";
  return /[\u3400-\u9fff]/.test(message) ? message : "无法创建学生，请稍后重试。";
}
