"use client";

import Link from "next/link";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { useRef, useState } from "react";
import { useStudentCachedData, STUDENT_WRITING_CORRECTION_CACHE_PREFIX, STUDENT_ACADEMIC_DISCUSSION_AVATARS_CACHE_KEY } from "@/components/StudentDataCache";
import { StudentErrorState, StudentLoadingState } from "./StudentUI";
import { ReviewViewTab, ReviewTabButton } from "./StudentWritingReview";
import { StudentWritingReviewArticleCard } from "./StudentWritingReviewArticle";
import { WritingCorrectionComparison } from "@/components/teacher/WritingCorrectionComparison";
import { WritingQuestionReview } from "@/components/writing/WritingQuestionPrompt";
import { correctionDeltaLabel } from "@/lib/writingCorrectionReviewUi";
import { CorrectionCompletionPanel, CorrectionIssueCard, useCorrectionBlankDeselection } from "@/components/writing/WritingCorrectionReviewPresentation";
import { ReviewBadge, ReviewOfficialScoreCard, ReviewScoreTable, ReviewScoreRow, ReviewToolbarButton } from "@/components/teacher/WritingReviewPresentation";
import { loadAcademicDiscussionAvatars, type AcademicDiscussionAvatarsPayload } from "@/lib/academicDiscussionAvatars";
import { languageEditSeverityLabel, languageEditSeverityMarkerClass, writingReviewCategoryLabel } from "@/lib/writingReviewWorkspaceUi";
import { WRITING_TASK_CONFIG } from "@/lib/writing";
import type { loadStudentCorrectionReview } from "@/lib/writingCorrectionPublished.server";

type Payload = Awaited<ReturnType<typeof loadStudentCorrectionReview>>;
const card = "flex min-w-0 flex-col overflow-hidden rounded-xl border border-student-border bg-white shadow-[0_2px_12px_rgba(60,47,119,0.05)]";

export function StudentWritingCorrectionReview({ attemptId, backHref }: { attemptId: string; backHref: string }) {
  const state = useStudentCachedData<Payload>(`${STUDENT_WRITING_CORRECTION_CACHE_PREFIX}:attempt:${attemptId}:review`, async session => {
    const response = await fetch(`/api/writing/corrections/${encodeURIComponent(attemptId)}/review`, { cache: "no-store", headers: { Authorization: `Bearer ${session.accessToken}` } });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "无法加载订正批改。");
    return payload;
  }, { refreshOnMount: true });
  if (state.loading) return <StudentLoadingState text="正在加载批改结果…" />;
  if (!state.data || state.error) return <StudentErrorState text={state.error || "无法加载订正批改。"} />;
  return <StudentWritingCorrectionReviewResult data={state.data} backHref={backHref} />;
}

