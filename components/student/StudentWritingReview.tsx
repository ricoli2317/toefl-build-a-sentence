"use client";

import clsx from "clsx";
import { ArrowLeft, ArrowRight, FileCheck2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  STUDENT_ACADEMIC_DISCUSSION_AVATARS_CACHE_KEY,
  useStudentCachedData,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import {
  StudentEmptyState,
  StudentErrorState,
  StudentLoadingState,
  StudentNavigation
} from "@/components/student/StudentUI";
import { CollapsibleText } from "@/components/writing/CollapsibleText";
import { WritingQuestionReview } from "@/components/writing/WritingQuestionPrompt";
import { WritingRevisionMarkedText } from "@/components/writing/WritingRevisionMarkedText";
import { WritingOvertimeText } from "@/components/writing/WritingOvertimeText";
import {
  loadAcademicDiscussionAvatars,
  type AcademicDiscussionAvatarMap,
  type AcademicDiscussionAvatarsPayload
} from "@/lib/academicDiscussionAvatars";
import {
  STUDENT_ROUTES,
  writingReviewResultHref
} from "@/lib/studentNavigation";
import {
  WRITING_TASK_CONFIG,
  type WritingOvertimeRange,
  type WritingQuestion,
  type WritingTaskType
} from "@/lib/writing";
import {
  CONTENT_FEEDBACK_MARKER_CLASS,
  buildWorkspaceAnnotationSegments,
  languageEditSeverityLabel,
  languageEditSeverityMarkerClass,
  writingDimensionDefinitions,
  writingReviewCategoryLabel
} from "@/lib/writingReviewWorkspaceUi";
import { buildWritingRevisionComposition } from "@/lib/writingReviewRevisionComposition";
import {
  orderedPublishedReviewItems,
  publishedReviewItemsForTab,
  type PublishedReviewItem,
  type StudentPublishedWritingReview
} from "@/lib/writingPublishedReview";

type ReviewPayload = {
  attempt: {
    attempt_id: string;
    task_type: WritingTaskType;
    response_text: string;
    overtime_ranges: WritingOvertimeRange[] | null;
    word_count: number;
    submitted_at: string | null;
  };
  question: WritingQuestion;
  question_source?: "question_bank" | "custom";
  review: StudentPublishedWritingReview;
  error?: string;
};

type ReviewSummary = {
  attempt_id: string;
  task_type: WritingTaskType;
  set_id: string;
  set_title: string;
  year_month: string;
  submitted_at: string | null;
  published_at: string;
};

type ReviewListPayload = { error?: string; reviews: ReviewSummary[] };
type ReviewTab = "all" | "language_edit" | "content_feedback";
type ReviewView = "marked" | "revised" | "original" | "question";

const REVIEW_LIST_CACHE_KEY = "writing:published-reviews";
const EMPTY_ACADEMIC_DISCUSSION_AVATAR_MAP: AcademicDiscussionAvatarMap = {};

export function StudentWritingReviewResult({
  attemptId,
  backHref
}: {
  attemptId: string;
  backHref: string;
}) {
  const state = useStudentCachedData<ReviewPayload>(
    `writing:published-review:${attemptId}`,
    (session) => loadReview(attemptId, session)
  );
  const avatarState = useStudentCachedData<AcademicDiscussionAvatarsPayload>(
    STUDENT_ACADEMIC_DISCUSSION_AVATARS_CACHE_KEY,
    loadAcademicDiscussionAvatars,
    { enabled: state.data?.attempt.task_type === "academic_discussion" }
  );
  const [tab, setTab] = useState<ReviewTab>("all");
  const [view, setView] = useState<ReviewView>("marked");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const composition = useMemo(() => {
    if (!state.data) return null;
    return buildWritingRevisionComposition(
      state.data.attempt.response_text,
      state.data.review.language_edits,
      state.data.review.content_feedback.items
    );
  }, [state.data]);
  const items = useMemo(
    () => (state.data ? orderedPublishedReviewItems(state.data.review) : []),
    [state.data]
  );
  const markerSegments = useMemo(
    () => state.data
      ? buildWorkspaceAnnotationSegments(
          state.data.attempt.response_text,
          state.data.review.language_edits,
          state.data.review.content_feedback.items
        )
      : [],
    [state.data]
  );
  const reviewCounts = useMemo(
    () => ({
      all: items.length,
      language_edit: items.filter((item) => item.kind === "language_edit").length,
      content_feedback: items.filter((item) => item.kind === "content_feedback").length
    }),
    [items]
  );

  useEffect(() => {
    if (selectedId && items.some((item) => item.id === selectedId)) return;
    setSelectedId(items[0]?.id ?? null);
  }, [items, selectedId]);

  if (state.loading) {
    return (
      <div className="grid min-h-[100dvh] place-items-center">
        <StudentLoadingState text="正在加载批改结果..." />
      </div>
    );
  }
  if (state.error || !state.data || !composition) {
    return (
      <div className="grid min-h-[100dvh] place-items-center p-5">
        <StudentErrorState text={state.error || "无法加载批改结果，请稍后重试。"} />
      </div>
    );
  }

  const { attempt, question, review } = state.data;
  const selectedItem = items.find((item) => item.id === selectedId) ?? null;
  const taskLabel = WRITING_TASK_CONFIG[attempt.task_type].label;

  function selectTab(nextTab: ReviewTab) {
    setTab(nextTab);
    setSelectedId(publishedReviewItemsForTab(items, nextTab)[0]?.id ?? null);
  }

  function selectMarker(item: PublishedReviewItem) {
    setTab(item.kind);
    setSelectedId(item.id);
    window.requestAnimationFrame(() => {
      document.getElementById("current-review-detail")?.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
    });
  }

  function selectMarkerById(id: string) {
    const item = items.find((candidate) => candidate.id === id);
    if (item) selectMarker(item);
  }

  return (
    <div className="min-h-[100dvh] bg-[#f8f9fc] text-student-text lg:flex lg:h-[100dvh] lg:flex-col lg:overflow-hidden">
      <header className="shrink-0 border-b border-student-border bg-white px-4 sm:px-6">
        <div className="flex min-h-14 flex-wrap items-center justify-between gap-x-5 gap-y-2 py-1.5 lg:h-14 lg:flex-nowrap">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              aria-label="返回"
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-student-text hover:bg-student-bg"
              href={backHref}
            >
              <ArrowLeft aria-hidden="true" size={20} />
            </Link>
            <span className="hidden h-7 w-px bg-student-border sm:block" />
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h1 className="truncate text-base font-bold sm:text-lg">
                  {taskLabel} · {question.set_title}
                </h1>
                <span className="student-chip !py-1">已发布</span>
              </div>
              <p className="mt-0.5 text-[11px] text-student-muted sm:text-xs">
                {attempt.word_count} words · 提交于 {formatDateTime(attempt.submitted_at)}
              </p>
            </div>
          </div>
          <p className="text-xs text-student-muted">
            批改完成于 {formatDateTime(review.published_at)}
          </p>
        </div>
        <nav aria-label="批改结果视图" className="flex h-10 items-end gap-6">
          <ReviewViewTab active={view === "marked"} onClick={() => setView("marked")}>批改稿</ReviewViewTab>
          <ReviewViewTab active={view === "revised"} onClick={() => setView("revised")}>修改稿</ReviewViewTab>
          <ReviewViewTab active={view === "original"} onClick={() => setView("original")}>原文</ReviewViewTab>
          <ReviewViewTab active={view === "question"} onClick={() => setView("question")}>题目</ReviewViewTab>
        </nav>
      </header>

      <div className="grid min-w-0 flex-1 gap-2.5 p-2.5 lg:min-h-0 lg:grid-cols-[minmax(0,2fr)_minmax(340px,1fr)] lg:overflow-hidden">
        <main className="grid min-w-0 gap-2.5 lg:min-h-0 lg:grid-rows-[minmax(0,1fr)_auto]">
          <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-student-border bg-white shadow-[0_2px_12px_rgba(60,47,119,0.05)]">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-student-border px-4 py-2.5">
              <div>
                <h2 className="font-bold text-student-text">
                  {view === "marked" ? "批改稿" : view === "revised" ? "修改稿" : view === "original" ? "原文" : "题目"}
                </h2>
                {view === "marked" ? (
                  <p className="mt-0.5 text-[11px] text-student-muted">点击修改标记查看对应详情</p>
                ) : null}
              </div>
              {view === "marked" ? <ReviewMarkerLegend /> : null}
            </div>
            <article className="min-h-[360px] flex-1 overflow-y-auto px-5 py-3.5 text-[15px] leading-7 text-student-text lg:min-h-0 sm:text-base">
              {view === "marked" ? (
                <WritingRevisionMarkedText
                  composition={composition}
                  markerSegments={markerSegments}
                  onSelectContentFeedback={selectMarkerById}
                  onSelectLanguageEdit={(edit) => selectMarkerById(edit.edit_id)}
                  overtimeRanges={attempt.overtime_ranges}
                  selectedId={selectedId}
                />
              ) : view === "revised" ? (
                <WritingRevisionMarkedText composition={composition} marksVisible={false} />
              ) : view === "original" ? (
                <p className="whitespace-pre-wrap">
                  <WritingOvertimeText ranges={attempt.overtime_ranges} text={attempt.response_text} />
                </p>
              ) : (
                <WritingQuestionReview
                  academicDiscussionAvatarSource={state.data.question_source}
                  avatarMap={avatarState.data?.avatars ?? EMPTY_ACADEMIC_DISCUSSION_AVATAR_MAP}
                  avatarMapReady={Boolean(avatarState.data)}
                  question={question}
                  taskType={attempt.task_type}
                />
              )}
            </article>
          </section>

          <section className="flex flex-col overflow-hidden rounded-xl border border-student-border bg-white shadow-[0_2px_12px_rgba(60,47,119,0.05)] lg:max-h-[38dvh]" id="current-review-detail">
            <div className="flex shrink-0 gap-5 overflow-x-auto border-b border-student-border px-3">
              <ReviewTabButton active={tab === "all"} onClick={() => selectTab("all")}>全部批改（{reviewCounts.all}）</ReviewTabButton>
              <ReviewTabButton active={tab === "language_edit"} onClick={() => selectTab("language_edit")}>语言错误修改（{reviewCounts.language_edit}）</ReviewTabButton>
              <ReviewTabButton active={tab === "content_feedback"} onClick={() => selectTab("content_feedback")}>内容反馈（{reviewCounts.content_feedback}）</ReviewTabButton>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
              <h2 className="text-sm font-bold text-student-text">当前批改详情</h2>
              {selectedItem ? (
                <PublishedReviewDetail item={selectedItem} />
              ) : (
                <p className="mt-3 text-sm text-student-muted">当前类型暂无批改内容。</p>
              )}
            </div>
          </section>
        </main>

        <aside className="grid min-w-0 gap-2.5 lg:min-h-0 lg:grid-rows-[minmax(0,1fr)_auto]">
          <PublishedScorePanel review={review} taskType={attempt.task_type} />
          <section className="rounded-xl border border-student-border bg-white p-3 shadow-[0_2px_12px_rgba(60,47,119,0.05)]">
            <h2 className="text-sm font-bold text-student-text">总体评价</h2>
            <p className="mt-1.5 whitespace-pre-wrap text-xs leading-5 text-student-text">
              {review.overall_evaluation || "暂无总体评价。"}
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}

export function StudentWritingReviewList() {
  const state = useStudentCachedData<ReviewListPayload>(
    REVIEW_LIST_CACHE_KEY,
    loadReviewList
  );
  if (state.loading) return <StudentLoadingState text="正在加载已发布批改..." />;
  if (state.error) return <StudentErrorState text="加载批改记录失败，请稍后重试。" />;
  const reviews = state.data?.reviews ?? [];
  return (
    <div className="grid gap-5">
      <StudentNavigation
        backHref={STUDENT_ROUTES.home}
        crumbs={[
          { label: "学生首页", href: STUDENT_ROUTES.home },
          { label: "已发布批改" }
        ]}
      />
      {reviews.length === 0 ? (
        <StudentEmptyState text="暂时没有已发布的写作批改。" />
      ) : (
        <div className="grid gap-3">
          {reviews.map((review) => (
            <Link
              className="student-card student-card-interactive flex flex-wrap items-center justify-between gap-4"
              href={writingReviewResultHref(review.attempt_id, STUDENT_ROUTES.writingReviews)}
              key={review.attempt_id}
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-student-primary-soft text-student-primary">
                  <FileCheck2 aria-hidden="true" size={23} />
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-bold text-student-primary">{WRITING_TASK_CONFIG[review.task_type].label}</p>
                  <h2 className="mt-1 truncate font-bold text-student-text">{review.set_title}</h2>
                  <p className="mt-1 text-xs text-student-muted">发布于 {formatDateTime(review.published_at)}</p>
                </div>
              </div>
              <span className="inline-flex items-center gap-2 text-sm font-bold text-student-primary">
                查看批改 <ArrowRight aria-hidden="true" size={18} />
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function PublishedReviewDetail({ item }: { item: PublishedReviewItem }) {
  if (item.kind === "language_edit") {
    const edit = item.edit;
    return (
      <dl className="mt-1.5 grid gap-y-1">
        <DetailRow label="原文" value={edit.original_text} />
        <DetailRow label="修改后" value={edit.replacement_text} />
        <DetailRow label="错误类型" value={writingReviewCategoryLabel(edit.category)} />
        <DetailRow label="修改说明" value={edit.explanation} />
      </dl>
    );
  }
  const feedback = item.feedback;
  return (
    <dl className="mt-1.5 grid gap-y-1">
      <DetailRow label="反馈类型" value={writingReviewCategoryLabel(feedback.category)} />
      <DetailRow label="问题" value={feedback.issue} />
      <DetailRow label="建议" value={feedback.suggestion} />
      <DetailRow
        label="改写示例"
        value={"proposed_revision" in feedback ? feedback.proposed_revision : ""}
      />
    </dl>
  );
}

function ReviewMarkerLegend() {
  const severities = ["major", "moderate", "minor"] as const;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-4 text-student-muted" aria-label="批改标记说明">
      {severities.map((severity) => (
        <span className="inline-flex items-center gap-1" key={severity}>
          <span className={languageEditSeverityMarkerClass(severity)}>&nbsp;</span>
          {languageEditSeverityLabel(severity)}
        </span>
      ))}
      <span className="inline-flex items-center gap-1">
        <span className={CONTENT_FEEDBACK_MARKER_CLASS}>F</span>
        内容反馈
      </span>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: unknown }) {
  if (typeof value !== "string" || !value.trim()) return null;
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 py-0.5">
      <dt className="text-xs font-bold leading-5 text-student-muted">{label}</dt>
      <dd className="whitespace-pre-wrap text-[13px] leading-5 text-student-text">{value}</dd>
    </div>
  );
}

function PublishedScorePanel({
  review,
  taskType
}: {
  review: StudentPublishedWritingReview;
  taskType: WritingTaskType;
}) {
  const definitions = writingDimensionDefinitions(taskType);
  return (
    <section className="flex min-h-[390px] min-w-0 flex-col overflow-hidden rounded-xl border border-student-border bg-white shadow-[0_2px_12px_rgba(60,47,119,0.05)] lg:min-h-0">
      <h2 className="shrink-0 border-b border-student-border px-3 py-2 text-sm font-bold text-student-text">评分</h2>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
      {review.scores.dimension_scores ? (
        <div className="mt-1 overflow-hidden rounded-lg border border-student-border">
          <div className="grid grid-cols-[25%_12%_minmax(0,1fr)] gap-1.5 bg-student-bg px-2 py-1.5 text-xs font-bold leading-4 text-student-muted">
            <span>评分维度</span><span>分数</span><span>评分理由</span>
          </div>
          {definitions.map((definition) => {
            const dimension = review.scores.dimension_scores?.[definition.key as keyof typeof review.scores.dimension_scores];
            if (!dimension) return null;
            return (
              <div className="grid grid-cols-[25%_12%_minmax(0,1fr)] items-start gap-1.5 border-t border-student-border px-2 py-1 text-xs leading-[1.125rem]" key={definition.key}>
                <div><strong>{definition.zh}</strong><p className="mt-0.5 text-[11px] leading-4 text-student-muted">{definition.en}</p></div>
                <strong className="text-student-primary">{dimension.score}/5</strong>
                <CollapsibleText
                  buttonClassName="text-[11px] leading-4"
                  className="text-xs leading-[1.125rem] text-student-text"
                  lines={2}
                  value={dimension.rationale}
                />
              </div>
            );
          })}
          <div className="grid grid-cols-[25%_12%_minmax(0,1fr)] items-start gap-1.5 border-t-2 border-student-primary-border bg-student-primary-soft/25 px-2 py-1 text-xs leading-[1.125rem]">
            <strong>总分</strong>
            <strong className="text-student-primary">{review.scores.official_score.score}/5</strong>
            <CollapsibleText
              buttonClassName="text-[11px] leading-4"
              className="text-xs leading-[1.125rem] text-student-text"
              lines={2}
              value={review.scores.official_score.rationale}
            />
          </div>
        </div>
      ) : (
        <div className="mt-2 rounded-lg border border-student-border p-2 text-xs">
          <div className="grid grid-cols-[24%_12%_minmax(0,1fr)] gap-1.5 leading-4">
            <strong>总分</strong>
            <strong className="text-student-primary">{review.scores.official_score.score}/5</strong>
            <p>{review.scores.official_score.rationale}</p>
          </div>
        </div>
      )}
      </div>
    </section>
  );
}

function ReviewViewTab({
  active,
  children,
  onClick
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      aria-current={active ? "page" : undefined}
      className={clsx(
        "h-10 border-b-2 px-1 text-sm font-bold transition",
        active
          ? "border-student-primary text-student-primary"
          : "border-transparent text-student-muted hover:text-student-text"
      )}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function ReviewTabButton({
  active,
  children,
  onClick
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className={clsx(
        "h-9 shrink-0 whitespace-nowrap border-b-2 px-0.5 text-xs transition",
        active
          ? "border-student-primary font-semibold text-student-primary"
          : "border-transparent font-medium text-student-muted hover:text-student-text"
      )}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function formatDateTime(value: string | null) {
  if (!value) return "时间未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

async function loadReview(attemptId: string, session: StudentCacheSession) {
  return loadJson<ReviewPayload>(
    `/api/writing/reviews/${encodeURIComponent(attemptId)}`,
    session,
    "无法加载批改结果。"
  );
}

async function loadReviewList(session: StudentCacheSession) {
  return loadJson<ReviewListPayload>(
    "/api/writing/reviews",
    session,
    "无法加载批改记录。"
  );
}

async function loadJson<T extends { error?: string }>(
  url: string,
  session: StudentCacheSession,
  fallback: string
) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${session.accessToken}` }
  });
  const payload = (await response.json()) as T;
  if (!response.ok || payload.error) throw new Error(payload.error ?? fallback);
  return payload;
}
