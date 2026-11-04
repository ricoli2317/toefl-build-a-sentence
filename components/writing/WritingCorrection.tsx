"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AcademicStudentResponses, EmailResponseHeader, WritingPageHeader } from "./WritingPractice";
import { WritingRevisionEditor, type RevisionEditorHandle } from "./WritingRevisionEditor";
import { initializeWritingRevision, revisionStateKey } from "@/lib/writingRevisionState";
import { AcademicPrompt, EmailPrompt } from "./WritingQuestionPrompt";
import { WritingPracticeActions } from "./WritingPracticeActions";
import { ModalShell } from "@/components/shared/ConfirmDialog";
import { WritingRevisionMarkedText } from "./WritingRevisionMarkedText";
import { PublishedReviewDetail, ReviewMarkerLegend, ReviewViewTab, ReviewTabButton } from "@/components/student/StudentWritingReview";
import { type WritingAttempt, type EmailQuestion, type AcademicDiscussionQuestion } from "@/lib/writing";
import { resolveCustomAcademicDiscussionAvatar } from "@/lib/academicDiscussionAvatars";
import { StudentErrorState, StudentLoadingState } from "@/components/student/StudentUI";
import { frozenWritingCorrectionSource } from "@/lib/writingCorrection";
import { CorrectionRequestError, correctionAnnotations, type WritingCorrectionClient } from "@/lib/writingCorrectionUi";
import { writingCorrectionClient } from "@/lib/writingCorrectionClient";
import { buildWritingRevisionComposition } from "@/lib/writingReviewRevisionComposition";
import { buildWorkspaceAnnotationSegments } from "@/lib/writingReviewWorkspaceUi";
import { orderedPublishedReviewItems, publishedReviewItemsForTab } from "@/lib/writingPublishedReview";

export function WritingCorrection({ attemptId, backHref, client = writingCorrectionClient }: {
  attemptId: string; backHref: string; client?: WritingCorrectionClient;
}) {
  const [attempt, setAttempt] = useState<WritingAttempt | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setAttempt(null); setError("");
    void client.load(attemptId).then((value) => { if (!cancelled) setAttempt(value); })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "无法恢复订正草稿。"); });
    return () => { cancelled = true; };
  }, [attemptId, client]);
  if (!attempt) return <main className="grid min-h-screen place-content-center gap-4 bg-student-bg p-6 text-center">
    {error ? <><StudentErrorState text={error} /><a className="student-button-secondary" href={backHref}>返回原稿</a></> : <StudentLoadingState text="正在恢复订正草稿…" />}
  </main>;
  return <WritingCorrectionSession key={attempt.attempt_id} initialAttempt={attempt} backHref={backHref} client={client} />;
}

