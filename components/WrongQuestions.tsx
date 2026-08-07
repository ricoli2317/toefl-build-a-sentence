"use client";

import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import {
  BookOpen,
  CalendarDays,
  Clock3,
  FileText,
  Info,
  Target,
  Timer,
  X,
  type LucideIcon
} from "lucide-react";
import { PracticeSession } from "@/components/PracticeSession";
import {
  StudentEmptyState,
  StudentErrorState,
  StudentInfoStrip,
  StudentLoadingState,
  StudentNavigation
} from "@/components/student/StudentUI";
import {
  studentWrongQuestionsCacheKey,
  useStudentCachedData,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import { STUDENT_UI_TEXT } from "@/lib/studentUiText";
import type { PublicQuestion } from "@/lib/types";

type WrongQuestionsPayload = {
  count?: number;
  questions?: PublicQuestion[];
  error?: string;
  stats?: WrongQuestionStats;
};

type WrongQuestionStats = {
  knowledgePointCount: number;
  latestWrongAt: string | null;
  masteredQuestionCount: number;
  masteryRate: number | null;
  totalWrongOccurrences: number;
};

const DEFAULT_SET_TIME_SECONDS = 6 * 60 + 50;

export function WrongQuestionsHome() {
  const today = useWrongQuestions("today");
  const history = useWrongQuestions("history");
  const todayCount = stateValue(today.loading, today.error, today.questions.length);
  const historyCount = stateValue(history.loading, history.error, history.questions.length);
  const todayKnowledgeCount = stateValue(
    today.loading,
    today.error,
    today.stats?.knowledgePointCount ?? 0,
    " 个"
  );
  const historyKnowledgeCount = stateValue(
    history.loading,
    history.error,
    history.stats?.knowledgePointCount ?? 0,
    " 个"
  );
  const historyOccurrences = stateValue(
    history.loading,
    history.error,
    history.stats?.totalWrongOccurrences ?? 0,
    " 次"
  );
  const masteryValue = history.loading
    ? "…"
    : history.error || history.stats?.masteryRate === null || history.stats?.masteryRate === undefined
      ? "—"
      : `↑ ${history.stats.masteryRate}%`;

  return (
    <div className="grid gap-5">
      <StudentNavigation
        backHref={STUDENT_ROUTES.home}
        crumbs={[
          { label: STUDENT_UI_TEXT.studentHome, href: STUDENT_ROUTES.home },
          { label: STUDENT_UI_TEXT.wrongQuestions }
        ]}
      />
      <div className="grid items-stretch gap-5 xl:grid-cols-2">
        <WrongDashboardCard
          actions={(
            <Link className="student-button-error min-h-[52px] w-full text-base" href="/student/wrong-questions/today/practice">
              开始订正
            </Link>
          )}
          countLabel="待复习"
          countValue={todayCount}
          description="巩固今日所错，加深记忆，及时提升"
          footer="建议及时订正，强化薄弱知识点，避免重复犯错。"
          icon={CalendarDays}
          infoItems={[
            { icon: BookOpen, label: "错题来源", value: "今日练习" },
            {
              icon: Clock3,
              label: "最近错题",
              value: stateText(today.loading, today.error, formatRelativeTime(today.stats?.latestWrongAt))
            },
            { icon: Target, label: "知识点", value: todayKnowledgeCount }
          ]}
          title="今日错题"
        />
        <WrongDashboardCard
          actions={(
            <div className="grid gap-3 sm:grid-cols-2">
              <Link className="student-button-error min-h-[52px] w-full text-base" href="/student/wrong-questions/history/practice?mode=all">
                全部订正
              </Link>
              <Link className="student-button-secondary min-h-[52px] w-full text-base" href="/student/wrong-questions/history/practice?mode=random">
                <Timer aria-hidden="true" size={20} strokeWidth={1.9} />
                随机计时练习
              </Link>
            </div>
          )}
          countLabel="累计"
          countValue={historyCount}
          description="系统回顾所有错题，全面巩固提升"
          footer="支持按知识点筛选，针对性突破薄弱环节。"
          icon={FileText}
          infoColumns={4}
          infoItems={[
            { label: "涉及知识点", value: historyKnowledgeCount },
            { label: "总错题次数", value: historyOccurrences },
            { label: "掌握提升", tone: "success", value: masteryValue },
            {
              label: "最近错题",
              value: stateText(history.loading, history.error, formatRelativeTime(history.stats?.latestWrongAt))
            }
          ]}
          title="历史错题合集"
        />
      </div>
      <StudentInfoStrip>错题集已整合继续练习与历史错题功能，所有错题管理与练习均在此完成。</StudentInfoStrip>
    </div>
  );
}

function WrongDashboardCard({
  actions,
  countLabel,
  countValue,
  description,
  footer,
  icon: Icon,
  infoColumns = 3,
  infoItems,
  title
}: {
  actions: ReactNode;
  countLabel: string;
  countValue: string;
  description: string;
  footer: string;
  icon: LucideIcon;
  infoColumns?: 3 | 4;
  infoItems: Array<{
    icon?: LucideIcon;
    label: string;
    tone?: "default" | "success";
    value: string;
  }>;
  title: string;
}) {
  return (
    <section className="flex h-full flex-col rounded-2xl border border-student-error-border bg-white p-5 shadow-[0_2px_8px_rgba(23,32,51,0.035)] sm:p-6 xl:min-h-[500px]">
      <div className="flex items-center gap-4">
        <span className="relative inline-flex h-16 w-16 shrink-0 items-center justify-center text-student-primary">
          <Icon aria-hidden="true" size={52} strokeWidth={1.8} />
          <span className="absolute bottom-0 right-0 inline-flex h-6 w-6 items-center justify-center rounded-full bg-student-error text-white shadow-[0_0_0_2px_white]">
            <X aria-hidden="true" size={14} strokeWidth={3} />
          </span>
        </span>
        <div className="min-w-0">
          <h2 className="text-2xl font-bold tracking-[-0.02em] text-student-text sm:text-[26px]">{title}</h2>
          <p className="mt-1 text-sm leading-6 text-student-muted sm:text-base">{description}</p>
        </div>
      </div>

      <div className="mt-5 border-t border-student-border" />

      <div className="mt-5 flex items-baseline gap-3">
        <span className="text-lg font-semibold text-student-muted">{countLabel}</span>
        <span className="text-[2.75rem] font-bold leading-none tracking-tight text-student-error sm:text-5xl">{countValue}</span>
        <span className="text-sm font-semibold text-student-muted">题</span>
      </div>

      <div
        className={
          infoColumns === 4
            ? "mt-6 grid grid-cols-2 gap-2.5 sm:grid-cols-4"
            : "mt-6 grid gap-2.5 sm:grid-cols-3"
        }
      >
        {infoItems.map((item) => (
          <WrongInfoMetric key={item.label} {...item} />
        ))}
      </div>

      <div className="mt-6">{actions}</div>

      <div className="mt-auto flex items-center gap-2 border-t border-student-border pt-5 text-xs leading-5 text-student-muted sm:text-sm">
        <Info aria-hidden="true" className="shrink-0 text-student-primary" size={18} strokeWidth={1.9} />
        <p>{footer}</p>
      </div>
    </section>
  );
}

function WrongInfoMetric({
  icon: Icon,
  label,
  tone = "default",
  value
}: {
  icon?: LucideIcon;
  label: string;
  tone?: "default" | "success";
  value: string;
}) {
  return (
    <div className="flex min-h-[88px] items-center justify-center gap-2.5 rounded-xl border border-student-primary-border bg-white px-3 py-3 text-center">
      {Icon ? (
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-student-primary-soft text-student-primary">
          <Icon aria-hidden="true" size={20} strokeWidth={1.9} />
        </span>
      ) : null}
      <div className={Icon ? "min-w-0 text-left" : "min-w-0"}>
        <p className="text-xs font-medium leading-5 text-student-muted">{label}</p>
        <p className={tone === "success" ? "mt-0.5 truncate text-sm font-bold text-emerald-500" : "mt-0.5 truncate text-sm font-bold text-student-text"}>
          {value}
        </p>
      </div>
    </div>
  );
}

export function TodayWrongQuestions() {
  const { error, loading, questions } = useWrongQuestions("today");
  if (loading) return <StudentLoadingState text="正在加载今日错题..." />;
  if (error) return <StudentErrorState text="加载今日错题失败，请稍后重试。" />;

  return (
    <div className="grid gap-5">
      <WrongQuestionsNavigation current={STUDENT_UI_TEXT.todayWrongQuestions} />
      {questions.length === 0 ? (
        <StudentEmptyState text="今日无错题。" />
      ) : (
        <section className="student-card border-t-2 border-t-student-error-border">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-student-muted">待复习</p>
              <p className="mt-1 text-2xl font-bold text-student-error">{questions.length}题</p>
            </div>
            <Link className="student-button-error" href="/student/wrong-questions/today/practice">
              开始订正
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}

export function HistoryWrongQuestions() {
  const { error, loading, questions } = useWrongQuestions("history");
  if (loading) return <StudentLoadingState text="正在加载历史错题..." />;
  if (error) return <StudentErrorState text="加载历史错题失败，请稍后重试。" />;

  return (
    <div className="grid gap-5">
      <WrongQuestionsNavigation current={STUDENT_UI_TEXT.historyWrongQuestions} />
      {questions.length === 0 ? (
        <StudentEmptyState text="暂无历史错题。" />
      ) : (
        <section className="student-card border-t-2 border-t-student-error-border">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-student-muted">累计错题</p>
              <p className="mt-1 text-2xl font-bold text-student-error">{questions.length}题</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link className="student-button-error" href="/student/wrong-questions/history/practice?mode=all">
                全部订正
              </Link>
              <Link className="student-button-secondary" href="/student/wrong-questions/history/practice?mode=random">
                随机计时练习
              </Link>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

export function WrongQuestionsPractice({ mode }: { mode: "history-all" | "history-random" | "today" }) {
  const scope = mode === "today" ? "today" : "history";
  const randomLimit = mode === "history-random" ? 10 : undefined;
  const { error, loading, questions } = useWrongQuestions(scope, randomLimit);
  const today = useMemo(() => formatTimestamp(new Date()), []);
  const virtualSetId = useMemo(() => {
    if (mode === "today") return `wrongbook-today-${today.slice(0, 8)}`;
    if (mode === "history-random") return `wrongbook-random-${today}`;
    return `wrongbook-all-${today}`;
  }, [mode, today]);
  const title = mode === "today"
    ? "Today's Wrong Questions"
    : mode === "history-random"
      ? "Random Timed Wrong Questions"
      : "History Wrong Questions";
  const timed = mode === "history-random";
  const totalSeconds = timed
    ? Math.max(1, Math.round((DEFAULT_SET_TIME_SECONDS / 10) * Math.min(10, questions.length)))
    : DEFAULT_SET_TIME_SECONDS;

  if (loading) return <StudentLoadingState text="正在加载练习..." />;
  if (error) return <StudentErrorState text="加载错题练习失败，请稍后重试。" />;
  if (questions.length === 0) {
    return (
      <div className="grid gap-5">
        <WrongQuestionsNavigation
          current={mode === "today" ? STUDENT_UI_TEXT.todayWrongQuestions : STUDENT_UI_TEXT.historyWrongQuestions}
        />
        <StudentEmptyState text={mode === "today" ? "今日无错题。" : "暂无历史错题。"} />
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

function WrongQuestionsNavigation({ current }: { current: string }) {
  return (
    <StudentNavigation
      backHref={STUDENT_ROUTES.wrongQuestions}
      crumbs={[
        { label: STUDENT_UI_TEXT.studentHome, href: STUDENT_ROUTES.home },
        { label: STUDENT_UI_TEXT.wrongQuestions, href: STUDENT_ROUTES.wrongQuestions },
        { label: current }
      ]}
    />
  );
}

function useWrongQuestions(scope: "history" | "today", randomLimit?: number) {
  const todayRange = useMemo(() => getTodayRange(), []);
  const query = useMemo(() => {
    const params = new URLSearchParams({ scope });
    if (scope === "today") {
      params.set("todayStart", todayRange.start);
      params.set("todayEnd", todayRange.end);
    }
    if (randomLimit) params.set("randomLimit", String(randomLimit));
    return params.toString();
  }, [randomLimit, scope, todayRange.end, todayRange.start]);
  const { data, error, loading } = useStudentCachedData<WrongQuestionsPayload>(
    studentWrongQuestionsCacheKey(query),
    (session) => loadWrongQuestions(query, session)
  );
  return { error, loading, questions: data?.questions ?? [], stats: data?.stats };
}

function stateValue(
  loading: boolean,
  error: string | null,
  value: number,
  suffix = ""
) {
  if (loading) return "…";
  if (error) return "—";
  return `${value}${suffix}`;
}

function stateText(loading: boolean, error: string | null, value: string) {
  if (loading) return "加载中";
  if (error) return "暂不可用";
  return value;
}

function formatRelativeTime(value: string | null | undefined) {
  if (!value) return "暂无记录";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "暂无记录";

  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (elapsedMinutes < 1) return "刚刚";
  if (elapsedMinutes < 60) return `${elapsedMinutes} 分钟前`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours} 小时前`;
  if (elapsedHours < 48) return "昨天";

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays} 天前`;

  const date = new Date(timestamp);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

async function loadWrongQuestions(query: string, session: StudentCacheSession) {
  const response = await fetch(`/api/wrong-questions?${query}`, {
    headers: { Authorization: `Bearer ${session.accessToken}` }
  });
  const responseText = await response.text();
  let payload: WrongQuestionsPayload;
  try {
    payload = responseText ? JSON.parse(responseText) : { error: "错题服务返回了空响应。", questions: [] };
  } catch {
    payload = { error: "错题服务返回的数据格式无效。", questions: [] };
  }
  if (!response.ok || payload.error) throw new Error(payload.error ?? "无法加载错题。");
  return payload;
}

function getTodayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { end: end.toISOString(), start: start.toISOString() };
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
