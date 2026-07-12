"use client";

import { FormEvent, useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase/client";
import {
  TEACHER_STATS_CACHE_KEY,
  useTeacherDataCache
} from "@/components/TeacherDataCache";

type CreateStudentResponse = {
  student?: {
    id: string;
    email: string;
    displayName: string;
  };
  error?: string;
};

export function TeacherCreateStudent() {
  const { invalidate } = useTeacherDataCache();
  const [studentName, setStudentName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setSuccess("");

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
          email,
          password,
          studentName
        })
      });
      const responseText = await response.text();
      let payload: CreateStudentResponse;
      try {
        payload = responseText
          ? JSON.parse(responseText)
          : { error: "The create student API returned an empty response." };
      } catch {
        payload = { error: "The create student API returned invalid JSON." };
      }

      if (!response.ok) {
        setError(payload.error ?? "Could not create student.");
        return;
      }

      setSuccess(`Created student: ${payload.student?.displayName ?? studentName}`);
      setStudentName("");
      setEmail("");
      setPassword("");
      invalidate(TEACHER_STATS_CACHE_KEY);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not create student.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="rounded-lg border border-line bg-white p-5 shadow-sm" onSubmit={onSubmit}>
      <h2 className="text-xl font-bold">Create student account</h2>
      <div className="mt-5 grid gap-4">
        <label className="block text-sm font-semibold" htmlFor="student-name">
          Student name
        </label>
        <input
          className="w-full rounded-md border border-line px-3 py-2 outline-none focus:border-ocean"
          id="student-name"
          onChange={(event) => setStudentName(event.target.value)}
          required
          value={studentName}
        />

        <label className="block text-sm font-semibold" htmlFor="student-email">
          Email
        </label>
        <input
          className="w-full rounded-md border border-line px-3 py-2 outline-none focus:border-ocean"
          id="student-email"
          onChange={(event) => setEmail(event.target.value)}
          required
          type="email"
          value={email}
        />

        <label className="block text-sm font-semibold" htmlFor="student-password">
          Password
        </label>
        <input
          className="w-full rounded-md border border-line px-3 py-2 outline-none focus:border-ocean"
          id="student-password"
          minLength={6}
          onChange={(event) => setPassword(event.target.value)}
          required
          type="password"
          value={password}
        />
      </div>

      {error ? <p className="mt-4 text-sm font-semibold text-coral">{error}</p> : null}
      {success ? <p className="mt-4 text-sm font-semibold text-ocean">{success}</p> : null}

      <button
        className="mt-6 rounded-md bg-ink px-4 py-2 font-semibold text-white hover:bg-ocean disabled:cursor-not-allowed disabled:opacity-60"
        disabled={loading}
        type="submit"
      >
        {loading ? "Creating..." : "Create student"}
      </button>
    </form>
  );
}
