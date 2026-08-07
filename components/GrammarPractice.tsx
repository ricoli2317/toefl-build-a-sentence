"use client";

import Link from "next/link";
import { useMemo } from "react";
import { PracticeSession } from "@/components/PracticeSession";
import { StudentNavigation } from "@/components/SetList";
import {
  STUDENT_GRAMMAR_PRACTICE_CACHE_PREFIX,
  useStudentCachedData,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import type { GrammarTagSummary } from "@/lib/grammarPractice";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import type { PublicQuestion } from "@/lib/types";

type GrammarTagsPayload = {
  error?: string;
  tags?: GrammarTagSummary[];
};

type GrammarQuestionsPayload = {
  count?: number;
  error?: string;
  questions?: PublicQuestion[];
  tag?: string;
};

const GRAMMAR_RANDOM_TIME_SECONDS = 6 * 60 + 50;

export function GrammarPracticeHome() {
  const { data, error, loading } = useStudentCachedData<GrammarTagsPayload>(
    `${STUDENT_GRAMMAR_PRACTICE_CACHE_PREFIX}:tags`,
    (session) => loadGrammarPractice("", session)
  );
  const tags = data?.tags ?? [];

  return (
    <div className="grid gap-5">
      <GrammarNavigation />
      {loading ? <LoadingText text="Loading grammar points..." /> : null}
      {error ? <ErrorText text={error} /> : null}
      {!loading && !error ? (
        <div className="grid gap-4 md:grid-cols-2">
          {tags.map((item) => (
            <Link
              className="rounded-lg border border-line bg-white p-5 shadow-sm hover:border-ocean"
              href={`${STUDENT_ROUTES.grammarPractice}?tag=${encodeURIComponent(item.tag)}`}
              key={item.tag}
            >
              <p className="text-sm font-semibold text-ocean">Grammar Point</p>
              <h2 className="mt-1 text-xl font-bold">{item.tag}</h2>
              <span className="mt-4 inline-flex rounded-full bg-paper px-3 py-1 text-xs font-semibold">
                {item.questionCount} question{item.questionCount === 1 ? "" : "s"}
              </span>
            </Link>
          ))}
          {tags.length === 0 ? (
            <p className="rounded-lg border border-line bg-white p-5 shadow-sm">
              暂无可练习的语法标签。
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function GrammarPracticeModeSelect({ tag }: { tag: string }) {
  const { data, error, loading } = useStudentCachedData<GrammarTagsPayload>(
    `${STUDENT_GRAMMAR_PRACTICE_CACHE_PREFIX}:tags`,
    (session) => loadGrammarPractice("", session)
  );
  const summary = data?.tags?.find((item) => item.tag === tag);
  const practiceHref = (mode: "all" | "random") => {
    const params = new URLSearchParams({ mode, tag });
    return `${STUDENT_ROUTES.grammarPractice}/practice?${params.toString()}`;
  };

  return (
    <div className="grid gap-5">
      <GrammarNavigation tag={tag} />
      {loading ? <LoadingText text="Loading grammar point..." /> : null}
      {error ? <ErrorText text={error} /> : null}
      {!loading && !error && !summary ? (
        <p className="rounded-lg border border-line bg-white p-5 shadow-sm">
          该语法标签暂无可练习题目。
        </p>
      ) : null}
      {summary ? (
        <>
          <section className="rounded-lg border border-line bg-white p-5 shadow-sm">
            <p className="text-sm font-semibold text-ocean">Selected Grammar Point</p>
            <h2 className="mt-1 text-2xl font-bold">{summary.tag}</h2>
            <p className="mt-2 text-sm text-ink/60">
              {summary.questionCount} unique question{summary.questionCount === 1 ? "" : "s"}
            </p>
          </section>
          <div className="grid gap-4 md:grid-cols-2">
            <Link
              className="rounded-lg border border-line bg-white p-5 shadow-sm hover:border-ocean"
              href={practiceHref("all")}
            >
              <p className="text-sm font-semibold text-ocean">全部练习</p>
              <h2 className="mt-1 text-2xl font-bold">Practice All</h2>
              <p className="mt-2 text-sm leading-6 text-ink/70">
                不计时，练习该语法点的全部去重题目。
              </p>
            </Link>
            <Link
              className="rounded-lg border border-line bg-white p-5 shadow-sm hover:border-ocean"
              href={practiceHref("random")}
            >
              <p className="text-sm font-semibold text-ocean">随机计时练习</p>
              <h2 className="mt-1 text-2xl font-bold">Random Timed Practice</h2>
              <p className="mt-2 text-sm leading-6 text-ink/70">
                随机最多 10 题，固定倒计时 6:50。
              </p>
            </Link>
          </div>
        </>
      ) : null}
    </div>
  );
}

export function GrammarQuestionsPractice({
  mode,
  tag
}: {
  mode: "all" | "random";
  tag: string;
}) {
  const practiceSessionKey = useMemo(
    () => `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    []
  );
  const query = useMemo(() => new URLSearchParams({ mode, tag }).toString(), [mode, tag]);
  const { data, error, loading } = useStudentCachedData<GrammarQuestionsPayload>(
    `${STUDENT_GRAMMAR_PRACTICE_CACHE_PREFIX}:session:${practiceSessionKey}`,
    (session) => loadGrammarPractice(query, session)
  );
  const questions = data?.questions ?? [];
  const virtualSetId = useMemo(
    () => `grammar-${mode === "random" ? "random" : "all"}-${formatTimestamp(new Date())}`,
    [mode]
  );

  if (loading) return <LoadingText text="Loading grammar practice..." />;
  if (error) return <ErrorText text={error} />;
  if (!tag || questions.length === 0) {
    return (
      <div className="grid gap-5">
        <GrammarNavigation tag={tag || undefined} />
        <p className="rounded-lg border border-line bg-white p-5 shadow-sm">
          该语法标签暂无可练习题目，无法开始练习。
        </p>
      </div>
    );
  }

  return (
    <PracticeSession
      allowEndPractice={mode === "all"}
      hideQuestionCardNumber
      initialQuestions={questions}
      setId={virtualSetId}
      setTitle={`Grammar Practice · ${tag}`}
      submitAnsweredOnly={mode === "all"}
      timed={mode === "random"}
      totalSeconds={GRAMMAR_RANDOM_TIME_SECONDS}
    />
  );
}

function GrammarNavigation({ tag }: { tag?: string }) {
  return (
    <StudentNavigation
      backHref={tag ? STUDENT_ROUTES.grammarPractice : STUDENT_ROUTES.home}
      crumbs={[
        { label: "Student Home", href: STUDENT_ROUTES.home },
        ...(tag
          ? [{ label: "Grammar Practice", href: STUDENT_ROUTES.grammarPractice }]
          : [{ label: "Grammar Practice" }]),
        ...(tag ? [{ label: tag }] : [])
      ]}
    />
  );
}

async function loadGrammarPractice(query: string, session: StudentCacheSession) {
  const response = await fetch(`/api/grammar-practice${query ? `?${query}` : ""}`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${session.accessToken}` }
  });
  const responseText = await response.text();
  let payload: GrammarTagsPayload | GrammarQuestionsPayload;

  try {
    payload = responseText
      ? JSON.parse(responseText)
      : { error: "The grammar practice API returned an empty response." };
  } catch {
    payload = { error: "The grammar practice API returned invalid JSON." };
  }

  if (!response.ok || payload.error) {
    throw new Error(payload.error ?? "Could not load grammar practice.");
  }
  return payload;
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
