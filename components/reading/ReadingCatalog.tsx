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
import type {
  ReadingCatalogItem,
  ReadingCatalogPayload
} from "@/lib/reading/catalog";
import type { ReadingModule } from "@/lib/reading/types";
import { READING_PRODUCT_NAMES } from "@/lib/reading/product";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import { formatOccurrenceDates } from "@/components/LogicalPracticeCatalog";
import { ReadingRetakeButton } from "./ReadingRetakeButton";

const PAGE_SIZE = 10;

export function ReadingCatalog({ taskType }: { taskType: ReadingModule }) {
  const cache = useStudentDataCache();
  const cacheKey = studentReadingCatalogCacheKey(taskType);
  const [page, setPage] = useState(1);
  const state = useStudentCachedData<ReadingCatalogPayload>(
    cacheKey,
    (session) => loadReadingCatalog(taskType, session)
  );
  useEffect(() => setPage(1), [taskType]);

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

  const totalPages = Math.ceil(state.data.items.length / PAGE_SIZE);
  const visiblePage = Math.min(page, Math.max(totalPages, 1));
  const items = state.data.items.slice((visiblePage - 1) * PAGE_SIZE, visiblePage * PAGE_SIZE);
  return (
    <div className="grid gap-5">
      <StudentNavigation
        backHref={STUDENT_ROUTES.home}
        crumbs={[
          { label: "学生首页", href: STUDENT_ROUTES.home },
          { label: state.data.taskName }
        ]}
      />
      <PracticeSetCatalogList
        emptyState={<StudentEmptyState text={`暂无可练习的 ${READING_PRODUCT_NAMES[taskType]} 题目。`} />}
        renderActions={(set) => <ReadingCatalogActions item={items.find((item) => item.itemId === set.setId)!} />}
        renderStatus={(set) => <ReadingCatalogStatusBadge status={items.find((item) => item.itemId === set.setId)!.status} />}
        sets={items.map((item) => ({
          setId: item.itemId,
          setTitle: item.title,
          titlePrefix: `${item.taskType === "ctw" ? "套题" : "题目"}${item.displayNumber}`,
          titleSuffix: item.taskType === "ctw" ? null : item.title,
          questionCount: item.taskType === "ctw" ? item.scoringPointCount : item.questionCount,
          metadata: <ReadingCatalogMetadata item={item} />
        }))}
      />
      <ReadingCatalogPagination
        onChange={setPage}
        page={visiblePage}
        totalItems={state.data.items.length}
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

function ReadingCatalogStatusBadge({ status }: { status: ReadingCatalogItem["status"] }) {
  const className = "inline-flex min-h-6 items-center rounded-full px-2.5 py-0.5 text-xs font-semibold";
  if (status === "in_progress") return <span className={`${className} bg-blue-50 text-blue-600`}>练习中</span>;
  if (status === "completed") return <span className={`${className} bg-emerald-50 text-emerald-700`}>已完成</span>;
  return <span className={`${className} bg-slate-100 text-student-muted`}>未开始</span>;
}

function ReadingCatalogMetadata({ item }: { item: ReadingCatalogItem }) {
  return <span>{formatOccurrenceDates(item.occurrenceDates)}</span>;
}

function ReadingCatalogPagination({
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
