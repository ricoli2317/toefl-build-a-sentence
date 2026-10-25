"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { canSwitchArea, roleCanAccess } from "@/lib/accountPermissions";
import { accountDiagnosticCode, accountFailure, describeAccountFailure, reportAccountFailure, type AccountFailure } from "@/lib/accountCredentials";
import { classifyAccountVerificationError, fetchVerifiedAccount } from "@/lib/accountVerification";
import type { AppArea, UserRole } from "@/lib/types";

type AccountContextValue = { displayName: string; role: UserRole; userId: string };
const AccountContext = createContext<AccountContextValue | null>(null);

const ACCOUNT_CACHE_PREFIX = "tps:account:";

function clearCachedAccount(area: AppArea) {
  try {
    window.sessionStorage.removeItem(`${ACCOUNT_CACHE_PREFIX}${area}`);
  } catch {
    // Session storage is an optimization only.
  }
}

export function RoleGate({ area, children }: { area: AppArea; children: React.ReactNode }) {
  const router = useRouter();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    area: AppArea;
    attempt: number;
    account: AccountContextValue | null;
    failure: AccountFailure | null;
  } | null>(null);

  // No cached identity authorizes rendering. Each mount/area/retry must pass
  // this verification; a transient failure never exposes protected children.
  useEffect(() => {
    let cancelled = false;
    let sessionUserId: string | null | undefined;
    let unsubscribe: (() => void) | undefined;
    function identityChanged() {
      // Revoke this rendering immediately, then verify the new identity. A
      // same-user refresh does neither, preserving active answers and drafts.
      cancelled = true;
      clearCachedAccount(area);
      setState(null);
      setAttempt((value) => value + 1);
    }
    function fail(failure: AccountFailure) {
      if (cancelled) return;
      clearCachedAccount(area);
      reportAccountFailure(failure);
      setState({ area, attempt, account: null, failure });
    }
    async function verify() {
      let stage: "session_lookup" | "account_verification" = "session_lookup";
      try {
        const supabase = createBrowserSupabase();
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
          if (cancelled) return;
          const nextUserId = session?.user.id ?? null;
          if (sessionUserId !== undefined && nextUserId !== sessionUserId) {
            identityChanged();
          }
          sessionUserId = nextUserId;
        });
        unsubscribe = () => subscription.unsubscribe();
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();
        if (cancelled) return;
        if (sessionError) {
          fail(classifyAccountVerificationError(sessionError, stage));
          return;
        }
        const nextUserId = session?.user.id ?? null;
        if (sessionUserId !== undefined && nextUserId !== sessionUserId) {
          identityChanged();
          return;
        }
        sessionUserId = nextUserId;
        if (!session) {
          fail(accountFailure("ACCOUNT_UNAUTHENTICATED", stage));
          router.replace("/login");
          return;
        }
        stage = "account_verification";
        const result = await fetchVerifiedAccount(session.access_token, session.user.id);
        if (cancelled) return;
        if (!result.ok) {
          fail(result.failure);
          if (result.failure.code === "ACCOUNT_UNAUTHENTICATED") router.replace("/login");
          return;
        }
        const payload = result.account;
        if (!roleCanAccess(payload.role, area)) {
          fail(accountFailure("ACCOUNT_ACCESS_DENIED", stage));
          router.replace(payload.defaultRoute);
          return;
        }
        const nextAccount = {
          displayName: payload.displayName || payload.userId,
          role: payload.role,
          userId: payload.userId
        };
        setState({ area, attempt, account: nextAccount, failure: null });
      } catch (error) {
        fail(classifyAccountVerificationError(error, stage));
      }
    }
    void verify();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [area, attempt, router]);

  // A previous area's/attempt's success cannot flash during a new check.
  const current = state?.area === area && state.attempt === attempt ? state : null;
  if (current?.failure) {
    const failure = current.failure;
    const temporary = failure.code === "ACCOUNT_VERIFICATION_UNAVAILABLE"
      || failure.code === "ACCOUNT_VERIFICATION_FAILED";
    return (
      <main className="flex min-h-screen items-center justify-center bg-student-bg px-5">
        <div className="teacher-card max-w-md p-8 text-center">
          <h1 className="text-xl font-bold text-student-text">{temporary ? "暂时无法验证账号" : "无法访问"}</h1>
          <p className="mt-3 text-sm text-student-muted" role="alert">{describeAccountFailure(failure.code)}</p>
          <p className="mt-2 break-all text-xs text-student-muted" data-testid="account-diagnostic">
            反馈管理员时请附诊断代码：<code className="select-text">{accountDiagnosticCode(failure)}</code>
          </p>
          <div className="mt-5 flex justify-center gap-3">
            <button className="student-button-primary" onClick={() => setAttempt((value) => value + 1)} type="button">重新验证</button>
            <Link className="student-button-secondary" href="/login">返回登录</Link>
          </div>
        </div>
      </main>
    );
  }
  if (!current?.account) return <main className="min-h-screen bg-white" aria-busy="true" />;
  return <AccountContext.Provider key={current.account.userId} value={current.account}>{children}</AccountContext.Provider>;
}

export function useCurrentAccount() {
  const value = useContext(AccountContext);
  if (!value) throw new Error("Account context is unavailable outside RoleGate.");
  return value;
}

/**
 * Teacher/Student interface switcher. Admin and Teacher may move between the
 * two areas through this single shared entry; Student never sees it.
 */
export function AreaSwitch({ current }: { current: AppArea }) {
  const account = useCurrentAccount();
  if (!canSwitchArea(account.role)) return null;
  const target = current === "teacher" ? "/student" : "/teacher/dashboard";
  return (
    <Link className="student-button-secondary whitespace-nowrap" href={target}>
      {current === "teacher" ? "切换到学生端" : "切换到教师端"}
    </Link>
  );
}

export function AdminOnly({ children }: { children: React.ReactNode }) {
  const account = useCurrentAccount();
  const router = useRouter();
  useEffect(() => {
    if (account.role !== "admin") router.replace("/teacher/students");
  }, [account.role, router]);
  return account.role === "admin" ? children : null;
}

/**
 * Teacher personal teaching workstations (assignments, reviews, reading
 * statistics, teaching detail pages) are for actual teachers only. Admin is a
 * platform manager and is redirected to the admin home instead.
 */
export function TeacherOnly({ children }: { children: React.ReactNode }) {
  const account = useCurrentAccount();
  const router = useRouter();
  useEffect(() => {
    if (account.role !== "teacher") router.replace("/teacher/dashboard");
  }, [account.role, router]);
  return account.role === "teacher" ? children : null;
}
