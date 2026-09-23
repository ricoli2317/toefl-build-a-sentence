"use client";

import { ChevronLeft, ChevronRight, Eye, FilePenLine, Play, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { PracticeSetAction, PracticeSetCatalogList } from "@/components/shared/PracticeCatalog";
import {
  CatalogDiscoveryControls,
  CatalogFilteredEmptyState,
  type CatalogDiscoveryControlValue
} from "@/components/shared/CatalogDiscoveryControls";
import { STUDENT_PRACTICE_ICONS } from "@/components/icons/StudentPracticeIcons";
import {
  studentLogicalCatalogCacheKey,
  useStudentCachedData,
  useStudentDataCache,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import {
  StudentEmptyState,
  StudentNavigation
} from "@/components/student/StudentUI";
import {
  LOGICAL_PRACTICE_ROOTS,
  logicalPracticeActionHref,
  type LogicalPracticeActionName
} from "@/lib/practiceLogicalNavigation";
import type {
  LogicalPracticeCatalogItemWithStudentState,
  LogicalPracticeCatalogWithStudentState
} from "@/lib/practiceLogicalCatalog";
import { logicalPracticeItemTitle } from "@/lib/practiceLogicalCatalog";
import type { PracticeTaskType } from "@/lib/practiceImporter/types";
import {
  measureStudentRequest,
  useStudentPagePerformance
} from "@/lib/studentPerformance.client";
import {
  catalogMonths,
  filterAndSortCatalogItems
} from "@/lib/catalogDiscovery";
import { formatOccurrenceDates } from "@/lib/catalogOccurrenceDates";

const TASK_LABELS: Record<PracticeTaskType, string> = {
  build_sentence: "Build a Sentence",
  email: "Write an Email",
  academic_discussion: "Academic Discussion"
};

export function LogicalPracticeCatalog({
  page,
  taskType
}: {
  page: number;
  taskType: PracticeTaskType;
}) {
  const label = TASK_LABELS[taskType];
  const rootHref = LOGICAL_PRACTICE_ROOTS[taskType];
  const cache = useStudentDataCache();
  const cacheKey = studentLogicalCatalogCacheKey(taskType);
  const [currentPage, setCurrentPage] = useState(page);
  const [controls, setControls] = useState<CatalogDiscoveryControlValue>(defaultControls);
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const state = useStudentCachedData<LogicalPracticeCatalogWithStudentState>(
    cacheKey,
    (session) => loadLogicalPracticeCatalog(taskType, session)
  );
  useEffect(() => setCurrentPage(page), [page, taskType]);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(controls.query), 200);
    return () => window.clearTimeout(timeout);
  }, [controls.query]);
  useEffect(() => setCurrentPage(1), [
    controls.query,
    controls.status,
    controls.months,
    controls.categories,
    controls.sortKey,
    controls.sortDirection
  ]);
  useEffect(() => {
    setControls(defaultControls());
    setDebouncedQuery("");
  }, [taskType]);
  useStudentPagePerformance({
    errors: [state.error],
    loading: state.loading,
    route: rootHref
  });

  return (
    <div className="grid gap-5">
      <StudentNavigation
        backHref="/student/sets"
        crumbs={[
          { label: "学生首页", href: "/student/sets" },
          { label }
        ]}
      />
      {state.loading ? (
        <LogicalPracticeListSkeleton />
      ) : state.error || !state.data ? (
        <LogicalPracticeCatalogError
          message={state.error || "无法加载练习列表。"}
          onRetry={() => cache.invalidate(cacheKey)}
        />
      ) : (
        <CatalogContent
          catalog={state.data}
          controls={controls}
          debouncedQuery={debouncedQuery}
          onControlsChange={setControls}
          onPageChange={setCurrentPage}
          page={currentPage}
          taskType={taskType}
        />
      )}
    </div>
  );
}

async function loadLogicalPracticeCatalog(
  taskType: PracticeTaskType,
  session: StudentCacheSession
) {
  const url = `/api/practice-catalog?taskType=${encodeURIComponent(taskType)}`;
  return measureStudentRequest(`GET ${url}`, async (captureResponse) => {
    const response = await fetch(
      url,
      {
        cache: "no-store",
        headers: { Authorization: `Bearer ${session.accessToken}` }
      }
    );
    captureResponse(response);
    const payload = (await response.json()) as LogicalPracticeCatalogWithStudentState & {
      error?: string;
    };
    if (!response.ok || payload.error) {
      throw new Error(payload.error ?? "无法加载练习列表。");
    }
    return payload;
  });
}

