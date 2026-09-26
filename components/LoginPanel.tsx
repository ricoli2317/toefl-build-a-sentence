"use client";

import Image from "next/image";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Eye, EyeOff, LockKeyhole, UserRound } from "lucide-react";
import { ConfirmDialog, ModalShell } from "@/components/shared/ConfirmDialog";
import {
  describeForgotPasswordError,
  describeLoginErrorMessage
} from "@/lib/accountCredentials";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { resolveLoginAuthEmail } from "@/lib/accountIdentifier";

type ForgotPasswordStage = "closed" | "confirm" | "success";

export function LoginPanel() {
  const router = useRouter();
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [forgotStage, setForgotStage] = useState<ForgotPasswordStage>("closed");
  const [forgotBusy, setForgotBusy] = useState(false);
  const [forgotError, setForgotError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function redirectExistingSession() {
      const supabase = createBrowserSupabase();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session || cancelled) return;
      const result = await resolveAuthenticatedRoute(session.access_token);
      if (cancelled || !result) return;
      if (result.defaultRoute) {
        router.replace(result.defaultRoute);
        return;
      }
      setError(
        result.code === "ACCOUNT_DISABLED"
          ? "账号已停用，请联系管理员。"
          : "账号配置异常，请联系管理员。"
      );
    }
    void redirectExistingSession();
    return () => { cancelled = true; };
  }, [router]);

  function closeForgotDialog() {
    if (forgotBusy) return;
    setForgotStage("closed");
    setForgotError("");
  }

  async function submitForgotRequest() {
    if (forgotBusy) return;
    const trimmed = account.trim();
    if (!trimmed) {
      setForgotError("请先输入账号。");
      return;
    }
    setForgotBusy(true);
    setForgotError("");
    try {
      const response = await fetch("/api/auth/password-reset-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: trimmed }),
        cache: "no-store"
      });
      const payload = (await response.json().catch(() => ({}))) as { message?: string };
      if (!response.ok) {
        throw new Error(payload.message ?? "请求提交失败，请稍后重试。");
      }
      setForgotStage("success");
    } catch (submitError) {
      setForgotError(
        describeForgotPasswordError(
          submitError instanceof Error ? submitError.message : null
        )
      );
    } finally {
      setForgotBusy(false);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");

    const supabase = createBrowserSupabase();
    const { data, error: signInError } = await supabase.auth.signInWithPassword({
      email: resolveLoginAuthEmail(account),
      password
    });

    if (signInError || !data.user) {
      setError(describeLoginErrorMessage(signInError?.message));
      setLoading(false);
      return;
    }

    const result = data.session
      ? await resolveAuthenticatedRoute(data.session.access_token)
      : null;
    if (!result?.defaultRoute) {
      await supabase.auth.signOut();
      setError(
        result?.code === "ACCOUNT_DISABLED"
          ? "账号已停用，请联系管理员。"
          : "账号配置异常，请联系管理员。"
      );
      setLoading(false);
      return;
    }
    router.push(result.defaultRoute);
    router.refresh();
  }

  return (
    <main className="login-page relative flex flex-col px-5 py-5 sm:px-8 md:py-5">
      <div aria-hidden="true" className="absolute inset-0 overflow-hidden">
        <div className="login-orb login-orb-left" />
        <div className="login-orb login-orb-right" />
        <div className="login-dot-grid login-dot-grid-top" />
        <div className="login-dot-grid login-dot-grid-bottom" />
      </div>

      <header className="relative z-10">
        <Image
          alt="TPS · TOEFL Practice System"
          className="h-auto w-[164px] object-contain sm:w-[184px]"
          height={724}
          priority
          src="/brand/tps-logo.png"
          width={2172}
        />
      </header>

      <div className="relative z-10 flex flex-1 items-center justify-center py-4 sm:py-5">
        <form
          className="w-full max-w-[480px] rounded-[22px] border border-white/90 bg-white/95 p-6 shadow-[0_22px_70px_rgba(44,35,99,0.11)] backdrop-blur sm:p-8"
          onSubmit={onSubmit}
        >
          <div className="text-center">
            <span className="mx-auto inline-flex h-14 w-14 items-center justify-center rounded-full bg-[linear-gradient(145deg,#f2efff,#ebe8ff)] text-student-primary">
              <LockKeyhole aria-hidden="true" size={26} strokeWidth={1.8} />
            </span>
            <h1 className="mt-3 text-[1.75rem] font-bold tracking-[-0.025em] text-student-text sm:text-[1.875rem]">Welcome to TPS</h1>
            <p className="mt-1 text-sm text-student-muted sm:text-base">Sign in to continue</p>
          </div>

          <label className="mt-6 block text-sm font-semibold text-student-text" htmlFor="account">账号</label>
          <div className="relative mt-1.5">
            <UserRound aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#7f879f]" size={19} />
            <input
              autoComplete="username"
              className="h-12 w-full rounded-xl border border-[#dfe2eb] bg-white pl-12 pr-4 text-sm text-student-text transition placeholder:text-[#8a91a5] hover:border-student-primary-border focus:border-student-primary"
              id="account"
              onChange={(event) => setAccount(event.target.value)}
              placeholder="请输入账号"
              required
              type="text"
              value={account}
            />
          </div>

          <div className="mt-4 flex items-center gap-3.5">
            <label className="block text-sm font-semibold text-student-text" htmlFor="password">密码</label>
            <button
              className="text-sm font-semibold text-student-primary hover:underline"
              onClick={() => {
                setForgotError("");
                setForgotStage("confirm");
              }}
              type="button"
            >
              忘记密码
            </button>
          </div>
          <div className="relative mt-1.5">
            <LockKeyhole aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#7f879f]" size={19} />
            <input
              autoComplete="current-password"
              className="h-12 w-full rounded-xl border border-[#dfe2eb] bg-white pl-12 pr-12 text-sm text-student-text transition placeholder:text-[#8a91a5] hover:border-student-primary-border focus:border-student-primary"
              id="password"
              onChange={(event) => setPassword(event.target.value)}
              placeholder="请输入密码"
              required
              type={showPassword ? "text" : "password"}
              value={password}
            />
            <button
              aria-label={showPassword ? "Hide password" : "Show password"}
              className="absolute right-3 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-[#7f879f] hover:bg-student-primary-soft hover:text-student-primary"
              onClick={() => setShowPassword((visible) => !visible)}
              type="button"
            >
              {showPassword ? <EyeOff aria-hidden="true" size={19} /> : <Eye aria-hidden="true" size={19} />}
            </button>
          </div>

          {error ? <p className="mt-4 text-sm font-semibold text-student-error" role="alert">{error}</p> : null}
          <button
            className="mt-5 inline-flex min-h-12 w-full items-center justify-center gap-3 rounded-xl bg-[linear-gradient(135deg,#7357ff,#5134ef)] px-4 py-2.5 text-base font-semibold text-white shadow-[0_9px_22px_rgba(93,65,243,0.25)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={loading}
            type="submit"
          >
            {loading ? "正在登录..." : "登录"}
            {!loading ? <ArrowRight aria-hidden="true" size={19} /> : null}
          </button>
        </form>
      </div>

      <p className="relative z-10 text-center text-sm font-medium text-student-muted">Created by Rico</p>

      <ConfirmDialog
        open={forgotStage === "confirm"}
        title="是否重置为初始密码？"
        message={account.trim() ? `账号：${account.trim()}` : undefined}
        confirming={forgotBusy}
        error={forgotError}
        onCancel={closeForgotDialog}
        onConfirm={() => void submitForgotRequest()}
      />
      <ModalShell open={forgotStage === "success"} onClose={closeForgotDialog}>
        <p className="text-base font-bold text-student-text">请等待教师许可</p>
        <div className="mt-6 flex justify-end">
          <button className="teacher-button-primary" onClick={closeForgotDialog} type="button">
            确定
          </button>
        </div>
      </ModalShell>
    </main>
  );
}

async function resolveAuthenticatedRoute(accessToken: string) {
  const response = await fetch("/api/account/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store"
  });
  const payload = await response.json().catch(() => ({})) as {
    code?: unknown;
    defaultRoute?: unknown;
  };
  if (!response.ok) {
    return {
      defaultRoute: null,
      code: typeof payload.code === "string" ? payload.code : null
    };
  }
  return {
    defaultRoute: typeof payload.defaultRoute === "string" ? payload.defaultRoute : null,
    code: null
  };
}
