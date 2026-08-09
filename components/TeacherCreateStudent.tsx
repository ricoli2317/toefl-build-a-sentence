"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { createBrowserSupabase } from "@/lib/supabase/client";
import {
  TEACHER_STATS_CACHE_KEY,
  useTeacherDataCache
} from "@/components/TeacherDataCache";

type CreateStudentResponse = {
  student?: {
    id: string;
    email: string;
    displayName: string;
  };
  error?: string;
};

export function TeacherCreateStudent() {
  const { invalidate } = useTeacherDataCache();
  const [studentName, setStudentName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setSuccess("");

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
          email,
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
      setEmail("");
      setPassword("");
      invalidate(TEACHER_STATS_CACHE_KEY);
    } catch (error) {
      setError(localizeCreateStudentError(error instanceof Error ? error.message : undefined));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="teacher-card p-6 sm:p-8" onSubmit={onSubmit}>
      <h2 className="text-xl font-bold text-student-text">创建学生账号</h2>
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

        <label className="grid gap-2.5 text-sm font-semibold text-student-text" htmlFor="student-email">
          邮箱
          <input
            className="h-14 w-full rounded-xl border border-student-border bg-white px-4 font-normal text-student-text placeholder:text-student-muted focus:border-student-primary"
            id="student-email"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="请输入邮箱地址"
            required
            type="email"
            value={email}
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
        <button className="teacher-button-primary min-w-36" disabled={loading} type="submit">
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
  if (/already (been )?registered|already exists/i.test(message)) return "该邮箱已注册。";
  if (/password must be at least 6 characters/i.test(message)) return "密码至少需要 6 个字符。";
  if (/email, password, and student name are required/i.test(message)) return "请填写邮箱、密码和学生姓名。";
  if (/profile save failed/i.test(message)) return "学生账号已创建，但学生资料保存失败。";
  return /[\u3400-\u9fff]/.test(message) ? message : "无法创建学生，请稍后重试。";
}
