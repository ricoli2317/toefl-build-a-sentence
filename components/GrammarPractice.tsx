"use client";

import Link from "next/link";
import { useMemo } from "react";
import { BookOpen, Clock3, ListChecks } from "lucide-react";
import { PracticeSession } from "@/components/PracticeSession";
import {
  StudentEmptyState,
  StudentErrorState,
  StudentInfoStrip,
  StudentLoadingState,
  StudentNavigation
} from "@/components/student/StudentUI";
import {
  STUDENT_GRAMMAR_PRACTICE_CACHE_PREFIX,
  useStudentCachedData,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import type { GrammarTagSummary } from "@/lib/grammarPractice";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import { STUDENT_UI_TEXT } from "@/lib/studentUiText";
import type { PublicQuestion } from "@/lib/types";

export type GrammarTagsPayload = {
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
const GRAMMAR_TAG_ORDER = [
  "简单句－陈述句",
  "简单句－疑问句",
  "复杂句－陈述句－宾语从句",
  "复杂句－陈述句－定语从句",
  "复杂句－陈述句－状语从句",
  "复杂句－陈述句－表语从句",
  "复杂句－疑问句－宾语从句",
  "复杂句－疑问句－定语从句",
  "复杂句－疑问句－状语从句",
  "复杂句－疑问句－表语从句",
  "其他－并列句",
  "其他－后置定语",
  "其他－混合从句",
  "省略句"
] as const;

const GRAMMAR_TAG_PRIORITY: ReadonlyMap<string, number> = new Map(
  GRAMMAR_TAG_ORDER.map((tag, index) => [tag, index])
);

export function GrammarPracticeHome() {
  const { data, error, loading } = useGrammarTags();
  const sortedTags = useMemo(() => sortGrammarTags(data?.tags ?? []), [data?.tags]);

  return (
    <div className="grid gap-5">
      <GrammarNavigation />
      <StudentInfoStrip>选择语法点开始练习，系统会使用该分类下的题目生成练习。</StudentInfoStrip>
      {loading ? <StudentLoadingState text="正在加载语法点..." /> : null}
      {error ? <StudentErrorState text="加载语法点失败，请稍后重试。" /> : null}
      {!loading && !error ? (
        sortedTags.length === 0 ? (
          <StudentEmptyState text="暂无可练习的语法标签。" />
        ) : (
          <div className="grid gap-2">
            {sortedTags.map((item) => (
              <GrammarPracticeRow
                key={item.tag}
                label={item.tag}
                questionCount={item.questionCount}
              />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

function GrammarPracticeRow({
  label,
  questionCount
}: {
  label: string;
  questionCount: number;
}) {
  return (
    <article className="grid min-h-[58px] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 rounded-xl border border-student-border bg-white px-4 py-3 shadow-[0_1px_2px_rgba(23,32,51,0.025)] sm:px-5 lg:grid-cols-[minmax(0,1fr)_5.5rem_10rem_12rem] lg:gap-x-3 lg:py-2">
      <div className="flex min-w-0 items-center gap-3">
        <BookOpen
          aria-hidden="true"
          className="shrink-0 text-student-primary"
          size={23}
          strokeWidth={1.9}
        />
        <h2 className="min-w-0 text-[16px] font-semibold leading-6 text-student-text sm:text-[17px]">
          {label}
        </h2>
      </div>
      <p className="text-right text-[15px] font-medium tabular-nums text-student-muted lg:pr-2">
        {questionCount}题
      </p>
      <div className="col-span-2 grid grid-cols-2 gap-2 lg:contents">
        <GrammarAction href={practiceHref(label, "all")} icon={ListChecks} label="全部练习" />
        <GrammarAction href={practiceHref(label, "random")} icon={Clock3} label="随机计时练习" />
      </div>
    </article>
  );
}

function GrammarAction({
  href,
  icon: Icon,
  label
}: {
  href: string;
  icon: typeof ListChecks;
  label: string;
}) {
  return (
    <Link
      className="inline-flex min-h-9 min-w-0 items-center justify-center gap-2 rounded-[10px] bg-student-primary-soft px-3 py-1.5 text-sm font-semibold text-student-primary transition hover:bg-student-primary-border"
      href={href}
    >
      <Icon aria-hidden="true" className="shrink-0" size={19} strokeWidth={1.9} />
      <span className="whitespace-nowrap">{label}</span>
    </Link>
  );
}

function practiceHref(tag: string, mode: "all" | "random") {
  const params = new URLSearchParams({ mode, tag });
  return `${STUDENT_ROUTES.grammarPractice}/practice?${params.toString()}`;
}

function sortGrammarTags(tags: GrammarTagSummary[]) {
  return tags
    .map((tag, index) => ({ tag, index }))
    .sort((left, right) => {
      const leftPriority = grammarTagPriority(left.tag.tag);
      const rightPriority = grammarTagPriority(right.tag.tag);
      return (
        leftPriority - rightPriority ||
        (leftPriority === GRAMMAR_TAG_ORDER.length
          ? left.tag.tag.localeCompare(right.tag.tag, "zh-CN")
          : left.index - right.index)
      );
    })
    .map(({ tag }) => tag);
}

function grammarTagPriority(tag: string) {
  return GRAMMAR_TAG_PRIORITY.get(normalizeGrammarTagForSort(tag)) ?? GRAMMAR_TAG_ORDER.length;
}

function normalizeGrammarTagForSort(tag: string) {
  return tag
    .trim()
    .replace(/[\-‐‑‒–—―−]/g, "－")
    .replace(/\s*－\s*/g, "－")
    .replace(/\s+/g, " ");
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

  if (loading) return <StudentLoadingState text="正在加载语法练习..." />;
  if (error) return <StudentErrorState text="加载语法练习失败，请稍后重试。" />;
  if (!tag || questions.length === 0) {
    return (
      <div className="grid gap-5">
        <GrammarNavigation tag={tag || undefined} />
        <StudentEmptyState text="该语法标签暂无可练习题目，无法开始练习。" />
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
        { label: STUDENT_UI_TEXT.studentHome, href: STUDENT_ROUTES.home },
        ...(tag
          ? [{ label: STUDENT_UI_TEXT.grammarPractice, href: STUDENT_ROUTES.grammarPractice }]
          : [{ label: STUDENT_UI_TEXT.grammarPractice }]),
        ...(tag ? [{ label: tag }] : [])
      ]}
    />
  );
}

export function useGrammarTags() {
  return useStudentCachedData<GrammarTagsPayload>(
    `${STUDENT_GRAMMAR_PRACTICE_CACHE_PREFIX}:tags`,
    (session) => loadGrammarPractice("", session)
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
      : { error: "语法练习服务返回了空响应。" };
  } catch {
    payload = { error: "语法练习服务返回的数据格式无效。" };
  }

  if (!response.ok || payload.error) {
    throw new Error(payload.error ?? "无法加载语法练习。");
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
