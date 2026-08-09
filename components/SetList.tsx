"use client";

import Link from "next/link";
import {
  ArrowRight,
  BookOpen,
  CalendarDays,
  CircleCheckBig,
  Clock3,
  ClipboardX,
  ListChecks,
  Play,
  RotateCcw,
  Target,
  type LucideIcon
} from "lucide-react";
import { useGrammarTags } from "@/components/GrammarPractice";
import { usePracticeHistory } from "@/components/PracticeHistory";
import {
  PracticeSetAction,
  PracticeSetCatalogList
} from "@/components/shared/PracticeCatalog";
import {
  STUDENT_SETS_CACHE_KEY,
  useStudentCachedData,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import {
  StudentEmptyState,
  StudentErrorGrammarPanel,
  StudentErrorState,
  StudentInfoStrip,
  StudentLoadingState,
  StudentMonthCard,
  StudentNavigation as StudentNavigationComponent
} from "@/components/student/StudentUI";
import { formatPracticeMonthLabel, STUDENT_ROUTES } from "@/lib/studentNavigation";
import { STUDENT_UI_TEXT } from "@/lib/studentUiText";
import type { PracticeMonth, PracticeSet } from "@/lib/types";

type SetsPayload = {
  months?: PracticeMonth[];
  sets?: PracticeSet[];
  error?: string;
};

export { StudentNavigation } from "@/components/student/StudentUI";

export function StudentHome() {
  const setsState = useStudentSetsData();
  const grammarState = useGrammarTags();
  const historyState = usePracticeHistory();
  const history = historyState.data?.history;
  const currentMonth = setsState.months.find((month) => month.month_key === currentMonthKey());

  const historyUnavailable = historyState.loading || Boolean(historyState.error);

  return (
    <div>
      <section className="flex items-center gap-4">
        <span aria-hidden="true" className="h-14 w-1.5 shrink-0 rounded-full bg-student-primary" />
        <div>
          <h2 className="text-2xl font-bold tracking-[-0.02em] text-student-text">欢迎回来，继续加油！</h2>
          <p className="mt-1 text-sm text-student-muted">专注练习 · 提升能力 · 逐步精进</p>
        </div>
      </section>

      <section className="mt-6">
        <HomeSectionTitle title="学习入口" />
        <div className="mt-3.5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <HomeFeatureCard
          description="查看和练习错题"
          href={STUDENT_ROUTES.wrongQuestions}
          icon={ClipboardX}
          metric={
            historyState.loading
              ? { text: "正在统计" }
              : historyState.error
                ? { text: "暂不可用" }
                : { suffix: "道未掌握", value: String(history?.errorCount ?? 0) }
          }
          title="错题集"
          tone="error"
          />
          <HomeFeatureCard
          description="选择练习月份"
          href={STUDENT_ROUTES.practiceSets}
          icon={CalendarDays}
          metric={
            setsState.loading
              ? { text: "正在统计" }
              : setsState.error
                ? { text: "暂不可用" }
                : { prefix: "本月", suffix: "套", value: String(currentMonth?.set_count ?? 0) }
          }
          title="套题练习"
          />
          <HomeFeatureCard
          description="按语法点针对性练习"
          href={STUDENT_ROUTES.grammarPractice}
          icon={BookOpen}
          metric={
            grammarState.loading
              ? { text: "正在统计" }
              : grammarState.error
                ? { text: "暂不可用" }
                : {
                    prefix: "共",
                    suffix: "个语法点",
                    value: String(grammarState.data?.tags?.length ?? 0)
                  }
          }
          title="按语法分类练习"
          />
          <HomeFeatureCard
          description="查看练习记录与统计"
          href={STUDENT_ROUTES.practiceHistory}
          icon={Clock3}
          metric={
            historyState.loading
              ? { text: "正在统计" }
              : historyState.error
                ? { text: "暂不可用" }
                : history?.averageAccuracy === null || history?.averageAccuracy === undefined
                  ? { text: "暂无正确率" }
                  : { prefix: "正确率", value: formatPercent(history.averageAccuracy) }
          }
          title="练习历史"
          />
        </div>
      </section>

      <DashboardOverview
        accuracy={
          historyUnavailable || history?.averageAccuracy === null || history?.averageAccuracy === undefined
            ? "—"
            : formatPercent(history.averageAccuracy)
        }
        correctedCount={historyUnavailable ? "—" : String(history?.correctedCount ?? 0)}
        errorCount={historyUnavailable ? "—" : String(history?.errorCount ?? 0)}
        setCount={historyUnavailable ? "—" : String(history?.setCount ?? 0)}
      />

      <div className="mt-6">
        <StudentErrorGrammarPanel items={history?.grammarPoints ?? []} limit={3} sectionMarker />
      </div>
    </div>
  );
}

function DashboardOverview({
  accuracy,
  correctedCount,
  errorCount,
  setCount
}: {
  accuracy: string;
  correctedCount: string;
  errorCount: string;
  setCount: string;
}) {
  const items = [
    { icon: ListChecks, label: "总练习套题数", tone: "primary" as const, value: setCount },
    { icon: Target, label: "历史平均正确率", tone: "primary" as const, value: accuracy },
    { icon: ClipboardX, label: "历史错题数", tone: "error" as const, value: errorCount },
    { icon: CircleCheckBig, label: "历史已订正", tone: "primary" as const, value: correctedCount }
  ];

  return (
    <section className="mt-6">
      <HomeSectionTitle title="练习概览" />
      <div className="mt-3.5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {items.map((item) => (
          <HomeOverviewCard
            icon={item.icon}
            key={item.label}
            label={item.label}
            tone={item.tone}
            value={item.value}
          />
        ))}
      </div>
    </section>
  );
}

