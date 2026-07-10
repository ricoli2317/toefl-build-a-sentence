"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase/client";
import type { PracticeMonth, PracticeSet } from "@/lib/types";

type SetsPayload = {
  months?: PracticeMonth[];
  sets?: PracticeSet[];
  error?: string;
};

const SETS_CACHE_KEY = "student-practice-sets";

export function StudentHome() {
  return (
    <div className="grid gap-5">
      <StudentNavigation
        backHref="/student/sets"
        crumbs={[
          { label: "Student Home", href: "/student/sets" },
          { label: "Practice Sets" }
        ]}
      />
      <div className="grid gap-4 md:grid-cols-2">
        <Link
          className="rounded-lg border border-line bg-white p-5 shadow-sm hover:border-ocean"
          href="/student/wrong-questions"
        >
          <p className="text-sm font-semibold text-ocean">Review</p>
          <h2 className="mt-1 text-2xl font-bold">Wrong Questions</h2>
          <p className="mt-2 text-sm leading-6 text-ink/70">错题集</p>
        </Link>
        <Link
          className="rounded-lg border border-line bg-white p-5 shadow-sm hover:border-ocean"
          href="/student/practice-sets"
        >
          <p className="text-sm font-semibold text-ocean">Practice</p>
          <h2 className="mt-1 text-2xl font-bold">Practice Sets</h2>
          <p className="mt-2 text-sm leading-6 text-ink/70">按月选择套题</p>
        </Link>
      </div>
    </div>
  );
}

export function MonthList() {
  const { error, loading, months } = useStudentSetsData();

  if (loading) {
    return <p className="text-sm text-ink/70">Loading months...</p>;
  }

  if (error) {
    return <p className="font-semibold text-coral">{error}</p>;
  }

  return (
    <div className="grid gap-5">
      <StudentNavigation crumbs={[{ label: "Student Home" }]} showBack={false} />
      <div className="grid gap-4 md:grid-cols-2">
        {months.map((month) => (
          <Link
            className="rounded-lg border border-line bg-white p-5 shadow-sm hover:border-ocean"
            href={`/student/practice-sets/${month.month_key}`}
            key={month.month_key}
          >
            <p className="text-sm font-semibold text-ocean">Practice Month</p>
            <h2 className="mt-1 text-2xl font-bold">{month.month_label}</h2>
            <div className="mt-4 flex flex-wrap gap-2">
              <span className="rounded-full bg-paper px-3 py-1 text-xs font-semibold">
                {month.set_count} sets
              </span>
              <span className="rounded-full bg-paper px-3 py-1 text-xs font-semibold">
                {month.question_count} questions
              </span>
            </div>
          </Link>
        ))}
        {months.length === 0 ? (
          <p className="rounded-lg border border-line bg-white p-5">No practice months found.</p>
        ) : null}
      </div>
    </div>
  );
}

export function SetList({ monthKey, monthLabel }: { monthKey: string; monthLabel: string }) {
  const { error, loading, sets } = useStudentSetsData(monthKey);

  if (loading) {
    return <p className="text-sm text-ink/70">Loading sets...</p>;
  }

  if (error) {
    return <p className="font-semibold text-coral">{error}</p>;
  }

  return (
    <div className="grid gap-5">
      <StudentNavigation
        backHref="/student/practice-sets"
        crumbs={[
          { label: "Student Home", href: "/student/sets" },
          { label: "Practice Sets", href: "/student/practice-sets" },
          { label: monthLabel }
        ]}
      />
      <PracticeSetGrid sets={sets} />
    </div>
  );
}

