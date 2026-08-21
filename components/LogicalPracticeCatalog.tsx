"use client";

import { ChevronLeft, ChevronRight, Eye, FilePenLine, Play, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { PracticeSetAction, PracticeSetCatalogList } from "@/components/shared/PracticeCatalog";
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
  const state = useStudentCachedData<LogicalPracticeCatalogWithStudentState>(
    cacheKey,
    (session) => loadLogicalPracticeCatalog(taskType, session)
  );
  useEffect(() => setCurrentPage(page), [page, taskType]);
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
  onPageChange,
  page,
  taskType
}: {
  catalog: LogicalPracticeCatalogWithStudentState;
  onPageChange: (page: number) => void;
  page: number;
  taskType: PracticeTaskType;
}) {
  const totalPages = catalog.pagination.total_pages;
  const visibleTotalPages = Math.max(totalPages, 1);
  const visiblePage = Math.min(Math.max(page, 1), visibleTotalPages);
  const from = (visiblePage - 1) * catalog.pagination.page_size;
  const items = catalog.items.slice(from, from + catalog.pagination.page_size);

  return (
    <>
      <PracticeSetCatalogList
        emptyState={<StudentEmptyState text={emptyStateText(taskType)} />}
        renderActions={(catalogSet) => {
          const item = items.find((candidate) => candidate.item_id === catalogSet.setId)!;
          return <LogicalItemActions item={item} taskType={taskType} />;
        }}
        renderStatus={(catalogSet) => {
          const item = items.find((candidate) => candidate.item_id === catalogSet.setId)!;
          return <LogicalItemStatus status={item.student_state.status} />;
        }}
        sets={items.map((item) => ({
          metadata: formatOccurrenceDates(item.occurrence_dates),
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
        totalItems={catalog.pagination.total_items}
        totalPages={totalPages}
      />
    </>
  );
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

export function formatOccurrenceDates(dates: string[]) {
  return dates.map((date) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    return match ? `${match[1].slice(-2)}${match[2]}${match[3]}` : date;
  }).join("、");
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
