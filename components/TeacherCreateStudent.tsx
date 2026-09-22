"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { publishCacheInvalidation } from "@/lib/cacheInvalidation";
import { useCurrentAccount } from "@/components/RoleGate";
import {
  TEACHER_WRITING_ASSIGNMENT_STUDENTS_CACHE_KEY,
  TEACHER_STATS_CACHE_KEY,
  useTeacherDataCache
} from "@/components/TeacherDataCache";
import { normalizeNewAccountInput, prepareNewAccount, formatAccountForDisplay } from "@/lib/accountIdentifier";
import {
  STUDENT_BINDING_DOMAINS,
  STUDENT_BINDING_DOMAIN_LABELS,
  formatBindingDomainList,
  type StudentBindingDomain
} from "@/lib/studentBindings";
import type { StudentBindingCandidate } from "@/lib/teacherStudentBindings";

type CreateStudentResponse = {
  student?: {
    id: string;
    account: string;
    displayName: string;
    domains?: StudentBindingDomain[];
  };
  error?: string;
  code?: string;
  candidates?: StudentBindingCandidate[];
};

export function TeacherCreateStudent() {
  const router = useRouter();
  const { invalidate } = useTeacherDataCache();
  const { role } = useCurrentAccount();
  const isTeacher = role === "teacher";
  const [studentName, setStudentName] = useState("");
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [domains, setDomains] = useState<StudentBindingDomain[]>([]);
  const [duplicateCandidates, setDuplicateCandidates] = useState<StudentBindingCandidate[]>([]);
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

  async function createStudent(options: { confirmDuplicateName?: boolean } = {}) {
    setLoading(true);
    setError("");
    setSuccess("");
    setDuplicateCandidates([]);

    const preparedAccount = prepareNewAccount(account);
    if (!preparedAccount.ok) {
      setError(preparedAccount.error);
      setLoading(false);
      return;
    }
    if (isTeacher && domains.length === 0) {
      setError("请至少选择一个授课科目。");
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
          studentName,
          ...(isTeacher ? { domains } : {}),
          ...(options.confirmDuplicateName ? { confirmDuplicateName: true } : {})
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
        if (payload.code === "DUPLICATE_NAME" && (payload.candidates?.length ?? 0) > 0) {
          setDuplicateCandidates(payload.candidates ?? []);
          return;
        }
        setError(localizeCreateStudentError(payload.error));
        return;
      }

      setSuccess(
        isTeacher && (payload.student?.domains?.length ?? 0) > 0
          ? `已创建学生：${payload.student?.displayName ?? studentName}（${formatBindingDomainList(payload.student?.domains ?? [])}）`
          : `已创建学生：${payload.student?.displayName ?? studentName}`
      );
      setStudentName("");
      setAccount("");
      setPassword("");
      setDomains([]);
      setDuplicateCandidates([]);
      invalidate(TEACHER_STATS_CACHE_KEY);
      invalidate(TEACHER_WRITING_ASSIGNMENT_STUDENTS_CACHE_KEY);
      if (isTeacher) publishCacheInvalidation({ type: "TEACHER_BINDING_UPDATED" });
    } catch (error) {
      setError(localizeCreateStudentError(error instanceof Error ? error.message : undefined));
    } finally {
      setLoading(false);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDuplicateCandidates([]);
    await createStudent();
  }

  function bindingHref(candidates: StudentBindingCandidate[]) {
    const params = new URLSearchParams(
      candidates.length === 1
        ? { studentId: candidates[0].id }
        : { q: studentName.trim() }
    );
    if (domains.length > 0) params.set("domains", domains.join(","));
    return `/teacher/students/bind?${params.toString()}`;
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

        {isTeacher ? (
          <fieldset className="grid gap-3">
            <legend className="text-sm font-semibold text-student-text">授课科目</legend>
            <div className="flex flex-wrap gap-3">
              {STUDENT_BINDING_DOMAINS.map((domain) => (
                <label
                  className="flex items-center gap-2.5 rounded-xl border border-student-border bg-white px-4 py-3 text-sm font-semibold text-student-text"
                  key={domain}
                >
                  <input
                    checked={domains.includes(domain)}
                    onChange={(event) => {
                      setDomains((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(domain);
                        else next.delete(domain);
                        return STUDENT_BINDING_DOMAINS.filter((item) => next.has(item));
                      });
                    }}
                    type="checkbox"
                  />
                  {STUDENT_BINDING_DOMAIN_LABELS[domain]}
                </label>
              ))}
            </div>
            <p className="text-sm text-student-muted">至少选择一个授课科目，可同时选择阅读和写作。</p>
          </fieldset>
        ) : null}
      </div>

      {error ? <p className="teacher-error mt-5">{error}</p> : null}
      {success ? <p className="mt-5 rounded-xl border border-student-primary-border bg-student-primary-soft p-4 text-sm font-semibold text-student-primary">{success}</p> : null}

      {duplicateCandidates.length > 0 ? (
        <div className="mt-6 rounded-xl border border-student-primary-border bg-student-primary-soft/40 p-5">
          <p className="text-sm font-bold text-student-text">已存在同名学生：</p>
          <div className="mt-4 grid gap-3">
            {duplicateCandidates.map((candidate) => (
              <div className="rounded-xl border border-student-border bg-white p-4" key={candidate.id}>
                <p className="font-semibold text-student-text">{candidate.displayName}</p>
                <p className="mt-1 text-sm text-student-muted">
                  账号：{formatAccountForDisplay(candidate.email)}
                </p>
                <p className="mt-2 text-sm text-student-muted">
                  <span className="font-semibold text-student-text">当前绑定：</span>
                  {candidate.bindings.length === 0 ? (
                    "暂无"
                  ) : (
                    <span className="mt-1 grid gap-1">
                      {candidate.bindings.map((binding) => (
                        <span key={binding.teacherId}>
                          {binding.teacherName} · {formatBindingDomainList(binding.domains)}
                        </span>
                      ))}
                    </span>
                  )}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-4 text-sm text-student-text">是否绑定已有学生？</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              className="teacher-button-primary"
              onClick={() => router.push(bindingHref(duplicateCandidates))}
              type="button"
            >
              绑定已有学生
            </button>
            <button
              className="teacher-button-secondary"
              disabled={loading}
              onClick={() => void createStudent({ confirmDuplicateName: true })}
              type="button"
            >
              {loading ? "正在创建..." : "继续新增"}
            </button>
          </div>
        </div>
      ) : null}

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
  if (/该学生账号已存在/.test(message)) return message;
  if (/already (been )?registered|already exists|账号已存在/i.test(message)) return "该账号已存在。";
  if (/password must be at least 6 characters/i.test(message)) return "密码至少需要 6 个字符。";
  if (/account, password, and student name are required/i.test(message)) return "请填写账号、密码和学生姓名。";
  if (/请至少选择一个授课科目/.test(message)) return message;
  if (/profile save failed/i.test(message)) return "学生账号已创建，但学生资料保存失败。";
  if (/STUDENT_ACCOUNT_LIMIT_REACHED/i.test(message)) return "已达到学生账号数量上限，请联系管理员调整。";
  return /[\u3400-\u9fff]/.test(message) ? message : "无法创建学生，请稍后重试。";
}