function CatalogContent({
  catalog,
  controls,
  debouncedQuery,
  onControlsChange,
  onPageChange,
  page,
  taskType
}: {
  catalog: LogicalPracticeCatalogWithStudentState;
  controls: CatalogDiscoveryControlValue;
  debouncedQuery: string;
  onControlsChange: (value: CatalogDiscoveryControlValue) => void;
  onPageChange: (page: number) => void;
  page: number;
  taskType: PracticeTaskType;
}) {
  const discoveryItems = catalog.items.map((item, defaultIndex) => ({
    ...item,
    id: item.item_id,
    title: logicalPracticeItemTitle(item),
    searchText: item.search_text ?? (item as LogicalPracticeCatalogItemWithStudentState & { searchText?: string }).searchText ?? "",
    status: item.student_state.status,
    occurrenceDates: item.occurrence_dates ?? [],
    occurrenceCount: item.occurrence_count ?? 0,
    firstSeenDate: item.first_seen_date,
    latestSeenDate: item.latest_seen_date ?? item.occurrence_dates?.[0] ?? item.first_seen_date,
    category: item.catalog_category ?? (item as LogicalPracticeCatalogItemWithStudentState & { category?: string | null }).category ?? null,
    defaultIndex
  }));
  const filteredItems = filterAndSortCatalogItems(discoveryItems, {
    ...controls,
    query: debouncedQuery
  });
  const totalPages = Math.ceil(filteredItems.length / catalog.pagination.page_size);
  const visibleTotalPages = Math.max(totalPages, 1);
  const visiblePage = Math.min(Math.max(page, 1), visibleTotalPages);
  const from = (visiblePage - 1) * catalog.pagination.page_size;
  const items = filteredItems.slice(from, from + catalog.pagination.page_size);
  const categories = taskType === "build_sentence" ? null : Array.from(new Set(
    catalog.items.map((item) => item.catalog_category).filter((value): value is string => Boolean(value))
  )).sort((left, right) => left.localeCompare(right, "zh-CN"));
  const clearControls = () => onControlsChange(defaultControls());

  return (
    <>
      <CatalogDiscoveryControls
        categories={categories}
        months={catalogMonths(discoveryItems)}
        onChange={onControlsChange}
        onClear={clearControls}
        value={controls}
      />
      <PracticeSetCatalogList
        emptyState={catalog.items.length
          ? <CatalogFilteredEmptyState onClear={clearControls} />
          : <StudentEmptyState text={emptyStateText(taskType)} />}
        renderActions={(catalogSet) => {
          const item = items.find((candidate) => candidate.item_id === catalogSet.setId)!;
          return <LogicalItemActions item={item} taskType={taskType} />;
        }}
        renderStatus={(catalogSet) => {
          const item = items.find((candidate) => candidate.item_id === catalogSet.setId)!;
          return <LogicalItemStatus status={item.student_state.status} />;
        }}
        sets={items.map((item) => ({
          icon: STUDENT_PRACTICE_ICONS[item.task_type],
          metadata: formatOccurrenceDates(
            item.occurrence_date_counts
              ?? (item as LogicalPracticeCatalogItemWithStudentState & { occurrenceDateCounts?: Parameters<typeof formatOccurrenceDates>[0] }).occurrenceDateCounts
              ?? item.occurrence_dates
          ),
          questionCount: item.question_count,
          setId: item.item_id,
          setTitle: logicalPracticeItemTitle(item),
          titlePrefix: item.task_type === "build_sentence" ? `套题${item.display_number}` : `题目${item.display_number}`,
          titleSuffix: item.task_type === "build_sentence" ? null : item.display_title
        }))}
      />
      <CatalogPagination
        onPageChange={onPageChange}
        page={visiblePage}
        totalItems={filteredItems.length}
        totalPages={totalPages}
      />
    </>
  );
}

function defaultControls(): CatalogDiscoveryControlValue {
  return {
    query: "",
    status: "all",
    months: [],
    categories: [],
    sortKey: "default",
    sortDirection: "desc"
  };
}