function useStudentSetsData(monthKey?: string) {
  const [months, setMonths] = useState<PracticeMonth[]>([]);
  const [sets, setSets] = useState<PracticeSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const cached = readSetsCache();
    if (cached) {
      setMonths(cached.months ?? []);
      setSets(monthKey ? (cached.sets ?? []).filter((set) => set.month_key === monthKey) : cached.sets ?? []);
      setLoading(false);
    }

    async function loadSets() {
      const supabase = createBrowserSupabase();
      const {
        data: { session }
      } = await supabase.auth.getSession();

      const apiPath = monthKey ? `/api/sets?month=${encodeURIComponent(monthKey)}` : "/api/sets";
      const response = await fetch(apiPath, {
        headers: {
          Authorization: `Bearer ${session?.access_token ?? ""}`
        }
      });
      const responseText = await response.text();
      let payload: SetsPayload;
      try {
        payload = responseText
          ? JSON.parse(responseText)
          : { error: "The sets API returned an empty response." };
      } catch {
        payload = { error: "The sets API returned invalid JSON." };
      }

      if (!response.ok) {
        setError(payload.error ?? "Could not load sets.");
      } else {
        setMonths(payload.months ?? []);
        setSets(payload.sets ?? []);
        if (!monthKey) {
          window.sessionStorage.setItem(SETS_CACHE_KEY, JSON.stringify(payload));
        } else if (cached) {
          window.sessionStorage.setItem(
            SETS_CACHE_KEY,
            JSON.stringify({
              months: payload.months ?? cached.months ?? [],
              sets: [
                ...(cached.sets ?? []).filter((set) => set.month_key !== monthKey),
                ...(payload.sets ?? [])
              ]
            })
          );
        }
      }

      setLoading(false);
    }

    loadSets();
  }, [monthKey]);

  return { error, loading, months, sets };
}

function readSetsCache() {
  try {
    const value = window.sessionStorage.getItem(SETS_CACHE_KEY);
    return value ? (JSON.parse(value) as SetsPayload) : null;
  } catch {
    window.sessionStorage.removeItem(SETS_CACHE_KEY);
    return null;
  }
}

function PracticeSetGrid({ sets }: { sets: PracticeSet[] }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {sets.map((set) => (
        <article className="rounded-lg border border-line bg-white p-5 shadow-sm" key={set.set_id}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-ocean">{set.level ?? "Practice"}</p>
              <h2 className="mt-1 text-xl font-bold">{set.set_title}</h2>
            </div>
            <div className="flex flex-col items-end gap-2">
              {set.completed ? (
                <span className="rounded-full bg-ocean px-3 py-1 text-xs font-semibold text-white">
                  Completed
                </span>
              ) : null}
              <span className="rounded-full bg-paper px-3 py-1 text-xs font-semibold">
                {set.question_count} items
              </span>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap gap-2">
            {set.completed && set.latest_attempt_id ? (
              <Link
                className="inline-flex rounded-md border border-line bg-white px-4 py-2 font-semibold hover:border-ocean"
                href={`/student/results/${set.latest_attempt_id}`}
              >
                View result
              </Link>
            ) : null}
            <Link
              className="inline-flex rounded-md bg-ocean px-4 py-2 font-semibold text-white hover:bg-ink"
              href={`/student/practice/${set.set_id}`}
            >
              {set.completed ? "Retake" : "Start practice"}
            </Link>
          </div>
        </article>
      ))}
      {sets.length === 0 ? (
        <p className="rounded-lg border border-line bg-white p-5">No question sets found.</p>
      ) : null}
    </div>
  );
}

export function StudentNavigation({
  backHref = "/student/sets",
  crumbs,
  showBack = true
}: {
  backHref?: string;
  crumbs: Array<{
    href?: string;
    label: string;
  }>;
  showBack?: boolean;
}) {
  return (
    <nav className="rounded-lg border border-line bg-white p-4 shadow-sm" aria-label="Student navigation">
      <div className="flex flex-wrap gap-2">
        {showBack ? (
          <Link
            className="rounded-md border border-line px-3 py-2 text-sm font-semibold hover:border-ocean"
            href={backHref}
          >
            Back
          </Link>
        ) : null}
        <Link
          className="rounded-md bg-ink px-3 py-2 text-sm font-semibold text-white hover:bg-ocean"
          href="/student/sets"
        >
          Student Home
        </Link>
      </div>
      <ol className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink/60">
        {crumbs.map((crumb, index) => (
          <li className="flex items-center gap-2" key={`${crumb.label}-${index}`}>
            {index > 0 ? <span aria-hidden="true">/</span> : null}
            {crumb.href ? (
              <Link className="font-semibold text-ocean hover:underline" href={crumb.href}>
                {crumb.label}
              </Link>
            ) : (
              <span className="font-semibold text-ink">{crumb.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
