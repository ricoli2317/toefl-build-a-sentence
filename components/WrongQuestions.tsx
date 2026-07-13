"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { PracticeSession } from "@/components/PracticeSession";
import { StudentNavigation } from "@/components/SetList";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import type { PublicQuestion } from "@/lib/types";

type WrongQuestionsPayload = {
  count?: number;
  questions?: PublicQuestion[];
  error?: string;
};

const DEFAULT_SET_TIME_SECONDS = 6 * 60 + 50;

export function WrongQuestionsHome() {
  return (
    <div className="grid gap-5">
      <StudentNavigation
        backHref={STUDENT_ROUTES.home}
        crumbs={[
          { label: "Student Home", href: STUDENT_ROUTES.home },
          { label: "Wrong Questions" }
        ]}
      />
      <div className="grid gap-4 md:grid-cols-2">
        <Link
          className="rounded-lg border border-line bg-white p-5 shadow-sm hover:border-ocean"
          href={STUDENT_ROUTES.wrongQuestionsToday}
        >
          <p className="text-sm font-semibold text-ocean">Today</p>
          <h2 className="mt-1 text-2xl font-bold">Today&apos;s Wrong Questions</h2>
          <p className="mt-2 text-sm leading-6 text-ink/70">今日错题</p>
        </Link>
        <Link
          className="rounded-lg border border-line bg-white p-5 shadow-sm hover:border-ocean"
          href={STUDENT_ROUTES.wrongQuestionsHistory}
        >
          <p className="text-sm font-semibold text-ocean">History</p>
          <h2 className="mt-1 text-2xl font-bold">History Wrong Questions</h2>
          <p className="mt-2 text-sm leading-6 text-ink/70">历史错题合集</p>
        </Link>
      </div>
    </div>
  );
}

export function TodayWrongQuestions() {
  const { error, loading, questions } = useWrongQuestions("today");

  if (loading) return <LoadingText text="Loading today's wrong questions..." />;
  if (error) return <ErrorText text={error} />;

  return (
    <div className="grid gap-5">
      <StudentNavigation
        backHref={STUDENT_ROUTES.wrongQuestions}
        crumbs={[
          { label: "Student Home", href: STUDENT_ROUTES.home },
          { label: "Wrong Questions", href: STUDENT_ROUTES.wrongQuestions },
          { label: "Today's Wrong Questions" }
        ]}
      />
      <section className="rounded-lg border border-line bg-white p-5 shadow-sm">
        {questions.length === 0 ? (
          <p className="text-lg font-bold">今日无错题</p>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-ocean">有错题待复习</p>
              <h2 className="mt-1 text-2xl font-bold">{questions.length} question{questions.length === 1 ? "" : "s"}</h2>
            </div>
            <Link
              className="rounded-md bg-ocean px-4 py-2 font-semibold text-white hover:bg-ink"
              href="/student/wrong-questions/today/practice"
            >
              Start practice
            </Link>
          </div>
        )}
      </section>
    </div>
  );
}

