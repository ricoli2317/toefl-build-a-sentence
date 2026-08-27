"use client";

import Image from "next/image";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Eye, EyeOff, LockKeyhole, UserRound } from "lucide-react";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { resolveLoginAuthEmail } from "@/lib/accountIdentifier";

export function LoginPanel() {
  const router = useRouter();
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function redirectExistingSession() {
      const supabase = createBrowserSupabase();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session || cancelled) return;
      const route = await resolveAuthenticatedRoute(session.access_token);
      if (!cancelled && route) router.replace(route);
      if (!cancelled && !route) setError("账号配置异常，请联系管理员。");
    }
    void redirectExistingSession();
    return () => { cancelled = true; };
  }, [router]);

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
      setError(signInError?.message ?? "Login failed.");
      setLoading(false);
      return;
    }

    const route = data.session
      ? await resolveAuthenticatedRoute(data.session.access_token)
      : null;
    if (!route) {
      await supabase.auth.signOut();
      setError("账号配置异常，请联系管理员。");
      setLoading(false);
      return;
    }
    router.push(route);
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

          <label className="mt-4 block text-sm font-semibold text-student-text" htmlFor="password">密码</label>
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
    </main>
  );
}

async function resolveAuthenticatedRoute(accessToken: string) {
  const response = await fetch("/api/account/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store"
  });
  if (!response.ok) return null;
  const payload = await response.json() as { defaultRoute?: unknown };
  return typeof payload.defaultRoute === "string" ? payload.defaultRoute : null;
}
