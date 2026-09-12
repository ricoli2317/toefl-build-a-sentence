"use client";

import Link from "next/link";
import { useMemo, useState, type ComponentType, type SVGProps } from "react";
import {
  ArrowRight,
  BookOpen,
  CalendarPlus,
  CircleCheckBig,
  ClipboardList,
  FileText,
  Puzzle,
  Target
} from "lucide-react";
import { CompleteTheWordsIcon } from "@/components/icons/CompleteTheWordsIcon";
import {
  studentWrongQuestionsCacheKey,
  useStudentCachedData,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import {
  StudentEmptyState,
  StudentErrorState,
  StudentLoadingState,
  StudentNavigation
} from "@/components/student/StudentUI";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import { STUDENT_UI_TEXT } from "@/lib/studentUiText";
import {
  WRONG_QUESTION_TASK_LABELS,
  WRONG_QUESTION_TASK_TYPES,
  type WrongQuestionGroup,
  type WrongQuestionsOverviewPayload,
  type WrongQuestionTaskType
} from "@/lib/wrongQuestions";

type WrongQuestionIcon = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>;

const WRONG_QUESTION_ICONS: Record<WrongQuestionTaskType, WrongQuestionIcon> = {
  build_sentence: Puzzle,
  ctw: CompleteTheWordsIcon,
  rdl: FileText,
  rap: BookOpen
};

export function WrongQuestionsHome() {
  const [activeTab, setActiveTab] = useState<WrongQuestionTaskType | "all">("all");
  const [todayRange] = useState(localDayRange);
  const overviewQuery = useMemo(() => new URLSearchParams({
    todayEnd: todayRange.end,
    todayStart: todayRange.start,
    view: "overview"
  }).toString(), [todayRange.end, todayRange.start]);
  const state = useStudentCachedData<WrongQuestionsOverviewPayload>(
    studentWrongQuestionsCacheKey(overviewQuery),
    (session) => loadWrongQuestionsOverview(overviewQuery, session),
    { refreshOnMount: true }
  );
  const groups = state.data?.groups.filter((group) =>
    activeTab === "all" || group.taskType === activeTab
  ) ?? [];

  return (
    <div className="grid gap-5">
      <StudentNavigation
        backHref={STUDENT_ROUTES.home}
        crumbs={[
          { label: STUDENT_UI_TEXT.studentHome, href: STUDENT_ROUTES.home },
          { label: STUDENT_UI_TEXT.wrongQuestions }
        ]}
      />
      {state.loading ? <StudentLoadingState text="正在加载错题集..." /> : null}
      {state.error || (!state.loading && !state.data) ? (
        <StudentErrorState text="错题集加载失败，请稍后重试。" />
      ) : null}
      {state.data ? (
        <>
          <WrongQuestionOverviewCards stats={state.data.stats} />
          {activeTab === "build_sentence" ? (
            <>
              <BasCorrectionActions />
              <BasGrammarAnalysis items={state.data.grammarPoints} />
            </>
          ) : null}
          {activeTab !== "all" && activeTab !== "build_sentence" ? (
            <ReadingCorrectionActions taskType={activeTab} />
          ) : null}
          <section aria-labelledby="wrong-question-list-title">
            <h2 className="mb-3 border-l-4 border-student-primary pl-3 text-lg font-bold text-student-text" id="wrong-question-list-title">
              我的错题
            </h2>
            <div className="overflow-hidden rounded-2xl border border-student-border bg-white shadow-[0_2px_12px_rgba(60,47,119,0.045)]">
              <WrongQuestionTabs activeTab={activeTab} onChange={setActiveTab} />
              <WrongQuestionGroupList groups={groups} />
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}

function BasCorrectionActions() {
  return (
    <section className="rounded-2xl border border-student-error-border bg-white p-5 shadow-[0_2px_12px_rgba(60,47,119,0.04)]" data-testid="bas-wrong-question-correction">
      <div>
        <h2 className="text-lg font-bold text-student-text">错题订正</h2>
        <p className="mt-1 text-sm text-student-muted">进入现有错题练习流程，分别处理今日待订正和历史错题。</p>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Link className="student-button-error min-h-11" href="/student/wrong-questions/today/practice?scope=today">
          今日错题订正 <ArrowRight aria-hidden="true" size={16} />
        </Link>
        <Link className="student-button-secondary min-h-11" href="/student/wrong-questions/history/practice?scope=history&mode=all">
          历史错题订正 <ArrowRight aria-hidden="true" size={16} />
        </Link>
      </div>
    </section>
  );
}

function ReadingCorrectionActions({ taskType }: { taskType: "ctw" | "rdl" | "rap" }) {
  return (
    <section
      className="rounded-2xl border border-student-error-border bg-white p-5 shadow-[0_2px_12px_rgba(60,47,119,0.04)]"
      data-testid={`${taskType}-wrong-question-correction`}
    >
      <div>
        <h2 className="text-lg font-bold text-student-text">错题订正</h2>
        <p className="mt-1 text-sm text-student-muted">使用当前题型原有练习界面，分别订正今日待处理和历史错题。</p>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Link className="student-button-error min-h-11" href={readingCorrectionHref("today", taskType)}>
          今日错题订正 <ArrowRight aria-hidden="true" size={16} />
        </Link>
        <Link className="student-button-secondary min-h-11" href={readingCorrectionHref("history", taskType)}>
          历史错题订正 <ArrowRight aria-hidden="true" size={16} />
        </Link>
      </div>
    </section>
  );
}

function WrongQuestionOverviewCards({ stats }: { stats: WrongQuestionsOverviewPayload["stats"] }) {
  const cards = [
    { icon: ClipboardList, label: "待订正", tone: "error", value: stats.pending },
    { icon: CircleCheckBig, label: "已订正", tone: "primary", value: stats.corrected },
    { icon: CalendarPlus, label: "本日新增", tone: "reading", value: stats.todayNew },
    { icon: Target, label: "总错题", tone: "primary", value: stats.total }
  ] as const;
  return (
    <section aria-label="错题概览" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map(({ icon: Icon, label, tone, value }) => (
        <article className="student-card flex min-h-[104px] items-center gap-4" key={label}>
          <span className={`inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full ${
            tone === "error"
              ? "bg-student-error-soft text-student-error"
              : tone === "reading"
                ? "bg-[#eef6ff] text-[#347fdc]"
                : "bg-student-primary-soft text-student-primary"
          }`}>
            <Icon aria-hidden="true" size={24} />
          </span>
          <div>
            <p className="text-sm font-semibold text-student-text">{label}</p>
            <p className={`mt-1 text-2xl font-bold tabular-nums ${
              tone === "error"
                ? "text-student-error"
                : tone === "reading"
                  ? "text-[#347fdc]"
                  : "text-student-primary"
            }`}>
              {value}<span className="ml-1 text-xs font-semibold text-student-muted">题</span>
            </p>
          </div>
        </article>
      ))}
    </section>
  );
}

function BasGrammarAnalysis({ items }: { items: Array<{ count: number; tag: string }> }) {
  const visibleItems = items.slice(0, 5);
  const highestCount = visibleItems[0]?.count ?? 0;
  return (
    <section className="rounded-2xl border border-student-primary-border bg-[linear-gradient(135deg,#fff_0%,#fbfaff_55%,#f7f5ff_100%)] p-5 shadow-[0_2px_12px_rgba(60,47,119,0.04)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold text-student-text">
          <span className="text-student-primary">Build a Sentence</span> 语法分析
        </h2>
        <Link className="inline-flex items-center gap-1.5 text-sm font-bold text-student-primary hover:underline" href={STUDENT_ROUTES.grammarPractice}>
          按语法分类练习 <ArrowRight aria-hidden="true" size={16} />
        </Link>
      </div>
      <h3 className="mt-4 text-sm font-bold text-student-text">高频错误语法点</h3>
      {visibleItems.length === 0 ? (
        <p className="mt-3 text-sm text-student-muted">暂无高频错误语法点。</p>
      ) : (
        <ol className="mt-2 divide-y divide-student-border">
          {visibleItems.map((item, index) => (
            <li className="grid items-center gap-3 py-2.5 sm:grid-cols-[1.75rem_minmax(10rem,1fr)_minmax(12rem,2fr)_4rem_auto]" key={item.tag}>
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-student-primary-soft text-xs font-bold text-student-primary">
                {index + 1}
              </span>
              <span className="min-w-0 text-sm font-semibold text-student-text">{item.tag}</span>
              <span className="h-1.5 overflow-hidden rounded-full bg-student-primary-soft">
                <span
                  className="block h-full rounded-full bg-student-primary"
                  style={{ width: `${Math.max(10, highestCount > 0 ? (item.count / highestCount) * 100 : 0)}%` }}
                />
              </span>
              <span className="text-right text-xs font-semibold tabular-nums text-student-muted">{item.count} 题</span>
              <Link className="student-button-secondary min-h-8 px-3 py-1 text-xs" href={grammarPracticeHref(item.tag)}>
                专项练习 <ArrowRight aria-hidden="true" size={14} />
              </Link>
            </li>
          ))}
        </ol>
      )}
      <div className="mt-2 border-t border-student-border pt-3 text-center">
        <Link className="inline-flex items-center gap-1.5 text-sm font-bold text-student-primary hover:underline" href={STUDENT_ROUTES.grammarPractice}>
          查看全部语法点 <ArrowRight aria-hidden="true" size={15} />
        </Link>
      </div>
    </section>
  );
}

function WrongQuestionTabs({
  activeTab,
  onChange
}: {
  activeTab: WrongQuestionTaskType | "all";
  onChange: (tab: WrongQuestionTaskType | "all") => void;
}) {
  const tabs: Array<{ label: string; value: WrongQuestionTaskType | "all" }> = [
    { label: "全部", value: "all" },
    ...WRONG_QUESTION_TASK_TYPES.map((value) => ({ label: WRONG_QUESTION_TASK_LABELS[value], value }))
  ];
  return (
    <div aria-label="错题题型" className="flex gap-6 overflow-x-auto border-b border-student-border px-5 pt-3" role="tablist">
      {tabs.map((tab) => (
        <button
          aria-selected={activeTab === tab.value}
          className={activeTab === tab.value
            ? "shrink-0 border-b-2 border-student-primary px-1 pb-3 text-sm font-bold text-student-primary"
            : "shrink-0 border-b-2 border-transparent px-1 pb-3 text-sm font-semibold text-student-muted hover:text-student-text"}
          key={tab.value}
          onClick={() => onChange(tab.value)}
          role="tab"
          type="button"
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function WrongQuestionGroupList({ groups }: { groups: WrongQuestionGroup[] }) {
  if (groups.length === 0) {
    return <div className="p-5"><StudentEmptyState text="当前题型暂无错题。" /></div>;
  }
  return (
    <div>
      {groups.map((group) => {
        const Icon = WRONG_QUESTION_ICONS[group.taskType];
        const reading = group.taskType !== "build_sentence";
        return (
          <article
            className="grid gap-4 border-b border-student-border px-5 py-4 last:border-b-0 lg:grid-cols-[minmax(0,1fr)_auto_auto] lg:items-center"
            key={`${group.taskType}:${group.groupId}`}
          >
            <div className="flex min-w-0 items-center gap-3">
              <span className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${reading ? "bg-[#eef6ff] text-[#347fdc]" : "bg-student-primary-soft text-student-primary"}`}>
                <Icon aria-hidden="true" size={22} />
              </span>
              <div className="min-w-0">
                <p>
                  <span className={reading ? "inline-flex rounded-full bg-[#eef6ff] px-2 py-0.5 text-xs font-bold text-[#347fdc]" : "student-chip"}>
                    {group.taskLabel}
                  </span>
                </p>
                <h3 className="mt-1 truncate font-bold text-student-text">{group.title}</h3>
                <p className="mt-1 text-sm text-student-muted">错题 {group.wrongCount}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm font-semibold tabular-nums">
              {group.correctedCount > 0 ? <span className="text-student-primary">已订正 {group.correctedCount}</span> : null}
              {group.pendingCount > 0 ? <span className="text-student-error">待订正 {group.pendingCount}</span> : null}
              <span className="text-xs font-medium text-student-muted">{formatWrongDate(group.latestWrongAt)}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {group.pendingCount > 0 && group.correctionHref ? (
                <Link className="student-button-error min-h-9 px-3 py-1.5 text-sm" href={group.correctionHref}>
                  去订正 <ArrowRight aria-hidden="true" size={16} />
                </Link>
              ) : null}
              <Link className="student-button-secondary min-h-9 px-3 py-1.5 text-sm" href={group.actionHref}>
                查看错题 <ArrowRight aria-hidden="true" size={16} />
              </Link>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function grammarPracticeHref(tag: string) {
  return `${STUDENT_ROUTES.grammarPractice}/practice?${new URLSearchParams({ mode: "all", tag }).toString()}`;
}

function readingCorrectionHref(scope: "history" | "today", taskType: "ctw" | "rdl" | "rap") {
  return `/student/wrong-questions/${scope}/reading/practice?${new URLSearchParams({ taskType }).toString()}`;
}

function formatWrongDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "时间未知"
    : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(date);
}

function localDayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { end: end.toISOString(), start: start.toISOString() };
}

async function loadWrongQuestionsOverview(query: string, session: StudentCacheSession) {
  const response = await fetch(`/api/wrong-questions?${query}`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${session.accessToken}` }
  });
  const payload = await response.json().catch(() => ({})) as WrongQuestionsOverviewPayload & { error?: string };
  if (!response.ok || payload.error) throw new Error(payload.error ?? "无法加载错题集。");
  return payload;
}
