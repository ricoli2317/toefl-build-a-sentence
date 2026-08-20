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
import type { PracticeTaskType } from "@/lib/practiceImporter/types";
import type { AcademicDiscussionAvatarMap } from "@/lib/academicDiscussionAvatars";
import type { Question } from "@/lib/types";
import type { WritingQuestion } from "@/lib/writing";
import { formatOccurrenceDates } from "@/components/LogicalPracticeCatalog";

const TASK_TABS: Array<{ label: string; taskType: PracticeTaskType }> = [
  { label: "Build a Sentence", taskType: "build_sentence" },
  { label: "Write an Email", taskType: "email" },
  { label: "Academic Discussion", taskType: "academic_discussion" }
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
  taskType: PracticeTaskType;
}) {
  const cacheKey = `${TEACHER_QUESTION_BANK_CACHE_PREFIX}:catalog:${taskType}:${page}`;
  const { data, error, loading } = useTeacherCachedData<LogicalPracticeCatalog>(
    cacheKey,
    () => loadQuestionBankCatalog(taskType, page),
    { refreshOnMount: true }
  );

  return (
    <div className="grid gap-5">
      <TeacherBreadcrumbs
        crumbs={[{ label: "首页", href: "/teacher/dashboard" }, { label: "教师题库" }]}
      />
      <nav aria-label="题目类型" className="flex flex-wrap gap-2">
        {TASK_TABS.map((tab) => {
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
      </nav>
      {loading ? <TeacherLoadingRegion label="正在加载题目" /> : null}
      {loading ? (
        <LogicalItemListSkeleton />
      ) : error || !data ? (
        <TeacherDataError text={toQuestionBankErrorMessage(error || "无法加载题库。")} />
      ) : (
        <>
          <PracticeSetCatalogList
            emptyState={<TeacherEmptyState text={emptyStateText(taskType)} />}
            renderActions={(catalogSet) => (
              <PracticeSetAction
                href={`/teacher/question-bank/${encodeURIComponent(catalogSet.setId)}?taskType=${taskType}&page=${page}`}
                icon={Eye}
                label="查看题目"
              />
            )}
            sets={data.items.map((item) => ({
              metadata: formatOccurrenceDates(item.occurrence_dates),
              questionCount: item.question_count,
              setId: item.item_id,
              setTitle: logicalPracticeItemTitle(item),
              titlePrefix: item.task_type === "build_sentence" ? `套题${item.display_number}` : `题目${item.display_number}`,
              titleSuffix: item.task_type === "build_sentence" ? null : item.display_title
            }))}
          />
          <CatalogPagination
            page={data.pagination.page}
            taskType={taskType}
            totalItems={data.pagination.total_items}
            totalPages={data.pagination.total_pages}
          />
        </>
      )}
    </div>
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
    () => loadQuestionBankItem(itemId),
    { refreshOnMount: true }
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
  page,
  taskType,
  totalItems,
  totalPages
}: {
  page: number;
  taskType: PracticeTaskType;
  totalItems: number;
  totalPages: number;
}) {
  const visibleTotalPages = Math.max(totalPages, 1);
  return (
    <nav aria-label="题库分页" className="flex flex-wrap items-center justify-between gap-3 text-sm text-student-muted">
      <span>共 {totalItems} 项 · 第 {page}/{visibleTotalPages} 页</span>
      <div className="flex gap-2">
        <CatalogPageLink disabled={page <= 1} href={`/teacher/question-bank?taskType=${taskType}&page=${page - 1}`}>
          <ChevronLeft aria-hidden="true" size={16} />上一页
        </CatalogPageLink>
        <CatalogPageLink disabled={totalPages === 0 || page >= totalPages} href={`/teacher/question-bank?taskType=${taskType}&page=${page + 1}`}>
          下一页<ChevronRight aria-hidden="true" size={16} />
        </CatalogPageLink>
      </div>
    </nav>
  );
}

function CatalogPageLink({
  children,
  disabled,
  href
}: {
  children: React.ReactNode;
  disabled: boolean;
  href: string;
}) {
  const className = "student-button-secondary min-h-9 px-3 py-1.5";
  return disabled ? (
    <span aria-disabled="true" className={`${className} cursor-not-allowed opacity-50`}>
      {children}
    </span>
  ) : (
    <Link className={className} href={href}>{children}</Link>
  );
}

async function loadQuestionBankCatalog(taskType: PracticeTaskType, page: number) {
  return loadTeacherQuestionBankJson<LogicalPracticeCatalog>(
    `/api/teacher/question-bank?taskType=${taskType}&page=${page}`
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