type HomeMetric =
  | { prefix?: string; suffix?: string; text?: never; value: string }
  | { prefix?: never; suffix?: never; text: string; value?: never };

function HomeSectionTitle({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-3">
      <span aria-hidden="true" className="h-5 w-1 rounded-full bg-student-primary" />
      <h2 className="text-[19px] font-bold leading-6 text-student-text">{title}</h2>
    </div>
  );
}

function HomeFeatureCard({
  description,
  href,
  icon: Icon,
  metric,
  title,
  tone = "primary"
}: {
  description: string;
  href: string;
  icon: LucideIcon;
  metric: HomeMetric;
  title: string;
  tone?: "primary" | "error";
}) {
  const error = tone === "error";
  return (
    <Link
      className={`group flex min-h-[210px] flex-col rounded-[18px] border p-6 shadow-[0_1px_2px_rgba(23,32,51,0.025)] transition duration-200 hover:-translate-y-px hover:shadow-[0_8px_24px_rgba(23,32,51,0.055)] ${
        error
          ? "border-student-error-border bg-[linear-gradient(135deg,#fff_0%,#fffaf8_45%,#fff1ec_100%)]"
          : "border-student-primary-border bg-[linear-gradient(135deg,#fff_0%,#fbfaff_45%,#f2f0ff_100%)]"
      }`}
      href={href}
    >
      <span
        className={`inline-flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-[14px] ${
          error
            ? "bg-student-error-soft text-student-error"
            : "bg-student-primary-soft text-student-primary"
        }`}
      >
        <Icon aria-hidden="true" size={30} strokeWidth={1.9} />
      </span>
      <div className="mt-4 min-w-0">
        <h3 className="text-[21px] font-bold leading-7 tracking-[-0.015em] text-student-text">
          {title}
        </h3>
        <p className="mt-1 text-[15px] leading-5 text-student-muted">{description}</p>
      </div>
      <div className="mt-auto flex items-end justify-between gap-3 pt-4">
        <span
          className={`inline-flex min-h-[42px] min-w-0 items-baseline gap-1 rounded-xl px-4 py-2 font-semibold ${
            error
              ? "bg-student-error-soft text-student-error"
              : "bg-student-primary-soft text-student-primary"
          }`}
        >
          {metric.text ? (
            <span className="text-[15px] leading-6">{metric.text}</span>
          ) : (
            <>
              {metric.prefix ? <span className="text-[15px] leading-6">{metric.prefix}</span> : null}
              <span className="text-2xl font-bold leading-6 tabular-nums">{metric.value}</span>
              {metric.suffix ? <span className="text-[15px] leading-6">{metric.suffix}</span> : null}
            </>
          )}
        </span>
        <ArrowRight
          aria-hidden="true"
          className={`mb-2 shrink-0 transition group-hover:translate-x-0.5 ${
            error ? "text-student-error" : "text-student-primary"
          }`}
          size={22}
          strokeWidth={1.9}
        />
      </div>
    </Link>
  );
}

function HomeOverviewCard({
  icon: Icon,
  label,
  tone,
  value
}: {
  icon: LucideIcon;
  label: string;
  tone: "primary" | "error";
  value: string;
}) {
  const error = tone === "error";
  return (
    <div
      className={`flex min-h-[112px] items-center gap-4 rounded-2xl border bg-white px-5 py-4 shadow-[0_1px_2px_rgba(23,32,51,0.025)] ${
        error ? "border-student-error-border" : "border-student-primary-border"
      }`}
    >
      <span
        className={`inline-flex h-[50px] w-[50px] shrink-0 items-center justify-center rounded-[14px] ${
          error
            ? "bg-student-error-soft text-student-error"
            : "bg-student-primary-soft text-student-primary"
        }`}
      >
        <Icon aria-hidden="true" size={28} strokeWidth={1.9} />
      </span>
      <div className="min-w-0">
        <p
          className={`text-[34px] font-bold leading-none tracking-tight tabular-nums ${
            error ? "text-student-error" : "text-student-primary"
          }`}
        >
          {value}
        </p>
        <p className="mt-2 text-[14px] font-medium leading-5 text-student-muted">{label}</p>
      </div>
    </div>
  );
}

