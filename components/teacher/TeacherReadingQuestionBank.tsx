"use client";

import Link from "next/link";
import { ChevronLeft, ChevronRight, Eye } from "lucide-react";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { TEACHER_QUESTION_BANK_CACHE_PREFIX, useTeacherCachedData } from "@/components/TeacherDataCache";
import { TeacherBreadcrumbs } from "@/components/teacher/TeacherAppShell";
import {
  TeacherCard,
  TeacherDataError,
  TeacherEmptyState,
  TeacherLoadingRegion,
  TeacherSectionTitle,
  TeacherSkeleton
} from "@/components/teacher/TeacherUI";
import {
  PracticeSetAction,
  PracticeSetCatalogList
} from "@/components/shared/PracticeCatalog";
import type { ReadingModule } from "@/lib/reading/types";
import {
  READING_PRODUCT_NAMES
} from "@/lib/reading/product";
import type {
  TeacherReadingBankCatalog,
  TeacherReadingBankItemDetail,
  TeacherReadingBankQuestion
} from "@/lib/teacherReadingQuestionBank";

export function TeacherReadingQuestionBankCatalog({
  module,
  page
}: {
  module: ReadingModule;
  page: number;
}) {
  const cacheKey = `${TEACHER_QUESTION_BANK_CACHE_PREFIX}:reading:${module}:${page}`;
  const { data, error, loading } = useTeacherCachedData<TeacherReadingBankCatalog>(
    cacheKey,
    () => loadReadingBankCatalog(module, page)
  );

  return (
    <div className="grid gap-5">
      {loading ? <TeacherLoadingRegion label="正在加载阅读题库" /> : null}
      {loading ? (
        <ReadingItemListSkeleton />
      ) : error || !data ? (
        <TeacherDataError text={toQuestionBankErrorMessage(error || "无法加载阅读题库。")} />
      ) : (
        <>
          <PracticeSetCatalogList
            emptyState={<TeacherEmptyState text={`暂无 ${READING_PRODUCT_NAMES[module]} 题目。`} />}
            renderActions={(catalogSet) => (
              <PracticeSetAction
                href={`/teacher/question-bank/${encodeURIComponent(catalogSet.setId)}?taskType=${module}&page=${page}`}
                icon={Eye}
                label="查看题目"
              />
            )}
            sets={data.items.map((item) => ({
              metadata: formatReadingItemMetadata(item),
              questionCount: item.questionCount,
              setId: item.itemId,
              setTitle: item.title,
              titlePrefix: item.module === "ctw" ? `套题${item.displayNumber}` : `题目${item.displayNumber}`,
              titleSuffix: item.module === "ctw" ? null : item.title
            }))}
          />
          <ReadingBankPagination
            module={module}
            page={data.page}
            totalItems={data.totalItems}
            totalPages={data.totalPages}
          />
        </>
      )}
    </div>
  );
}

