"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { canSwitchArea, roleCanAccess } from "@/lib/accountPermissions";
import type { AppArea, UserRole } from "@/lib/types";

type AccountContextValue = { displayName: string; role: UserRole; userId: string };
const AccountContext = createContext<AccountContextValue | null>(null);

export function RoleGate({ area, children }: { area: AppArea; children: React.ReactNode }) {
  const router = useRouter();
  const [account, setAccount] = useState<AccountContextValue | null>(null);
  const [configurationError, setConfigurationError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function verify() {
      const supabase = createBrowserSupabase();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.replace("/login");
        return;
      }
      const response = await fetch("/api/account/me", {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: "no-store"
      });
      const payload = await response.json().catch(() => ({})) as {
        defaultRoute?: string;
        displayName?: string;
        role?: UserRole;
        userId?: string;
      };
      if (cancelled) return;
      if (!response.ok || !payload.role || !payload.userId) {
        setConfigurationError(response.status === 403);
        if (response.status !== 403) router.replace("/login");
        return;
      }
      const allowed = roleCanAccess(payload.role, area);
      if (!allowed) {
        router.replace(payload.defaultRoute ?? "/login");
        return;
      }
      const displayName = payload.displayName?.trim() || payload.userId;
      setAccount({ displayName, role: payload.role, userId: payload.userId });
    }
    void verify();
    return () => { cancelled = true; };
  }, [area, router]);

  if (configurationError) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-student-bg px-5">
        <div className="teacher-card max-w-md p-8 text-center">
          <h1 className="text-xl font-bold text-student-text">账号配置异常</h1>
          <p className="mt-3 text-sm text-student-muted">当前账号没有有效身份，请联系管理员处理。</p>
        </div>
      </main>
    );
  }
  if (!account) return <main className="min-h-screen bg-white" aria-busy="true" />;
  return <AccountContext.Provider value={account}>{children}</AccountContext.Provider>;
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
