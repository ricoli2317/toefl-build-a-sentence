"use client";

import { useEffect, useState } from "react";
import { buildSentenceDisplay } from "@/lib/questionText";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { StudentNavigation } from "@/components/SetList";

type ResultPayload = {
  attempt: {
    attempt_id: string;
    set_id: string;
    set_title: string;
    correct_count: number;
    total_questions: number;
    accuracy: number;
    time_spent_seconds: number;
    submitted_at: string;
  };
  total_count: number;
  correct_count: number;
  accuracy: number;
  answers: Array<{
    attempt_answer_id: string;
    question_id: string;
    question_order: number;
    prompt: string;
    submitted_order_text: string;
    correct_order_text: string;
    sentence_template: string;
    final_sentence: string;
    is_correct: boolean;
    grammar_tags_text: string | null;
  }>;
};

export function PracticeResult({ attemptId }: { attemptId: string }) {
  const [payload, setPayload] = useState<ResultPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showIncorrectOnly, setShowIncorrectOnly] = useState(false);

  useEffect(() => {
    const cached = window.sessionStorage.getItem(resultCacheKey(attemptId));
    let hasCachedResult = false;
    if (cached) {
      try {
        setPayload(JSON.parse(cached) as ResultPayload);
        setLoading(false);
        hasCachedResult = true;
      } catch {
        window.sessionStorage.removeItem(resultCacheKey(attemptId));
      }
    }

    async function loadResult() {
      const supabase = createBrowserSupabase();
      const {
        data: { session }
      } = await supabase.auth.getSession();

      const response = await fetch(`/api/attempts/${attemptId}`, {
        headers: {
          Authorization: `Bearer ${session?.access_token ?? ""}`
        }
      });
      const responseText = await response.text();
      let data: ResultPayload | { error?: string };
      try {
        data = responseText
          ? JSON.parse(responseText)
          : { error: "The result API returned an empty response." };
      } catch {
        data = { error: "The result API returned invalid JSON." };
      }

      if (!response.ok) {
        if (!hasCachedResult) {
          setError(getErrorMessage(data, "Could not load result."));
        }
      } else {
        setPayload(data as ResultPayload);
        window.sessionStorage.setItem(resultCacheKey(attemptId), JSON.stringify(data));
      }

      setLoading(false);
    }

    loadResult();
  }, [attemptId]);

  if (loading) {
    return <p className="text-sm text-ink/70">Loading result...</p>;
  }

  if (error || !payload) {
    return <p className="font-semibold text-coral">{error || "Result not found."}</p>;
  }

  const { attempt, answers } = payload;
  const visibleAnswers = showIncorrectOnly
    ? answers.filter((answer) => !answer.is_correct)
    : answers;

  return (
    <div className="space-y-5">
      <StudentNavigation
        backHref="/student/sets"
        crumbs={[
          { label: "Student Home", href: "/student/sets" },
          { label: attempt.set_title, href: "/student/sets" },
          { label: "Result" }
        ]}
      />

      <section className="rounded-lg border border-line bg-white p-5 shadow-sm">
        <p className="text-sm font-semibold text-ocean">{attempt.set_title}</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Metric label="Score" value={`${attempt.correct_count}/${attempt.total_questions}`} />
          <Metric label="Accuracy" value={`${Math.round(attempt.accuracy * 100)}%`} />
          <Metric label="Time" value={formatDuration(attempt.time_spent_seconds)} />
        </div>
      </section>

      <section className="rounded-lg border border-line bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-bold">Answers</h2>
          <button
            className={`rounded-md border px-3 py-2 text-sm font-semibold ${
              showIncorrectOnly
                ? "border-coral bg-coral text-white"
                : "border-line bg-white hover:border-ocean"
            }`}
            onClick={() => setShowIncorrectOnly((value) => !value)}
            type="button"
          >
            Show incorrect only
          </button>
        </div>
        <div className="mt-4 grid gap-3">
          {visibleAnswers.map((answer) => (
            <article
              className={`rounded-md border p-4 ${
                answer.is_correct
                  ? "border-line bg-paper"
                  : "border-coral bg-coral/10 shadow-sm"
              }`}
              key={answer.attempt_answer_id}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-gold">
                    Question {answer.question_order}
                  </p>
                  <h3 className="mt-1 font-bold">{answer.prompt}</h3>
                </div>
                <span
                  className={`rounded-full px-3 py-1 text-sm font-semibold text-white ${
                    answer.is_correct ? "bg-ocean" : "bg-coral"
                  }`}
                >
                  {answer.is_correct ? "Correct" : "Incorrect"}
                </span>
              </div>
              <dl className="mt-4 grid gap-3 text-sm">
                <div>
                  <dt className="font-semibold text-ink/60">Your answer</dt>
                  <dd className="mt-1">
                    {buildSentenceDisplay(answer.sentence_template, answer.submitted_order_text) ||
                      "No answer"}
                  </dd>
                </div>
                <div>
                  <dt className="font-semibold text-ink/60">Correct answer</dt>
                  <dd className="mt-1">
                    {buildSentenceDisplay(
                      answer.sentence_template,
                      answer.correct_order_text,
                      answer.final_sentence
                    )}
                  </dd>
                </div>
              </dl>
            </article>
          ))}
          {visibleAnswers.length === 0 && showIncorrectOnly ? (
            <p className="rounded-md border border-line bg-paper p-4 text-sm font-semibold">
              No incorrect answers.
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function resultCacheKey(attemptId: string) {
  return `practice-result:${attemptId}`;
}

function getErrorMessage(value: ResultPayload | { error?: string }, fallback: string) {
  return "error" in value && value.error ? value.error : fallback;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-paper p-4">
      <p className="text-sm font-semibold text-ink/60">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}

function formatDuration(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
