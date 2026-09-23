"use client";

import { ChevronLeft, ChevronRight, Eye, FilePenLine, Play } from "lucide-react";
import { useEffect, useState } from "react";
import {
  PracticeSetAction,
  PracticeSetCatalogList
} from "@/components/shared/PracticeCatalog";
import {
  studentReadingCatalogCacheKey,
  useStudentCachedData,
  useStudentDataCache,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import {
  StudentEmptyState,
  StudentErrorState,
  StudentLoadingState,
  StudentNavigation
} from "@/components/student/StudentUI";
import {
  readingCatalogTitleParts,
  type ReadingCatalogItem,
  type ReadingCatalogPayload
} from "@/lib/reading/catalog";
import type { ReadingModule } from "@/lib/reading/types";
import { READING_PRODUCT_NAMES } from "@/lib/reading/product";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import { ReadingRetakeButton } from "./ReadingRetakeButton";
import { STUDENT_PRACTICE_ICONS } from "@/components/icons/StudentPracticeIcons";
import {
  CatalogDiscoveryControls,
  CatalogFilteredEmptyState,
  type CatalogDiscoveryControlValue
} from "@/components/shared/CatalogDiscoveryControls";
import { formatOccurrenceDates } from "@/lib/catalogOccurrenceDates";
import { catalogMonths, filterAndSortCatalogItems } from "@/lib/catalogDiscovery";
import {
  filterReadingCatalogByLength,
  type ReadingLengthFilter
} from "@/lib/reading/catalogDiscovery";

const PAGE_SIZE = 10;

export function ReadingCatalog({ taskType }: { taskType: ReadingModule }) {
  const cache = useStudentDataCache();
  const cacheKey = studentReadingCatalogCacheKey(taskType);
  const [page, setPage] = useState(1);
  const [controls, setControls] = useState<CatalogDiscoveryControlValue>(defaultControls);
  const [lengthFilter, setLengthFilter] = useState<ReadingLengthFilter>("all");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const state = useStudentCachedData<ReadingCatalogPayload>(
    cacheKey,
    (session) => loadReadingCatalog(taskType, session)
  );
  useEffect(() => {
    setPage(1);
    setControls(defaultControls());
    setLengthFilter("all");
    setDebouncedQuery("");
  }, [taskType]);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(controls.query), 200);
    return () => window.clearTimeout(timeout);
  }, [controls.query]);
  useEffect(() => setPage(1), [
    controls.query,
    controls.status,
    controls.months,
    controls.categories,
    controls.sortKey,
    controls.sortDirection,
    lengthFilter
  ]);

  if (state.loading) return <StudentLoadingState text="正在加载阅读练习..." />;
  if (state.error || !state.data) {
    return (
      <div className="grid gap-4">
        <StudentErrorState text="阅读练习列表加载失败，请稍后重试。" />
        <button className="student-button-secondary justify-self-start" onClick={() => cache.invalidate(cacheKey)} type="button">
          重新加载
        </button>
      </div>
    );
  }

  const discoveryItems = state.data.items.map((item, defaultIndex) => {
    const title = readingCatalogTitleParts(item);
    return {
      ...item,
      id: item.itemId,
      title: `${title.prefix} ${title.suffix}`,
      searchText: item.searchText ?? (item as ReadingCatalogItem & { search_text?: string }).search_text ?? "",
      occurrenceDates: item.occurrenceDates ?? [],
      occurrenceCount: item.occurrenceCount ?? 0,
      firstSeenDate: item.firstSeenDate,
      latestSeenDate: item.latestSeenDate ?? item.occurrenceDates?.[0] ?? item.firstSeenDate,
      category: item.category ?? (item as ReadingCatalogItem & { catalog_category?: string }).catalog_category ?? "",
      defaultIndex
    };
  });
  const filteredItems = filterAndSortCatalogItems(filterReadingCatalogByLength(
    discoveryItems,
    taskType === "rdl" ? lengthFilter : "all"
  ), {
    ...controls,
    query: debouncedQuery
  });
  const totalPages = Math.ceil(filteredItems.length / PAGE_SIZE);
  const visiblePage = Math.min(page, Math.max(totalPages, 1));
  const items = filteredItems.slice((visiblePage - 1) * PAGE_SIZE, visiblePage * PAGE_SIZE);
  const categories = Array.from(new Set(
    state.data.items.map((item) => item.category).filter(Boolean)
  )).sort((left, right) => left.localeCompare(right, "zh-CN"));
  const clearControls = () => {
    setControls(defaultControls());
    setLengthFilter("all");
  };
  return (
    <div className="grid gap-5">
      <StudentNavigation
        backHref={STUDENT_ROUTES.home}
        crumbs={[
          { label: "学生首页", href: STUDENT_ROUTES.home },
          { label: state.data.taskName }
        ]}
      />
      <CatalogDiscoveryControls
        categories={categories}
        months={catalogMonths(discoveryItems)}
        onChange={setControls}
        onClear={clearControls}
        layoutVariant={taskType === "rdl" ? "rdl" : "default"}
        rdlLengthFilter={taskType === "rdl" ? { onChange: setLengthFilter, value: lengthFilter } : undefined}
        value={controls}
      />
      <PracticeSetCatalogList
        emptyState={state.data.items.length
          ? <CatalogFilteredEmptyState onClear={clearControls} />
          : <StudentEmptyState text={`暂无可练习的 ${READING_PRODUCT_NAMES[taskType]} 题目。`} />}
        renderActions={(set) => <ReadingCatalogActions item={items.find((item) => item.itemId === set.setId)!} />}
        renderStatus={(set) => <ReadingCatalogStatusBadge status={items.find((item) => item.itemId === set.setId)!.status} />}
        sets={items.map((item) => {
          const title = readingCatalogTitleParts(item);
          return {
            icon: STUDENT_PRACTICE_ICONS[item.taskType],
            setId: item.itemId,
            setTitle: item.title,
            titlePrefix: title.prefix,
            titleSuffix: title.suffix,
            questionCount: item.taskType === "ctw" ? item.scoringPointCount : item.questionCount,
            metadata: <ReadingCatalogMetadata item={item} />
          };
        })}
      />
      <ReadingCatalogPagination
        onChange={setPage}
        page={visiblePage}
        totalItems={filteredItems.length}
        totalPages={totalPages}
      />
    </div>
  );
}

