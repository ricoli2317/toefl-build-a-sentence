"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { useStudentCachedData, STUDENT_WRITING_CORRECTION_CACHE_PREFIX } from "@/components/StudentDataCache";
import { StudentErrorState, StudentLoadingState } from "./StudentUI";
import { PublishedScorePanel, ReviewViewTab } from "./StudentWritingReview";
import { WritingCorrectionComparison } from "@/components/teacher/WritingCorrectionComparison";
import { WritingQuestionReview } from "@/components/writing/WritingQuestionPrompt";
import { CORRECTION_STATUS_LABEL, CORRECTION_STATUS_TONE } from "@/lib/writingCorrectionReviewUi";
import { writingReviewCategoryLabel } from "@/lib/writingReviewWorkspaceUi";
import { WRITING_TASK_CONFIG } from "@/lib/writing";
import type { loadStudentCorrectionReview } from "@/lib/writingCorrectionPublished.server";
import type { StudentPublishedWritingReview } from "@/lib/writingPublishedReview";

type Payload = Awaited<ReturnType<typeof loadStudentCorrectionReview>>;
const card = "flex min-w-0 flex-col overflow-hidden rounded-xl border border-student-border bg-white shadow-[0_2px_12px_rgba(60,47,119,0.05)]";

export function StudentWritingCorrectionReview({ attemptId, backHref }: { attemptId: string; backHref: string }) {
  const state = useStudentCachedData<Payload>(`${STUDENT_WRITING_CORRECTION_CACHE_PREFIX}:attempt:${attemptId}:review`, async session => {
    const response = await fetch(`/api/writing/corrections/${encodeURIComponent(attemptId)}/review`, { cache: "no-store", headers: { Authorization: `Bearer ${session.accessToken}` } });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "无法加载订正批改。");
    return payload;
  }, { refreshOnMount: true });
  const [view, setView] = useState<"response" | "question">("response");
  if (state.loading) return <StudentLoadingState text="正在加载批改结果…" />;
  if (!state.data || state.error) return <StudentErrorState text={state.error || "无法加载订正批改。"} />;
  const { attempt, review, question } = state.data;
  // UI adapter only: reuse ordinary published scoring, never create ordinary review data.
  const scoreReview: Pick<StudentPublishedWritingReview, "scores"> = { scores: { official_score: { score: review.correction_score, rationale: review.score_rationale }, dimension_scores: null } };
  return <div className="min-h-[100dvh] bg-[#f8f9fc] text-student-text lg:flex lg:h-[100dvh] lg:flex-col lg:overflow-hidden">
    <header className="shrink-0 border-b border-student-border bg-white">
      <div className="mx-auto flex min-h-14 max-w-[1920px] flex-wrap items-center justify-between gap-3 px-4 py-2 sm:px-6">
        <div className="flex min-w-0 items-center gap-3"><Link aria-label="返回" className="rounded-lg p-2 text-student-primary hover:bg-student-primary-soft" href={backHref}><ArrowLeft size={20} /></Link>
          <div><div className="flex flex-wrap items-center gap-2"><h1 className="text-base font-bold sm:text-lg">{WRITING_TASK_CONFIG[attempt.task_type].label} · {state.data.display_name}</h1><span className="student-chip">订正稿</span><span className="student-chip">已发布</span></div>
            <p className="mt-0.5 text-xs text-student-muted">{attempt.word_count} words · 提交于 {date(attempt.submitted_at)}</p></div></div>
        <p className="text-xs text-student-muted">批改完成于 {date(review.published_at)}</p>
      </div>
      <nav className="mx-auto flex h-10 max-w-[1920px] gap-6 px-4 sm:px-6"><ReviewViewTab active={view === "response"} onClick={() => setView("response")}>订正正文</ReviewViewTab><ReviewViewTab active={view === "question"} onClick={() => setView("question")}>题目</ReviewViewTab></nav>
    </header>
    <div className="mx-auto grid w-full max-w-[1920px] min-w-0 flex-1 gap-2.5 p-2.5 lg:min-h-0 lg:grid-cols-[minmax(0,2fr)_minmax(340px,1fr)] lg:overflow-hidden">
      <main className={`${card} min-h-[360px] overflow-y-auto p-5 lg:min-h-0`}>
        {view === "response" ? <WritingCorrectionComparison className="whitespace-pre-wrap text-[15px] leading-7 sm:text-base" original={state.data.original_response_text} corrected={attempt.response_text} revisionState={attempt.revision_state} /> : <WritingQuestionReview question={question} taskType={attempt.task_type} academicDiscussionAvatarSource={state.data.question_source} avatarMap={{}} avatarMapReady={false} />}
      </main>
      <aside className="flex min-h-0 flex-col gap-2.5 overflow-y-auto">
        <PublishedScorePanel review={scoreReview} taskType={attempt.task_type} />
        <section className={`${card} shrink-0 p-3`}><h2 className="text-sm font-bold">订正完成度</h2><p className="mt-2 text-2xl font-bold text-student-primary">{review.completion.rate === null ? "不适用" : `${Math.round(review.completion.rate * 100)}%`}</p><p className="mt-2 text-xs">原稿 {review.original_score}/5 · 订正 {review.correction_score}/5 · 分差 {review.score_delta > 0 ? "+" : ""}{review.score_delta}</p><h3 className="mt-3 text-xs font-bold">分差原因</h3><p className="mt-1 whitespace-pre-wrap text-xs leading-5">{review.score_change_explanation || "—"}</p></section>
        <section className={`${card} shrink-0 p-3`}><h2 className="text-sm font-bold">原始问题审核</h2><ul className="mt-2 grid gap-2">{review.issues.map(issue => <li key={issue.issue_id} className="rounded-lg border border-student-border p-2.5 text-xs leading-5"><div className="flex flex-wrap items-center gap-2"><strong>{writingReviewCategoryLabel(issue.category)}</strong>{issue.status ? <span className={`rounded px-2 ${CORRECTION_STATUS_TONE[issue.status]}`}>{CORRECTION_STATUS_LABEL[issue.status]}</span> : null}</div><p>{issue.original_text || issue.original_sentence || issue.issue}</p><p className="mt-1">{issue.explanation}</p></li>)}</ul></section>
        <section className={`${card} shrink-0 p-3`}><h2 className="text-sm font-bold">订正产生的新问题</h2>{review.new_issues.length ? <ul className="mt-2 grid gap-2">{review.new_issues.map(issue => <li key={issue.index} className="rounded-lg border border-student-border p-2.5 text-xs leading-5"><strong>{writingReviewCategoryLabel(issue.type)}</strong><p>{issue.evidence}</p><p>{issue.explanation}</p></li>)}</ul> : <p className="mt-2 text-xs text-student-muted">暂无新问题。</p>}</section>
      </aside>
    </div>
  </div>;
}

function date(value: string | null) { return value ? new Date(value).toLocaleString("zh-CN") : "—"; }