export function TeacherReadingQuestionBankItemViewer({
  itemId,
  returnModule,
  returnPage
}: {
  itemId: string;
  returnModule: ReadingModule;
  returnPage: number;
}) {
  const cacheKey = `${TEACHER_QUESTION_BANK_CACHE_PREFIX}:reading-item:${itemId}`;
  const { data, error, loading } = useTeacherCachedData<TeacherReadingBankItemDetail>(
    cacheKey,
    () => loadReadingBankItem(itemId)
  );
  const readingModule = data?.item.module ?? returnModule;
  const rootHref = `/teacher/question-bank?taskType=${readingModule}&page=${returnPage}`;
  const title = data?.item.title ?? "题目详情";

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
      {loading ? <TeacherLoadingRegion label="正在加载阅读题目详情" /> : null}
      {loading ? (
        <ReadingItemSkeleton />
      ) : error || !data ? (
        <TeacherDataError text={toQuestionBankErrorMessage(error || "无法加载阅读题目详情。")} />
      ) : (
        <>
          <TeacherCard className="p-5">
            <p className="text-sm font-semibold text-student-primary">
              {READING_PRODUCT_NAMES[data.item.module]} · 题目{data.item.displayNumber}
            </p>
            <h2 className="mt-1.5 text-xl font-bold text-student-text">{data.item.title}</h2>
            <p className="mt-2 text-sm text-student-muted">
              {data.item.questionCount} 题 · {data.item.scoringPointCount} 个评分点
            </p>
          </TeacherCard>

          {data.material?.imageUrl ? (
            <TeacherCard className="p-5">
              <TeacherSectionTitle>材料</TeacherSectionTitle>
              <img
                alt={data.material.title || "Read in Daily Life material"}
                className="mt-3 w-full max-w-[560px] rounded-xl border border-student-border"
                src={data.material.imageUrl}
              />
            </TeacherCard>
          ) : null}

          {data.passage ? (
            <TeacherCard className="p-5">
              <TeacherSectionTitle>{data.passage.title}</TeacherSectionTitle>
              <div className="mt-3 grid gap-3">
                {data.passage.paragraphs.map((paragraph) => (
                  <p className="text-sm leading-7 text-student-text" key={paragraph.paragraphId}>
                    {paragraph.text}
                  </p>
                ))}
              </div>
            </TeacherCard>
          ) : null}

          <div className="grid gap-3">
            {data.questions.map((question) => (
              <ReadingQuestionCard
                key={question.questionId}
                passage={data.passage}
                question={question}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ReadingQuestionCard({
  passage,
  question
}: {
  passage: TeacherReadingBankItemDetail["passage"];
  question: TeacherReadingBankQuestion;
}) {
  return (
    <TeacherCard className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="text-base font-bold text-student-text">
          第 {question.questionOrder} 题
        </h3>
        <span className="rounded-full border border-student-border px-3 py-1 text-xs font-semibold text-student-muted">
          {questionTypeLabel(question.questionType)}
        </span>
      </div>
      <p className="mt-2 text-sm leading-6 text-student-text">{question.stem}</p>

      {question.ctwParagraphs.length > 0 ? (
        <div className="mt-3 grid gap-3">
          {question.ctwParagraphs.map((paragraph) => (
            <p className="text-sm leading-8 text-student-text" key={paragraph.paragraphId}>
              {paragraph.segments.map((segment, index) =>
                segment.kind === "text" ? (
                  <span key={index}>{segment.text}</span>
                ) : (
                  <span
                    className="mx-0.5 rounded bg-student-primary-soft px-1.5 font-semibold text-student-primary"
                    key={index}
                    title={segment.displayText}
                  >
                    {segment.answer}
                  </span>
                )
              )}
            </p>
          ))}
        </div>
      ) : null}

      {question.options.length > 0 ? (
        <ul className="mt-3 grid gap-2">
          {question.options.map((option) => (
            <li
              className={
                option.isCorrect
                  ? "flex items-start gap-2.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-student-text"
                  : "flex items-start gap-2.5 rounded-lg border border-student-border px-3 py-2 text-sm text-student-text"
              }
              key={option.optionId}
            >
              <span className="font-semibold text-student-muted">{optionTextKey(option.optionOrder)}</span>
              <span className="min-w-0 flex-1">{option.text}</span>
              {option.isCorrect ? (
                <span className="shrink-0 text-xs font-semibold text-emerald-700">正确答案</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {question.insertSentence ? (
        <div className="mt-3 rounded-lg border border-student-primary-border bg-student-primary-soft/55 px-3 py-2.5">
          <p className="text-xs font-semibold text-student-primary">待插入句子</p>
          <p className="mt-1 text-sm leading-6 text-student-text">{question.insertSentence}</p>
        </div>
      ) : null}

      {question.anchors.length > 0 ? (
        <ul className="mt-3 grid gap-2">
          {question.anchors.map((anchor) => {
            const correct = anchor.anchorId === question.correctAnchorId;
            return (
              <li
                className={
                  correct
                    ? "flex items-start gap-2.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-student-text"
                    : "flex items-start gap-2.5 rounded-lg border border-student-border px-3 py-2 text-sm text-student-text"
                }
                key={anchor.anchorId}
              >
                <span className="font-semibold text-student-muted">■{anchor.anchorOrder}</span>
                <span className="min-w-0 flex-1">
                  {anchor.afterSentenceText
                    ? `在“${anchor.afterSentenceText}”之后`
                    : "段落开头"}
                </span>
                {correct ? (
                  <span className="shrink-0 text-xs font-semibold text-emerald-700">正确答案</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {question.questionType === "rap_sentence_selection" ? (
        <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5">
          <p className="text-xs font-semibold text-emerald-700">正确答案所在句</p>
          <p className="mt-1 text-sm leading-6 text-student-text">
            {question.correctSentenceText ?? "该题暂无可显示的句子。"}
          </p>
          <p className="mt-1 text-xs text-student-muted">
            目标段落：{paragraphLabel(passage, question.targetParagraphId)}
          </p>
        </div>
      ) : null}
    </TeacherCard>
  );
}

function ReadingBankPagination({
  module,
  page,
  totalItems,
  totalPages
}: {
  module: ReadingModule;
  page: number;
  totalItems: number;
  totalPages: number;
}) {
  const visibleTotalPages = Math.max(totalPages, 1);
  return (
    <nav aria-label="阅读题库分页" className="flex flex-wrap items-center justify-between gap-3 text-sm text-student-muted">
      <span>共 {totalItems} 项 · 第 {page}/{visibleTotalPages} 页</span>
      <div className="flex gap-2">
        <ReadingPageLink disabled={page <= 1} href={`/teacher/question-bank?taskType=${module}&page=${page - 1}`}>
          <ChevronLeft aria-hidden="true" size={16} />上一页
        </ReadingPageLink>
        <ReadingPageLink disabled={totalPages === 0 || page >= totalPages} href={`/teacher/question-bank?taskType=${module}&page=${page + 1}`}>
          下一页<ChevronRight aria-hidden="true" size={16} />
        </ReadingPageLink>
      </div>
    </nav>
  );
}

function ReadingPageLink({
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

function formatReadingItemMetadata(item: {
  firstSeenDate: string;
  occurrenceDates: string[];
}) {
  const count = item.occurrenceDates.length;
  return `首次出现 ${formatLogicalDate(item.firstSeenDate)}${count > 1 ? ` · ${count} 个日期` : ""}`;
}

function formatLogicalDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value || "日期未知";
  return `${match[1]}年${Number(match[2])}月${Number(match[3])}日`;
}

function questionTypeLabel(questionType: TeacherReadingBankQuestion["questionType"]) {
  switch (questionType) {
    case "ctw":
      return "Complete the Words";
    case "rdl":
      return "Read in Daily Life";
    case "rap_multiple_choice":
      return "选择题";
    case "rap_sentence_insertion":
      return "句子插入";
    case "rap_sentence_selection":
      return "句子选择";
  }
}

function optionTextKey(order: number) {
  return order <= 26 ? String.fromCharCode(64 + order) : String(order);
}

function paragraphLabel(
  passage: TeacherReadingBankItemDetail["passage"],
  paragraphId: string | null
) {
  if (!passage || !paragraphId) return "—";
  const paragraph = passage.paragraphs.find((item) => item.paragraphId === paragraphId);
  return paragraph ? `第 ${paragraph.paragraphOrder} 段` : "—";
}

async function loadReadingBankCatalog(module: ReadingModule, page: number) {
  return loadTeacherQuestionBankJson<TeacherReadingBankCatalog>(
    `/api/teacher/question-bank/reading?module=${module}&page=${page}`
  );
}

async function loadReadingBankItem(itemId: string) {
  return loadTeacherQuestionBankJson<TeacherReadingBankItemDetail>(
    `/api/teacher/question-bank/reading?itemId=${encodeURIComponent(itemId)}`
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

function toQuestionBankErrorMessage(message: string) {
  if (/unauthorized|not authenticated/i.test(message)) return "登录状态已失效，请重新登录。";
  if (/forbidden|teacher role required/i.test(message)) return "当前账号没有教师端访问权限。";
  if (/not found/i.test(message)) return "未找到该题目。";
  return /[\u3400-\u9fff]/.test(message) ? message : "题库加载失败，请稍后重试。";
}

function ReadingItemListSkeleton() {
  return (
    <div aria-label="正在加载阅读题库" className="grid gap-1.5">
      {Array.from({ length: 7 }, (_, index) => (
        <TeacherSkeleton className="h-16 w-full rounded-2xl" key={index} />
      ))}
    </div>
  );
}

function ReadingItemSkeleton() {
  return (
    <div className="grid gap-4">
      <TeacherCard className="p-5">
        <TeacherSkeleton className="h-5 w-24" />
        <TeacherSkeleton className="mt-3 h-7 w-64" />
      </TeacherCard>
      <TeacherSkeleton className="h-40 w-full rounded-2xl" />
      <TeacherSkeleton className="h-40 w-full rounded-2xl" />
    </div>
  );
}
