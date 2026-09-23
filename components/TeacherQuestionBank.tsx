"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Eye } from "lucide-react";
import { buildSentenceDisplay, splitTextItems } from "@/lib/questionText";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { QuestionViewerNav } from "@/components/QuestionViewerNav";
import { TeacherBreadcrumbs } from "@/components/teacher/TeacherAppShell";
import {
  TeacherCard,
  TeacherDataError,
  TeacherEmptyState,
  TeacherLoadingRegion,
  TeacherSkeleton
} from "@/components/teacher/TeacherUI";
import {
  PracticeSetAction,
  PracticeSetCatalogList
} from "@/components/shared/PracticeCatalog";
import {
  CatalogDiscoveryControls,
  CatalogFilteredEmptyState,
  type CatalogDiscoveryControlValue
} from "@/components/shared/CatalogDiscoveryControls";
import { QuestionDisplay } from "@/components/shared/QuestionDisplay";
import { WritingQuestionReview } from "@/components/writing/WritingQuestionPrompt";
import {
  TEACHER_QUESTION_BANK_CACHE_PREFIX,
  useTeacherCachedData
} from "@/components/TeacherDataCache";
import {
  logicalPracticeItemTitle,
  type LogicalPracticeCatalog,
  type LogicalPracticeListItem
} from "@/lib/practiceLogicalCatalog";
import { READING_PRODUCT_NAMES } from "@/lib/reading/product";
import type { PracticeTaskType } from "@/lib/practiceImporter/types";
import type { AcademicDiscussionAvatarMap } from "@/lib/academicDiscussionAvatars";
import type { Question } from "@/lib/types";
import type { WritingQuestion } from "@/lib/writing";
import { formatOccurrenceDates } from "@/lib/catalogOccurrenceDates";
import { catalogMonths, filterAndSortCatalogItems } from "@/lib/catalogDiscovery";
import { TeacherReadingQuestionBankCatalog } from "@/components/teacher/TeacherReadingQuestionBank";
import { STUDENT_PRACTICE_ICONS } from "@/components/icons/StudentPracticeIcons";
import {
  isReadingModuleTaskType,
  type TeacherQuestionBankTaskType
} from "@/lib/teacherReadingQuestionBank";

const QUESTION_BANK_TASK_GROUPS: Array<{
  label: string;
  tabs: Array<{ label: string; taskType: TeacherQuestionBankTaskType }>;
}> = [
  {
    label: "写作",
    tabs: [
      { label: "Build a Sentence", taskType: "build_sentence" },
      { label: "Write an Email", taskType: "email" },
      { label: "Academic Discussion", taskType: "academic_discussion" }
    ]
  },
  {
    label: "阅读",
    tabs: [
      { label: READING_PRODUCT_NAMES.ctw, taskType: "ctw" },
      { label: READING_PRODUCT_NAMES.rdl, taskType: "rdl" },
      { label: READING_PRODUCT_NAMES.rap, taskType: "rap" }
    ]
  }
];

type TeacherLogicalItem = Pick<
  LogicalPracticeListItem,
  "item_id" | "task_type" | "display_number" | "display_title" | "first_seen_date" | "question_count"
>;

type LogicalItemDetail = {
  avatars?: AcademicDiscussionAvatarMap;
  item: TeacherLogicalItem;
  question?: WritingQuestion;
  questions?: Question[];
  error?: string;
};

export function TeacherQuestionBankCatalog({
  page,
  taskType
}: {
  page: number;
  taskType: TeacherQuestionBankTaskType;
}) {
  return (
    <div className="grid gap-5">
      <TeacherBreadcrumbs
        crumbs={[{ label: "首页", href: "/teacher/dashboard" }, { label: "教师题库" }]}
      />
      <QuestionBankTaskTabs taskType={taskType} />
      {isReadingModuleTaskType(taskType) ? (
        <TeacherReadingQuestionBankCatalog module={taskType} page={page} />
      ) : (
        <TeacherWritingQuestionBankCatalog page={page} taskType={taskType} />
      )}
    </div>
  );
}

