"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ClipboardX,
  Info,
  X
} from "lucide-react";
import {
  STUDENT_PRACTICE_ICONS,
  type StudentPracticeIcon
} from "@/components/icons/StudentPracticeIcons";
import {
  studentWrongQuestionsCacheKey,
  useStudentCachedData,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import {
  StudentErrorState,
  StudentLoadingState,
  StudentNavigation
} from "@/components/student/StudentUI";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import { STUDENT_UI_TEXT } from "@/lib/studentUiText";
import {
  WRONG_QUESTION_BANK_LABELS,
  WRONG_QUESTION_BANK_TASK_TYPES,
  WRONG_QUESTION_HISTORY_AMOUNTS,
  wrongQuestionAmountOptions,
  type WrongQuestionBankTaskType,
  type WrongQuestionHistoryAmount,
  type WrongQuestionPendingCounts
} from "@/lib/wrongQuestionBank";

const WRONG_QUESTION_ICONS: Record<WrongQuestionBankTaskType, StudentPracticeIcon> = {
  bas: STUDENT_PRACTICE_ICONS.build_sentence,
  ctw: STUDENT_PRACTICE_ICONS.ctw,
  rdl: STUDENT_PRACTICE_ICONS.rdl,
  rap: STUDENT_PRACTICE_ICONS.rap
};

const WRONG_QUESTION_CODES: Record<WrongQuestionBankTaskType, string> = {
  bas: "BAS",
  ctw: "CTW",
  rdl: "RDL",
  rap: "RAP"
};

const PURPLE_TONE = {
  chip: "bg-student-primary-soft text-student-primary",
  text: "text-student-primary"
} as const;

const BLUE_TONE = {
  chip: "bg-[#eef6ff] text-[#347fdc]",
  text: "text-[#347fdc]"
} as const;

function taskTone(taskType: WrongQuestionBankTaskType) {
  return taskType === "bas" ? PURPLE_TONE : BLUE_TONE;
}

type WrongQuestionSummaryPayload = {
  error?: string;
  pending?: WrongQuestionPendingCounts;
  practiceDate?: string;
};

type WrongQuestionHistoryCountPayload = {
  count?: number;
  error?: string;
};

export function WrongQuestionsHome() {
  const summary = useStudentCachedData<WrongQuestionSummaryPayload>(
    // The client date only busts the in-memory cache at midnight; the server
    // still derives the authoritative business date for the query itself.
    studentWrongQuestionsCacheKey(`summary:v2:${localDayKey()}`),
    loadWrongQuestionSummary
  );
  const [historyTaskType, setHistoryTaskType] = useState<WrongQuestionBankTaskType | null>(null);
  const pending = summary.data?.pending;
  const summaryError = summary.error || summary.data?.error;

  return (
    <div className="grid gap-5">
      <StudentNavigation
        backHref={STUDENT_ROUTES.home}
        crumbs={[
          { label: STUDENT_UI_TEXT.studentHome, href: STUDENT_ROUTES.home },
          { label: STUDENT_UI_TEXT.wrongQuestions }
        ]}
      />
      {summary.loading ? <StudentLoadingState text="正在加载错题集..." /> : null}
      {summaryError || (!summary.loading && !pending) ? (
        <StudentErrorState text="错题集加载失败，请稍后重试。" />
      ) : null}
      {pending ? (
        <>
          <WrongQuestionSummaryCard pending={pending} />
          <WrongQuestionTaskCard
            onOpenHistory={setHistoryTaskType}
            pending={pending}
          />
          <WrongQuestionRulesCard />
        </>
      ) : null}
      {historyTaskType ? (
        <WrongQuestionHistoryDialog
          onClose={() => setHistoryTaskType(null)}
          taskType={historyTaskType}
        />
      ) : null}
    </div>
  );
}

function WrongQuestionSummaryCard({ pending }: { pending: WrongQuestionPendingCounts }) {
  const total = WRONG_QUESTION_BANK_TASK_TYPES.reduce((sum, taskType) => sum + pending[taskType], 0);
  const completedTabs = WRONG_QUESTION_BANK_TASK_TYPES
    .filter((taskType) => pending[taskType] === 0).length;

  return (
    <section
      aria-label="今日错题订正总览"
      className="student-card"
      data-testid="wrong-question-summary"
    >
      <div className="flex flex-wrap items-center gap-x-10 gap-y-6">
        <div className="flex min-w-0 items-center gap-4">
          <span className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-student-error-soft text-student-error">
            <ClipboardX aria-hidden="true" size={28} strokeWidth={1.9} />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-student-text">今日错题订正</p>
            {total > 0 ? (
              <p className="mt-1 text-xl font-bold text-student-text sm:text-2xl">
                <AlertTriangle
                  aria-hidden="true"
                  className="mr-1.5 inline align-[-0.15em] text-student-error"
                  size={22}
                />
                还有 <span className="tabular-nums text-student-error">{total}</span> 道错题待订正
              </p>
            ) : (
              <p className="mt-1 inline-flex items-center gap-2 text-xl font-bold text-student-text sm:text-2xl">
                <Check aria-hidden="true" className="text-student-primary" size={22} />
                今日错题已全部订正
              </p>
            )}
          </div>
        </div>

        <div className="hidden h-16 w-px bg-student-border lg:block" aria-hidden="true" />

        <div>
          <p className="text-sm font-semibold text-student-text">今日进度</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-student-text sm:text-3xl">
            <span className="text-student-error">{completedTabs}</span>
            <span className="mx-1 text-lg font-semibold text-student-muted">/</span>
            <span className="text-student-muted">{WRONG_QUESTION_BANK_TASK_TYPES.length}</span>
          </p>
          <p className="mt-1 text-sm text-student-muted">个题型已完成今日错题</p>
        </div>

        <div className="flex flex-1 flex-wrap items-start justify-end gap-x-8 gap-y-4">
          {WRONG_QUESTION_BANK_TASK_TYPES.map((taskType) => {
            const Icon = WRONG_QUESTION_ICONS[taskType];
            const tone = taskTone(taskType);
            return (
              <div className="flex min-w-[64px] flex-col items-center gap-1.5 text-center" key={taskType}>
                <span className={`inline-flex h-10 w-10 items-center justify-center rounded-full ${tone.chip}`}>
                  <Icon aria-hidden="true" size={20} />
                </span>
                <span className="text-xs font-bold text-student-muted">{WRONG_QUESTION_CODES[taskType]}</span>
                <span className={`text-lg font-bold tabular-nums ${pending[taskType] > 0 ? "text-student-error" : "text-student-muted"}`}>
                  {pending[taskType]}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function WrongQuestionTaskCard({
  onOpenHistory,
  pending
}: {
  onOpenHistory: (taskType: WrongQuestionBankTaskType) => void;
  pending: WrongQuestionPendingCounts;
}) {
  return (
    <section
      aria-label="按题型的错题订正"
      className="overflow-hidden rounded-2xl border border-student-border bg-white shadow-[0_2px_12px_rgba(60,47,119,0.045)]"
      data-testid="wrong-question-task-list"
    >
      <ul className="divide-y divide-student-border">
        {WRONG_QUESTION_BANK_TASK_TYPES.map((taskType) => (
          <WrongQuestionTaskRow
            key={taskType}
            onOpenHistory={onOpenHistory}
            pendingCount={pending[taskType]}
            taskType={taskType}
          />
        ))}
      </ul>
    </section>
  );
}

function WrongQuestionTaskRow({
  onOpenHistory,
  pendingCount,
  taskType
}: {
  onOpenHistory: (taskType: WrongQuestionBankTaskType) => void;
  pendingCount: number;
  taskType: WrongQuestionBankTaskType;
}) {
  const Icon = WRONG_QUESTION_ICONS[taskType];
  const tone = taskTone(taskType);
  const todayHref = wrongQuestionTodayHref(taskType);
  return (
    <li
      className="grid items-center gap-3 px-4 py-3.5 sm:grid-cols-[minmax(200px,1fr)_minmax(220px,1.2fr)_auto] sm:px-5"
      data-testid={`wrong-question-task-${taskType}`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${tone.chip}`}>
          <Icon aria-hidden="true" size={22} />
        </span>
        <div className="min-w-0">
          <p className="truncate font-bold text-student-text">{WRONG_QUESTION_BANK_LABELS[taskType]}</p>
          <p className="text-xs font-semibold text-student-muted">{WRONG_QUESTION_CODES[taskType]}</p>
        </div>
      </div>

      <div className="flex min-w-0 items-center gap-2 text-sm">
        {pendingCount > 0 ? (
          <>
            <AlertTriangle aria-hidden="true" className="shrink-0 text-student-error" size={18} />
            <p className="font-semibold text-student-text">
              今日还有 <span className="tabular-nums text-student-error">{pendingCount}</span> 道错题待订正
            </p>
          </>
        ) : (
          <>
            <Check aria-hidden="true" className={`shrink-0 ${tone.text}`} size={18} />
            <p className="font-semibold text-student-text">今日错题已全部订正</p>
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        {pendingCount > 0 ? (
          <Link
            className="student-button-error min-h-10 gap-1.5 px-4 py-2 text-sm"
            data-testid={`today-wrong-questions-${taskType}`}
            href={todayHref}
          >
            今日错题
            <ArrowRight aria-hidden="true" size={15} />
          </Link>
        ) : (
          <button
            aria-disabled="true"
            className="inline-flex min-h-10 cursor-not-allowed items-center justify-center gap-1.5 rounded-[10px] border border-student-border bg-student-bg px-4 py-2 text-sm font-semibold text-student-muted"
            data-testid={`today-wrong-questions-${taskType}`}
            disabled
            type="button"
          >
            今日错题
            <ArrowRight aria-hidden="true" size={15} />
          </button>
        )}
        <button
          className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-[10px] border border-student-error-border bg-white px-4 py-2 text-sm font-semibold text-student-error transition hover:border-student-error hover:bg-student-error-soft"
          data-testid={`history-wrong-questions-${taskType}`}
          onClick={() => onOpenHistory(taskType)}
          type="button"
        >
          历史错题
          <ArrowRight aria-hidden="true" size={15} />
        </button>
      </div>
    </li>
  );
}

function WrongQuestionRulesCard() {
  return (
    <section
      aria-label="错题练习说明"
      className="rounded-2xl border border-student-primary-border bg-student-primary-soft/60 p-4 sm:p-5"
      data-testid="wrong-question-rules"
    >
      <div className="flex items-start gap-3">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#eef6ff] text-[#347fdc]">
          <Info aria-hidden="true" size={18} />
        </span>
        <div className="min-w-0">
          <h2 className="font-bold text-student-text">错题练习说明</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-student-muted">
            <li>今日错题：本次练习中答错的题目，需要全部订正。订正完成后，今日错题将从列表中清零。</li>
            <li>历史错题：所有历史练习中的错题会永久保留，可随机选择 5 / 10 / 15 / 20 题进行练习。</li>
          </ul>
        </div>
      </div>
    </section>
  );
}

function WrongQuestionHistoryDialog({
  onClose,
  taskType
}: {
  onClose: () => void;
  taskType: WrongQuestionBankTaskType;
}) {
  const router = useRouter();
  const historyState = useStudentCachedData<WrongQuestionHistoryCountPayload>(
    studentWrongQuestionsCacheKey(`history-count:v1:${taskType}`),
    (session) => loadWrongQuestionHistoryCount(taskType, session)
  );
  const count = historyState.data?.count ?? null;
  const loading = historyState.loading || count === null;
  const error = historyState.error || historyState.data?.error;
  const options = useMemo(
    () => (typeof count === "number" ? wrongQuestionAmountOptions(count) : []),
    [count]
  );

  function startPractice(amount: WrongQuestionHistoryAmount) {
    router.push(wrongQuestionHistoryHref(taskType, amount));
  }

  return (
    <div
      aria-labelledby="wrong-question-history-title"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-student-text/25 px-5"
      role="dialog"
    >
      <section className="w-full max-w-md rounded-2xl border border-student-border bg-white p-5 shadow-[0_18px_45px_rgba(23,32,51,0.18)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-student-text" id="wrong-question-history-title">
              选择练习题目数量
            </h2>
            <p className="mt-1 text-sm text-student-muted">
              {WRONG_QUESTION_BANK_LABELS[taskType]} · 历史错题
            </p>
          </div>
          <button
            aria-label="关闭"
            className="inline-flex h-8 w-8 items-center justify-center rounded-full text-student-muted transition hover:bg-student-bg hover:text-student-text"
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" size={18} />
          </button>
        </div>

        {error ? (
          <p className="mt-4 rounded-xl border border-student-error-border bg-student-error-soft px-3 py-2 text-sm font-semibold text-student-error">
            历史错题数量加载失败，请稍后重试。
          </p>
        ) : loading ? (
          <p className="mt-4 text-sm text-student-muted">正在加载历史错题...</p>
        ) : count === 0 ? (
          <p className="mt-4 rounded-xl border border-student-border bg-student-bg px-3 py-3 text-sm font-semibold text-student-muted">
            暂无历史错题。
          </p>
        ) : null}

        <div className="mt-4 grid grid-cols-4 gap-2.5">
          {WRONG_QUESTION_HISTORY_AMOUNTS.map((amount) => {
            const option = options.find((candidate) => candidate.amount === amount);
            const enabled = Boolean(option?.enabled);
            return (
              <div className="flex flex-col items-center gap-1.5" key={amount}>
                <button
                  className={enabled
                    ? "inline-flex h-14 w-full items-center justify-center rounded-xl border border-student-error-border bg-white text-lg font-bold tabular-nums text-student-error transition hover:border-student-error hover:bg-student-error-soft"
                    : "inline-flex h-14 w-full cursor-not-allowed items-center justify-center rounded-xl border border-student-border bg-student-bg text-lg font-bold tabular-nums text-student-muted"}
                  data-testid={`wrong-question-amount-${amount}`}
                  disabled={!enabled || loading || Boolean(error)}
                  onClick={() => startPractice(amount)}
                  type="button"
                >
                  {amount}
                </button>
                {option?.shortfallHint ? (
                  <span className="text-center text-[11px] font-semibold leading-4 text-student-error">
                    {option.shortfallHint}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function wrongQuestionTodayHref(taskType: WrongQuestionBankTaskType) {
  if (taskType === "bas") {
    return `/student/wrong-questions/today/practice?${new URLSearchParams({
      returnTo: STUDENT_ROUTES.wrongQuestions,
      scope: "today"
    }).toString()}`;
  }
  return `/student/wrong-questions/today/reading/practice?${new URLSearchParams({
    returnTo: STUDENT_ROUTES.wrongQuestions,
    taskType
  }).toString()}`;
}

function wrongQuestionHistoryHref(taskType: WrongQuestionBankTaskType, amount: WrongQuestionHistoryAmount) {
  if (taskType === "bas") {
    return `/student/wrong-questions/history/practice?${new URLSearchParams({
      amount: String(amount),
      mode: "random",
      returnTo: STUDENT_ROUTES.wrongQuestions,
      scope: "history"
    }).toString()}`;
  }
  return `/student/wrong-questions/history/reading/practice?${new URLSearchParams({
    amount: String(amount),
    mode: "history",
    returnTo: STUDENT_ROUTES.wrongQuestions,
    taskType
  }).toString()}`;
}

async function loadWrongQuestionSummary(session: StudentCacheSession) {
  const response = await fetch("/api/wrong-questions?view=summary", {
    cache: "no-store",
    headers: { Authorization: `Bearer ${session.accessToken}` }
  });
  const payload = await response.json().catch(() => ({})) as WrongQuestionSummaryPayload;
  if (!response.ok || payload.error || !payload.pending) {
    throw new Error(payload.error ?? "无法加载错题集。");
  }
  return payload;
}

async function loadWrongQuestionHistoryCount(
  taskType: WrongQuestionBankTaskType,
  session: StudentCacheSession
) {
  const query = new URLSearchParams({ taskType, view: "history-count" });
  const response = await fetch(`/api/wrong-questions?${query}`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${session.accessToken}` }
  });
  const payload = await response.json().catch(() => ({})) as WrongQuestionHistoryCountPayload;
  if (!response.ok || payload.error || typeof payload.count !== "number") {
    throw new Error(payload.error ?? "无法加载历史错题数量。");
  }
  return payload;
}

type BasGrammarAnalysisTone = "orange" | "primary";

const BAS_GRAMMAR_ANALYSIS_TONES = {
  orange: {
    action:
      "inline-flex min-h-8 items-center justify-center gap-2 rounded-[10px] border border-orange-300 bg-white px-3 py-1 text-xs font-semibold text-orange-500 transition hover:border-orange-500 hover:bg-orange-50",
    progress: "bg-orange-500",
    progressTrack: "bg-orange-100",
    rank: "bg-orange-50 text-orange-500"
  },
  primary: {
    action: "student-button-secondary min-h-8 px-3 py-1 text-xs",
    progress: "bg-student-primary",
    progressTrack: "bg-student-primary-soft",
    rank: "bg-student-primary-soft text-student-primary"
  }
} as const;

export function BasGrammarAnalysis({
  items,
  showLinks = true,
  tone = "primary"
}: {
  items: Array<{ count: number; tag: string }>;
  showLinks?: boolean;
  tone?: BasGrammarAnalysisTone;
}) {
  const visibleItems = items.slice(0, 5);
  const highestCount = visibleItems[0]?.count ?? 0;
  const toneStyles = BAS_GRAMMAR_ANALYSIS_TONES[tone];
  return (
    <section className="rounded-2xl border border-student-primary-border bg-[linear-gradient(135deg,#fff_0%,#fbfaff_55%,#f7f5ff_100%)] p-5 shadow-[0_2px_12px_rgba(60,47,119,0.04)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold text-student-text">
          <span className="text-student-primary">Build a Sentence</span> 语法分析
        </h2>
        {showLinks ? (
          <Link className="inline-flex items-center gap-1.5 text-sm font-bold text-student-primary hover:underline" href={STUDENT_ROUTES.grammarPractice}>
            按语法分类练习 <ArrowRight aria-hidden="true" size={16} />
          </Link>
        ) : null}
      </div>
      <h3 className="mt-4 text-sm font-bold text-student-text">高频错误语法点</h3>
      {visibleItems.length === 0 ? (
        <p className="mt-3 text-sm text-student-muted">暂无高频错误语法点。</p>
      ) : (
        <ol className="mt-2 divide-y divide-student-border">
          {visibleItems.map((item, index) => (
            <li className="grid items-center gap-3 py-2.5 sm:grid-cols-[1.75rem_minmax(10rem,1fr)_minmax(12rem,2fr)_4rem_auto]" key={item.tag}>
              <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${toneStyles.rank}`}>
                {index + 1}
              </span>
              <span className="min-w-0 text-sm font-semibold text-student-text">{item.tag}</span>
              <span className={`h-1.5 overflow-hidden rounded-full ${toneStyles.progressTrack}`}>
                <span
                  className={`block h-full rounded-full ${toneStyles.progress}`}
                  style={{ width: `${Math.max(10, highestCount > 0 ? (item.count / highestCount) * 100 : 0)}%` }}
                />
              </span>
              <span className="text-right text-xs font-semibold tabular-nums text-student-muted">{item.count} 题</span>
              <Link className={toneStyles.action} href={grammarPracticeHref(item.tag)}>
                专项练习 <ArrowRight aria-hidden="true" size={14} />
              </Link>
            </li>
          ))}
        </ol>
      )}
      {showLinks ? (
        <div className="mt-2 border-t border-student-border pt-3 text-center">
          <Link className="inline-flex items-center gap-1.5 text-sm font-bold text-student-primary hover:underline" href={STUDENT_ROUTES.grammarPractice}>
            查看全部语法点 <ArrowRight aria-hidden="true" size={15} />
          </Link>
        </div>
      ) : null}
    </section>
  );
}

function grammarPracticeHref(tag: string) {
  return `${STUDENT_ROUTES.grammarPractice}/practice?${new URLSearchParams({ mode: "all", tag }).toString()}`;
}

function localDayKey() {
  const date = new Date();
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}
