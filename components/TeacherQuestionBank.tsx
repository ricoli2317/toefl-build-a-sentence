"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  buildSentenceDisplay,
  formatOptionChunk,
  formatTemplateText,
  isBlankToken,
  isTemplatePartSentenceStart,
  splitSentenceTemplate,
  splitTextItems
} from "@/lib/questionText";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { TeacherNavigation } from "@/components/TeacherDashboard";

type QuestionBankPayload = {
  months: MonthSummary[];
  sets: SetSummary[];
  questions: QuestionBankQuestion[];
  error?: string;
};

type MonthSummary = {
  month_key: string;
  month_label: string;
  question_count: number;
  set_count: number;
};

type SetSummary = {
  month_key: string;
  month_label: string;
  set_id: string;
  set_title: string;
  question_count: number;
};

type QuestionBankQuestion = {
  question_id: string;
  set_id: string;
  set_title: string;
  question_order: number;
  prompt: string;
  sentence_template: string;
  blank_count: number;
  options_text: string;
  correct_order_text: string;
  distractors_text: string;
  final_sentence: string;
  grammar_tags_text: string;
};

type LoadState = {
  data: QuestionBankPayload | null;
  error: string;
  loading: boolean;
};

export function TeacherQuestionBankMonths() {
  const { data, error, loading } = useQuestionBank();

  if (loading) return <LoadingText text="Loading practice months..." />;
  if (error) return <ErrorText text={error} />;

  const months = data?.months ?? [];

  return (
    <div className="grid gap-5">
      <TeacherNavigation
        backHref="/teacher/dashboard"
        crumbs={[
          { label: "Teacher Home", href: "/teacher/dashboard" },
          { label: "All Practice Sets" }
        ]}
      />
      {months.length === 0 ? (
        <EmptyPanel text="No practice months found." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {months.map((month) => (
            <Link
              className="rounded-lg border border-line bg-white p-6 shadow-sm hover:border-ocean"
              href={`/teacher/question-bank/${encodeURIComponent(month.month_key)}`}
              key={month.month_key}
            >
              <p className="text-sm font-semibold text-ocean">Practice Month</p>
              <h2 className="mt-1 text-2xl font-bold">{month.month_label}</h2>
              <div className="mt-4 grid gap-1 text-sm text-ink/70">
                <p>{month.set_count} set{month.set_count === 1 ? "" : "s"}</p>
                <p>{month.question_count} question{month.question_count === 1 ? "" : "s"}</p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function TeacherQuestionBankSets({ monthKey }: { monthKey: string }) {
  const { data, error, loading } = useQuestionBank({ month: monthKey });
  const monthLabel = getMonthLabel(data, monthKey);

  if (loading) return <LoadingText text="Loading practice sets..." />;
  if (error) return <ErrorText text={error} />;

  const sets = data?.sets ?? [];

  return (
    <div className="grid gap-5">
      <TeacherNavigation
        backHref="/teacher/question-bank"
        crumbs={[
          { label: "Teacher Home", href: "/teacher/dashboard" },
          { label: "All Practice Sets", href: "/teacher/question-bank" },
          { label: monthLabel }
        ]}
      />
      {sets.length === 0 ? (
        <EmptyPanel text="No practice sets found for this month." />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {sets.map((set) => (
            <Link
              className="rounded-lg border border-line bg-white p-5 shadow-sm hover:border-ocean"
              href={`/teacher/question-bank/${encodeURIComponent(monthKey)}/${encodeURIComponent(set.set_id)}`}
              key={set.set_id}
            >
              <p className="text-lg font-bold text-ocean">{set.set_title}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function TeacherQuestionBankSetViewer({
  monthKey,
  setId
}: {
  monthKey: string;
  setId: string;
}) {
  const { data, error, loading } = useQuestionBank({ setId });
  const [currentIndex, setCurrentIndex] = useState(0);
  const questions = data?.questions ?? [];
  const currentQuestion = questions[currentIndex];
  const setTitle = currentQuestion?.set_title ?? data?.sets[0]?.set_title ?? setId;
  const monthLabel = getMonthLabel(data, monthKey);

  useEffect(() => {
    setCurrentIndex(0);
  }, [setId]);

  if (loading) return <LoadingText text="Loading questions..." />;
  if (error) return <ErrorText text={error} />;

  return (
    <div className="grid gap-5">
      <TeacherNavigation
        backHref={`/teacher/question-bank/${encodeURIComponent(monthKey)}`}
        crumbs={[
          { label: "Teacher Home", href: "/teacher/dashboard" },
          { label: "All Practice Sets", href: "/teacher/question-bank" },
          { label: monthLabel, href: `/teacher/question-bank/${encodeURIComponent(monthKey)}` },
          { label: setTitle }
        ]}
      />
      {questions.length === 0 || !currentQuestion ? (
        <EmptyPanel text="No questions found for this set." />
      ) : (
        <article className="rounded-lg border border-line bg-white p-5 shadow-sm">
          <div>
            <div>
              <p className="text-sm font-semibold text-gold">Q{currentIndex + 1}</p>
              <h2 className="mt-1 text-xl font-bold">{currentQuestion.prompt}</h2>
            </div>
          </div>

          <div className="mt-6 text-lg leading-10">
            <ReadOnlySentenceTemplate
              blankCount={currentQuestion.blank_count}
              template={currentQuestion.sentence_template}
            />
          </div>

          <div className="mt-6">
            <div className="flex flex-wrap justify-center gap-3 text-center">
              {splitTextItems(currentQuestion.options_text).map((chunk, index) => (
                <span
                  className="inline-flex min-h-12 items-center justify-center rounded-md border border-line bg-white px-4 py-2 text-base font-semibold"
                  key={`${chunk}-${index}`}
                >
                  {formatOptionChunk(chunk)}
                </span>
              ))}
            </div>
          </div>

          <section className="mt-6 rounded-md border border-line bg-paper p-4">
            <p className="text-sm font-semibold uppercase tracking-wide text-ink/50">
              Correct Answer
            </p>
            <p className="mt-2 text-lg font-semibold">
              {currentQuestion.final_sentence ||
                buildSentenceDisplay(
                  currentQuestion.sentence_template,
                  currentQuestion.correct_order_text
                ) ||
                splitTextItems(currentQuestion.correct_order_text).join(" ")}
            </p>
          </section>

          <QuestionViewerNav
            currentIndex={currentIndex}
            onChange={setCurrentIndex}
            questionCount={questions.length}
          />
        </article>
      )}
    </div>
  );
}

function useQuestionBank(params?: { month?: string; setId?: string }): LoadState {
  const [state, setState] = useState<LoadState>({
    data: null,
    error: "",
    loading: true
  });
  const query = useMemo(() => {
    const searchParams = new URLSearchParams();
    if (params?.month) searchParams.set("month", params.month);
    if (params?.setId) searchParams.set("setId", params.setId);
    const queryString = searchParams.toString();
    return queryString ? `?${queryString}` : "";
  }, [params?.month, params?.setId]);

  useEffect(() => {
    let ignore = false;

    async function loadQuestionBank() {
      setState({ data: null, error: "", loading: true });

      try {
        const supabase = createBrowserSupabase();
        const {
          data: { session }
        } = await supabase.auth.getSession();

        const response = await fetch(`/api/teacher/question-bank${query}`, {
          headers: {
            Authorization: `Bearer ${session?.access_token ?? ""}`
          }
        });
        const responseText = await response.text();
        let payload: QuestionBankPayload;

        try {
          payload = responseText
            ? JSON.parse(responseText)
            : { error: "The question bank API returned an empty response.", months: [], questions: [], sets: [] };
        } catch {
          payload = {
            error: "The question bank API returned invalid JSON.",
            months: [],
            questions: [],
            sets: []
          };
        }

        if (ignore) return;

        if (!response.ok) {
          setState({
            data: null,
            error: payload.error ?? "Could not load question bank.",
            loading: false
          });
        } else {
          setState({ data: payload, error: "", loading: false });
        }
      } catch (error) {
        if (!ignore) {
          setState({
            data: null,
            error: error instanceof Error ? error.message : "Could not load question bank.",
            loading: false
          });
        }
      }
    }

    loadQuestionBank();

    return () => {
      ignore = true;
    };
  }, [query]);

  return state;
}

function ReadOnlySentenceTemplate({
  blankCount,
  template
}: {
  blankCount: number;
  template: string;
}) {
  const parts = splitSentenceTemplate(template);
  let blankIndex = 0;

  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-3">
      {parts.map((part, index) => {
        if (isBlankToken(part)) {
          const currentBlankIndex = blankIndex;
          blankIndex += 1;

          return <BlankLabel index={currentBlankIndex} key={`${part}-${index}`} />;
        }

        return part ? (
          <span className="whitespace-pre-wrap" key={`${part}-${index}`}>
            {formatTemplateText(part, isTemplatePartSentenceStart(parts, index))}
          </span>
        ) : null;
      })}
      {Array.from({ length: Math.max(0, blankCount - blankIndex) }, (_, index) => (
        <BlankLabel index={blankIndex + index} key={`extra-blank-${blankIndex + index}`} />
      ))}
    </p>
  );
}

function BlankLabel({ index }: { index: number }) {
  return (
    <span className="inline-flex min-h-11 min-w-32 items-center justify-center rounded-md border border-dashed border-ink/40 bg-paper px-4 text-base font-semibold text-ink/40">
      Blank {index + 1}
    </span>
  );
}

function QuestionViewerNav({
  currentIndex,
  onChange,
  questionCount
}: {
  currentIndex: number;
  onChange: (index: number) => void;
  questionCount: number;
}) {
  return (
    <div className="mt-6 grid gap-4">
      <div className="flex flex-wrap justify-center gap-2">
        {Array.from({ length: questionCount }, (_, index) => (
          <button
            className={`rounded-md border px-3 py-2 text-sm font-bold ${
              currentIndex === index
                ? "border-ocean bg-ocean/10 text-ocean"
                : "border-line bg-white hover:border-ocean"
            }`}
            key={index}
            onClick={() => onChange(index)}
            type="button"
          >
            Q{index + 1}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap justify-end gap-3">
        <button
          className="rounded-md bg-ink px-5 py-3 font-semibold text-white hover:bg-ocean disabled:cursor-not-allowed disabled:opacity-50"
          disabled={currentIndex === 0}
          onClick={() => onChange(currentIndex - 1)}
          type="button"
        >
          Previous
        </button>
        <button
          className="rounded-md bg-ink px-5 py-3 font-semibold text-white hover:bg-ocean disabled:cursor-not-allowed disabled:opacity-50"
          disabled={currentIndex === questionCount - 1}
          onClick={() => onChange(currentIndex + 1)}
          type="button"
        >
          Next
        </button>
      </div>
    </div>
  );
}

function getMonthLabel(data: QuestionBankPayload | null, monthKey: string) {
  return data?.months.find((month) => month.month_key === monthKey)?.month_label ?? monthKey;
}

function LoadingText({ text }: { text: string }) {
  return <p className="text-sm text-ink/70">{text}</p>;
}

function ErrorText({ text }: { text: string }) {
  return <p className="font-semibold text-coral">{text}</p>;
}

function EmptyPanel({ text }: { text: string }) {
  return <p className="rounded-lg border border-line bg-white p-5">{text}</p>;
}
