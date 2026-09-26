"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { canSwitchArea, roleCanAccess } from "@/lib/accountPermissions";
import type { AppArea, UserRole } from "@/lib/types";

type AccountContextValue = { displayName: string; role: UserRole; userId: string };
const AccountContext = createContext<AccountContextValue | null>(null);

const ACCOUNT_CACHE_PREFIX = "tps:account:";
const ACCOUNT_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Account verification is not allowed to gate the first paint on every hard
 * load: a recent verified account (same tab session, five minutes) renders the
 * shell immediately while the server check still runs and can still redirect
 * an account that lost access. Every teacher API re-verifies the token on the
 * server, so the cached value is a rendering hint, never an authorization.
 */
function readCachedAccount(area: AppArea): AccountContextValue | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(`${ACCOUNT_CACHE_PREFIX}${area}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { account?: AccountContextValue; cachedAt?: number };
    if (!parsed.account?.userId || !parsed.account.role || !parsed.cachedAt) return null;
    if (Date.now() - parsed.cachedAt > ACCOUNT_CACHE_TTL_MS) return null;
    return parsed.account;
  } catch {
    return null;
  }
}

function writeCachedAccount(area: AppArea, account: AccountContextValue) {
  try {
    window.sessionStorage.setItem(
      `${ACCOUNT_CACHE_PREFIX}${area}`,
      JSON.stringify({ account, cachedAt: Date.now() })
    );
  } catch {
    // Session storage is an optimization only.
  }
}

function clearCachedAccount(area: AppArea) {
  try {
    window.sessionStorage.removeItem(`${ACCOUNT_CACHE_PREFIX}${area}`);
  } catch {
    // Session storage is an optimization only.
  }
}

export function RoleGate({ area, children }: { area: AppArea; children: React.ReactNode }) {
  const router = useRouter();
  const [account, setAccount] = useState<AccountContextValue | null>(null);
  const [configurationError, setConfigurationError] = useState(false);

  // Restore the last verified account right after mount (never during the
  // hydration render, which would mismatch the server HTML), but only while it
  // still belongs to the signed-in session user. The server check below always
  // runs and can redirect an account that lost access.
  useEffect(() => {
    let cancelled = false;
    void createBrowserSupabase().auth.getSession().then(({ data }) => {
      if (cancelled) return;
      const sessionUserId = data.session?.user?.id ?? null;
      const cached = readCachedAccount(area);
      if (cached && sessionUserId === cached.userId) {
        setAccount((current) => current ?? cached);
      } else if (!sessionUserId || (cached && cached.userId !== sessionUserId)) {
        clearCachedAccount(area);
      }
    });
    return () => { cancelled = true; };
  }, [area]);

  useEffect(() => {
    let cancelled = false;
    async function verify() {
      const supabase = createBrowserSupabase();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        clearCachedAccount(area);
        router.replace("/login");
        return;
      }
      let response: Response;
      try {
        response = await fetch("/api/account/me", {
          headers: { Authorization: `Bearer ${session.access_token}` },
          cache: "no-store"
        });
      } catch {
        if (!cancelled && !readCachedAccount(area)) setConfigurationError(true);
        return;
      }
      const payload = await response.json().catch(() => ({})) as {
        code?: string;
        defaultRoute?: string;
        displayName?: string;
        role?: UserRole;
        userId?: string;
      };
      if (cancelled) return;
      if (!response.ok || !payload.role || !payload.userId) {
        clearCachedAccount(area);
        // A deactivated account cannot keep using its existing session: send it
        // back to the login page, where the disabled state is explained.
        if (payload.code === "ACCOUNT_DISABLED") {
          router.replace("/login");
          return;
        }
        if (response.status === 403) {
          setConfigurationError(true);
          return;
        }
        if (response.status === 401) {
          router.replace("/login");
          return;
        }
        setConfigurationError(true);
        return;
      }
      const allowed = roleCanAccess(payload.role, area);
      if (!allowed) {
        clearCachedAccount(area);
        router.replace(payload.defaultRoute ?? "/login");
        return;
      }
      const displayName = payload.displayName?.trim() || payload.userId;
      const nextAccount = { displayName, role: payload.role, userId: payload.userId };
      writeCachedAccount(area, nextAccount);
      setAccount(nextAccount);
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
