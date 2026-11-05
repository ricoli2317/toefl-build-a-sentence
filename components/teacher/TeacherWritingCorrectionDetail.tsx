"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { CompactSection, ReviewInclusionButton, QuestionColumn, ScoreSelect, WritingReviewInfoBar, WorkspaceSkeleton } from "./TeacherWritingReviewWorkspace";
import { ReviewWorkspaceFrame, ReviewWorkspaceGrid, ReviewToolbar, ReviewToolbarActions, ReviewFeedbackCard, ReviewFeedbackLine, ReviewBadge, ReviewOfficialScoreCard, ReviewScoreRationale, ReviewScoreTable, ReviewScoreRow, ReviewSelect } from "./WritingReviewPresentation";
import Link from "next/link";
import { languageEditSeverityLabel, languageEditSeverityMarkerClass, writingReviewCategoryLabel } from "@/lib/writingReviewWorkspaceUi";
import { CorrectionCompletionPanel, CorrectionIssueCard, useCorrectionBlankDeselection } from "@/components/writing/WritingCorrectionReviewPresentation";
import type { RubricScore } from "@/lib/writingReviewSchemaV2";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { WritingCorrectionComparison } from "@/components/teacher/WritingCorrectionComparison";
import { publishCacheInvalidation } from "@/lib/cacheInvalidation";
import {
  EMPTY_CORRECTION_TEACHER_OVERRIDES,
  recomputeCorrectionState,
  type CorrectionTeacherOverrides,
  type CorrectionWorkspace
} from "@/lib/writingCorrectionReview";
import type { CorrectionResolutionStatus } from "@/lib/writingCorrectionReviewSchema";
import {
  CORRECTION_STATUS_LABEL,
  CORRECTION_STATUS_ORDER,
  CORRECTION_STATUS_TONE,
  correctionCompletionSummary,
  correctionDeltaLabel,
  correctionIssueSummary
} from "@/lib/writingCorrectionReviewUi";

export type TeacherCorrectionPayload = { attempt: unknown; studentName: string };

async function teacherRequest(path: string, init?: RequestInit) {
  const { data: { session } } = await createBrowserSupabase().auth.getSession();
  return fetch(path, {
    ...init,
    cache: "no-store",
    headers: { ...init?.headers, Authorization: `Bearer ${session?.access_token ?? ""}` }
  });
}

type Busy = "load" | "generate" | "save" | "publish" | null;