export function HistoryWrongQuestions() {
  const { error, loading, questions } = useWrongQuestions("history");

  if (loading) return <LoadingText text="Loading history wrong questions..." />;
  if (error) return <ErrorText text={error} />;

  return (
    <div className="grid gap-5">
      <StudentNavigation
        backHref={STUDENT_ROUTES.wrongQuestions}
        crumbs={[
          { label: "Student Home", href: STUDENT_ROUTES.home },
          { label: "Wrong Questions", href: STUDENT_ROUTES.wrongQuestions },
          { label: "History Wrong Questions" }
        ]}
      />
      <section className="rounded-lg border border-line bg-white p-5 shadow-sm">
        {questions.length === 0 ? (
          <p className="text-lg font-bold">暂无历史错题</p>
        ) : (
          <div>
            <p className="text-sm font-semibold text-ocean">History Wrong Questions</p>
            <h2 className="mt-1 text-2xl font-bold">{questions.length} question{questions.length === 1 ? "" : "s"}</h2>
            <div className="mt-5 flex flex-wrap gap-2">
              <Link
                className="inline-flex rounded-md bg-ocean px-4 py-2 font-semibold text-white hover:bg-ink"
                href="/student/wrong-questions/history/practice?mode=all"
              >
                Practice All
              </Link>
              <Link
                className="inline-flex rounded-md border border-line bg-white px-4 py-2 font-semibold hover:border-ocean"
                href="/student/wrong-questions/history/practice?mode=random"
              >
                Random Timed Practice
              </Link>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export function WrongQuestionsPractice({
  mode
}: {
  mode: "history-all" | "history-random" | "today";
}) {
  const scope = mode === "today" ? "today" : "history";
  const randomLimit = mode === "history-random" ? 10 : undefined;
  const { error, loading, questions } = useWrongQuestions(scope, randomLimit);
  const today = useMemo(() => formatTimestamp(new Date()), []);
  const virtualSetId = useMemo(() => {
    if (mode === "today") return `wrongbook-today-${today.slice(0, 8)}`;
    if (mode === "history-random") return `wrongbook-random-${today}`;
    return `wrongbook-all-${today}`;
  }, [mode, today]);
  const title =
    mode === "today"
      ? "Today's Wrong Questions"
      : mode === "history-random"
        ? "Random Timed Wrong Questions"
        : "History Wrong Questions";
  const timed = mode === "history-random";
  const totalSeconds = timed
    ? Math.max(1, Math.round((DEFAULT_SET_TIME_SECONDS / 10) * Math.min(10, questions.length)))
    : DEFAULT_SET_TIME_SECONDS;

  if (loading) return <LoadingText text="Loading practice..." />;
  if (error) return <ErrorText text={error} />;
  if (questions.length === 0) {
    return (
      <div className="grid gap-5">
        <StudentNavigation
          backHref={
            mode === "today"
              ? STUDENT_ROUTES.wrongQuestionsToday
              : STUDENT_ROUTES.wrongQuestionsHistory
          }
          crumbs={
            mode === "today"
              ? [
                  { label: "Student Home", href: STUDENT_ROUTES.home },
                  { label: "Wrong Questions", href: STUDENT_ROUTES.wrongQuestions },
                  { label: "Today's Wrong Questions" }
                ]
              : [
                  { label: "Student Home", href: STUDENT_ROUTES.home },
                  { label: "Wrong Questions", href: STUDENT_ROUTES.wrongQuestions },
                  { label: "History Wrong Questions" }
                ]
          }
        />
        <p className="rounded-lg border border-line bg-white p-5">
          {mode === "today" ? "今日无错题" : "暂无历史错题"}
        </p>
      </div>
    );
  }

  return (
    <PracticeSession
      allowEndPractice={mode === "history-all"}
      hideQuestionCardNumber
      initialQuestions={questions}
      setId={virtualSetId}
      setTitle={title}
      submitAnsweredOnly={mode === "history-all"}
      timed={timed}
      totalSeconds={totalSeconds}
    />
  );
}

function useWrongQuestions(scope: "history" | "today", randomLimit?: number) {
  const [questions, setQuestions] = useState<PublicQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const todayRange = useMemo(() => getTodayRange(), []);

  useEffect(() => {
    let ignore = false;

    async function loadWrongQuestions() {
      try {
        const supabase = createBrowserSupabase();
        const {
          data: { session }
        } = await supabase.auth.getSession();
        const params = new URLSearchParams({ scope });
        if (scope === "today") {
          params.set("todayStart", todayRange.start);
          params.set("todayEnd", todayRange.end);
        }
        if (randomLimit) {
          params.set("randomLimit", String(randomLimit));
        }

        const response = await fetch(`/api/wrong-questions?${params.toString()}`, {
          headers: {
            Authorization: `Bearer ${session?.access_token ?? ""}`
          }
        });
        const responseText = await response.text();
        let payload: WrongQuestionsPayload;
        try {
          payload = responseText
            ? JSON.parse(responseText)
            : { error: "The wrong questions API returned an empty response.", questions: [] };
        } catch {
          payload = { error: "The wrong questions API returned invalid JSON.", questions: [] };
        }

        if (ignore) return;

        if (!response.ok) {
          setError(payload.error ?? "Could not load wrong questions.");
        } else {
          setQuestions(payload.questions ?? []);
        }
      } catch (error) {
        if (!ignore) {
          setError(error instanceof Error ? error.message : "Could not load wrong questions.");
        }
      } finally {
        if (!ignore) setLoading(false);
      }
    }

    loadWrongQuestions();

    return () => {
      ignore = true;
    };
  }, [randomLimit, scope, todayRange.end, todayRange.start]);

  return { error, loading, questions };
}

function getTodayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  return {
    end: end.toISOString(),
    start: start.toISOString()
  };
}

function formatTimestamp(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function LoadingText({ text }: { text: string }) {
  return <p className="text-sm text-ink/70">{text}</p>;
}

function ErrorText({ text }: { text: string }) {
  return <p className="font-semibold text-coral">{text}</p>;
}
