"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, BookOpen, ListChecks } from "lucide-react";
import { useStudentCachedData, STUDENT_READING_CATEGORY_COUNTS_CACHE_KEY, STUDENT_READING_HISTORY_CACHE_PREFIX } from "@/components/StudentDataCache";
import { StudentNavigation, StudentErrorState, StudentLoadingState } from "@/components/student/StudentUI";
import {
  StudentEntitlementNotice,
  useStudentPracticeEntitlements
} from "@/components/student/StudentPracticeEntitlements";
import { PracticeAmountDialog } from "@/components/student/PracticeAmountDialog";
import { StudentErrorAnalysis } from "@/components/student/StudentErrorAnalysis";
import type { QuestionCategoryErrorCount } from "@/lib/reading/questionCategoryAnalysis.server";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import { STUDENT_UI_TEXT } from "@/lib/studentUiText";
import { wrongQuestionAmountOptions } from "@/lib/wrongQuestionBank";
import { CATEGORY_API, READING_QUESTION_CATEGORIES, categoryPracticeHref, type ReadingQuestionCategory } from "@/lib/reading/questionCategory";

let pendingCategoryStart: { key: string; requestId: string } | null = null;

export function QuestionCategoryPracticeHome() {
  const router = useRouter();
  const [selected, setSelected] = useState<ReadingQuestionCategory | null>(null);
  const entitlements = useStudentPracticeEntitlements();
  const exhausted = entitlements.exhausted("rap_category");
  const state = useStudentCachedData<{ categories: Array<{ questionCategory: ReadingQuestionCategory; count: number }> }>(
    STUDENT_READING_CATEGORY_COUNTS_CACHE_KEY, async (auth) => {
      const response = await fetch(CATEGORY_API, { cache: "no-store", headers: { Authorization: `Bearer ${auth.accessToken}` } });
      const payload = await response.json();
      if (!response.ok || !Array.isArray(payload.categories)) throw new Error(payload.error ?? "题型数量加载失败。");
      return payload;
    }
  );
  const counts = new Map(state.data?.categories.map((category) => [category.questionCategory, category.count]));
  const analysis = useStudentCachedData<{ ranking: QuestionCategoryErrorCount[] }>(
    `${STUDENT_READING_HISTORY_CACHE_PREFIX}:rap-category-errors`, async (auth) => {
      const response = await fetch(`${CATEGORY_API}/analysis`, { cache: "no-store", headers: { Authorization: `Bearer ${auth.accessToken}` } });
      const payload = await response.json();
      if (!response.ok || !Array.isArray(payload.ranking)) throw new Error(payload.error ?? "题型统计加载失败。");
      return payload;
    },
    // Also refresh after returning from a Full Set; its existing cache flow is separate.
    { refreshOnMount: true }
  );
  const count = selected ? counts.get(selected) ?? 0 : 0;
  return <div className="grid gap-5">
    <StudentNavigation backHref={STUDENT_ROUTES.home} crumbs={[
      { label: STUDENT_UI_TEXT.studentHome, href: STUDENT_ROUTES.home },
      { label: STUDENT_UI_TEXT.questionCategoryPractice }
    ]} />
    <StudentEntitlementNotice kind="rap_category" />
    <StudentErrorAnalysis
      title={<><span className="text-student-primary">Read an Academic Passage</span> 题型分析</>}
      subtitle="高频错误题型" emptyText="暂无高频错误题型。" tone="orange"
      items={(analysis.data?.ranking ?? []).map((row) => ({ ...row, tag: row.questionCategory }))}
      loading={analysis.loading} error={Boolean(analysis.error)} minimumProgressPercent={0}
      renderAction={(item, className) => <button type="button"
        className={`${className} disabled:opacity-50`} disabled={state.loading || Boolean(state.error) || exhausted}
        title={exhausted ? "自主分类练习次数已用完，已有练习仍可继续。" : undefined}
        onClick={() => setSelected(item.questionCategory)}>
        {exhausted ? "额度已用完" : "专项练习"} <ArrowRight aria-hidden="true" size={14} />
      </button>} />
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
        <button type="button" disabled={state.loading || Boolean(state.error) || exhausted}
          title={exhausted ? "自主分类练习次数已用完，已有练习仍可继续。" : undefined}
          onClick={() => setSelected(category)}
          className="col-span-2 inline-flex min-h-9 min-w-0 items-center justify-center gap-2 rounded-[10px] bg-student-primary-soft px-3 py-1.5 text-sm font-semibold text-student-primary transition hover:bg-student-primary-border disabled:opacity-50 lg:col-span-1">
          <ListChecks aria-hidden="true" size={19} strokeWidth={1.9} />{exhausted ? "额度已用完" : "开始练习"}
        </button>
      </article>)}
    </div>
    {/* The request id is only a start idempotency key; the database owns the
        quota and session ownership checks. */}
    {selected ? <PracticeAmountDialog count={count} options={wrongQuestionAmountOptions(count, "当前题型共")}
      subtitle={selected} tone="primary" onClose={() => setSelected(null)}
      onStart={(amount) => {
        const key = `${selected}:${amount}`;
        if (pendingCategoryStart?.key !== key) {
          pendingCategoryStart = { key, requestId: createCategoryRequestId() };
        }
        router.push(categoryPracticeHref(selected, amount, undefined, pendingCategoryStart.requestId));
        // A double click keeps the same request id; a later deliberate start
        // gets a new one after this short intent window.
        globalThis.setTimeout(() => {
          pendingCategoryStart = null;
        }, 1500);
      }} /> : null}
  </div>;
}

function createCategoryRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}
