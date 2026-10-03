"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
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
import { accountBaseFromStudentName } from "@/lib/studentAccountSuggestion";
import { formatBindingDomainList, type StudentBindingDomain } from "@/lib/studentBindings";
import { TeacherSubjectFieldset } from "@/components/teacher/TeacherSubjectFieldset";
import type { StudentBindingCandidate } from "@/lib/teacherStudentBindings";

const ACCOUNT_CHECK_DEBOUNCE_MS = 350;

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

type AccountSuggestionResponse = {
  account?: string;
  base?: string;
  available?: boolean;
  adjusted?: boolean;
  message?: string;
};

export function TeacherCreateStudent() {
  const router = useRouter();
  const { invalidate } = useTeacherDataCache();
  const { role } = useCurrentAccount();
  const isTeacher = role === "teacher";
  const [studentName, setStudentName] = useState("");
  const [account, setAccount] = useState("");
  const [accountEdited, setAccountEdited] = useState(false);
  const [accountNote, setAccountNote] = useState("");
  const [accountConflict, setAccountConflict] = useState(false);
  const [domains, setDomains] = useState<StudentBindingDomain[]>([]);
  const [duplicateCandidates, setDuplicateCandidates] = useState<StudentBindingCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [quotaReached, setQuotaReached] = useState(false);

  const accountEditedRef = useRef(false);
  const studentNameRef = useRef("");
  const accountRef = useRef("");
  const suggestionSeqRef = useRef(0);
  const suggestionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manualSeqRef = useRef(0);

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

  useEffect(() => () => {
    if (suggestionTimerRef.current) clearTimeout(suggestionTimerRef.current);
  }, []);

  const authorizedFetch = useCallback(async (input: string) => {
    const supabase = createBrowserSupabase();
    const { data: { session } } = await supabase.auth.getSession();
    return fetch(input, {
      headers: { Authorization: `Bearer ${session?.access_token ?? ""}` },
      cache: "no-store"
    });
  }, []);

  /**
   * Server-resolved account suggestion for the untouched auto-generated slug:
   * zhangsan -> zhangsan2 -> zhangsan3 ... The response is only applied while
   * the name and the un-edited account still match the request that produced
   * it, so a stale response can never overwrite a newer account.
   */
  const checkGeneratedAccount = useCallback(async (name: string, base: string, requestId: number) => {
    try {
      const response = await authorizedFetch(
        `/api/teacher/students/account-suggestion?name=${encodeURIComponent(name)}`
      );
      const payload = await response.json().catch(() => ({})) as AccountSuggestionResponse;
      if (requestId !== suggestionSeqRef.current) return;
      if (accountEditedRef.current) return;
      if (studentNameRef.current.trim() !== name.trim()) return;
      if (!response.ok || !payload.account) {
        setAccountNote(payload.message ?? "");
        return;
      }
      accountRef.current = payload.account;
      setAccount(payload.account);
      setAccountConflict(false);
      setAccountNote(
        payload.adjusted
          ? `账号「${payload.base || base}」已被占用，已自动使用「${payload.account}」。`
          : ""
      );
    } catch {
      // The locally generated pinyin base stays in the input; the server
      // re-validates and auto-suffixes again at creation time.
    }
  }, [authorizedFetch]);

  function scheduleAccountSuggestion(name: string, base: string) {
    suggestionSeqRef.current += 1;
    const requestId = suggestionSeqRef.current;
    if (suggestionTimerRef.current) clearTimeout(suggestionTimerRef.current);
    if (!base) {
      setAccountNote("");
      return;
    }
    suggestionTimerRef.current = setTimeout(() => {
      void checkGeneratedAccount(name, base, requestId);
    }, ACCOUNT_CHECK_DEBOUNCE_MS);
  }

  function onStudentNameChange(value: string) {
    setStudentName(value);
    studentNameRef.current = value;
    setDuplicateCandidates([]);
    // A manually edited account is never overwritten by the name.
    if (accountEditedRef.current) return;
    const base = accountBaseFromStudentName(value);
    accountRef.current = base;
    setAccount(base);
    setAccountConflict(false);
    setAccountNote("");
    scheduleAccountSuggestion(value, base);
  }

  function onAccountChange(value: string) {
    setAccount(value);
    accountRef.current = value;
    if (!accountEditedRef.current) {
      // The teacher took over: stop the auto suggestion for good.
      accountEditedRef.current = true;
      setAccountEdited(true);
      suggestionSeqRef.current += 1;
      if (suggestionTimerRef.current) clearTimeout(suggestionTimerRef.current);
    }
    setAccountConflict(false);
    setAccountNote("");
  }

  // Manually edited accounts are checked against the real account namespace
  // with the same debounce. Stale responses are dropped by request id.
  useEffect(() => {
    if (!accountEdited) return;
    const prepared = prepareNewAccount(account);
    if (!prepared.ok) return;
    manualSeqRef.current += 1;
    const requestId = manualSeqRef.current;
    const requestedValue = account.trim().toLocaleLowerCase();
    const timer = setTimeout(async () => {
      try {
        const response = await authorizedFetch(
          `/api/teacher/students/account-suggestion?account=${encodeURIComponent(prepared.account)}`
        );
        const payload = await response.json().catch(() => ({})) as AccountSuggestionResponse;
        if (requestId !== manualSeqRef.current) return;
        if (!accountEditedRef.current) return;
        if (accountRef.current.trim().toLocaleLowerCase() !== requestedValue) return;
        if (payload.available === false) {
          setAccountConflict(true);
          setAccountNote("该账号已存在，请更换。");
        } else {
          setAccountConflict(false);
          setAccountNote("");
        }
      } catch {
        // Ignore transient hint failures; creation re-validates on the server.
      }
    }, ACCOUNT_CHECK_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [account, accountEdited, authorizedFetch]);

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
          studentName,
          ...(isTeacher ? { domains } : {}),
          ...(options.confirmDuplicateName ? { confirmDuplicateName: true } : {}),
          // The password is always set on the server; the untouched
          // auto-generated account may receive the next free suffix there.
          ...(accountEditedRef.current ? {} : { autoSuffix: true })
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
      studentNameRef.current = "";
      setAccount("");
      accountRef.current = "";
      setAccountEdited(false);
      accountEditedRef.current = false;
      setAccountNote("");
      setAccountConflict(false);
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
            onChange={(event) => onStudentNameChange(event.target.value)}
            placeholder="请输入学生姓名"
            required
            value={studentName}
          />
        </label>

        <div className="grid gap-2">
          <label className="grid gap-2.5 text-sm font-semibold text-student-text" htmlFor="student-account">
            账号
            <input
              aria-invalid={accountConflict}
              autoComplete="username"
              className="h-14 w-full rounded-xl border border-student-border bg-white px-4 font-normal text-student-text placeholder:text-student-muted focus:border-student-primary"
              id="student-account"
              onBlur={() => {
                const normalized = normalizeNewAccountInput(account);
                accountRef.current = normalized;
                setAccount(normalized);
              }}
              onChange={(event) => onAccountChange(event.target.value)}
              placeholder="仅限英文字母和数字"
              required
              type="text"
              value={account}
            />
          </label>
          {accountConflict ? (
            <p className="text-xs font-semibold text-student-error">{accountNote}</p>
          ) : (
            <p className="text-xs text-student-muted">
              {accountNote || "账号按姓名自动生成拼音，可手动修改。"}
            </p>
          )}
          <p className="text-xs text-student-muted">学生初始密码统一为 123456，学生登录后可自行修改。</p>
        </div>

        {isTeacher ? (
          <TeacherSubjectFieldset onChange={setDomains} value={domains} />
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
  if (/student name is required|account and student name are required/i.test(message)) return "请填写学生姓名。";
  if (/请至少选择一个授课科目/.test(message)) return message;
  if (/profile save failed/i.test(message)) return "学生账号已创建，但学生资料保存失败。";
  if (/STUDENT_ACCOUNT_LIMIT_REACHED/i.test(message)) return "已达到学生账号数量上限，请联系管理员调整。";
  return /[\u3400-\u9fff]/.test(message) ? message : "无法创建学生，请稍后重试。";
}
