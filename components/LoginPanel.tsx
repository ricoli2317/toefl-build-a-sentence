"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  BarChart3,
  BookOpen,
  Eye,
  EyeOff,
  LockKeyhole,
  Mail,
  Target,
  Trophy
} from "lucide-react";
import { createBrowserSupabase } from "@/lib/supabase/client";
import type { UserRole } from "@/lib/types";

const features = [
  {
    description: "Target what you need to improve",
    icon: Target,
    title: "Focused Practice"
  },
  {
    description: "See your performance grow over time",
    icon: BarChart3,
    title: "Track Progress"
  },
  {
    description: "Build confidence. Achieve more.",
    icon: Trophy,
    title: "Reach Your Goals"
  }
];

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
    <main className="login-page grid min-h-screen lg:grid-cols-2">
      <section className="login-visual-panel flex min-h-[44rem] flex-col justify-between px-7 py-8 sm:px-12 lg:min-h-screen lg:px-[8%] lg:py-8">
        <div className="flex items-center gap-3 text-lg font-bold tracking-[-0.015em] text-student-text sm:text-xl">
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-student-primary text-white shadow-sm">
            <BookOpen aria-hidden="true" size={23} strokeWidth={1.9} />
          </span>
          Build a Sentence
        </div>

        <div className="max-w-[35rem] py-8 lg:py-0">
          <h1 className="text-[3.5rem] font-bold leading-[1.05] tracking-[-0.045em] text-student-text sm:text-[4rem]">
            Practice.
            <br />
            Improve.
            <br />
            <span className="text-student-error">Achieve.</span>
          </h1>
          <p className="mt-5 max-w-md text-base leading-7 text-student-muted sm:text-lg">
            Build your English skills with targeted practice
            <br className="hidden sm:block" /> and real progress tracking.
          </p>
          <span className="mt-5 block h-0.5 w-12 bg-student-error" />

          <div className="mt-6 grid gap-4">
            {features.map((feature) => {
              const Icon = feature.icon;
              return (
                <div className="flex items-center gap-4" key={feature.title}>
                  <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/80 text-student-primary shadow-sm">
                    <Icon aria-hidden="true" size={21} strokeWidth={1.9} />
                  </span>
                  <div>
                    <h2 className="text-sm font-bold text-student-primary sm:text-base">{feature.title}</h2>
                    <p className="mt-0.5 text-sm text-student-muted">{feature.description}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <p className="text-sm font-medium text-student-muted">Created by Rico</p>
      </section>

      <section className="flex min-h-[40rem] items-center justify-center bg-student-bg px-5 py-12 sm:px-8">
        <form
          className="w-full max-w-[500px] rounded-2xl border border-student-border bg-white p-6 shadow-[0_14px_44px_rgba(23,32,51,0.08)] sm:p-10"
          onSubmit={onSubmit}
        >
          <div className="text-center">
            <span className="mx-auto inline-flex h-14 w-14 items-center justify-center rounded-full bg-student-primary-soft text-student-primary">
              <LockKeyhole aria-hidden="true" size={25} strokeWidth={1.8} />
            </span>
            <h2 className="mt-5 text-2xl font-bold tracking-[-0.02em] text-student-text">Welcome back</h2>
            <p className="mt-2 text-sm text-student-muted sm:text-base">Sign in to continue to your account</p>
          </div>

          <div className="mt-7 grid grid-cols-2 rounded-xl bg-student-bg p-1">
            {(["student", "teacher"] as const).map((item) => (
              <button
                aria-pressed={role === item}
                className={`rounded-[9px] px-4 py-2.5 text-sm font-semibold transition ${
                  role === item
                    ? "bg-student-primary text-white shadow-sm"
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

          <label className="mt-6 block text-sm font-semibold text-student-text" htmlFor="email">
            Email
          </label>
          <div className="relative mt-2">
            <Mail aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-student-muted" size={18} />
            <input
              className="h-12 w-full rounded-xl border border-student-border bg-white pl-11 pr-4 text-sm text-student-text transition placeholder:text-student-muted hover:border-student-primary-border focus:border-student-primary"
              id="email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="Enter your email"
              required
              type="email"
              value={email}
            />
          </div>

          <label className="mt-5 block text-sm font-semibold text-student-text" htmlFor="password">
            Password
          </label>
          <div className="relative mt-2">
            <LockKeyhole aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-student-muted" size={18} />
            <input
              className="h-12 w-full rounded-xl border border-student-border bg-white pl-11 pr-11 text-sm text-student-text transition placeholder:text-student-muted hover:border-student-primary-border focus:border-student-primary"
              id="password"
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter your password"
              required
              type={showPassword ? "text" : "password"}
              value={password}
            />
            <button
              aria-label={showPassword ? "Hide password" : "Show password"}
              className="absolute right-2.5 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-student-muted hover:bg-student-primary-soft hover:text-student-primary"
              onClick={() => setShowPassword((visible) => !visible)}
              type="button"
            >
              {showPassword ? <EyeOff aria-hidden="true" size={18} /> : <Eye aria-hidden="true" size={18} />}
            </button>
          </div>

          <div className="mt-4 flex items-center justify-between gap-4 text-sm">
            <label className="flex items-center gap-2 text-student-text">
              <input className="h-4 w-4 rounded border-student-border accent-student-primary" type="checkbox" />
              Remember me
            </label>
            <button className="font-medium text-student-primary hover:underline" type="button">
              Forgot password?
            </button>
          </div>

          {error ? <p className="mt-4 text-sm font-semibold text-student-error">{error}</p> : null}
          <button
            className="mt-7 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-student-primary px-4 py-3 font-semibold text-white transition hover:bg-student-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
            disabled={loading}
            type="submit"
          >
            {loading ? "Signing in..." : `Continue as ${role}`}
            {!loading ? <ArrowRight aria-hidden="true" size={18} /> : null}
          </button>
        </form>
      </section>
    </main>
  );
}