export function MonthList() {
  const { error, loading, months } = useStudentSetsData();

  if (loading) return <StudentLoadingState text="正在加载练习月份..." />;
  if (error) return <StudentErrorState text="加载练习月份失败，请稍后重试。" />;

  return (
    <div className="grid gap-5">
      <StudentNavigationComponent
        backHref={STUDENT_ROUTES.home}
        crumbs={[
          { label: STUDENT_UI_TEXT.studentHome, href: STUDENT_ROUTES.home },
          { label: "按月练习" }
        ]}
      />
      {months.length === 0 ? (
        <StudentEmptyState text="暂无可练习月份。" />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {months.map((month) => (
            <StudentMonthCard
              href={`${STUDENT_ROUTES.practiceSets}/${month.month_key}`}
              key={month.month_key}
              month={formatPracticeMonthLabel(month.month_key)}
              questionCount={month.question_count}
              setCount={month.set_count}
            />
          ))}
        </div>
      )}
      <StudentInfoStrip>选择月份查看该月练习套题，继续巩固所学。</StudentInfoStrip>
    </div>
  );
}

export function SetList({ monthKey, monthLabel }: { monthKey: string; monthLabel: string }) {
  const { error, loading, sets } = useStudentSetsData(monthKey);

  if (loading) return <StudentLoadingState text="正在加载套题..." />;
  if (error) return <StudentErrorState text="加载套题失败，请稍后重试。" />;

  return (
    <div className="grid gap-5">
      <StudentNavigationComponent
        backHref={STUDENT_ROUTES.practiceSets}
        crumbs={[
          { label: STUDENT_UI_TEXT.studentHome, href: STUDENT_ROUTES.home },
          { label: STUDENT_UI_TEXT.practiceSets, href: STUDENT_ROUTES.practiceSets },
          { label: monthLabel }
        ]}
      />
      <PracticeSetGrid sets={sets} />
    </div>
  );
}

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function useStudentSetsData(monthKey?: string) {
  const { data, error, loading } = useStudentCachedData<SetsPayload>(
    STUDENT_SETS_CACHE_KEY,
    loadStudentSets
  );
  const months = data?.months ?? [];
  const allSets = data?.sets ?? [];
  const sets = monthKey ? allSets.filter((set) => set.month_key === monthKey) : allSets;
  return { error, loading, months, sets };
}

async function loadStudentSets(session: StudentCacheSession) {
  const response = await fetch("/api/sets", {
    cache: "no-store",
    headers: { Authorization: `Bearer ${session.accessToken}` }
  });
  const responseText = await response.text();
  let payload: SetsPayload;

  try {
    payload = responseText ? JSON.parse(responseText) : { error: "套题服务返回了空响应。" };
  } catch {
    payload = { error: "套题服务返回的数据格式无效。" };
  }

  if (!response.ok || payload.error) throw new Error(payload.error ?? "无法加载套题。");
  return payload;
}

function PracticeSetGrid({ sets }: { sets: PracticeSet[] }) {
  return (
    <PracticeSetCatalogList
      emptyState={<StudentEmptyState text="未找到套题。" />}
      renderActions={(item) => {
        const set = sets.find((candidate) => candidate.set_id === item.setId)!;
        return (
          <>
            {set.completed && set.latest_attempt_id ? (
              <PracticeSetAction href={`/student/results/${set.latest_attempt_id}`} icon={ListChecks} label="查看结果" />
            ) : null}
            <PracticeSetAction
              href={`/student/practice/${set.set_id}`}
              icon={set.completed ? RotateCcw : Play}
              label={set.completed ? "再练一次" : "开始练习"}
            />
          </>
        );
      }}
      renderStatus={(item) => sets.find((set) => set.set_id === item.setId)?.completed ? (
        <span className="inline-flex min-h-7 items-center rounded-full bg-student-primary-soft px-3 py-1 text-xs font-semibold text-student-primary">已完成</span>
      ) : null}
      sets={sets.map((set) => ({ setId: set.set_id, setTitle: set.set_title, questionCount: set.question_count }))}
    />
  );
}