function ReadingCatalogActions({ item }: { item: ReadingCatalogItem }) {
  const practiceHref = `/student/reading/practice/${encodeURIComponent(item.itemId)}`;
  if (item.status === "unstarted") {
    return <PracticeSetAction href={practiceHref} icon={Play} label="开始练习" primary />;
  }
  if (item.status === "in_progress") {
    return <PracticeSetAction href={practiceHref} icon={FilePenLine} label="继续练习" primary />;
  }
  const submitted = item.latestSubmittedAttempt;
  return (
    <>
      {submitted ? (
        <PracticeSetAction
          href={`/student/reading/results/${encodeURIComponent(submitted.attemptId)}`}
          icon={Eye}
          label="查看结果"
        />
      ) : null}
      {submitted ? <ReadingRetakeButton attemptId={submitted.attemptId} compact /> : null}
    </>
  );
}

export function ReadingCatalogStatusBadge({ status }: { status: ReadingCatalogItem["status"] }) {
  const className = "inline-flex min-h-6 items-center rounded-full px-2.5 py-0.5 text-xs font-semibold";
  if (status === "in_progress") return <span className={`${className} bg-blue-50 text-blue-600`}>练习中</span>;
  if (status === "completed") return <span className={`${className} bg-emerald-50 text-emerald-700`}>已完成</span>;
  return <span className={`${className} bg-slate-100 text-student-muted`}>未开始</span>;
}

function ReadingCatalogMetadata({ item }: { item: ReadingCatalogItem }) {
  return <span>{formatOccurrenceDates(
    item.occurrenceDateCounts
      ?? (item as ReadingCatalogItem & { occurrence_date_counts?: Parameters<typeof formatOccurrenceDates>[0] }).occurrence_date_counts
      ?? item.occurrenceDates
  )}</span>;
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

export function ReadingCatalogPagination({
  onChange,
  page,
  totalItems,
  totalPages
}: {
  onChange: (page: number) => void;
  page: number;
  totalItems: number;
  totalPages: number;
}) {
  const visibleTotalPages = Math.max(totalPages, 1);
  return (
    <nav aria-label="阅读练习列表分页" className="flex flex-wrap items-center justify-between gap-3 text-sm text-student-muted">
      <span>共 {totalItems} 项 · 第 {page}/{visibleTotalPages} 页</span>
      <div className="flex gap-2">
        <button className="student-button-secondary min-h-9 px-3 py-1.5" disabled={page <= 1} onClick={() => onChange(page - 1)} type="button">
          <ChevronLeft aria-hidden="true" size={16} />上一页
        </button>
        <button className="student-button-secondary min-h-9 px-3 py-1.5" disabled={totalPages === 0 || page >= totalPages} onClick={() => onChange(page + 1)} type="button">
          下一页<ChevronRight aria-hidden="true" size={16} />
        </button>
      </div>
    </nav>
  );
}

async function loadReadingCatalog(taskType: ReadingModule, session: StudentCacheSession) {
  const response = await fetch(`/api/reading/catalog?taskType=${encodeURIComponent(taskType)}`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${session.accessToken}` }
  });
  const payload = await response.json().catch(() => ({})) as ReadingCatalogPayload & { error?: string };
  if (!response.ok || payload.error) throw new Error(payload.error ?? "阅读练习列表加载失败。");
  return payload;
}
