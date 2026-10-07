"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { BookOpen, ListChecks } from "lucide-react";
import { useStudentCachedData, STUDENT_READING_CATEGORY_COUNTS_CACHE_KEY } from "@/components/StudentDataCache";
import { StudentNavigation, StudentErrorState, StudentLoadingState } from "@/components/student/StudentUI";
import { PracticeAmountDialog } from "@/components/student/PracticeAmountDialog";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import { STUDENT_UI_TEXT } from "@/lib/studentUiText";
import { wrongQuestionAmountOptions } from "@/lib/wrongQuestionBank";
import { CATEGORY_API, READING_QUESTION_CATEGORIES, categoryPracticeHref, type ReadingQuestionCategory } from "@/lib/reading/questionCategory";

export function QuestionCategoryPracticeHome() {
  const router = useRouter();
  const [selected, setSelected] = useState<ReadingQuestionCategory | null>(null);
  const state = useStudentCachedData<{ categories: Array<{ questionCategory: ReadingQuestionCategory; count: number }> }>(
    STUDENT_READING_CATEGORY_COUNTS_CACHE_KEY, async (auth) => {
      const response = await fetch(CATEGORY_API, { cache: "no-store", headers: { Authorization: `Bearer ${auth.accessToken}` } });
      const payload = await response.json();
      if (!response.ok || !Array.isArray(payload.categories)) throw new Error(payload.error ?? "题型数量加载失败。");
      return payload;
    }
  );
  const counts = new Map(state.data?.categories.map((category) => [category.questionCategory, category.count]));
  const count = selected ? counts.get(selected) ?? 0 : 0;
  return <div className="grid gap-5">
    <StudentNavigation backHref={STUDENT_ROUTES.home} crumbs={[
      { label: STUDENT_UI_TEXT.studentHome, href: STUDENT_ROUTES.home },
      { label: STUDENT_UI_TEXT.questionCategoryPractice }
    ]} />
    {state.error ? <StudentErrorState text="题型数量加载失败，请稍后重试。" /> : null}
    {state.loading ? <StudentLoadingState text="正在加载题型数量..." /> : null}
    <div className="grid gap-2">
      {READING_QUESTION_CATEGORIES.map((category) => <article key={category}
        className="grid min-h-[58px] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 rounded-xl border border-student-border bg-white px-4 py-3 shadow-[0_1px_2px_rgba(23,32,51,0.025)] sm:px-5 lg:grid-cols-[minmax(0,1fr)_5.5rem_10rem] lg:gap-x-3 lg:py-2">
        <div className="flex min-w-0 items-center gap-3">
          <BookOpen aria-hidden="true" className="shrink-0 text-student-primary" size={23} strokeWidth={1.9} />
          <h2 className="min-w-0 text-[16px] font-semibold leading-6 text-student-text sm:text-[17px]">{category}</h2>
        </div>
        <p className="text-right text-[15px] font-medium tabular-nums text-student-muted lg:pr-2">{counts.has(category) ? `${counts.get(category)}题` : "—"}</p>
        <button type="button" disabled={state.loading || Boolean(state.error)} onClick={() => setSelected(category)}
          className="col-span-2 inline-flex min-h-9 min-w-0 items-center justify-center gap-2 rounded-[10px] bg-student-primary-soft px-3 py-1.5 text-sm font-semibold text-student-primary transition hover:bg-student-primary-border disabled:opacity-50 lg:col-span-1">
          <ListChecks aria-hidden="true" size={19} strokeWidth={1.9} />开始练习
        </button>
      </article>)}
    </div>
    {selected ? <PracticeAmountDialog count={count} options={wrongQuestionAmountOptions(count, "当前题型共")}
      subtitle={selected} tone="primary" onClose={() => setSelected(null)}
      onStart={(amount) => router.push(categoryPracticeHref(selected, amount))} /> : null}
  </div>;
}
