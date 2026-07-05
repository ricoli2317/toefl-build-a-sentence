"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/client";
import type { UserRole } from "@/lib/types";

export function LoginPanel() {
  const router = useRouter();
  const [role, setRole] = useState<UserRole>("student");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

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
    <main className="grid min-h-screen lg:grid-cols-[0.95fr_1.05fr]">
      <section className="flex min-h-[38vh] flex-col justify-between bg-ink px-6 py-8 text-white lg:min-h-screen lg:px-12">
        <div className="text-lg font-semibold text-gold">Build a Sentence</div>
        <div className="max-w-xl py-10">
          <h1 className="text-4xl font-bold leading-tight lg:text-6xl">
            Build a Sentence
          </h1>
          <p className="mt-5 max-w-lg text-lg leading-8 text-white/78">
            Practice System created by Rico
          </p>
        </div>
        <div className="text-sm text-white/60">Student practice and teacher analytics</div>
      </section>

      <section className="flex items-center justify-center px-5 py-10">
        <form
          className="w-full max-w-md rounded-lg border border-line bg-white p-6 shadow-sm"
          onSubmit={onSubmit}
        >
          <h2 className="text-2xl font-bold">Login</h2>
          <div className="mt-6 grid grid-cols-2 gap-2 rounded-md bg-paper p-1">
            {(["student", "teacher"] as const).map((item) => (
              <button
                className={`rounded px-4 py-2 text-sm font-semibold ${
                  role === item ? "bg-ocean text-white" : "text-ink hover:bg-white"
                }`}
                key={item}
                onClick={() => setRole(item)}
                type="button"
              >
                {item === "student" ? "Student" : "Teacher"}
              </button>
            ))}
          </div>
          <label className="mt-5 block text-sm font-semibold" htmlFor="email">
            Email
          </label>
          <input
            className="mt-2 w-full rounded-md border border-line px-3 py-2 outline-none focus:border-ocean"
            id="email"
            onChange={(event) => setEmail(event.target.value)}
            required
            type="email"
            value={email}
          />
          <label className="mt-4 block text-sm font-semibold" htmlFor="password">
            Password
          </label>
          <input
            className="mt-2 w-full rounded-md border border-line px-3 py-2 outline-none focus:border-ocean"
            id="password"
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
          {error ? <p className="mt-4 text-sm font-semibold text-coral">{error}</p> : null}
          <button
            className="mt-6 w-full rounded-md bg-ink px-4 py-3 font-semibold text-white hover:bg-ocean disabled:cursor-not-allowed disabled:opacity-60"
            disabled={loading}
            type="submit"
          >
            {loading ? "Signing in..." : `Continue as ${role}`}
          </button>
        </form>
      </section>
    </main>
  );
}