/** Phase 4 workspace: AI correction review, issue audit, score, publish. */
export function TeacherWritingCorrectionDetail({
  attemptId,
  returnTo,
  send = teacherRequest
}: {
  attemptId: string;
  returnTo: string;
  send?: typeof teacherRequest;
}) {
  const [workspace, setWorkspace] = useState<CorrectionWorkspace | null>(null);
  const [draft, setDraft] = useState<CorrectionTeacherOverrides>(
    EMPTY_CORRECTION_TEACHER_OVERRIDES
  );
  const [busy, setBusy] = useState<Busy>("load");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmGenerate, setConfirmGenerate] = useState(false);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [locationRequest, setLocationRequest] = useState(0);
  const busyRef = useRef<Busy>(null);

  useCorrectionBlankDeselection(selectedIssueId, () => setSelectedIssueId(null));

  const apply = (next: CorrectionWorkspace) => {
    setWorkspace(next);
    setDraft({
      ...EMPTY_CORRECTION_TEACHER_OVERRIDES,
      ...next.review.teacher
    });
  };

  useEffect(() => {
    let cancelled = false;
    setWorkspace(null);
    setError("");
    setNotice("");
    setBusy("load");
    void (async () => {
      const response = await send(
        `/api/teacher/writing/reviews/${encodeURIComponent(attemptId)}/correction-review`
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? payload.error ?? "无法读取订正评价。");
      if (!cancelled) apply(payload.workspace as CorrectionWorkspace);
    })()
      .catch((reason) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "无法读取订正评价。");
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(null);
      });
    return () => { cancelled = true; };
  }, [attemptId, send]);

  const state = useMemo(
    () => (workspace ? recomputeCorrectionState(workspace.review.state, draft) : null),
    [workspace, draft]
  );
  const published = workspace?.review.status === "published";
  const readonly = busy !== null;
  const dirty = workspace
    ? JSON.stringify(draft) !== JSON.stringify(workspace.review.teacher)
    : false;
  const canPublish = Boolean(state && state.effective_score !== null);

  // Correction caches also refresh the combined published list; ordinary
  // practice history, calendar and assignment progress remain untouched.
  const invalidateCorrectionCaches = (next: CorrectionWorkspace) => {
    publishCacheInvalidation({
      type: "WRITING_CORRECTION_UPDATED",
      attemptKind: "correction",
      studentId: next.attempt.user_id,
      attemptId: next.attempt.attempt_id,
      originalAttemptId: next.attempt.original_attempt_id,
      assignmentId: next.attempt.assignment_id
    });
  };

  const run = async (kind: Exclude<Busy, "load" | null>, task: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = kind;
    setBusy(kind);
    setError("");
    setNotice("");
    try {
      await task();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败，请重试。");
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  };

  const post = async (path: string, body: unknown) => {
    const response = await send(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message ?? payload.error ?? "操作失败，请重试。");
    return payload;
  };

  const generate = () => run("generate", async () => {
    // As in ordinary Writing, never discard unsaved human edits when regenerating.
    if (dirty) {
      const saved = await post(`/api/teacher/writing/reviews/${encodeURIComponent(attemptId)}/correction-review`,
        { action: "save", teacher: draft });
      apply(saved.workspace as CorrectionWorkspace);
    }
    const payload = await post(
      `/api/teacher/writing/reviews/${encodeURIComponent(attemptId)}/correction-review/generate-ai`,
      {}
    );
    apply(payload.workspace as CorrectionWorkspace);
  });

  const save = () => run("save", async () => {
    const payload = await post(
      `/api/teacher/writing/reviews/${encodeURIComponent(attemptId)}/correction-review`,
      { action: "save", teacher: draft }
    );
    const next = payload.workspace as CorrectionWorkspace;
    apply(next);
    invalidateCorrectionCaches(next);
    setNotice("已保存未发布的订正评价工作稿。");
  });

  const publish = () => run("publish", async () => {
    const payload = await post(
      `/api/teacher/writing/reviews/${encodeURIComponent(attemptId)}/correction-review`,
      { action: "publish", teacher: draft }
    );
    const next = payload.workspace as CorrectionWorkspace;
    apply(next);
    invalidateCorrectionCaches(next);
    setNotice("订正评价已发布。");
  });


  const setIssueStatus = (issueId: string, value: string) => {
    setDraft((current) => {
      const statuses = { ...current.issue_statuses };
      statuses[issueId] = value as CorrectionResolutionStatus;
      return { ...current, issue_statuses: statuses };
    });
  };

  const setNewIssueReview = (index: number, status: "accepted" | "dismissed") => {
    setDraft((current) => {
      const reviews = { ...current.new_issue_reviews };
      const existing = reviews[String(index)];
      reviews[String(index)] = { status, note: existing?.note ?? "" };
      return { ...current, new_issue_reviews: reviews };
    });
  };

  const summary = state ? correctionIssueSummary(state) : null;
  const completion = state ? correctionCompletionSummary(state.completion) : null;
  const locateIssue = (id: string) => {
    setSelectedIssueId(id);
    setLocationRequest(request => request + 1);
  };

  if (busy === "load") return <WorkspaceSkeleton error={error} />;

  return (
    <ReviewWorkspaceFrame>
      <ReviewToolbar title="订正批改" returnTo={returnTo} displayName={workspace?.display_name ?? workspace?.question.set_title} status={published ? "已发布" : workspace?.review.status === "ignored" ? "已忽略" : "批改中"}>
          <Link className="teacher-button-secondary !min-h-8 !px-3 !py-1 text-xs" href={`/teacher/writing/reviews/logs?source=correction&attempt_id=${encodeURIComponent(attemptId)}&returnTo=${encodeURIComponent(`/teacher/writing/reviews/${attemptId}/correction?returnTo=${encodeURIComponent(returnTo)}`)}`}>查看 AI 日志</Link>
          {workspace && state ? <ReviewToolbarActions
            generateLabel={busy === "generate" ? state.ai_score === null ? "正在评价……" : "正在重新生成……" : state.ai_score === null ? "生成 AI 评价" : "重新生成 AI 评价"}
            statusText={error || (busy === "save" ? "保存中..." : busy === "publish" ? "发布中..." : busy === "generate" ? "AI 评价中..." : dirty ? "有未发布修改" : notice || "已保存")}
            error={Boolean(error)} generateDisabled={readonly || published} saveDisabled={readonly || !dirty} publishDisabled={readonly || !canPublish}
            onGenerate={() => (dirty || Object.keys(draft.issue_statuses).length > 0 || draft.correction_score !== null ? setConfirmGenerate(true) : void generate())}
            onSave={() => void save()} onPublish={() => void publish()}
          /> : null}
      </ReviewToolbar>
      {workspace ? <WritingReviewInfoBar items={[
        ["学生信息", workspace.attempt.student_name],
        ["题目类型", workspace.attempt.task_type === "email" ? "Write an Email" : "Academic Discussion"],
        ["题目来源", workspace.attempt.assignment_id ? workspace.question_source === "custom" ? "自定义作业题目" : "作业题目" : workspace.question.set_title],
        ["提交时间", workspace.attempt.submitted_at ? new Date(workspace.attempt.submitted_at).toLocaleString("zh-CN") : "—"],
        ["字数", String(workspace.attempt.word_count)],
        ["AI 评价时间", workspace.review.ai_generated_at ? new Date(workspace.review.ai_generated_at).toLocaleString("zh-CN") : "—"],
        ["评价状态", published ? "已发布" : state?.ai_score === null ? "待 AI 评价" : "评价草稿"]
      ]} /> : null}

      {error ? <p role="alert" className="shrink-0 border-b border-student-error-border bg-student-error-soft px-3 py-2 text-xs text-student-error">{error}</p> : null}

      {workspace && state && summary && completion ? (
        <>
          <ReviewWorkspaceGrid>
            <div className="min-w-0 [&>.writing-review-column]:h-full max-[1099px]:shrink-0 max-[1099px]:[&>.writing-review-column]:min-h-0"><QuestionColumn question={workspace.question} taskType={workspace.attempt.task_type} /></div>
            <section className="writing-review-column min-w-0 bg-white max-[1099px]:!min-h-0 max-[1099px]:shrink-0">
              <WritingCorrectionComparison
                workspace
                corrected={workspace.corrected_response_text}
                revisionState={workspace.revision_state}
                original={workspace.source.original_response_text}
                selectedIssue={workspace.review.state.issues.find(issue => issue.issue_id === selectedIssueId) ?? null}
                locationRequest={locationRequest}
              />
            </section>

            <aside className="writing-review-column min-w-0 bg-white max-[1099px]:!min-h-0 max-[1099px]:shrink-0 max-[1099px]:!overflow-visible">
              <div data-correction-review-scroll className="min-h-0 flex-1 overflow-y-auto p-2.5 max-[1099px]:flex-none max-[1099px]:overflow-visible">
              <CompactSection title="订正完成度">
                <CorrectionCompletionPanel completion={state.completion} summary={<ReviewBadge>语言 {summary.language} · 内容 {summary.content}</ReviewBadge>} />
              </CompactSection>

              <CompactSection title="综合评分">
                <ReviewScoreTable headings={["原稿评分", "AI 订正评分", "最终分差"]} columns="1fr 1fr 1fr">
                  <ReviewScoreRow columns="1fr 1fr 1fr"><strong>{state.original_score}/5</strong><strong className="text-student-primary">{state.ai_score === null ? "—" : `${state.ai_score}/5`}</strong><span><ReviewBadge toneClass={state.score_delta !== null && state.score_delta > 0 ? CORRECTION_STATUS_TONE.resolved : state.score_delta !== null && state.score_delta < 0 ? CORRECTION_STATUS_TONE.unresolved : undefined}>{correctionDeltaLabel(state.score_delta)}</ReviewBadge></span></ReviewScoreRow>
                </ReviewScoreTable>
                <ReviewOfficialScoreCard title="订正整体评分" teacherLabel="教师最终评分" aiScore={state.ai_score ?? "—"}
                  teacherControl={<ScoreSelect<RubricScore | null>
                    ariaLabel="教师订正评分"
                    disabled={readonly || state.effective_score === null}
                    value={state.effective_score as RubricScore | null}
                    onChange={(value) => setDraft((current) => ({
                      ...current,
                      correction_score: value
                    }))}
                  />}
                  rationaleLabel="教师评分解释"
                  rationale={<ReviewScoreRationale aria-label="教师评分解释"
                    disabled={readonly}
                    onChange={(event) => setDraft((current) => ({
                      ...current,
                      score_rationale: event.target.value
                    }))}
                    value={draft.score_rationale ?? state.ai_rationale}
                  />}
                >
                <label className="mt-2 block text-[10px] font-semibold text-student-muted">分差原因
                  <ReviewScoreRationale aria-label="分差原因" disabled={readonly} value={draft.score_change_explanation ?? state.ai_score_change_explanation}
                    onChange={event => setDraft(current => ({ ...current, score_change_explanation: event.target.value }))} />
                </label>
                </ReviewOfficialScoreCard>
              </CompactSection>

              <CompactSection title="原始问题逐项审核" subtitle={`${state.issues.length} 项`}>
                <ul className="grid gap-2">
                  {state.issues.map((issue) => (
                    <li key={issue.issue_id}><CorrectionIssueCard issue={issue} selected={selectedIssueId === issue.issue_id} onLocate={() => locateIssue(issue.issue_id)} badge={issue.teacher_status ? <ReviewBadge>教师已修改</ReviewBadge> : null}>
                      <div className="mt-2 rounded-md bg-student-bg p-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <strong>AI 判断</strong>
                        {issue.ai_status ? (
                          <ReviewBadge toneClass={CORRECTION_STATUS_TONE[issue.ai_status]}>
                            {CORRECTION_STATUS_LABEL[issue.ai_status]}
                          </ReviewBadge>
                        ) : (
                          <ReviewBadge>尚未评价</ReviewBadge>
                        )}
                        {issue.ai_deletion_based ? (
                          <ReviewBadge>
                            基于删除
                          </ReviewBadge>
                        ) : null}
                      </div>
                      {issue.ai_explanation ? (
                        <p className="mt-1.5">{issue.ai_explanation}</p>
                      ) : null}
                      </div>
                      <label className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[10px] font-semibold">
                        教师判定
                        <ReviewSelect
                          disabled={readonly}
                          onChange={(event) => setIssueStatus(issue.issue_id, event.target.value)}
                          aria-label={`教师判定 ${issue.issue_id}`}
                          value={issue.effective_status === "uncertain" ? "" : issue.effective_status ?? ""}
                        >
                          {issue.effective_status === null || issue.effective_status === "uncertain" ? <option disabled value="">请选择判定</option> : null}
                          {CORRECTION_STATUS_ORDER.filter(status => status !== "uncertain").map((status) => (
                            <option key={status} value={status}>{CORRECTION_STATUS_LABEL[status]}</option>
                          ))}
                        </ReviewSelect>
                      </label>
                    </CorrectionIssueCard></li>
                  ))}
                </ul>
              </CompactSection>

              <CompactSection title="订正产生的新问题" subtitle={`${state.new_issues.length} 项`}>
                {state.new_issues.length === 0 ? (
                   <p className="text-xs">暂无新问题。</p>
                ) : (
                  <ul className="grid gap-2">
                    {state.new_issues.map((issue) => (
                      <li key={issue.index}><ReviewFeedbackCard muted={issue.review_status === "dismissed"}>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-semibold text-student-primary">
                            {writingReviewCategoryLabel(issue.type)}
                          </span>
                          <span className={languageEditSeverityMarkerClass(issue.severity)}>{languageEditSeverityLabel(issue.severity)}</span>
                          <ReviewBadge>评分影响：{issue.score_impact}</ReviewBadge>
                          {issue.review_status !== "pending" ? (
                            <ReviewBadge>
                              {issue.review_status === "dismissed" ? "未采用" : "已采用"}
                            </ReviewBadge>
                          ) : null}
                        </div>
                        <ReviewFeedbackLine label="订正稿证据" value={issue.evidence} />
                        <ReviewFeedbackLine label="AI 解释" value={issue.explanation} />
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <ReviewInclusionButton restoreLabel="采用" included={issue.review_status !== "dismissed"} disabled={readonly}
                            onChange={included => setNewIssueReview(issue.index, included ? "accepted" : "dismissed")} />
                        </div>
                      </ReviewFeedbackCard></li>
                    ))}
                  </ul>
                )}
              </CompactSection>
              </div>
            </aside>
          </ReviewWorkspaceGrid>
        </>
      ) : null}

      <ConfirmDialog
        open={confirmGenerate}
        title="重新生成 AI 评价"
        message="AI 的逐项判断与评分会被新的结果替换；你手动修改的问题状态、评分与解释会被保留，不会静默覆盖。"
        confirmText="继续生成"
        cancelText="取消"
        confirming={busy === "generate"}
        onCancel={() => { if (!busyRef.current) setConfirmGenerate(false); }}
        onConfirm={() => { setConfirmGenerate(false); void generate(); }}
      />
    </ReviewWorkspaceFrame>
  );
}