function LogicalItemActions({
  item,
  taskType
}: {
  item: LogicalPracticeCatalogItemWithStudentState;
  taskType: PracticeTaskType;
}) {
  const viewLabel = taskType === "build_sentence" ? "查看结果" : "查看提交";
  return (
    <>
      {item.student_state.status === "unstarted"
        ? action(item, taskType, "start", Play, "开始练习")
        : null}
      {item.student_state.status === "in_progress"
        ? action(item, taskType, "resume", FilePenLine, "继续练习", true)
        : null}
      {item.actions.view_result
        ? action(item, taskType, "view_result", Eye, viewLabel)
        : null}
      {item.student_state.status === "completed"
        ? action(item, taskType, "retake", RotateCcw, "再练一次")
        : null}
    </>
  );
}

function action(
  item: LogicalPracticeCatalogItemWithStudentState,
  taskType: PracticeTaskType,
  actionName: LogicalPracticeActionName,
  icon: typeof Play,
  label: string,
  primary = false
) {
  const href = logicalPracticeActionHref(taskType, actionName, item.actions[actionName]);
  return href ? (
    <PracticeSetAction href={href} icon={icon} key={actionName} label={label} primary={primary} />
  ) : null;
}

function CatalogPagination({
  onPageChange,
  page,
  totalItems,
  totalPages
}: {
  onPageChange: (page: number) => void;
  page: number;
  totalItems: number;
  totalPages: number;
}) {
  const visibleTotalPages = Math.max(totalPages, 1);
  return (
    <nav aria-label="练习列表分页" className="flex flex-wrap items-center justify-between gap-3 text-sm text-student-muted">
      <span>共 {totalItems} 项 · 第 {page}/{visibleTotalPages} 页</span>
      <div className="flex gap-2">
        <CatalogPageButton disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          <ChevronLeft aria-hidden="true" size={16} />上一页
        </CatalogPageButton>
        <CatalogPageButton
          disabled={totalPages === 0 || page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          下一页<ChevronRight aria-hidden="true" size={16} />
        </CatalogPageButton>
      </div>
    </nav>
  );
}

function CatalogPageButton({
  children,
  disabled,
  onClick
}: {
  children: React.ReactNode;
  disabled: boolean;
  onClick: () => void;
}) {
  const className = "student-button-secondary min-h-9 px-3 py-1.5";
  return (
    <button
      className={disabled ? `${className} cursor-not-allowed opacity-50` : className}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function LogicalItemStatus({
  status
}: {
  status: LogicalPracticeCatalogItemWithStudentState["student_state"]["status"];
}) {
  if (status === "in_progress") {
    return (
      <span className="inline-flex min-h-6 items-center rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-semibold text-blue-600">
        练习中
      </span>
    );
  }
  if (status === "completed") {
    return (
      <span className="inline-flex min-h-6 items-center rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
        已完成
      </span>
    );
  }
  return null;
}

function emptyStateText(taskType: PracticeTaskType) {
  if (taskType === "build_sentence") return "暂无可练习套题。";
  if (taskType === "email") return "暂无可练习邮件题目。";
  return "暂无可练习学术讨论题目。";
}

function LogicalPracticeListSkeleton() {
  return (
    <div aria-label="正在加载练习列表" aria-live="polite" className="grid gap-1.5">
      {Array.from({ length: 7 }, (_, index) => (
        <div
          aria-hidden="true"
          className="grid min-h-[64px] animate-pulse grid-cols-[2.5rem_minmax(0,1fr)_5rem] items-center gap-3 rounded-2xl border border-student-border bg-white px-4 py-2.5 sm:px-5"
          key={index}
        >
          <span className="h-10 w-10 rounded-[10px] bg-student-primary-soft" />
          <span className="grid gap-2">
            <span className="h-4 w-2/5 rounded bg-slate-100" />
            <span className="h-3 w-1/3 rounded bg-slate-100" />
          </span>
          <span className="h-8 rounded-[9px] bg-student-primary-soft" />
        </div>
      ))}
    </div>
  );
}

function LogicalPracticeCatalogError({
  message,
  onRetry
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="student-error-state flex flex-wrap items-center justify-between gap-3">
      <p>{message}</p>
      <button className="student-button-secondary min-h-9 px-3 py-1.5" onClick={onRetry} type="button">
        重新加载
      </button>
    </div>
  );
}
