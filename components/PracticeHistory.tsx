"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { AttemptHistoryList } from "@/components/AttemptHistoryList";
import {
  STUDENT_PRACTICE_HISTORY_CACHE_PREFIX,
  useStudentCachedData,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import { StudentNavigation } from "@/components/SetList";
import {
  buildSentenceDisplay,
  formatOptionChunk,
  formatTemplateText,
  isBlankToken,
  isTemplatePartSentenceStart,
  splitSentenceTemplate,
  splitTextItems
} from "@/lib/questionText";
import type {
  PracticeHistoryAnswer,
  PracticeHistoryPayload,
  PracticeHistoryScopeSummary
} from "@/lib/practiceHistory";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";

export type HistoryScope = "history" | "today";

export function PracticeHistoryDashboard({ scope }: { scope: HistoryScope }) {
  const { data, error, loading } = usePracticeHistory();

  if (loading) return <LoadingText text="Loading practice history..." />;
  if (error || !data) return <ErrorText text={error || "Practice history is unavailable."} />;

  const summary = data[scope];
  return (
    <div className="grid gap-5">
      <HistoryNavigation backHref={STUDENT_ROUTES.home} />
      <div className="flex flex-wrap gap-2 border-b border-line">
        <ScopeTab
          active={scope === "today"}
          href={`${STUDENT_ROUTES.practiceHistory}?tab=today`}
          label="今日套题练习情况"
        />
        <ScopeTab
          active={scope === "history"}
          href={`${STUDENT_ROUTES.practiceHistory}?tab=history`}
          label="历史套题练习情况"
        />
      </div>
      <ScopeMetrics scope={scope} summary={summary} />
      {scope === "history" ? <GrammarPoints summary={summary} /> : null}
    </div>
  );
}

export function PracticeHistorySetList({ scope }: { scope: HistoryScope }) {
  const { data, error, loading } = usePracticeHistory();
  if (loading) return <LoadingText text="Loading practice sets..." />;
  if (error || !data) return <ErrorText text={error || "Practice sets are unavailable."} />;

  const title = scope === "today" ? "今日练习套题" : "历史练习套题";
  return (
    <div className="grid gap-5">
      <HistoryNavigation
        backHref={practiceHistoryHomeHref(scope)}
        crumbs={[
          { label: "Student Home", href: STUDENT_ROUTES.home },
          { label: "Practice History", href: practiceHistoryHomeHref(scope) },
          { label: title }
        ]}
      />
      <div className="grid gap-4 md:grid-cols-2">
        {data[scope].sets.map((set) => (
          <Link
            className="rounded-lg border border-line bg-white p-5 shadow-sm hover:border-ocean"
            href={`${STUDENT_ROUTES.practiceHistory}/sets/${encodeURIComponent(set.setId)}?scope=${scope}`}
            key={set.setId}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-ocean">{set.setId}</p>
                <h2 className="mt-1 text-xl font-bold">{set.setTitle}</h2>
              </div>
              <span className="rounded-full bg-paper px-3 py-1 text-xs font-semibold">
                {set.attemptCount} attempt{set.attemptCount === 1 ? "" : "s"}
              </span>
            </div>
            <p className="mt-4 text-sm text-ink/60">
              Average accuracy {formatPercent(set.averageAccuracy)}
            </p>
          </Link>
        ))}
        {data[scope].sets.length === 0 ? (
          <EmptyState text={scope === "today" ? "今日暂无普通套题练习。" : "暂无普通套题练习历史。"} />
        ) : null}
      </div>
    </div>
  );
}

export function PracticeHistorySetAttempts({
  scope,
  setId
}: {
  scope: HistoryScope;
  setId: string;
}) {
  const { data, error, loading } = usePracticeHistory();
  if (loading) return <LoadingText text="Loading attempts..." />;
  if (error || !data) return <ErrorText text={error || "Attempts are unavailable."} />;

  const attempts = data.attempts.filter((attempt) => attempt.setId === setId);
  const attemptIds = new Set(attempts.map((attempt) => attempt.attemptId));
  const answers = data.answers.filter((answer) => attemptIds.has(answer.attemptId));
  const title = attempts[0]?.setTitle ?? setId;

  return (
    <div className="grid gap-5">
      <HistoryNavigation
        backHref={practiceHistorySetsHref(scope)}
        crumbs={[
          { label: "Student Home", href: STUDENT_ROUTES.home },
          { label: "Practice History", href: practiceHistoryHomeHref(scope) },
          {
            label: scope === "today" ? "今日练习套题" : "历史练习套题",
            href: practiceHistorySetsHref(scope)
          },
          { label: setId }
        ]}
      />
      <div>
        <p className="text-sm font-semibold text-ink/60">Set attempts</p>
        <h2 className="text-2xl font-bold">{title}</h2>
        <p className="text-sm text-ink/60">{setId}</p>
      </div>
      <AttemptHistoryList
        answers={answers}
        attempts={attempts}
        getAnswerHref={(answer) => {
          const params = new URLSearchParams({
            setId,
            source: `practice-history-${scope}`
          });
          return `/student/results/${encodeURIComponent(answer.attemptId)}?${params.toString()}#question-${encodeURIComponent(answer.questionId)}`;
        }}
        missingAnswerAttemptIds={data.missingAnswerAttemptIds.filter((attemptId) =>
          attemptIds.has(attemptId)
        )}
      />
    </div>
  );
}

export function PracticeHistoryErrorSummary({ scope }: { scope: HistoryScope }) {
  const { data, error, loading } = usePracticeHistory();
  const [page, setPage] = useState(1);
  const listTopRef = useRef<HTMLDivElement>(null);
  const pageSize = 10;

  if (loading) return <LoadingText text="Loading wrong question summary..." />;
  if (error || !data) return <ErrorText text={error || "Wrong questions are unavailable."} />;

  const errors = data[scope].errors;
  const pageCount = Math.max(1, Math.ceil(errors.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const startIndex = (safePage - 1) * pageSize;
  const visibleErrors = errors.slice(startIndex, startIndex + pageSize);
  const title = scope === "today" ? "今日错题汇总" : "历史错题汇总";

  function goToPage(nextPage: number) {
    setPage(nextPage);
    window.requestAnimationFrame(() => {
      listTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  return (
    <div className="grid gap-5">
      <HistoryNavigation
        backHref={practiceHistoryHomeHref(scope)}
        crumbs={[
          { label: "Student Home", href: STUDENT_ROUTES.home },
          { label: "Practice History", href: practiceHistoryHomeHref(scope) },
          { label: title }
        ]}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-ocean">Read-only review</p>
          <h2 className="text-2xl font-bold">{title}</h2>
        </div>
        <Link
          className="rounded-md bg-ocean px-4 py-2 font-semibold text-white hover:bg-ink"
          href={STUDENT_ROUTES.wrongQuestions}
        >
          订正错题
        </Link>
      </div>
      <div className="grid scroll-mt-5 gap-3" ref={listTopRef}>
        {visibleErrors.length > 0 ? (
          <QuestionRangeBar
            end={startIndex + visibleErrors.length}
            start={startIndex + 1}
            total={errors.length}
          />
        ) : null}
        {visibleErrors.length === 0 ? (
          <EmptyState text={scope === "today" ? "今日普通套题练习中没有错题。" : "普通套题练习历史中没有错题。"} />
        ) : (
          <div className="grid gap-3">
            {visibleErrors.map((answer, index) => (
              <WrongAnswerCard
                answer={answer}
                key={`${answer.attemptAnswerId}-${index}`}
                number={startIndex + index + 1}
              />
            ))}
          </div>
        )}
      </div>
      <nav aria-label="Wrong question pages" className="flex flex-wrap justify-center gap-2">
        {Array.from({ length: pageCount }, (_, index) => index + 1).map((pageNumber) => (
          <button
            aria-current={pageNumber === safePage ? "page" : undefined}
            className={`min-w-10 rounded-md border px-3 py-2 font-semibold ${
              pageNumber === safePage
                ? "border-ocean bg-ocean text-white"
                : "border-line bg-white hover:border-ocean"
            }`}
            key={pageNumber}
            onClick={() => goToPage(pageNumber)}
            type="button"
          >
            {pageNumber}
          </button>
        ))}
      </nav>
    </div>
  );
}

function ScopeMetrics({
  scope,
  summary
}: {
  scope: HistoryScope;
  summary: PracticeHistoryScopeSummary;
}) {
  const prefix = scope === "today" ? "今日" : "";
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <MetricLink
        disabled={summary.setCount === 0}
        href={`${STUDENT_ROUTES.practiceHistory}/sets?scope=${scope}`}
        label={scope === "today" ? "今日练习套题数" : "总练习套题数"}
        value={String(summary.setCount)}
      />
      <MetricCard
        label={scope === "today" ? "今日平均正确率" : "历史平均正确率"}
        value={summary.averageAccuracy === null ? "—" : formatPercent(summary.averageAccuracy)}
      />
      <MetricLink
        disabled={summary.errorCount === 0}
        href={`${STUDENT_ROUTES.practiceHistory}/errors?scope=${scope}`}
        label={`${prefix || "历史"}错误题数`}
        value={String(summary.errorCount)}
      />
    </div>
  );
}

function GrammarPoints({ summary }: { summary: PracticeHistoryScopeSummary }) {
  const highestCount = summary.grammarPoints[0]?.count ?? 0;
  return (
    <section className="rounded-lg border border-line bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-bold">高频错误语法点</h2>
        <Link
          className="rounded-md bg-ocean px-4 py-2 text-sm font-semibold text-white hover:bg-ink"
          href={STUDENT_ROUTES.grammarPractice}
        >
          按语法分类练习
        </Link>
      </div>
      <div className="mt-4 border-t border-line" />
      {summary.grammarPoints.length === 0 ? (
        <p className="pt-4 text-sm text-ink/60">暂无高频错误语法点。</p>
      ) : (
        <ol>
          {summary.grammarPoints.map((item, index) => (
            <li
              className="grid grid-cols-[2rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 border-b border-line/70 py-3 last:border-b-0 sm:grid-cols-[2rem_minmax(12rem,1fr)_minmax(10rem,2fr)]"
              key={item.tag}
            >
              <span
                className={`inline-flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ${rankBadgeClass(index)}`}
              >
                {index + 1}
              </span>
              <span className="min-w-0 font-semibold leading-6">{item.tag}</span>
              <div
                aria-label={`${item.tag} relative error frequency`}
                className="col-start-2 h-2.5 overflow-hidden rounded-full bg-paper sm:col-start-3"
              >
                <div
                  className="h-full rounded-full bg-ocean"
                  style={{
                    width: `${Math.max(10, highestCount > 0 ? (item.count / highestCount) * 100 : 0)}%`
                  }}
                />
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function QuestionRangeBar({
  end,
  start,
  total
}: {
  end: number;
  start: number;
  total: number;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border border-line bg-white px-4 py-3 shadow-sm">
      <p className="text-sm font-semibold text-ocean">
        Questions {start}–{end}/{total}
      </p>
    </div>
  );
}

function WrongAnswerCard({
  answer,
  number
}: {
  answer: PracticeHistoryAnswer;
  number: number;
}) {
  return (
    <article className="rounded-lg border border-line bg-white p-4 shadow-sm">
      <p className="text-sm font-bold text-gold">Q{number}</p>
      <p className="mt-2 text-lg font-bold">{answer.prompt || "No prompt"}</p>
      <div className="mt-3 text-base leading-8">
        <ReadOnlySentenceTemplate template={answer.sentenceTemplate} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {splitTextItems(answer.optionsText).map((chunk, index) => (
          <span
            className="inline-flex min-h-9 items-center justify-center rounded-md border border-line bg-paper px-3 py-1.5 text-sm font-semibold"
            key={`${chunk}-${index}`}
          >
            {formatOptionChunk(chunk)}
          </span>
        ))}
      </div>
      <div className="mt-3 rounded-md border border-line bg-paper p-3">
        <p className="text-sm font-semibold text-ink/60">Student Answer</p>
        <p className="mt-1 leading-7">
          {buildSentenceDisplay(answer.sentenceTemplate, answer.submittedOrderText) || "No answer"}
        </p>
      </div>
    </article>
  );
}

function ReadOnlySentenceTemplate({ template }: { template: string }) {
  const parts = splitSentenceTemplate(template);
  let blankIndex = 0;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-2">
      {parts.map((part, index) => {
        if (isBlankToken(part)) {
          blankIndex += 1;
          return (
            <span
              aria-label={`Blank ${blankIndex}`}
              className="inline-block min-w-24 border-b-2 border-ink/50"
              key={`${part}-${index}`}
            >
              &nbsp;
            </span>
          );
        }
        return part ? (
          <span className="whitespace-pre-wrap" key={`${part}-${index}`}>
            {formatTemplateText(part, isTemplatePartSentenceStart(parts, index))}
          </span>
        ) : null;
      })}
    </p>
  );
}

function HistoryNavigation({
  backHref = STUDENT_ROUTES.practiceHistory,
  crumbs
}: {
  backHref?: string;
  crumbs?: Array<{ href?: string; label: string }>;
}) {
  return (
    <StudentNavigation
      backHref={backHref}
      crumbs={crumbs ?? [
        { label: "Student Home", href: STUDENT_ROUTES.home },
        { label: "Practice History" }
      ]}
    />
  );
}

function ScopeTab({ active, href, label }: { active: boolean; href: string; label: string }) {
  return (
    <Link
      aria-selected={active}
      className={`border-b-2 px-4 py-3 font-semibold ${
        active ? "border-ocean text-ocean" : "border-transparent text-ink/60 hover:text-ink"
      }`}
      href={href}
      role="tab"
    >
      {label}
    </Link>
  );
}

function practiceHistoryHomeHref(scope: HistoryScope) {
  return `${STUDENT_ROUTES.practiceHistory}?tab=${scope}`;
}

function practiceHistorySetsHref(scope: HistoryScope) {
  return `${STUDENT_ROUTES.practiceHistory}/sets?scope=${scope}`;
}

function rankBadgeClass(index: number) {
  if (index === 0) return "bg-gold/30 text-amber-900 ring-1 ring-gold/60";
  if (index === 1) return "bg-slate-200 text-slate-700 ring-1 ring-slate-300";
  if (index === 2) return "bg-orange-100 text-orange-900 ring-1 ring-orange-300";
  return "bg-paper text-ink/60 ring-1 ring-line";
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-white p-4 shadow-sm">
      <p className="text-sm font-semibold text-ink/60">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}

function MetricLink({
  disabled,
  href,
  label,
  value
}: {
  disabled: boolean;
  href: string;
  label: string;
  value: string;
}) {
  if (disabled) return <MetricCard label={label} value={value} />;
  return (
    <Link className="rounded-md border border-line bg-white p-4 shadow-sm hover:border-ocean" href={href}>
      <p className="text-sm font-semibold text-ink/60">{label}</p>
      <p className="mt-1 text-2xl font-bold text-ocean underline decoration-ocean/30 underline-offset-4">{value}</p>
    </Link>
  );
}

function EmptyState({ text }: { text: string }) {
  return <p className="rounded-lg border border-line bg-white p-5 text-ink/60">{text}</p>;
}

function LoadingText({ text }: { text: string }) {
  return <p className="text-sm text-ink/70">{text}</p>;
}

function ErrorText({ text }: { text: string }) {
  return <p className="font-semibold text-coral">{text}</p>;
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function usePracticeHistory() {
  const range = useMemo(getTodayRange, []);
  const query = useMemo(() => {
    const params = new URLSearchParams({ todayStart: range.start, todayEnd: range.end });
    return params.toString();
  }, [range.end, range.start]);
  return useStudentCachedData<PracticeHistoryPayload>(
    `${STUDENT_PRACTICE_HISTORY_CACHE_PREFIX}:${query}`,
    (session) => loadPracticeHistory(query, session)
  );
}

async function loadPracticeHistory(query: string, session: StudentCacheSession) {
  const response = await fetch(`/api/practice-history?${query}`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${session.accessToken}` }
  });
  const text = await response.text();
  let payload: PracticeHistoryPayload | { error?: string };
  try {
    payload = text ? JSON.parse(text) : { error: "The practice history API returned an empty response." };
  } catch {
    payload = { error: "The practice history API returned invalid JSON." };
  }
  if (!response.ok || "error" in payload) {
    throw new Error(("error" in payload && payload.error) || "Could not load practice history.");
  }
  return payload as PracticeHistoryPayload;
}

function getTodayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}
