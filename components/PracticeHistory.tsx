"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { ArrowRight, CircleCheckBig, CircleX, LibraryBig, Target, type LucideIcon } from "lucide-react";
import { AttemptHistoryList } from "@/components/AttemptHistoryList";
import { PracticeHistoryCompactList } from "@/components/shared/PracticeHistoryCards";
import {
  STUDENT_PRACTICE_HISTORY_CACHE_PREFIX,
  useStudentCachedData,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import {
  StudentEmptyState,
  StudentErrorGrammarPanel,
  StudentErrorState,
  StudentLoadingState,
  StudentNavigation
} from "@/components/student/StudentUI";
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
import { STUDENT_UI_TEXT } from "@/lib/studentUiText";

export type HistoryScope = "history" | "today";

export function PracticeHistoryDashboard() {
  const { data, error, loading } = usePracticeHistory();

  if (loading) return <StudentLoadingState text="正在加载练习历史..." />;
  if (error || !data) return <StudentErrorState text="加载练习历史失败，请稍后重试。" />;

  return (
    <div>
      <HistoryNavigation backHref={STUDENT_ROUTES.home} />
      <HistorySection className="mt-7" title="今日练习情况">
        <ScopeMetrics scope="today" summary={data.today} />
      </HistorySection>
      <HistorySection className="mt-6" title="历史练习情况">
        <ScopeMetrics scope="history" summary={data.history} />
      </HistorySection>
      <div className="mt-5">
        <StudentErrorGrammarPanel items={data.history.grammarPoints} />
      </div>
    </div>
  );
}

function HistorySection({
  children,
  className,
  title
}: {
  children: React.ReactNode;
  className?: string;
  title: string;
}) {
  return (
    <section className={className}>
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="h-5 w-1 rounded-full bg-student-primary" />
        <h2 className="text-lg font-bold leading-6 text-student-text">{title}</h2>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function PracticeHistorySetList({ scope }: { scope: HistoryScope }) {
  const { data, error, loading } = usePracticeHistory();
  if (loading) return <StudentLoadingState text="正在加载练习套题..." />;
  if (error || !data) return <StudentErrorState text="加载练习套题失败，请稍后重试。" />;

  const title = scope === "today" ? "今日练习套题" : "历史练习套题";
  return (
    <div className="grid gap-5">
      <HistoryNavigation
        backHref={practiceHistoryHomeHref(scope)}
        crumbs={[
          { label: STUDENT_UI_TEXT.studentHome, href: STUDENT_ROUTES.home },
          { label: STUDENT_UI_TEXT.practiceHistory, href: practiceHistoryHomeHref(scope) },
          { label: title }
        ]}
      />
      <PracticeHistoryCompactList
        emptyState={(
          <EmptyState text={scope === "today" ? "今日暂无普通套题练习。" : "暂无普通套题练习历史。"} />
        )}
        items={data[scope].sets.map((set) => ({
          attemptCount: set.attemptCount,
          bestAccuracy: formatPercent(set.bestAccuracy),
          href: `${STUDENT_ROUTES.practiceHistory}/sets/${encodeURIComponent(set.setId)}?scope=${scope}`,
          latestAccuracy: formatPercent(set.latestAccuracy),
          latestCompleted: formatCompactDateTime(set.latestSubmittedAt),
          setId: set.setId,
          setTitle: set.setTitle
        }))}
      />
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
  if (loading) return <StudentLoadingState text="正在加载练习记录..." />;
  if (error || !data) return <StudentErrorState text="加载练习记录失败，请稍后重试。" />;

  const attempts = data.attempts.filter((attempt) => attempt.setId === setId);
  const attemptIds = new Set(attempts.map((attempt) => attempt.attemptId));
  const answers = data.answers.filter((answer) => attemptIds.has(answer.attemptId));
  const title = attempts[0]?.setTitle ?? setId;

  return (
    <div className="grid gap-5">
      <HistoryNavigation
        backHref={practiceHistorySetsHref(scope)}
        crumbs={[
          { label: STUDENT_UI_TEXT.studentHome, href: STUDENT_ROUTES.home },
          { label: STUDENT_UI_TEXT.practiceHistory, href: practiceHistoryHomeHref(scope) },
          {
            label: scope === "today" ? "今日练习套题" : "历史练习套题",
            href: practiceHistorySetsHref(scope)
          },
          { label: setId }
        ]}
      />
      <div className="student-card">
        <h2 className="text-xl font-bold text-student-text">{title}</h2>
        <p className="mt-1 text-sm text-student-muted">{setId}</p>
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
        locale="zh-CN"
        missingAnswerAttemptIds={data.missingAnswerAttemptIds.filter((attemptId) =>
          attemptIds.has(attemptId)
        )}
        variant="student"
      />
    </div>
  );
}

export function PracticeHistoryErrorSummary({ scope }: { scope: HistoryScope }) {
  const { data, error, loading } = usePracticeHistory();
  const [page, setPage] = useState(1);
  const listTopRef = useRef<HTMLDivElement>(null);
  const pageSize = 10;

  if (loading) return <StudentLoadingState text="正在加载错题汇总..." />;
  if (error || !data) return <StudentErrorState text="加载错题汇总失败，请稍后重试。" />;

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
          { label: STUDENT_UI_TEXT.studentHome, href: STUDENT_ROUTES.home },
          { label: STUDENT_UI_TEXT.practiceHistory, href: practiceHistoryHomeHref(scope) },
          { label: title }
        ]}
      />
      <div className="flex flex-wrap items-center justify-end gap-3">
        <Link
          className="student-button-error"
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
      <nav aria-label="错题分页" className="flex flex-wrap justify-center gap-2">
        {Array.from({ length: pageCount }, (_, index) => index + 1).map((pageNumber) => (
          <button
            aria-current={pageNumber === safePage ? "page" : undefined}
            className={`min-w-10 rounded-[10px] border px-3 py-2 font-semibold transition ${
              pageNumber === safePage
                ? "border-student-primary bg-student-primary text-white"
                : "border-student-primary-border bg-white text-student-primary hover:border-student-primary"
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
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <HistoryMetricCard
        href={summary.setCount === 0 ? undefined : `${STUDENT_ROUTES.practiceHistory}/sets?scope=${scope}`}
        icon={LibraryBig}
        label={scope === "today" ? "今日练习套题数" : "总练习套题数"}
        unit="套"
        value={String(summary.setCount)}
      />
      <HistoryMetricCard
        icon={Target}
        label={scope === "today" ? "今日平均正确率" : "历史平均正确率"}
        unit={summary.averageAccuracy === null ? "" : "%"}
        value={summary.averageAccuracy === null ? "—" : String(Math.round(summary.averageAccuracy * 100))}
      />
      <HistoryMetricCard
        href={summary.errorCount === 0 ? undefined : `${STUDENT_ROUTES.practiceHistory}/errors?scope=${scope}`}
        icon={CircleX}
        label={scope === "today" ? "今日错题数" : "历史错题数"}
        tone="error"
        unit="题"
        value={String(summary.errorCount)}
      />
      <HistoryMetricCard
        icon={CircleCheckBig}
        label={scope === "today" ? "今日已订正" : "历史已订正"}
        unit="题"
        value={String(summary.correctedCount)}
      />
    </div>
  );
}

function HistoryMetricCard({
  href,
  icon: Icon,
  label,
  tone = "primary",
  unit,
  value
}: {
  href?: string;
  icon: LucideIcon;
  label: string;
  tone?: "primary" | "error";
  unit: string;
  value: string;
}) {
  const error = tone === "error";
  const cardClass = `h-[124px] rounded-xl border p-4 shadow-[0_1px_2px_rgba(23,32,51,0.025)] transition ${
    error
      ? "border-student-error-border bg-student-error-soft"
      : "border-student-primary-border bg-student-primary-soft"
  }`;
  const content = (
    <div className="flex h-full flex-col justify-between">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[17px] font-semibold leading-6 text-student-text">{label}</p>
        <Icon
          aria-hidden="true"
          className={error ? "shrink-0 text-student-error" : "shrink-0 text-student-primary"}
          size={32}
          strokeWidth={1.85}
        />
      </div>
      <div className="mt-3 flex items-baseline gap-1.5">
        <p className={error ? "text-[2.625rem] font-bold leading-none tracking-tight text-student-error" : "text-[2.625rem] font-bold leading-none tracking-tight text-student-primary"}>
          {value}
        </p>
        {unit ? <span className="text-[15px] font-medium text-student-muted">{unit}</span> : null}
      </div>
    </div>
  );

  return href ? (
    <Link className={`${cardClass} hover:-translate-y-px hover:shadow-[0_6px_18px_rgba(23,32,51,0.045)]`} href={href}>
      {content}
    </Link>
  ) : (
    <div className={cardClass}>{content}</div>
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
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-student-border bg-white px-4 py-3">
      <p className="text-sm font-semibold text-student-primary">
        第 {start}–{end} 题，共 {total} 题
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
    <article className="student-card p-4 sm:p-5">
      <p className="text-sm font-bold text-student-error">第 {number} 题</p>
      <p className="mt-2 text-lg font-bold text-student-text">{answer.prompt || "无题目内容"}</p>
      <div className="mt-3 text-base leading-8">
        <ReadOnlySentenceTemplate template={answer.sentenceTemplate} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {splitTextItems(answer.optionsText).map((chunk, index) => (
          <span
            className="inline-flex min-h-9 items-center justify-center rounded-[10px] border border-student-border bg-student-bg px-3 py-1.5 text-sm font-semibold"
            key={`${chunk}-${index}`}
          >
            {formatOptionChunk(chunk)}
          </span>
        ))}
      </div>
      <div className="mt-3 rounded-xl border border-student-error-border bg-student-error-soft p-3">
        <p className="text-sm font-semibold text-student-error">学生答案</p>
        <p className="mt-1 leading-7">
          {buildSentenceDisplay(answer.sentenceTemplate, answer.submittedOrderText) || "未作答"}
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
              aria-label={`空格 ${blankIndex}`}
              className="inline-block min-w-24 border-b-2 border-student-muted"
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
        { label: STUDENT_UI_TEXT.studentHome, href: STUDENT_ROUTES.home },
        { label: STUDENT_UI_TEXT.practiceHistory }
      ]}
    />
  );
}

function practiceHistoryHomeHref(_scope: HistoryScope) {
  return STUDENT_ROUTES.practiceHistory;
}

function practiceHistorySetsHref(scope: HistoryScope) {
  return `${STUDENT_ROUTES.practiceHistory}/sets?scope=${scope}`;
}

function EmptyState({ text }: { text: string }) {
  return <StudentEmptyState text={text} />;
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatCompactDateTime(value: string | null) {
  if (!value) return "时间未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";

  const now = new Date();
  const dateLabel = date.getFullYear() === now.getFullYear()
    ? `${date.getMonth() + 1}月${date.getDate()}日`
    : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  const timeLabel = date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit"
  });

  return `${dateLabel} ${timeLabel}`;
}

export function usePracticeHistory() {
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
    payload = text ? JSON.parse(text) : { error: "练习历史服务返回了空响应。" };
  } catch {
    payload = { error: "练习历史服务返回的数据格式无效。" };
  }
  if (!response.ok || "error" in payload) {
    throw new Error(("error" in payload && payload.error) || "无法加载练习历史。");
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
