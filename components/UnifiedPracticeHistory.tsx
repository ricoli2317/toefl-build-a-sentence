"use client";

import Link from "next/link";
import {
  BookOpen,
  CalendarDays,
  ChartNoAxesColumnIncreasing,
  Clock3,
  Eye,
  FileCheck2,
  FileText,
  Mail,
  MessageCircleMore,
  Puzzle,
  RotateCcw,
  Timer
} from "lucide-react";
import { useState, type ComponentType, type SVGProps } from "react";
import { CompleteTheWordsIcon } from "@/components/icons/CompleteTheWordsIcon";
import {
  STUDENT_PRACTICE_HISTORY_CACHE_PREFIX,
  useStudentCachedData,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import { ReadingRetakeButton } from "@/components/reading/ReadingRetakeButton";
import {
  StudentEmptyState,
  StudentErrorState,
  StudentLoadingState,
  StudentNavigation
} from "@/components/student/StudentUI";
import {
  UNIFIED_HISTORY_TASK_LABELS,
  UNIFIED_HISTORY_TASK_TYPES,
  type UnifiedHistoryCategory,
  type UnifiedHistoryPayload,
  type UnifiedHistoryRecord,
  type UnifiedHistoryTaskType
} from "@/lib/unifiedPracticeHistory";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";

const PAGE_SIZE = 20;

const CATEGORY_OPTIONS: Array<{ label: string; value: UnifiedHistoryCategory }> = [
  { label: "全部", value: "all" },
  { label: "写作", value: "writing" },
  { label: "阅读", value: "reading" }
];

type HistoryIcon = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>;

const TASK_ICONS: Record<UnifiedHistoryTaskType, HistoryIcon> = {
  build_sentence: Puzzle,
  email: Mail,
  academic_discussion: MessageCircleMore,
  ctw: CompleteTheWordsIcon,
  rdl: FileText,
  rap: BookOpen
};

export function UnifiedPracticeHistory() {
  const [category, setCategory] = useState<UnifiedHistoryCategory>("all");
  const [taskType, setTaskType] = useState<UnifiedHistoryTaskType | "all">("all");
  const [offset, setOffset] = useState(0);
  const [todayRange] = useState(localDayRange);
  const query = buildQuery({ category, offset, taskType, ...todayRange });
  const state = useStudentCachedData<UnifiedHistoryPayload>(
    `${STUDENT_PRACTICE_HISTORY_CACHE_PREFIX}:unified:${query}`,
    (session) => loadUnifiedHistory(query, session),
    { refreshOnMount: true }
  );

  function selectCategory(nextCategory: UnifiedHistoryCategory) {
    setCategory(nextCategory);
    if (
      (nextCategory === "writing" && isReadingTask(taskType))
      || (nextCategory === "reading" && isWritingTask(taskType))
    ) {
      setTaskType("all");
    }
    setOffset(0);
  }

  function selectTaskType(nextTaskType: UnifiedHistoryTaskType | "all") {
    setTaskType(nextTaskType);
    if (nextTaskType !== "all") {
      setCategory(isReadingTask(nextTaskType) ? "reading" : "writing");
    }
    setOffset(0);
  }

  return (
    <div className="grid gap-5">
      <StudentNavigation
        backHref={STUDENT_ROUTES.home}
        crumbs={[
          { label: "学生首页", href: STUDENT_ROUTES.home },
          { label: "练习历史" }
        ]}
      />

      {state.loading ? <StudentLoadingState text="正在加载练习历史..." /> : null}
      {state.error || (!state.loading && !state.data) ? (
        <StudentErrorState text="练习历史加载失败，请稍后重试。" />
      ) : null}
      {state.data ? (
        <>
          <OverviewCards overview={state.data.overview} />
          <section className="overflow-hidden rounded-2xl border border-student-border bg-white shadow-[0_2px_12px_rgba(60,47,119,0.045)]">
            <HistoryFilters
              category={category}
              onCategoryChange={selectCategory}
              onTaskTypeChange={selectTaskType}
              taskType={taskType}
            />
            <HistoryRecords records={state.data.records} />
            <HistoryPagination
              onPageChange={setOffset}
              pagination={state.data.pagination}
            />
          </section>
        </>
      ) : null}
    </div>
  );
}

function OverviewCards({ overview }: { overview: UnifiedHistoryPayload["overview"] }) {
  const cards = [
    { icon: CalendarDays, label: "今日完成", value: `${overview.todayCompleted} 次` },
    { icon: Clock3, label: "今日用时", value: formatOverviewDuration(overview.todayDurationSeconds) },
    { icon: ChartNoAxesColumnIncreasing, label: "累计完成", value: `${overview.allCompleted} 次` },
    { icon: Timer, label: "累计用时", value: formatOverviewDuration(overview.allDurationSeconds) }
  ];
  return (
    <section aria-labelledby="history-overview-title">
      <h2 className="mb-3 border-l-4 border-student-primary pl-3 text-lg font-bold text-student-text" id="history-overview-title">
        练习概览
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map(({ icon: Icon, label, value }) => (
          <article className="student-card flex min-h-[104px] items-center gap-4" key={label}>
            <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-student-primary-soft text-student-primary">
              <Icon aria-hidden="true" size={24} />
            </span>
            <div>
              <p className="text-sm font-semibold text-student-text">{label}</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-student-primary">{value}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function HistoryFilters({
  category,
  onCategoryChange,
  onTaskTypeChange,
  taskType
}: {
  category: UnifiedHistoryCategory;
  onCategoryChange: (category: UnifiedHistoryCategory) => void;
  onTaskTypeChange: (taskType: UnifiedHistoryTaskType | "all") => void;
  taskType: UnifiedHistoryTaskType | "all";
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-student-border px-5 pt-3">
      <div aria-label="练习分类" className="flex gap-6" role="tablist">
        {CATEGORY_OPTIONS.map((option) => (
          <button
            aria-selected={category === option.value}
            className={category === option.value
              ? "border-b-2 border-student-primary px-1 pb-3 text-sm font-bold text-student-primary"
              : "border-b-2 border-transparent px-1 pb-3 text-sm font-semibold text-student-muted hover:text-student-text"}
            key={option.value}
            onClick={() => onCategoryChange(option.value)}
            role="tab"
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
      <label className="mb-3 flex items-center gap-2 text-sm font-semibold text-student-muted">
        <span className="sr-only">题型</span>
        <select
          className="min-h-9 rounded-lg border border-student-border bg-white px-3 text-sm font-semibold text-student-text outline-none focus:border-student-primary"
          onChange={(event) => onTaskTypeChange(event.target.value as UnifiedHistoryTaskType | "all")}
          value={taskType}
        >
          <option value="all">全部题型</option>
          {UNIFIED_HISTORY_TASK_TYPES.map((value) => (
            <option key={value} value={value}>{UNIFIED_HISTORY_TASK_LABELS[value]}</option>
          ))}
        </select>
      </label>
    </div>
  );
}

function HistoryRecords({ records }: { records: UnifiedHistoryRecord[] }) {
  if (records.length === 0) {
    return <div className="p-5"><StudentEmptyState text="当前筛选下还没有已提交的练习记录。" /></div>;
  }
  return (
    <div>
      {records.map((record) => {
        const Icon = TASK_ICONS[record.taskType];
        return (
          <article
            className="grid gap-4 border-b border-student-border px-5 py-4 last:border-b-0 lg:grid-cols-[minmax(0,1.35fr)_minmax(15rem,.9fr)_auto] lg:items-center"
            key={`${record.taskType}:${record.attemptId}`}
          >
            <div className="flex min-w-0 items-center gap-3">
              <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-student-primary-soft text-student-primary">
                <Icon aria-hidden="true" size={22} />
              </span>
              <div className="min-w-0">
                <p><span className="student-chip">{record.taskLabel}</span></p>
                <h3 className="mt-1.5 truncate font-bold text-student-text">{record.title}</h3>
                <p className="mt-1 text-sm text-student-muted">{formatDateTime(record.submittedAt)}</p>
              </div>
            </div>
            <p className="text-sm font-semibold tabular-nums text-student-text">
              {formatMetrics(record)}
            </p>
            <div className="flex flex-wrap gap-2 lg:justify-end">
              <Link className="student-button-secondary min-h-9 px-3 py-1.5 text-sm" href={record.resultTarget.href}>
                {record.resultTarget.label === "查看批改"
                  ? <FileCheck2 aria-hidden="true" size={16} />
                  : <Eye aria-hidden="true" size={16} />}
                {record.resultTarget.label}
              </Link>
              {record.retakeTarget.method === "POST" ? (
                <ReadingRetakeButton attemptId={record.attemptId} compact label={record.retakeTarget.label} />
              ) : (
                <Link className="student-button-primary min-h-9 px-3 py-1.5 text-sm" href={record.retakeTarget.href}>
                  <RotateCcw aria-hidden="true" size={16} />
                  {record.retakeTarget.label}
                </Link>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function HistoryPagination({
  onPageChange,
  pagination
}: {
  onPageChange: (offset: number) => void;
  pagination: UnifiedHistoryPayload["pagination"];
}) {
  if (pagination.total <= pagination.limit) {
    return <p className="border-t border-student-border px-5 py-3 text-center text-xs text-student-muted">已加载全部记录</p>;
  }
  const currentPage = Math.floor(pagination.offset / pagination.limit) + 1;
  const totalPages = Math.ceil(pagination.total / pagination.limit);
  return (
    <div className="flex items-center justify-center gap-3 border-t border-student-border px-5 py-3">
      <button
        className="student-button-secondary min-h-8 px-3 py-1 text-sm"
        disabled={pagination.offset === 0}
        onClick={() => onPageChange(Math.max(0, pagination.offset - pagination.limit))}
        type="button"
      >上一页</button>
      <span className="text-sm tabular-nums text-student-muted">{currentPage} / {totalPages}</span>
      <button
        className="student-button-secondary min-h-8 px-3 py-1 text-sm"
        disabled={pagination.nextOffset === null}
        onClick={() => pagination.nextOffset !== null && onPageChange(pagination.nextOffset)}
        type="button"
      >下一页</button>
    </div>
  );
}

function formatMetrics(record: UnifiedHistoryRecord) {
  const duration = formatAttemptDuration(record.durationSeconds);
  if (record.metrics.kind === "objective") {
    return `得分 ${record.metrics.correct}/${record.metrics.total} · 正确率 ${Math.round(record.metrics.accuracy * 100)}% · 用时 ${duration}`;
  }
  return `${record.metrics.wordCount} words · 用时 ${duration} · ${record.metrics.hasPublishedReview
    ? `评分 ${record.metrics.reviewScore ?? "—"}/5`
    : "已提交"}`;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "完成时间未知"
    : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatAttemptDuration(value: number) {
  const seconds = Math.max(0, Math.round(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatOverviewDuration(value: number) {
  const seconds = Math.max(0, Math.round(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function localDayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { todayEnd: end.toISOString(), todayStart: start.toISOString() };
}

function buildQuery(input: {
  category: UnifiedHistoryCategory;
  offset: number;
  taskType: UnifiedHistoryTaskType | "all";
  todayEnd: string;
  todayStart: string;
}) {
  return new URLSearchParams({
    category: input.category,
    limit: String(PAGE_SIZE),
    offset: String(input.offset),
    taskType: input.taskType,
    todayEnd: input.todayEnd,
    todayStart: input.todayStart
  }).toString();
}

async function loadUnifiedHistory(query: string, session: StudentCacheSession) {
  const response = await fetch(`/api/unified-practice-history?${query}`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${session.accessToken}` }
  });
  const payload = await response.json().catch(() => ({})) as UnifiedHistoryPayload & { error?: string };
  if (!response.ok || payload.error) throw new Error(payload.error ?? "练习历史加载失败。");
  return payload;
}

function isReadingTask(taskType: UnifiedHistoryTaskType | "all") {
  return taskType === "ctw" || taskType === "rdl" || taskType === "rap";
}

function isWritingTask(taskType: UnifiedHistoryTaskType | "all") {
  return taskType === "build_sentence" || taskType === "email" || taskType === "academic_discussion";
}
