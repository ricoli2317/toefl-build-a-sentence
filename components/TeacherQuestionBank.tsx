"use client";

import { useEffect, useState } from "react";
import { Eye } from "lucide-react";
import { buildSentenceDisplay, splitTextItems } from "@/lib/questionText";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { QuestionViewerNav } from "@/components/QuestionViewerNav";
import { TeacherBreadcrumbs } from "@/components/teacher/TeacherAppShell";
import { TeacherCard, TeacherEmptyState } from "@/components/teacher/TeacherUI";
import {
  PracticeMonthCard,
  PracticeSetAction,
  PracticeSetCatalogList
} from "@/components/shared/PracticeCatalog";
import { QuestionDisplay } from "@/components/shared/QuestionDisplay";
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

  if (loading) return <LoadingText text="正在加载练习月份..." />;
  if (error) return <ErrorText text={error} />;

  const months = data?.months ?? [];

  return (
    <div className="grid gap-5">
      <TeacherBreadcrumbs
        crumbs={[{ label: "首页", href: "/teacher/dashboard" }, { label: "查看所有套题" }]}
      />
      {months.length === 0 ? (
          <TeacherEmptyState text="暂无练习月份。" />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {months.map((month) => (
            <PracticeMonthCard
              href={`/teacher/question-bank/${encodeURIComponent(month.month_key)}`}
              key={month.month_key}
              month={month.month_label}
              questionCount={month.question_count}
              setCount={month.set_count}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function TeacherQuestionBankSets({ monthKey }: { monthKey: string }) {
  const { data, error, loading } = useQuestionBank({ month: monthKey });
  const monthLabel = getMonthLabel(data, monthKey);

  if (loading) return <LoadingText text="正在加载套题..." />;
  if (error) return <ErrorText text={error} />;

  const sets = data?.sets ?? [];

  return (
    <div className="grid gap-5">
      <TeacherBreadcrumbs
        crumbs={[
          { label: "首页", href: "/teacher/dashboard" },
          { label: "查看所有套题", href: "/teacher/question-bank" },
          { label: monthLabel }
        ]}
      />
      <PracticeSetCatalogList
        emptyState={<TeacherEmptyState text="该月份暂无套题。" />}
        renderActions={(set) => (
          <PracticeSetAction
            href={`/teacher/question-bank/${encodeURIComponent(monthKey)}/${encodeURIComponent(set.setId)}`}
            icon={Eye}
            label="查看题目"
          />
        )}
        sets={sets.map((set) => ({ setId: set.set_id, setTitle: set.set_title, questionCount: set.question_count }))}
      />
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

  if (loading) return <LoadingText text="正在加载题目..." />;
  if (error) return <ErrorText text={error} />;

  return (
    <div className="grid gap-5">
      <TeacherBreadcrumbs
        crumbs={[
          { label: "首页", href: "/teacher/dashboard" },
          { label: "查看所有套题", href: "/teacher/question-bank" },
          { label: monthLabel, href: `/teacher/question-bank/${encodeURIComponent(monthKey)}` },
          { label: setTitle }
        ]}
      />
      {questions.length === 0 || !currentQuestion ? (
        <TeacherEmptyState text="该套题暂无题目。" />
      ) : (
        <div className="grid gap-4">
          <QuestionDisplay
            answers={Array.from({ length: currentQuestion.blank_count }, () => null)}
            options={splitTextItems(currentQuestion.options_text).map((text, index) => ({ id: `${currentQuestion.question_id}-${index}`, text }))}
            prompt={currentQuestion.prompt}
            questionNumber={currentQuestion.question_order}
            readOnly
            template={currentQuestion.sentence_template}
          />
          <TeacherCard className="border-student-primary-border bg-student-primary-soft/55 p-5">
            <p className="text-sm font-semibold text-student-primary">正确答案</p>
            <p className="mt-2 text-lg font-semibold leading-7 text-student-text">
              {currentQuestion.final_sentence || buildSentenceDisplay(currentQuestion.sentence_template, currentQuestion.correct_order_text) || splitTextItems(currentQuestion.correct_order_text).join(" ")}
            </p>
          </TeacherCard>
          <QuestionViewerNav
            currentIndex={currentIndex}
            onChange={setCurrentIndex}
            questionCount={questions.length}
          />
        </div>
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
    cache: "no-store",
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

function getMonthLabel(data: QuestionBankPayload | null, monthKey: string) {
  return data?.months.find((month) => month.month_key === monthKey)?.month_label ?? monthKey;
}

function LoadingText({ text }: { text: string }) {
  return <p className="teacher-loading">{text}</p>;
}

function ErrorText({ text }: { text: string }) {
  return <p className="teacher-error">{text}</p>;
}