function QuestionBankTaskTabs({ taskType }: { taskType: TeacherQuestionBankTaskType }) {
  return (
    <nav aria-label="题目类型" className="grid gap-2">
      {QUESTION_BANK_TASK_GROUPS.map((group) => (
        <div className="flex flex-wrap items-center gap-2" key={group.label}>
          <span className="w-8 text-xs font-semibold text-student-muted">{group.label}</span>
          {group.tabs.map((tab) => {
            const active = tab.taskType === taskType;
            return (
              <Link
                aria-current={active ? "page" : undefined}
                className={active ? "student-button-primary min-h-10 px-4" : "student-button-secondary min-h-10 px-4"}
                href={`/teacher/question-bank?taskType=${tab.taskType}`}
                key={tab.taskType}
              >
                {tab.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

function TeacherWritingQuestionBankCatalog({
  page,
  taskType
}: {
  page: number;
  taskType: PracticeTaskType;
}) {
  const cacheKey = `${TEACHER_QUESTION_BANK_CACHE_PREFIX}:catalog:${taskType}`;
  const [currentPage, setCurrentPage] = useState(page);
  const [controls, setControls] = useState<CatalogDiscoveryControlValue>(defaultDiscoveryControls);
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const { data, error, loading } = useTeacherCachedData<LogicalPracticeCatalog>(
    cacheKey,
    () => loadQuestionBankCatalog(taskType)
  );
  useEffect(() => setCurrentPage(page), [page, taskType]);
  useEffect(() => {
    setControls(defaultDiscoveryControls());
    setDebouncedQuery("");
  }, [taskType]);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(controls.query), 200);
    return () => window.clearTimeout(timeout);
  }, [controls.query]);
  useEffect(() => setCurrentPage(1), [
    controls.query,
    controls.months,
    controls.categories,
    controls.sortKey,
    controls.sortDirection
  ]);

  return (
    <div className="grid gap-5">
      {loading ? <TeacherLoadingRegion label="正在加载题目" /> : null}
      {loading ? (
        <LogicalItemListSkeleton />
      ) : error || !data ? (
        <TeacherDataError text={toQuestionBankErrorMessage(error || "无法加载题库。")} />
      ) : (
        <TeacherLogicalCatalogContent
          catalog={data}
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

function TeacherLogicalCatalogContent({
  catalog,
  controls,
  debouncedQuery,
  onControlsChange,
  onPageChange,
  page,
  taskType
}: {
  catalog: LogicalPracticeCatalog;
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
    searchText: item.search_text ?? "",
    occurrenceDates: item.occurrence_dates ?? [],
    occurrenceCount: item.occurrence_count ?? 0,
    firstSeenDate: item.first_seen_date,
    latestSeenDate: item.latest_seen_date ?? item.occurrence_dates?.[0] ?? item.first_seen_date,
    category: item.catalog_category ?? null,
    defaultIndex
  }));
  const filteredItems = filterAndSortCatalogItems(discoveryItems, {
    ...controls,
    status: "all",
    query: debouncedQuery
  });
  const totalPages = Math.ceil(filteredItems.length / catalog.pagination.page_size);
  const visiblePage = Math.min(Math.max(page, 1), Math.max(totalPages, 1));
  const from = (visiblePage - 1) * catalog.pagination.page_size;
  const items = filteredItems.slice(from, from + catalog.pagination.page_size);
  const categories = taskType === "build_sentence" ? null : Array.from(new Set(
    catalog.items.map((item) => item.catalog_category).filter((value): value is string => Boolean(value))
  )).sort((left, right) => left.localeCompare(right, "zh-CN"));
  const clearControls = () => onControlsChange(defaultDiscoveryControls());

  return (
    <>
      <CatalogDiscoveryControls
        categories={categories}
        months={catalogMonths(discoveryItems)}
        onChange={onControlsChange}
        onClear={clearControls}
        showStatus={false}
        value={controls}
      />
      <PracticeSetCatalogList
        emptyState={catalog.items.length
          ? <CatalogFilteredEmptyState onClear={clearControls} />
          : <TeacherEmptyState text={emptyStateText(taskType)} />}
        renderActions={(catalogSet) => (
          <PracticeSetAction
            href={`/teacher/question-bank/${encodeURIComponent(catalogSet.setId)}?taskType=${taskType}&page=${visiblePage}`}
            icon={Eye}
            label="查看题目"
          />
        )}
        sets={items.map((item) => ({
          icon: STUDENT_PRACTICE_ICONS[item.task_type],
          metadata: formatOccurrenceDates(item.occurrence_date_counts ?? item.occurrence_dates ?? []),
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

export function TeacherQuestionBankItemViewer({
  itemId,
  returnPage,
  returnTaskType
}: {
  itemId: string;
  returnPage: number;
  returnTaskType: PracticeTaskType;
}) {
  const cacheKey = `${TEACHER_QUESTION_BANK_CACHE_PREFIX}:item:${itemId}`;
  const { data, error, loading } = useTeacherCachedData<LogicalItemDetail>(
    cacheKey,
    () => loadQuestionBankItem(itemId)
  );
  const [currentIndex, setCurrentIndex] = useState(0);
  const item = data?.item;
  const taskType = item?.task_type ?? returnTaskType;
  const rootHref = `/teacher/question-bank?taskType=${taskType}&page=${returnPage}`;
  const title = item ? logicalPracticeItemTitle(item) : "题目详情";

  useEffect(() => {
    setCurrentIndex(0);
  }, [itemId]);

  return (
    <div className="grid gap-5">
      <TeacherBreadcrumbs
        crumbs={[
          { label: "首页", href: "/teacher/dashboard" },
          { label: "教师题库", href: rootHref },
          { label: title }
        ]}
      />
      <Link className="student-button-secondary w-fit min-h-10 px-4" href={rootHref}>
        <ChevronLeft aria-hidden="true" size={17} />返回教师题库
      </Link>
      {loading ? <TeacherLoadingRegion label="正在加载题目详情" /> : null}
      {loading ? (
        <QuestionViewerSkeleton />
      ) : error || !data || !item ? (
        <TeacherDataError text={toQuestionBankErrorMessage(error || "无法加载题目详情。")} />
      ) : item.task_type === "build_sentence" ? (
        <BasLogicalItemViewer
          currentIndex={currentIndex}
          onChange={setCurrentIndex}
          questions={data.questions ?? []}
        />
      ) : data.question ? (
        <div data-readonly-writing-question>
          <TeacherCard className="p-5">
            <WritingQuestionReview
              avatarMap={data.avatars ?? {}}
              avatarMapReady={item.task_type === "email" || Boolean(data.avatars)}
              question={data.question}
              taskType={item.task_type}
            />
          </TeacherCard>
        </div>
      ) : (
        <TeacherEmptyState text="该题目暂无内容。" />
      )}
    </div>
  );
}

function BasLogicalItemViewer({
  currentIndex,
  onChange,
  questions
}: {
  currentIndex: number;
  onChange: (index: number) => void;
  questions: Question[];
}) {
  const currentQuestion = questions[currentIndex];
  if (questions.length !== 10 || !currentQuestion) {
    return <TeacherEmptyState text="该 Build a Sentence 套题未包含完整 10 题。" />;
  }
  return (
    <div className="grid gap-4" data-logical-bas-question-count={questions.length}>
      <QuestionDisplay
        answers={Array.from({ length: currentQuestion.blank_count }, () => null)}
        locale="zh-CN"
        options={splitTextItems(currentQuestion.options_text).map((text, index) => ({
          id: `${currentQuestion.question_id}-${index}`,
          text
        }))}
        prompt={currentQuestion.prompt}
        questionNumber={currentQuestion.question_order}
        readOnly
        template={currentQuestion.sentence_template}
      />
      <TeacherCard className="border-student-primary-border bg-student-primary-soft/55 p-5">
        <p className="text-sm font-semibold text-student-primary">正确答案</p>
        <p className="mt-2 text-lg font-semibold leading-7 text-student-text">
          {currentQuestion.final_sentence ||
            buildSentenceDisplay(currentQuestion.sentence_template, currentQuestion.correct_order_text) ||
            splitTextItems(currentQuestion.correct_order_text).join(" ")}
        </p>
      </TeacherCard>
      <QuestionViewerNav
        currentIndex={currentIndex}
        onChange={onChange}
        questionCount={questions.length}
      />
    </div>
  );
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
    <nav aria-label="题库分页" className="flex flex-wrap items-center justify-between gap-3 text-sm text-student-muted">
      <span>共 {totalItems} 项 · 第 {page}/{visibleTotalPages} 页</span>
      <div className="flex gap-2">
        <CatalogPageButton disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          <ChevronLeft aria-hidden="true" size={16} />上一页
        </CatalogPageButton>
        <CatalogPageButton disabled={totalPages === 0 || page >= totalPages} onClick={() => onPageChange(page + 1)}>
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

async function loadQuestionBankCatalog(taskType: PracticeTaskType) {
  return loadTeacherQuestionBankJson<LogicalPracticeCatalog>(
    `/api/teacher/question-bank?taskType=${taskType}`
  );
}

async function loadQuestionBankItem(itemId: string) {
  return loadTeacherQuestionBankJson<LogicalItemDetail>(
    `/api/teacher/question-bank?itemId=${encodeURIComponent(itemId)}`
  );
}

async function loadTeacherQuestionBankJson<T>(url: string) {
  const supabase = createBrowserSupabase();
  const { data: { session } } = await supabase.auth.getSession();
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${session?.access_token ?? ""}` }
  });
  const text = await response.text();
  let payload: T & { error?: string };
  try {
    payload = text
      ? JSON.parse(text)
      : ({ error: "题库暂时无法加载，请稍后重试。" } as T & { error?: string });
  } catch {
    payload = { error: "题库暂时无法加载，请稍后重试。" } as T & { error?: string };
  }
  if (!response.ok || payload.error) {
    throw new Error(payload.error ?? "无法加载题库。");
  }
  return payload as T;
}

function emptyStateText(taskType: PracticeTaskType) {
  if (taskType === "build_sentence") return "暂无 Build a Sentence 题目。";
  if (taskType === "email") return "暂无 Write an Email 题目。";
  return "暂无 Academic Discussion 题目。";
}

function defaultDiscoveryControls(): CatalogDiscoveryControlValue {
  return {
    query: "",
    status: "all",
    months: [],
    categories: [],
    sortKey: "default",
    sortDirection: "desc"
  };
}

function toQuestionBankErrorMessage(message: string) {
  if (/unauthorized|not authenticated/i.test(message)) return "登录状态已失效，请重新登录。";
  if (/forbidden|teacher role required/i.test(message)) return "当前账号没有教师端访问权限。";
  if (/not found/i.test(message)) return "未找到该题目。";
  return /[\u3400-\u9fff]/.test(message) ? message : "题库加载失败，请稍后重试。";
}

function LogicalItemListSkeleton() {
  return (
    <div aria-label="正在加载题目" className="grid gap-1.5">
      {Array.from({ length: 7 }, (_, index) => (
        <TeacherSkeleton className="h-16 w-full rounded-2xl" key={index} />
      ))}
    </div>
  );
}

function QuestionViewerSkeleton() {
  return (
    <div className="grid gap-4">
      <TeacherCard className="p-5">
        <TeacherSkeleton className="h-5 w-20" />
        <TeacherSkeleton className="mt-3 h-7 w-64" />
        <TeacherSkeleton className="mt-6 h-28 w-full" />
      </TeacherCard>
      <TeacherSkeleton className="h-24 w-full rounded-2xl" />
    </div>
  );
}
