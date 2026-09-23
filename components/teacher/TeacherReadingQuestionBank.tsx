"use client";

import { useRouter } from "next/navigation";
import { Eye } from "lucide-react";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { TEACHER_QUESTION_BANK_CACHE_PREFIX, useTeacherCachedData } from "@/components/TeacherDataCache";
import {
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
  ReadingCatalogPagination
} from "@/components/reading/ReadingCatalog";
import {
  ReadingPracticeMessage,
  ReadingReadonlyReviewShell
} from "@/components/reading/ReadingPractice";
import { STUDENT_PRACTICE_ICONS } from "@/components/icons/StudentPracticeIcons";
import { READING_PRODUCT_NAMES } from "@/lib/reading/product";
import type { ReadingModule } from "@/lib/reading/types";
import {
  buildTeacherReadingAnswerKeyView,
  type TeacherReadingBankCatalog,
  type TeacherReadingBankItemDetail
} from "@/lib/teacherReadingQuestionBank";
import { formatOccurrenceDates } from "@/lib/catalogOccurrenceDates";

export function TeacherReadingQuestionBankCatalog({
  module,
  page
}: {
  module: ReadingModule;
  page: number;
}) {
  const router = useRouter();
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
              icon: STUDENT_PRACTICE_ICONS[item.module],
              metadata: formatOccurrenceDates(item.occurrenceDates),
              questionCount: item.module === "ctw" ? item.scoringPointCount : item.questionCount,
              setId: item.itemId,
              setTitle: item.title,
              titlePrefix: `题目${item.displayNumber}`,
              titleSuffix: item.title
            }))}
          />
          <ReadingCatalogPagination
            onChange={(nextPage) =>
              router.push(`/teacher/question-bank?taskType=${module}&page=${nextPage}`)
            }
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
  const router = useRouter();
  const cacheKey = `${TEACHER_QUESTION_BANK_CACHE_PREFIX}:reading-item:${itemId}`;
  const { data, error, loading } = useTeacherCachedData<TeacherReadingBankItemDetail>(
    cacheKey,
    () => loadReadingBankItem(itemId)
  );
  const readingModule = data?.practice.item.module ?? returnModule;
  const bankHref = `/teacher/question-bank?taskType=${readingModule}&page=${returnPage}`;

  if (loading) {
    return <ReadingPracticeMessage description="正在加载题目内容..." title="正在准备题目" />;
  }
  if (error || !data) {
    return (
      <ReadingPracticeMessage
        description={toQuestionBankErrorMessage(error || "无法加载题目内容。")}
        leaveLabel="返回教师题库"
        onLeave={() => router.push(bankHref)}
        title="无法打开题目"
      />
    );
  }

  const answerKeyView = buildTeacherReadingAnswerKeyView(data.answerKey);
  return (
    <ReadingReadonlyReviewShell
      answerKeyOnly
      answers={answerKeyView.answers}
      lookupEnabled={false}
      onBack={() => router.push(bankHref)}
      practice={data.practice}
      reviewDisclosures={answerKeyView.disclosures}
      reviewItems={answerKeyView.reviewItems}
      title={data.practice.item.title}
    />
  );
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