/** Read-only published projection; no teacher workspace or mutable review data. */
export function StudentWritingCorrectionReviewResult({ data, backHref }: { data: Payload; backHref: string }) {
  const [view, setView] = useState<"response" | "question">("response");
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [locationRequest, setLocationRequest] = useState(0);
  const [detailTab, setDetailTab] = useState<"original" | "new">("original");
  const [indices, setIndices] = useState({ original: 0, new: 0 });
  const detailScroll = useRef<HTMLDivElement>(null);
  useCorrectionBlankDeselection(selectedIssueId, () => setSelectedIssueId(null));
  const avatarState = useStudentCachedData<AcademicDiscussionAvatarsPayload>(STUDENT_ACADEMIC_DISCUSSION_AVATARS_CACHE_KEY, loadAcademicDiscussionAvatars, { enabled: data.attempt.task_type === "academic_discussion" });
  const { attempt, review, question } = data;
  const selected = review.issues.find(issue => issue.issue_id === selectedIssueId);
  const originalIndex = Math.min(indices.original, Math.max(0, review.issues.length - 1));
  const newIndex = Math.min(indices.new, Math.max(0, review.new_issues.length - 1));
  const currentIssue = review.issues[originalIndex];
  const currentNewIssue = review.new_issues[newIndex];
  const currentIndex = detailTab === "original" ? originalIndex : newIndex;
  const currentCount = detailTab === "original" ? review.issues.length : review.new_issues.length;
  function locate(issueId: string) {
    setView("response");
    setSelectedIssueId(issueId);
    setLocationRequest(value => value + 1);
  }
  function selectDetailTab(next: "original" | "new") {
    setDetailTab(next);
    setSelectedIssueId(null);
    if (next === "original" && currentIssue) locate(currentIssue.issue_id);
    if (detailScroll.current) detailScroll.current.scrollTop = 0;
  }
  function navigateDetail(direction: -1 | 1) {
    const nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= currentCount) return;
    setIndices(current => ({ ...current, [detailTab]: nextIndex }));
    if (detailTab === "original") locate(review.issues[nextIndex].issue_id);
    if (detailScroll.current) detailScroll.current.scrollTop = 0;
  }
  return <div className="min-h-[100dvh] bg-[#f8f9fc] text-student-text lg:flex lg:h-[100dvh] lg:flex-col lg:overflow-hidden">
    <header className="shrink-0 border-b border-student-border bg-white">
      <div className="mx-auto flex min-h-14 max-w-[1920px] flex-wrap items-center justify-between gap-3 px-4 py-2 sm:px-6">
        <div className="flex min-w-0 items-center gap-3"><Link aria-label="返回" className="rounded-lg p-2 text-student-primary hover:bg-student-primary-soft" href={backHref}><ArrowLeft size={20} /></Link>
          <div><div className="flex flex-wrap items-center gap-2"><h1 className="text-base font-bold sm:text-lg">{WRITING_TASK_CONFIG[attempt.task_type].label} · {data.display_name}</h1><span className="student-chip">订正稿</span><span className="student-chip">已发布</span></div>
            <p className="mt-0.5 text-xs text-student-muted">{attempt.word_count} words · 提交于 {date(attempt.submitted_at)}</p></div></div>
        <p className="text-xs text-student-muted">批改完成于 {date(review.published_at)}</p>
      </div>
      <nav className="mx-auto flex h-10 max-w-[1920px] gap-6 px-4 sm:px-6"><ReviewViewTab active={view === "response"} onClick={() => setView("response")}>订正正文</ReviewViewTab><ReviewViewTab active={view === "question"} onClick={() => setView("question")}>题目</ReviewViewTab></nav>
    </header>
    <div className="mx-auto grid w-full max-w-[1920px] min-w-0 flex-1 gap-2.5 p-2.5 lg:min-h-0 lg:grid-cols-[minmax(0,2fr)_minmax(340px,1fr)] lg:overflow-hidden">
      <main className="grid min-w-0 gap-2.5 lg:min-h-0 lg:grid-rows-[minmax(0,2fr)_minmax(0,1fr)]">
        {view === "response" ? <StudentWritingReviewArticleCard className="min-h-0"><WritingCorrectionComparison studentReview original={data.original_response_text} corrected={attempt.response_text} revisionState={attempt.revision_state} selectedIssue={selected ?? null} locationRequest={locationRequest} /></StudentWritingReviewArticleCard> : <section className={`${card} min-h-[360px] overflow-y-auto p-5 lg:min-h-0`}><WritingQuestionReview question={question} taskType={attempt.task_type} academicDiscussionAvatarSource={data.question_source} avatarMap={avatarState.data?.avatars ?? {}} avatarMapReady={Boolean(avatarState.data)} /></section>}
        <section data-correction-detail className={`${card} h-[30dvh] min-h-[180px] lg:h-auto lg:min-h-0 lg:max-h-[38dvh]`}>
          <div data-correction-detail-toolbar className="flex shrink-0 items-center border-b border-student-border">
            <div className="flex min-w-0 flex-1 gap-5 overflow-x-auto px-3" aria-label="审核详情类型">
              <ReviewTabButton active={detailTab === "original"} onClick={() => selectDetailTab("original")}>原始问题逐项审核（{review.issues.length}）</ReviewTabButton>
              <ReviewTabButton active={detailTab === "new"} onClick={() => selectDetailTab("new")}>订正产生的新问题（{review.new_issues.length}）</ReviewTabButton>
            </div>
            <div className="flex shrink-0 items-center gap-1 px-2">
              <ReviewToolbarButton className="!border-0 !shadow-none" aria-label="上一条" disabled={currentCount === 0 || currentIndex === 0} onClick={() => navigateDetail(-1)}><ChevronLeft aria-hidden="true" size={14} />上一条</ReviewToolbarButton>
              <ReviewToolbarButton className="!border-0 !shadow-none" aria-label="下一条" disabled={currentCount === 0 || currentIndex >= currentCount - 1} onClick={() => navigateDetail(1)}>下一条<ChevronRight aria-hidden="true" size={14} /></ReviewToolbarButton>
            </div>
          </div>
          <div data-correction-detail-scroll ref={detailScroll} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            <h2 className="text-sm font-bold text-student-text">当前审核详情{currentCount ? <span className="ml-2 text-xs font-normal text-student-muted">{currentIndex + 1} / {currentCount}</span> : null}</h2>
            <div className="mt-2">
              {detailTab === "original" ? currentIssue ? <CorrectionIssueCard issue={currentIssue} selected={selectedIssueId === currentIssue.issue_id} status={currentIssue.status} explanation={currentIssue.explanation} onLocate={() => locate(currentIssue.issue_id)} /> : <p className="text-xs text-student-muted">暂无原始问题审核。</p>
                : currentNewIssue ? <div data-correction-new-issue={currentNewIssue.index} className="rounded-lg border border-student-border p-2.5 text-xs leading-5"><div className="flex flex-wrap items-center gap-2"><strong>{writingReviewCategoryLabel(currentNewIssue.type)}</strong><span className={languageEditSeverityMarkerClass(currentNewIssue.severity)}>{languageEditSeverityLabel(currentNewIssue.severity)}</span></div><p className="mt-1 whitespace-pre-wrap">{currentNewIssue.evidence}</p><p className="mt-1 whitespace-pre-wrap">{currentNewIssue.explanation}</p></div> : <p className="text-xs text-student-muted">暂无已发布的新问题。</p>}
            </div>
          </div>
        </section>
      </main>
      <aside data-correction-review-scroll className="flex min-h-0 flex-col gap-2.5 overflow-y-auto">
        <section className={`${card} shrink-0 p-2.5`}><h2 className="mb-2 text-sm font-bold">订正完成度</h2><CorrectionCompletionPanel completion={review.completion} summary={<ReviewBadge>语言 {review.issues.filter(issue => issue.issue_type === "language_edit").length} · 内容 {review.issues.filter(issue => issue.issue_type === "content_feedback").length}</ReviewBadge>} /></section>
        <section className={`${card} shrink-0 p-2.5`}><h2 className="mb-2 text-sm font-bold">综合评分</h2>
          <ReviewScoreTable headings={["原稿评分", "订正评分", "最终分差"]} columns="1fr 1fr 1fr"><ReviewScoreRow columns="1fr 1fr 1fr"><strong>{review.original_score}/5</strong><strong className="text-student-primary">{review.correction_score}/5</strong><ReviewBadge>{correctionDeltaLabel(review.score_delta)}</ReviewBadge></ReviewScoreRow></ReviewScoreTable>
          <ReviewOfficialScoreCard student title="订正整体评分" teacherLabel="最终评分" teacherControl={<strong>{review.correction_score}/5</strong>} rationaleLabel="教师评分解释" rationale={<p className="mt-1 whitespace-pre-wrap text-[11px] font-normal leading-5 text-student-text">{review.score_rationale || "—"}</p>}><div className="mt-2 text-[10px] font-semibold text-student-muted">分差原因<p className="mt-1 whitespace-pre-wrap text-[11px] font-normal leading-5 text-student-text">{review.score_change_explanation || "—"}</p></div></ReviewOfficialScoreCard>
        </section>
      </aside>
    </div>
  </div>;
}

function date(value: string | null) { return value ? new Date(value).toLocaleString("zh-CN") : "—"; }
