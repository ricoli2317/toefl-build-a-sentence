"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
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
import { QuestionViewerNav } from "@/components/QuestionViewerNav";
import { TeacherNavigation } from "@/components/TeacherDashboard";
import {
  TEACHER_QUESTION_BANK_CACHE_PREFIX,
  useTeacherCachedData
} from "@/components/TeacherDataCache";

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
  const state = useTeacherCachedData<QuestionBankPayload>(
    `${TEACHER_QUESTION_BANK_CACHE_PREFIX}:all`,
    loadQuestionBank
  );
  if (!state.data || (!params?.month && !params?.setId)) return state;

  const sets = params.setId
    ? state.data.sets.filter((set) => set.set_id === params.setId)
    : state.data.sets.filter((set) => set.month_key === params.month);
  const setIds = new Set(sets.map((set) => set.set_id));

  return {
    ...state,
    data: {
      months: state.data.months,
      sets,
      questions: state.data.questions.filter((question) => setIds.has(question.set_id))
    }
  };
}

async function loadQuestionBank() {
  const supabase = createBrowserSupabase();
  const {
    data: { session }
  } = await supabase.auth.getSession();

  const response = await fetch("/api/teacher/question-bank", {
    headers: {
      Authorization: `Bearer ${session?.access_token ?? ""}`
    }
  });
  const responseText = await response.text();
  let payload: QuestionBankPayload;

  try {
    payload = responseText
      ? JSON.parse(responseText)
      : {
          error: "The question bank API returned an empty response.",
          months: [],
          questions: [],
          sets: []
        };
  } catch {
    payload = {
      error: "The question bank API returned invalid JSON.",
      months: [],
      questions: [],
      sets: []
    };
  }

  if (!response.ok || payload.error) {
    throw new Error(payload.error ?? "Could not load question bank.");
  }

  return payload;
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