function WritingCorrectionSession({ initialAttempt, backHref, client }: {
  initialAttempt: WritingAttempt; backHref: string; client: WritingCorrectionClient;
}) {
  const router = useRouter();
  // Never replace this source on tab changes, saves or conflict refreshes.
  const source = useMemo(() => frozenWritingCorrectionSource(initialAttempt), [initialAttempt]);
  const [attempt, setAttempt] = useState(initialAttempt);
  const [tab, setTab] = useState<"edit" | "annotations">("edit");
  const [savedText, setSavedText] = useState(initialAttempt.response_text);
  const initialRevision = useMemo(() => initializeWritingRevision(source.original_response_text, initialAttempt.response_text, initialAttempt.revision_state), [initialAttempt, source]);
  const [revision, setRevision] = useState(initialRevision);
  const [savedRevisionKey, setSavedRevisionKey] = useState(initialAttempt.revision_state ? revisionStateKey(initialRevision) : null);
  const editorHandle = useRef<RevisionEditorHandle | null>(null);
  const [editorGeneration, setEditorGeneration] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [reloadOpen, setReloadOpen] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  // Retain the exact submitted version on ambiguous network failures. Retry
  // the same RPC, never create another attempt or allow edits in between.
  const [pendingSubmitVersion, setPendingSubmitVersion] = useState<number | null>(null);
  const [exitHref, setExitHref] = useState<string | null>(null);
  const [previousLocalText, setPreviousLocalText] = useState<string | null>(null);
  const editor = { text: revision.ledger.text };
  const currentRevisionKey = useMemo(() => revisionStateKey(revision), [revision]);
  const dirty = editor.text !== savedText || currentRevisionKey !== savedRevisionKey;
  const submitted = attempt.status === "submitted";
  const locked = submitted || pendingSubmitVersion !== null;

  function requestExit(href = backHref) {
    if (busyRef.current) return;
    if (dirty) setExitHref(href);
    else router.push(href);
  }

  useEffect(() => {
    if (!dirty && !busy) return;
    const currentUrl = window.location.href;
    const currentState = window.history.state;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const click = (event: globalThis.MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element)?.closest<HTMLAnchorElement>("a[href]");
      if (!link || link.target === "_blank" || link.hasAttribute("download") || link.href === currentUrl) return;
      event.preventDefault(); event.stopPropagation();
      if (!busyRef.current) setExitHref(link.href);
    };
    const pop = (event: PopStateEvent) => {
      const destination = window.location.href;
      if (destination === currentUrl) return;
      // Capture before Next's popstate handler so the editor is not unmounted.
      event.stopImmediatePropagation();
      window.history.pushState(currentState, "", currentUrl);
      if (!busyRef.current) setExitHref(destination);
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", click, true);
    window.addEventListener("popstate", pop, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", click, true);
      window.removeEventListener("popstate", pop, true);
    };
  }, [dirty, busy]);

  async function save(leaveTo?: string) {
    if (busyRef.current || conflict || locked) return;
    if (!dirty) { if (leaveTo) router.push(leaveTo); return; }
    busyRef.current = true; setBusy(true); setError("");
    const state = editorHandle.current?.snapshot() ?? revision;
    const text = state.ledger.text;
    try {
      const saved = await client.save(attempt.attempt_id, text, attempt.draft_version, state);
      setAttempt(saved); setSavedText(text); setSavedRevisionKey(revisionStateKey(state));
      if (leaveTo) router.push(leaveTo);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "草稿保存失败，当前正文仍保留。");
      if (reason instanceof CorrectionRequestError && reason.status === 409) setConflict(true);
    } finally { busyRef.current = false; setBusy(false); }
  }

  async function submit() {
    if (busyRef.current || conflict || submitted) return;
    busyRef.current = true; setBusy(true); setError("");
    let submitting = false;
    try {
      let latest = attempt;
      const submittingState = editorHandle.current?.snapshot() ?? revision;
      if (pendingSubmitVersion === null && dirty) {
        const state = submittingState;
        latest = await client.save(attempt.attempt_id, state.ledger.text, attempt.draft_version, state);
        setAttempt(latest); setSavedText(state.ledger.text); setSavedRevisionKey(revisionStateKey(state));
      }
      const version = pendingSubmitVersion ?? latest.draft_version;
      setPendingSubmitVersion(version);
      submitting = true;
      const result = await client.submit(attempt.attempt_id, version);
      // The unchanged Phase 1B RPC deliberately makes submitted retries reads.
      // Another tab may have submitted a DIFFERENT saved version first. Never
      // label our still-local ledger as that submission or silently replace it.
      if (result.response_text !== submittingState.ledger.text || !result.revision_state ||
        revisionStateKey(result.revision_state) !== revisionStateKey(submittingState)) {
        throw new CorrectionRequestError(409, "WRITING_CORRECTION_VERSION_CONFLICT", "服务器已提交的修订版本与本地不同。已保留本地正文及修订，请确认后读取最新记录。");
      }
      setAttempt(result); setSavedText(result.response_text);
      setPendingSubmitVersion(null); setSubmitOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "提交结果未确认，请重试同一条订正。");
      if (!submitting || (reason instanceof CorrectionRequestError &&
        ((reason.status >= 400 && reason.status < 500 && reason.status !== 408) ||
          ["WRITING_CORRECTION_NOT_ENABLED", "CORRECTION_BACKEND_NOT_READY"].includes(reason.code)))) {
        setPendingSubmitVersion(null);
      }
      if (reason instanceof CorrectionRequestError && reason.status === 409) setConflict(true);
      setSubmitOpen(false);
    } finally { busyRef.current = false; setBusy(false); }
  }

  async function reload() {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const latest = await client.load(attempt.attempt_id);
      if (latest.original_attempt_id !== initialAttempt.original_attempt_id ||
        JSON.stringify(latest.correction_source_snapshot) !== JSON.stringify(source)) {
        throw new Error("冻结来源不一致，已保留当前正文，请返回原稿后重试。");
      }
      setPreviousLocalText(editor.text);
      const next = initializeWritingRevision(source.original_response_text, latest.response_text, latest.revision_state);
      setRevision(next); setSavedRevisionKey(latest.revision_state ? revisionStateKey(next) : null); setEditorGeneration(value => value + 1);
      setAttempt(latest); setSavedText(latest.response_text); setConflict(false); setReloadOpen(false); setPendingSubmitVersion(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "重新读取失败，当前正文仍保留。"); }
    finally { busyRef.current = false; setBusy(false); }
  }

  return <div className="writing-practice flex min-h-[100dvh] flex-col bg-[#fbfbfe] text-student-text lg:h-[100dvh] lg:overflow-hidden">
    <div className="shrink-0 border-b border-student-border bg-white">
      <WritingPageHeader title={`${source.question.set_title} · 订正`} disabled={busy} onBack={() => requestExit()} readOnly={submitted} />
      <div aria-label="订正视图" className="mx-auto flex max-w-[1920px] items-center gap-6 px-4 sm:px-6 lg:px-8" role="tablist">
        {([ ["edit", submitted ? "订正正文（只读）" : "编辑订正"], ["annotations", "查看批注"] ] as const).map(([value, label]) => <ReviewViewTab
          active={tab === value} panelId={`correction-${value}`} tabId={`correction-tab-${value}`} key={value} onClick={() => setTab(value)}>{label}</ReviewViewTab>)}
        <span aria-live="polite" className="ml-auto text-right text-xs text-student-muted">{busy ? "正在处理…" : submitted ? "已提交 · 只读" : dirty ? "有未保存修改" : "已保存"} · 版本 {attempt.draft_version}</span>
      </div>
    </div>
    {submitted ? <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-student-primary-border bg-student-primary-soft px-4 py-2 text-xs sm:px-6" role="status">订正提交成功 · 本次正文只读 · {attempt.submitted_at ? new Date(attempt.submitted_at).toLocaleString("zh-CN") : "—"}<a className="font-semibold text-student-primary" href={backHref}>返回原稿查看订正历史</a></div> : null}
    {pendingSubmitVersion !== null && !busy ? <p className="shrink-0 p-3 text-sm" role="status">提交结果尚未确认，正文暂时锁定。请重试提交以确认同一条记录，不会创建重复记录。</p> : null}
    {error ? <div className="shrink-0 border-b border-student-error-border bg-student-error-soft p-3 text-sm text-student-error" role="alert">
      {error} {conflict ? <><span>未覆盖本地修改。请先复制正文，再确认读取最新草稿。</span><button className="student-button-secondary ml-3" disabled={busy} onClick={() => setReloadOpen(true)} type="button">重新读取最新草稿</button></> : null}
    </div> : null}
    <section aria-labelledby="correction-tab-edit" className="min-h-0 flex-1 lg:overflow-hidden" hidden={tab !== "edit"} id="correction-edit" role="tabpanel">
      <div className="mx-auto grid h-full max-w-[1920px] gap-4 px-4 py-3 sm:px-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:px-8">
        <div className="min-h-0 overflow-y-auto">
          {attempt.task_type === "email" ? <EmailPrompt question={source.question as EmailQuestion} /> : <AcademicPrompt avatarMap={{}} avatarMapReady={false} avatarPathOverride={source.question_source === "custom" ? resolveCustomAcademicDiscussionAvatar((source.question as AcademicDiscussionQuestion).professor_avatar_type, "professor") : undefined} question={source.question as AcademicDiscussionQuestion} />}
        </div>
        <div className="flex min-h-[650px] min-w-0 flex-col gap-2 overflow-hidden lg:min-h-0">
          {attempt.task_type === "email" ? <EmailResponseHeader question={source.question as EmailQuestion} /> : <AcademicStudentResponses avatarMap={{}} avatarMapReady={false} customAvatars={source.question_source === "custom"} question={source.question as AcademicDiscussionQuestion} />}
          <WritingRevisionEditor key={editorGeneration} initialState={revision} onChange={setRevision} onReady={handle => { editorHandle.current = handle; }} disabled={busy} readOnly={locked} />
          {!submitted ? <WritingPracticeActions compact disabled={busy || conflict} onSave={!locked ? () => void save() : undefined} saveDisabled={!dirty} onSubmit={() => setSubmitOpen(true)} submitLabel={pendingSubmitVersion !== null ? "重试提交" : "提交订正"} /> : null}
          {previousLocalText !== null ? <details className="text-xs text-student-muted"><summary>读取前的本地正文（仅本页临时保留，可复制）</summary><p className="max-h-32 overflow-y-auto whitespace-pre-wrap select-text">{previousLocalText}</p></details> : null}
        </div>
      </div>
    </section>
    <section aria-labelledby="correction-tab-annotations" className="min-h-0 flex-1 overflow-y-auto" hidden={tab !== "annotations"} id="correction-annotations" role="tabpanel">
      <FrozenCorrectionAnnotations attempt={initialAttempt} />
    </section>
    {submitOpen ? <CorrectionDialog title="确认提交订正">
      <p className="text-sm leading-6">未保存修改会先保存，保存成功后再提交。提交后本次订正将锁定，不能继续编辑；之后可从原始作文新建另一份订正。</p>
      <div className="mt-4 flex justify-end gap-2"><button className="student-button-secondary" disabled={busy} onClick={() => setSubmitOpen(false)} type="button">取消</button><button className="student-button-primary" disabled={busy || conflict} onClick={() => void submit()} type="button">确认提交</button></div>
    </CorrectionDialog> : null}
    {reloadOpen ? <CorrectionDialog title="读取最新草稿前请保留当前正文">
      <p className="text-sm leading-6">确认后，编辑器会使用服务器最近保存的正文和版本。当前本地修改不会上传；请先复制下方正文。取消不会改变任何内容。</p>
      <textarea aria-label="读取前的本地正文" className="mt-3 h-40 w-full rounded-lg border p-3 text-sm" readOnly value={editor.text} />
      <div className="mt-4 flex justify-end gap-2"><button className="student-button-secondary" disabled={busy} onClick={() => setReloadOpen(false)} type="button">取消</button><button className="student-button-primary" disabled={busy} onClick={() => void reload()} type="button">确认读取并替换</button></div>
    </CorrectionDialog> : null}
    {exitHref ? <CorrectionDialog title="你有未保存的修改">
      <p className="mt-2 text-sm text-student-muted">离开前是否保存当前订正？未保存的修改不会在刷新后恢复。</p>
      <div className="mt-6 grid gap-2 sm:grid-cols-3">
        <button className="student-button-secondary" disabled={busy} onClick={() => setExitHref(null)} type="button">取消</button>
        <button className="student-button-secondary" disabled={busy} onClick={() => router.push(exitHref)} type="button">放弃修改</button>
        <button className="student-button-primary" disabled={busy || conflict} onClick={() => { const href = exitHref; setExitHref(null); void save(href); }} type="button">保存并退出</button>
      </div>
    </CorrectionDialog> : null}
  </div>;
}

