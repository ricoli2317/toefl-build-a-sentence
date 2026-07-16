import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { bearerToken } from "@/lib/auth";
import { readAllSupabaseRows } from "@/lib/supabasePagination";

type QuestionSetRow = {
  question_id: string;
  question_order: number | null;
  set_id: string;
  set_title: string | null;
};

type AttemptRow = {
  attempt_id: string;
  set_id: string;
  submitted_at: string | null;
  created_at: string | null;
};

type SetSummary = {
  set_id: string;
  set_title: string;
  month_key: string;
  month_label: string;
  question_count: number;
  completed: boolean;
  latest_attempt_id: string | null;
};

type MonthSummary = {
  month_key: string;
  month_label: string;
  set_count: number;
  question_count: number;
};

type SortKey = {
  yearMonth: number;
  datePart: number;
  setNumber: number;
};

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];

export const dynamic = "force-dynamic";

function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: {
      ...init?.headers,
      "Cache-Control": "no-store"
    }
  });
}

function parseSetSortKey(setId: string): SortKey {
  const parts = setId.split("-");
  const yearMonth = Number(parts[0] ?? 0);
  const datePart = Number(parts[1] ?? 0);
  const setNumber = Number(parts[2] ?? 1);

  return {
    yearMonth: Number.isFinite(yearMonth) ? yearMonth : 0,
    datePart: Number.isFinite(datePart) ? datePart : 0,
    setNumber: Number.isFinite(setNumber) ? setNumber : 1
  };
}

function parseMonthKey(setId: string) {
  const yearMonth = setId.split("-")[0] ?? "";
  return /^\d{6}$/.test(yearMonth) ? yearMonth : "";
}

function formatMonthLabel(monthKey: string) {
  const month = Number(monthKey.slice(4, 6));
  if (!Number.isFinite(month) || month < 1 || month > 12) return monthKey;
  return MONTH_NAMES[month - 1];
}

function compareMonths(a: MonthSummary, b: MonthSummary) {
  return Number(a.month_key) - Number(b.month_key);
}

function compareSets(a: SetSummary, b: SetSummary) {
  const left = parseSetSortKey(a.set_id);
  const right = parseSetSortKey(b.set_id);

  return (
    left.yearMonth - right.yearMonth ||
    left.datePart - right.datePart ||
    left.setNumber - right.setNumber
  );
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const monthFilter = url.searchParams.get("month") ?? "";
    const token = bearerToken(request);
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      return json(
        { error: "Missing Supabase environment variables." },
        { status: 500 }
      );
    }

    const authClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false },
      global: {
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      }
    });

    if (!token) {
      return json({ error: "Missing access token" }, { status: 401 });
    }

    const {
      data: { user },
      error: userError
    } = await authClient.auth.getUser(token);

    if (userError || !user) {
      return json({ error: "Invalid session" }, { status: 401 });
    }

    const { data: profile, error: profileError } = await authClient
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    if (profileError || profile?.role !== "student") {
      return json({ error: "Unauthorized" }, { status: 401 });
    }

    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const readClient = createClient(supabaseUrl, serviceRoleKey || supabaseAnonKey, {
      auth: { persistSession: false },
      global: {
        headers: serviceRoleKey ? {} : { Authorization: `Bearer ${token}` }
      }
    });

    const [questionResult, attemptResult] = await Promise.all([
      readAllSupabaseRows<QuestionSetRow>((from, to) =>
        readClient
          .from("questions")
          .select("question_id,set_id,set_title,question_order")
          .order("set_id", { ascending: true })
          .order("question_order", { ascending: true })
          .order("question_id", { ascending: true })
          .range(from, to)
      ),
      readAllSupabaseRows<AttemptRow>((from, to) =>
        readClient
          .from("attempts")
          .select("attempt_id,set_id,submitted_at,created_at")
          .eq("student_id", user.id)
          .order("attempt_id", { ascending: true })
          .range(from, to)
      )
    ]);

    if (questionResult.error) {
      return json(
        { months: [], sets: [], error: questionResult.error.message },
        { status: 500 }
      );
    }

    if (attemptResult.error) {
      return json(
        { months: [], sets: [], error: attemptResult.error.message },
        { status: 500 }
      );
    }

    const questionsById = new Map<string, QuestionSetRow>();
    for (const question of questionResult.data ?? []) {
      questionsById.set(String(question.question_id), question);
    }
    const questions = Array.from(questionsById.values());
    const attempts = attemptResult.data ?? [];

    const latestAttemptBySet = new Map<string, AttemptRow>();
    for (const attempt of (attempts ?? []) as AttemptRow[]) {
      const setId = String(attempt.set_id);
      const existing = latestAttemptBySet.get(setId);
      const attemptTime = new Date(attempt.submitted_at ?? attempt.created_at ?? 0).getTime();
      const existingTime = existing
        ? new Date(existing.submitted_at ?? existing.created_at ?? 0).getTime()
        : -1;

      if (!existing || attemptTime > existingTime) {
        latestAttemptBySet.set(setId, attempt);
      }
    }

    const setsById = new Map<string, SetSummary>();
    const monthSetIds = new Map<string, Set<string>>();
    const monthQuestionCounts = new Map<string, number>();

    for (const row of questions) {
      const setId = String(row.set_id);
      const monthKey = parseMonthKey(setId);
      if (monthKey) {
        const setIds = monthSetIds.get(monthKey) ?? new Set<string>();
        setIds.add(setId);
        monthSetIds.set(monthKey, setIds);
        monthQuestionCounts.set(monthKey, (monthQuestionCounts.get(monthKey) ?? 0) + 1);
      }

      if (monthFilter && monthKey !== monthFilter) {
        continue;
      }

      const existing = setsById.get(setId);
      if (existing) {
        existing.question_count += 1;
      } else {
        const latestAttempt = latestAttemptBySet.get(setId);
        setsById.set(setId, {
          set_id: setId,
          set_title: row.set_title ?? setId,
          month_key: monthKey,
          month_label: monthKey ? formatMonthLabel(monthKey) : "",
          question_count: 1,
          completed: Boolean(latestAttempt),
          latest_attempt_id: latestAttempt?.attempt_id ?? null
        });
      }
    }

    const months = Array.from(monthSetIds.entries())
      .map(([monthKey, setIds]) => ({
        month_key: monthKey,
        month_label: formatMonthLabel(monthKey),
        set_count: setIds.size,
        question_count: monthQuestionCounts.get(monthKey) ?? 0
      }))
      .sort(compareMonths);

    return json({
      months,
      sets: Array.from(setsById.values()).sort(compareSets)
    });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "Could not load sets." },
      { status: 500 }
    );
  }
}
