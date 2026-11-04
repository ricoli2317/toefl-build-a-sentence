"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { CompactSection, MiniButton, QuestionColumn, ScoreSelect, WritingReviewInfoBar } from "./TeacherWritingReviewWorkspace";
import { ReviewWorkspaceFrame, ReviewWorkspaceGrid, ReviewToolbar, ReviewToolbarActions, ReviewToolbarButton, ReviewFilterChip, ReviewFeedbackCard, ReviewFeedbackLine, ReviewBadge, ReviewOfficialScoreCard, ReviewScoreRationale, ReviewScoreTable, ReviewScoreRow, ReviewSelect } from "./WritingReviewPresentation";
import { CollapsibleText } from "@/components/writing/CollapsibleText";
import { CONTENT_FEEDBACK_MARKER_CLASS, languageEditSeverityLabel, languageEditSeverityMarkerClass, writingReviewCategoryLabel } from "@/lib/writingReviewWorkspaceUi";
import type { RubricScore } from "@/lib/writingReviewSchemaV2";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { WritingCorrectionComparison } from "@/components/teacher/WritingCorrectionComparison";
import { WRITING_CORRECTION_CHANGE_STYLE, WRITING_CORRECTION_DELETION_STYLE } from "@/lib/writingCorrectionDisplay";
import {
  parseWritingReviewModerationResponse,
  publishWritingReviewModerationInvalidation,
  writingReviewModerationNotice
} from "@/lib/writingReviewModeration";
import { publishCacheInvalidation } from "@/lib/cacheInvalidation";
import {
  EMPTY_CORRECTION_TEACHER_OVERRIDES,
  recomputeCorrectionState,
  type CorrectionTeacherOverrides,
  type CorrectionWorkspace
} from "@/lib/writingCorrectionReview";
import type { CorrectionResolutionStatus } from "@/lib/writingCorrectionReviewSchema";
import {
  CORRECTION_ISSUE_TYPE_LABEL,
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

type Busy = "load" | "generate" | "save" | "publish" | "return" | null;

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
  const [confirmReturn, setConfirmReturn] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [confirmGenerate, setConfirmGenerate] = useState(false);
  const [returned, setReturned] = useState(false);
  const [telemetry, setTelemetry] = useState<string>("");
  const busyRef = useRef<Busy>(null);

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
    setReturned(false);
    setTelemetry("");
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
  const readonly = published || busy !== null;
  const dirty = workspace
    ? JSON.stringify(draft) !== JSON.stringify(workspace.review.teacher)
    : false;
  const canPublish = Boolean(state && state.effective_score !== null);

  // A saved or published correction review only invalidates correction-aware
  // caches: the teacher queue, this workspace, and the student's correction
  // history. Ordinary writing history, calendar and published reviews stay.
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
    const payload = await post(
      `/api/teacher/writing/reviews/${encodeURIComponent(attemptId)}/correction-review/generate-ai`,
      {}
    );
    apply(payload.workspace as CorrectionWorkspace);
    if (payload.teacher_overrides_preserved) {
      setNotice("AI 已重新评价。你此前修改的问题状态与评分已保留，未被覆盖。");
    } else {
      setNotice("AI 订正评价已生成，仍是未发布草稿。");
    }
    const info = payload.telemetry as {
      model?: string | null; end_to_end_elapsed_ms?: number; hedge_triggered?: boolean;
      requests_started?: number;
    } | undefined;
    if (info) {
      setTelemetry([
        info.model ? `模型 ${info.model}` : "",
        typeof info.end_to_end_elapsed_ms === "number" ? `${Math.round(info.end_to_end_elapsed_ms / 100) / 10}s` : "",
        info.hedge_triggered ? `hedge ${info.requests_started} 次请求` : ""
      ].filter(Boolean).join(" · "));
    }
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
    setNotice("订正评价已发布并冻结，原稿已发布批改未被修改。");
    setConfirmPublish(false);
  });

  const returnCorrection = () => run("return", async () => {
    const payload = await post("/api/teacher/writing/reviews/moderate", {
      action: "return",
      attemptIds: [attemptId]
    });
    const parsed = parseWritingReviewModerationResponse(payload);
    const result = parsed?.results.find((item) => item.attemptId === attemptId);
    if (!parsed || !result) throw new Error("退回失败，请重试。");
    publishWritingReviewModerationInvalidation(
      "return",
      [{
        attemptId,
        studentId: workspace?.attempt.user_id ?? "",
        assignmentId: workspace?.attempt.assignment_id ?? null,
        attemptKind: "correction",
        originalAttemptId: workspace?.attempt.original_attempt_id ?? null
      }],
      parsed.results
    );
    setNotice(
      result.reason === "draft_exists"
        ? "无法退回：该原稿下已有另一份活动订正草稿，未覆盖任何草稿。"
        : writingReviewModerationNotice("return", parsed.results)
    );
    if (result.outcome === "returned") setReturned(true);
    setConfirmReturn(false);
  });

  const setIssueStatus = (issueId: string, value: string) => {
    setDraft((current) => {
      const statuses = { ...current.issue_statuses };
      if (value === "ai") delete statuses[issueId];
      else statuses[issueId] = value as CorrectionResolutionStatus;
      return { ...current, issue_statuses: statuses };
    });
  };

  const setNewIssueReview = (index: number, status: "accepted" | "dismissed") => {
    setDraft((current) => {
      const reviews = { ...current.new_issue_reviews };
      const existing = reviews[String(index)];
      if (existing?.status === status) delete reviews[String(index)];
      else reviews[String(index)] = { status, note: existing?.note ?? "" };
      return { ...current, new_issue_reviews: reviews };
    });
  };

  const summary = state ? correctionIssueSummary(state) : null;
  const completion = state ? correctionCompletionSummary(state.completion) : null;

  return (
    <ReviewWorkspaceFrame>
      <ReviewToolbar title="订正批改" returnTo={returnTo} displayName={workspace?.question.set_title} status={published ? "已发布" : returned ? "已退回" : "批改中"}>
          {workspace && !published && !returned ? (
            <ReviewToolbarButton
              disabled={readonly}
              onClick={() => setConfirmReturn(true)}
            >
              退回订正
            </ReviewToolbarButton>
          ) : null}
          {workspace && state && !returned ? <ReviewToolbarActions
            generateLabel={busy === "generate" ? "正在重新生成..." : state.ai_score === null ? "生成 AI 评价" : "重新生成 AI 评价"}
            statusText={error || (busy === "save" ? "保存中..." : busy === "publish" ? "发布中..." : busy === "generate" ? "AI 评价中..." : dirty ? "有未发布修改" : "已保存")}
            error={Boolean(error)} generateDisabled={readonly} saveDisabled={readonly || !dirty} publishDisabled={readonly || !canPublish}
            onGenerate={() => (Object.keys(draft.issue_statuses).length > 0 || draft.correction_score !== null ? setConfirmGenerate(true) : void generate())}
            onSave={() => void save()} onPublish={() => setConfirmPublish(true)}
          /> : null}
      </ReviewToolbar>
      {workspace ? <WritingReviewInfoBar items={[
        ["学生信息", workspace.attempt.student_name],
        ["题目类型", workspace.attempt.task_type === "email" ? "Write an Email" : "Academic Discussion"],
        ["题目来源", workspace.attempt.assignment_id ? workspace.question_source === "custom" ? "自定义作业题目" : "作业题目" : workspace.question.set_title],
        ["提交时间", workspace.attempt.submitted_at ? new Date(workspace.attempt.submitted_at).toLocaleString("zh-CN") : "—"],
        ["字数", String(workspace.attempt.word_count)],
        ["AI 评价时间", workspace.review.ai_generated_at ? new Date(workspace.review.ai_generated_at).toLocaleString("zh-CN") : "—"],
        ["评价状态", published ? "已发布 · 只读" : returned ? "已退回" : state?.ai_score === null ? "待 AI 评价" : "评价草稿"]
      ]} /> : null}

      {error ? <p role="alert" className="shrink-0 border-b border-student-error-border bg-student-error-soft px-3 py-2 text-xs text-student-error">{error}</p> : null}
      {notice ? <p role="status" className="shrink-0 border-b border-student-border px-3 py-2 text-xs">{notice}</p> : null}
      {returned ? (
        <p role="status" className="px-3 py-2 text-xs">已恢复同一份订正草稿，学生可继续编辑。</p>
      ) : null}
      {published ? (
        <p role="status" className="shrink-0 border-b border-student-primary-border bg-student-primary-soft px-3 py-2 text-xs text-student-primary">
          订正评价已发布并冻结于{" "}
          {workspace?.review.published_at
            ? new Date(workspace.review.published_at).toLocaleString("zh-CN")
            : "—"}
          。此页面只读。
        </p>
      ) : null}
      {busy === "load" ? <p>正在加载订正评价…</p> : null}

      {workspace && state && summary && completion ? (
        <>
          <ReviewWorkspaceGrid>
            <div className="min-w-0 [&>.writing-review-column]:h-full max-[1099px]:shrink-0 max-[1099px]:[&>.writing-review-column]:min-h-0"><QuestionColumn question={workspace.question} taskType={workspace.attempt.task_type} /></div>
            <section className="writing-review-column min-w-0 bg-white max-[1099px]:!min-h-0 max-[1099px]:shrink-0">
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-student-border px-3 py-2.5">
                <h2 className="text-sm font-bold">修订正文</h2>
                <div aria-label="修订图例" className="flex flex-wrap gap-3 text-xs text-student-muted">
                  <span style={WRITING_CORRECTION_DELETION_STYLE}>删除</span>
                  <span style={WRITING_CORRECTION_CHANGE_STYLE}>新增</span>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-5">
              <WritingCorrectionComparison
                corrected={workspace.corrected_response_text}
                revisionState={workspace.revision_state}
                original={workspace.source.original_response_text}
              />
              </div>
            </section>

            <aside className="writing-review-column min-w-0 overflow-y-auto bg-white p-2.5 max-[1099px]:!min-h-0 max-[1099px]:shrink-0 max-[1099px]:!overflow-visible">
              <div className="shrink-0">
              <CompactSection title="订正完成度">
                <div className="flex items-center justify-between gap-2"><p className="text-3xl font-bold leading-tight tabular-nums">{completion.label}</p><ReviewBadge>语言 {summary.language} · 内容 {summary.content}</ReviewBadge></div>
                {state.completion.rate !== null ? <div aria-label="原始问题加权完成度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={state.completion.rate * 100} className="mt-3 h-1.5 overflow-hidden rounded-full bg-student-primary-soft" role="progressbar"><div className="h-full rounded-full bg-student-primary" style={{ width: `${state.completion.rate * 100}%` }} /></div> : null}
                <dl className="mt-3 grid grid-cols-2 gap-2">
                  {CORRECTION_STATUS_ORDER.map(status => <div className="flex items-center justify-between gap-2 rounded-md bg-student-bg px-2 py-1.5" key={status}><dt><ReviewBadge toneClass={CORRECTION_STATUS_TONE[status]}>{CORRECTION_STATUS_LABEL[status]}</ReviewBadge></dt><dd className="text-sm font-bold tabular-nums">{state.completion.counts[status]}</dd></div>)}
                  {state.completion.counts.undetermined > 0 ? (
                    <>
                      <div className="col-span-2 flex items-center justify-between px-2 text-[11px]"><dt><ReviewBadge>未判定</ReviewBadge></dt><dd className="font-bold tabular-nums">{state.completion.counts.undetermined}</dd></div>
                    </>
                  ) : null}
                </dl>
                <details className="mt-2 text-[11px]"><summary className="cursor-pointer text-student-primary">计算方式</summary><p className="mt-1 leading-5">{completion.detail}。每条 LE 权重 1，每条 Content 权重 3；已解决计 1，部分解决计 0.5，未解决 / 无法确定计 0。新问题不参与计算。完成度不是评分。</p></details>
              </CompactSection>

              <CompactSection title="综合评分">
                <ReviewScoreTable headings={["原稿评分", "AI 订正评分", "最终分差"]} columns="1fr 1fr 1fr">
                  <ReviewScoreRow columns="1fr 1fr 1fr"><strong>{state.original_score}/5</strong><strong className="text-student-primary">{state.ai_score === null ? "—" : `${state.ai_score}/5`}</strong><span><ReviewBadge toneClass={state.score_delta !== null && state.score_delta > 0 ? CORRECTION_STATUS_TONE.resolved : state.score_delta !== null && state.score_delta < 0 ? CORRECTION_STATUS_TONE.unresolved : undefined}>{correctionDeltaLabel(state.score_delta)}</ReviewBadge></span></ReviewScoreRow>
                </ReviewScoreTable>
                <ReviewOfficialScoreCard title="订正整体评分" aiScore={state.ai_score ?? "—"}
                  teacherControl={<ScoreSelect<RubricScore | null>
                    ariaLabel="教师订正评分"
                    disabled={readonly}
                    value={draft.correction_score as RubricScore | null}
                    inheritLabel={`跟随 AI（${state.ai_score ?? "—"}）`}
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
                    placeholder={state.ai_rationale || "可留空，发布时使用 AI 解释"}
                    value={draft.score_rationale ?? ""}
                  />}
                />
                {state.ai_rationale || state.ai_score_change_explanation ? <div className="mt-2 text-[11px] leading-[1.55]">
                  {state.ai_rationale ? <div className="mt-1.5"><strong>AI 评价</strong><CollapsibleText className="text-[11px] leading-[1.55] text-student-text" value={state.ai_rationale} lines={3} /></div> : null}
                  {state.ai_score_change_explanation ? <div className="mt-1.5"><strong>分差原因</strong><CollapsibleText className="text-[11px] leading-[1.55] text-student-text" value={state.ai_score_change_explanation} lines={2} /></div> : null}
                </div> : null}
              </CompactSection>

              <CompactSection title="原始问题逐项审核" subtitle={`${state.issues.length} 项`}>
                <ul className="grid gap-2">
                  {state.issues.map((issue) => (
                    <li key={issue.issue_id}><ReviewFeedbackCard>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={issue.issue_type === "content_feedback" ? CONTENT_FEEDBACK_MARKER_CLASS : "font-semibold"}>
                          {CORRECTION_ISSUE_TYPE_LABEL[issue.issue_type] ?? issue.issue_type}
                        </span>
                        <span className="font-semibold text-student-primary">{writingReviewCategoryLabel(issue.category)}</span>
                        {issue.severity === "major" || issue.severity === "moderate" || issue.severity === "minor" ? <span className={languageEditSeverityMarkerClass(issue.severity)}>{languageEditSeverityLabel(issue.severity)}</span> : null}
                        {issue.teacher_status ? (
                           <ReviewBadge>教师已修改</ReviewBadge>
                        ) : null}
                      </div>
                      {issue.issue_type === "language_edit" ? (
                        <ReviewFeedbackLine label="原文 / 建议" value={<>
                          <span className="line-through">{issue.original_text}</span>
                          {" → "}
                          <span className="font-medium">{issue.replacement_text}</span>
                        </>} />
                      ) : (
                        <ReviewFeedbackLine label="对应原句" value={issue.original_sentence} />
                      )}
                      {issue.issue ? (
                        <ReviewFeedbackLine label="问题" value={issue.issue} />
                      ) : null}
                      {issue.suggestion ? <ReviewFeedbackLine label="建议" value={issue.suggestion} /> : null}
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
                      {issue.ai_evidence ? (
                        <ReviewFeedbackLine label="订正稿证据" value={issue.ai_evidence} />
                      ) : null}
                      </div>
                      <label className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[10px] font-semibold">
                        教师判定
                        <ReviewSelect
                          disabled={readonly}
                          onChange={(event) => setIssueStatus(issue.issue_id, event.target.value)}
                          value={issue.teacher_status ?? "ai"}
                        >
                          <option value="ai">跟随 AI</option>
                          {CORRECTION_STATUS_ORDER.map((status) => (
                            <option key={status} value={status}>{CORRECTION_STATUS_LABEL[status]}</option>
                          ))}
                        </ReviewSelect>
                      </label>
                    </ReviewFeedbackCard></li>
                  ))}
                </ul>
              </CompactSection>

              <CompactSection title="订正产生的新问题" subtitle={`${state.new_issues.length} 项`}>
                {state.new_issues.length === 0 ? (
                   <p className="text-xs">暂无新问题。</p>
                ) : (
                  <ul className="grid gap-2">
                    {state.new_issues.map((issue) => (
                      <li key={issue.index}><ReviewFeedbackCard>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-semibold text-student-primary">
                            {writingReviewCategoryLabel(issue.type)}
                          </span>
                          <span className={languageEditSeverityMarkerClass(issue.severity)}>{languageEditSeverityLabel(issue.severity)}</span>
                          <ReviewBadge>评分影响：{issue.score_impact}</ReviewBadge>
                          {issue.review_status !== "pending" ? (
                            <ReviewBadge>
                              {issue.review_status === "accepted" ? "教师已采纳" : "教师已驳回"}
                            </ReviewBadge>
                          ) : null}
                        </div>
                        <ReviewFeedbackLine label="订正稿证据" value={issue.evidence} />
                        <ReviewFeedbackLine label="AI 解释" value={issue.explanation} />
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <MiniButton
                            disabled={readonly}
                            onClick={() => setNewIssueReview(issue.index, "accepted")}
                          >
                            {issue.review_status === "accepted" ? "取消采纳" : "采纳"}
                          </MiniButton>
                          <MiniButton
                            disabled={readonly}
                            onClick={() => setNewIssueReview(issue.index, "dismissed")}
                          >
                            {issue.review_status === "dismissed" ? "取消驳回" : "驳回"}
                          </MiniButton>
                        </div>
                      </ReviewFeedbackCard></li>
                    ))}
                  </ul>
                )}
              </CompactSection>
              {telemetry ? <details className="text-xs"><summary className="cursor-pointer text-student-primary">AI 请求信息</summary><p className="mt-1">{telemetry}</p></details> : null}
              </div>
            </aside>
          </ReviewWorkspaceGrid>
        </>
      ) : null}

      <ConfirmDialog
        open={confirmReturn}
        title="退回订正草稿"
        message="退回后恢复同一个订正 ID，保留冻结来源，学生可以继续修改。已有另一份活动草稿或批改记录时不会退回，也不会覆盖。"
        confirmText="确认退回"
        cancelText="取消"
        confirming={busy === "return"}
        onCancel={() => { if (!busyRef.current) setConfirmReturn(false); }}
        onConfirm={() => void returnCorrection()}
      />
      <ConfirmDialog
        open={confirmPublish}
        title="发布订正评价"
        message="发布后订正评价将被冻结，学生可见；原稿的已发布批改不会被修改。发布后不能再编辑。"
        confirmText="确认发布"
        cancelText="取消"
        confirming={busy === "publish"}
        onCancel={() => { if (!busyRef.current) setConfirmPublish(false); }}
        onConfirm={() => void publish()}
      />
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