function FrozenCorrectionAnnotations({ attempt }: { attempt: WritingAttempt }) {
  const source = useMemo(() => frozenWritingCorrectionSource(attempt), [attempt]);
  const review = useMemo(() => correctionAnnotations(attempt), [attempt]);
  const items = useMemo(() => orderedPublishedReviewItems(review), [review]);
  const composition = useMemo(() => buildWritingRevisionComposition(source.original_response_text, review.language_edits, review.content_feedback.items), [source, review]);
  const segments = useMemo(() => buildWorkspaceAnnotationSegments(source.original_response_text, review.language_edits, review.content_feedback.items), [source, review]);
  const [selectedId, setSelectedId] = useState(items[0]?.id ?? null);
  const [filter, setFilter] = useState<"all" | "language_edit" | "content_feedback">("all");
  const selected = items.find((item) => item.id === selectedId);
  function selectMarker(id: string) {
    setSelectedId(id);
    const item = items.find((candidate) => candidate.id === id);
    if (item) setFilter(item.kind);
  }
  return <div className="mx-auto grid h-full max-w-[1920px] gap-2.5 p-2.5 lg:grid-cols-[minmax(0,2fr)_minmax(340px,1fr)]">
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-student-border bg-white shadow-[0_2px_12px_rgba(60,47,119,0.05)]">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-student-border px-4 py-2.5"><h2 className="font-bold">原稿批注</h2><ReviewMarkerLegend /></div>
      <article className="min-h-[360px] flex-1 overflow-y-auto px-5 py-3.5 text-[15px] leading-7 sm:text-base lg:min-h-0"><WritingRevisionMarkedText composition={composition} markerSegments={segments} selectedId={selectedId} onSelectLanguageEdit={(edit) => selectMarker(edit.edit_id)} onSelectContentFeedback={selectMarker} /></article>
    </section>
    <aside className="min-h-0 min-w-0 overflow-y-auto rounded-xl border border-student-border bg-white p-3 shadow-[0_2px_12px_rgba(60,47,119,0.05)]">
      <div className="mb-3 flex gap-4 overflow-x-auto border-b border-student-border">{([ ["all", "全部批改"], ["language_edit", "语言错误修改"], ["content_feedback", "内容反馈"] ] as const).map(([value, label]) => <ReviewTabButton active={filter === value} key={value} onClick={() => { setFilter(value); setSelectedId(publishedReviewItemsForTab(items, value)[0]?.id ?? null); }}>{label}（{publishedReviewItemsForTab(items, value).length}）</ReviewTabButton>)}</div>
      <h2 className="text-sm font-bold">当前批改详情</h2>
      {selected ? <PublishedReviewDetail item={selected} /> : <p className="text-sm text-student-muted">暂无已发布批注。</p>}
    </aside>
  </div>;
}

function CorrectionDialog({ title, children }: { title: string; children: React.ReactNode }) {
  return <ModalShell open containFocus dismissible={false} label={title} onClose={() => {}}>
    <h2 className="mb-3 text-base font-bold text-student-text">{title}</h2>{children}
  </ModalShell>;
}
