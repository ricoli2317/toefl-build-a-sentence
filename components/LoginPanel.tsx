"use client";

import Image from "next/image";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Eye, EyeOff, LockKeyhole, Mail } from "lucide-react";
import { createBrowserSupabase } from "@/lib/supabase/client";
import type { UserRole } from "@/lib/types";

export function LoginPanel() {
  const router = useRouter();
  const [role, setRole] = useState<UserRole>("student");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");

    const supabase = createBrowserSupabase();
    const { data, error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (signInError || !data.user) {
      setError(signInError?.message ?? "Login failed.");
      setLoading(false);
      return;
    }

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", data.user.id)
      .single();

    if (profileError || profile?.role !== role) {
      await supabase.auth.signOut();
      setError(`This account is not registered as a ${role}.`);
      setLoading(false);
      return;
    }

    router.push(role === "student" ? "/student/sets" : "/teacher/dashboard");
    router.refresh();
  }

  return (
    <main className="login-page relative flex min-h-screen flex-col overflow-hidden px-5 py-6 sm:px-9 sm:py-8">
      <div aria-hidden="true" className="login-orb login-orb-left" />
      <div aria-hidden="true" className="login-orb login-orb-right" />
      <div aria-hidden="true" className="login-dot-grid login-dot-grid-top" />
      <div aria-hidden="true" className="login-dot-grid login-dot-grid-bottom" />

      <header className="relative z-10">
        <Image
          alt="TPS · TOEFL Practice System"
          className="h-auto w-[172px] object-contain sm:w-[206px]"
          height={724}
          priority
          src="/brand/tps-logo.png"
          width={2172}
        />
      </header>

      <div className="relative z-10 flex flex-1 items-center justify-center py-8 sm:py-10">
        <form
          className="w-full max-w-[566px] rounded-[22px] border border-white/90 bg-white/95 p-6 shadow-[0_22px_70px_rgba(44,35,99,0.11)] backdrop-blur sm:p-10 md:p-12"
          onSubmit={onSubmit}
        >
          <div className="text-center">
            <span className="mx-auto inline-flex h-16 w-16 items-center justify-center rounded-full bg-[linear-gradient(145deg,#f2efff,#ebe8ff)] text-student-primary">
              <LockKeyhole aria-hidden="true" size={28} strokeWidth={1.8} />
            </span>
            <h1 className="mt-5 text-[1.9rem] font-bold tracking-[-0.025em] text-student-text sm:text-[2.1rem]">Welcome to TPS</h1>
            <p className="mt-2 text-sm text-student-muted sm:text-base">Sign in to continue</p>
          </div>

          <div className="mt-8 grid grid-cols-2 rounded-xl bg-[#f7f7fa] p-1">
            {(["student", "teacher"] as const).map((item) => (
              <button
                aria-pressed={role === item}
                className={`min-h-12 rounded-[10px] px-4 text-sm font-semibold transition sm:text-base ${
                  role === item
                    ? "bg-[linear-gradient(135deg,#7357ff,#5134ef)] text-white shadow-[0_6px_16px_rgba(93,65,243,0.24)]"
                    : "text-student-text hover:bg-white"
                }`}
                key={item}
                onClick={() => setRole(item)}
                type="button"
              >
                {item === "student" ? "Student" : "Teacher"}
              </button>
            ))}
          </div>

          <label className="mt-7 block text-sm font-semibold text-student-text" htmlFor="email">Email</label>
          <div className="relative mt-2">
            <Mail aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#7f879f]" size={19} />
            <input
              autoComplete="email"
              className="h-14 w-full rounded-xl border border-[#dfe2eb] bg-white pl-12 pr-4 text-sm text-student-text transition placeholder:text-[#8a91a5] hover:border-student-primary-border focus:border-student-primary"
              id="email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="Enter your email"
              required
              type="email"
              value={email}
            />
          </div>

          <label className="mt-5 block text-sm font-semibold text-student-text" htmlFor="password">Password</label>
          <div className="relative mt-2">
            <LockKeyhole aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#7f879f]" size={19} />
            <input
              autoComplete="current-password"
              className="h-14 w-full rounded-xl border border-[#dfe2eb] bg-white pl-12 pr-12 text-sm text-student-text transition placeholder:text-[#8a91a5] hover:border-student-primary-border focus:border-student-primary"
              id="password"
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter your password"
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
            className="mt-7 inline-flex min-h-14 w-full items-center justify-center gap-3 rounded-xl bg-[linear-gradient(135deg,#7357ff,#5134ef)] px-4 py-3 text-base font-semibold text-white shadow-[0_9px_22px_rgba(93,65,243,0.25)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={loading}
            type="submit"
          >
            {loading ? "Signing in..." : "Sign in"}
            {!loading ? <ArrowRight aria-hidden="true" size={19} /> : null}
          </button>
        </form>
      </div>

      <p className="relative z-10 text-center text-sm font-medium text-student-muted">Created by Rico</p>
    </main>
  );
}
