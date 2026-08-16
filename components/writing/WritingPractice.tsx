"use client";

import {
  ClipboardPaste,
  Clock3,
  DoorOpen,
  List,
  Save,
  Scissors,
  Send,
  Undo2,
  Redo2,
  RotateCcw,
  ArrowLeft
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent
} from "react";
import { createBrowserSupabase } from "@/lib/supabase/client";
import {
  STUDENT_ACADEMIC_DISCUSSION_AVATARS_CACHE_KEY,
  STUDENT_PRACTICE_HISTORY_CACHE_PREFIX,
  STUDENT_WRITING_CACHE_PREFIX,
  useStudentCachedData,
  useStudentDataCache,
} from "@/components/StudentDataCache";
import {
  loadAcademicDiscussionAvatars,
  type AcademicDiscussionAvatarMap,
  type AcademicDiscussionAvatarsPayload
} from "@/lib/academicDiscussionAvatars";
import {
  AcademicPrompt,
  AcademicStudentPost,
  EmailPrompt
} from "@/components/writing/WritingQuestionPrompt";
import {
  WRITING_TASK_CONFIG,
  countEnglishWords,
  formatWritingTimer,
  writingElapsedSeconds,
  type AcademicDiscussionQuestion,
  type EmailQuestion,
  type WritingAttempt,
  type WritingMode,
  type WritingOvertimeRange,
  type WritingQuestion,
  type WritingTaskType
} from "@/lib/writing";
import { normalizeWritingOvertimeRanges, updateWritingOvertimeRanges } from "@/lib/writingOvertime";
import { WritingOvertimeText } from "@/components/writing/WritingOvertimeText";
import { writingReviewResultHref } from "@/lib/studentNavigation";
import {
  applyExternalWritingPaste,
  canUseExternalWritingPaste
} from "@/lib/writingEditorPaste";

type PracticePayload = {
  attempt?: WritingAttempt;
  question?: WritingQuestion;
  has_published_review?: boolean;
  error?: string;
};

const EMPTY_ACADEMIC_DISCUSSION_AVATAR_MAP: AcademicDiscussionAvatarMap = {};

export function WritingPractice({
  attemptId,
  forceNew,
  mode = "practice",
  questionId,
  taskType
}: {
  attemptId?: string;
  forceNew?: boolean;
  mode?: "practice" | "readonly";
  questionId?: string;
  taskType: WritingTaskType;
}) {
  const router = useRouter();
  const [selectedWritingMode, setSelectedWritingMode] = useState<WritingMode | null>(null);
  const [payload, setPayload] = useState<PracticePayload | null>(null);
  const [accessToken, setAccessToken] = useState("");
  const [allowExternalPaste, setAllowExternalPaste] = useState(false);
  const [error, setError] = useState("");
  const avatarState = useStudentCachedData<AcademicDiscussionAvatarsPayload>(
    STUDENT_ACADEMIC_DISCUSSION_AVATARS_CACHE_KEY,
    loadAcademicDiscussionAvatars,
    { enabled: taskType === "academic_discussion" }
  );

  useEffect(() => {
    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
    };
  }, []);

  useEffect(() => {
    let ignore = false;
    async function load() {
      try {
        if (mode === "readonly" && !attemptId) {
          throw new Error("缺少要查看的提交记录。");
        }
        if (mode === "practice" && !attemptId && !questionId) {
          throw new Error("缺少写作题目。");
        }
        if (mode === "practice" && !attemptId && !selectedWritingMode) return;
        const supabase = createBrowserSupabase();
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token ?? "";
        if (!token) throw new Error("登录状态已失效，请重新登录。");
        const response = attemptId
          ? await fetch(`/api/writing/attempts/${encodeURIComponent(attemptId)}${
              mode === "readonly" ? "?mode=submission" : ""
            }`, {
              cache: "no-store",
              headers: { Authorization: `Bearer ${token}` }
            })
          : await fetch("/api/writing/attempts", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`
              },
              body: JSON.stringify({
                forceNew: Boolean(forceNew),
                questionId,
                taskType,
                writingMode: selectedWritingMode
              })
            });
        const result = (await response.json()) as PracticePayload;
        if (!response.ok || result.error || !result.attempt || !result.question) {
          throw new Error(result.error ?? "无法进入写作练习。");
        }
        if (
          result.attempt.task_type !== taskType ||
          (questionId && result.attempt.question_id !== questionId)
        ) {
          throw new Error("写作记录与当前题目不匹配。");
        }
        if (mode === "readonly" && result.attempt.status !== "submitted") {
          throw new Error("只能查看已提交的写作记录。");
        }
        if (!ignore) {
          setAccessToken(token);
          setAllowExternalPaste(
            canUseExternalWritingPaste(data.session?.user.email, taskType)
          );
          setPayload(result);
          if (!attemptId && result.attempt.status === "draft") {
            router.replace(
              `${WRITING_TASK_CONFIG[taskType].practiceHref}/${encodeURIComponent(
                result.attempt.question_id
              )}?attempt=${encodeURIComponent(result.attempt.attempt_id)}`
            );
          }
        }
      } catch (loadError) {
        if (!ignore) setError(loadError instanceof Error ? loadError.message : "无法进入写作练习。");
      }
    }
    void load();
    return () => {
      ignore = true;
    };
  }, [attemptId, forceNew, mode, questionId, router, selectedWritingMode, taskType]);

  if (mode === "practice" && !attemptId && !selectedWritingMode) {
    return (
      <WritingModeChoice
        onCancel={() => router.back()}
        onSelect={setSelectedWritingMode}
        taskType={taskType}
      />
    );
  }

  if (error) {
    return <PracticeMessage title="无法进入练习" description={error} />;
  }
  if (!payload?.attempt || !payload.question || !accessToken) {
    return <PracticeMessage title="正在准备练习" description="正在加载题目和草稿..." />;
  }

  return (
    <WritingPracticeSession
      accessToken={accessToken}
      allowExternalPaste={allowExternalPaste}
      avatarMap={
        avatarState.data?.avatars ?? EMPTY_ACADEMIC_DISCUSSION_AVATAR_MAP
      }
      avatarMapReady={Boolean(avatarState.data)}
      attempt={payload.attempt}
      readOnly={mode === "readonly"}
      reviewPublished={payload.has_published_review === true}
      question={payload.question}
      taskType={taskType}
    />
  );
}

function WritingPracticeSession({
  accessToken,
  allowExternalPaste,
  avatarMap,
  avatarMapReady,
  attempt: initialAttempt,
  readOnly: requestedReadOnly,
  reviewPublished,
  question,
  taskType
}: {
  accessToken: string;
  allowExternalPaste: boolean;
  avatarMap: AcademicDiscussionAvatarMap;
  avatarMapReady: boolean;
  attempt: WritingAttempt;
  readOnly: boolean;
  reviewPublished: boolean;
  question: WritingQuestion;
  taskType: WritingTaskType;
}) {
  const router = useRouter();
  const cache = useStudentDataCache();
  const [attempt, setAttempt] = useState(initialAttempt);
  const [remainingSeconds, setRemainingSeconds] = useState(() =>
    requestedReadOnly || initialAttempt.status === "submitted"
      ? initialAttempt.remaining_seconds
      : initialRemainingSeconds(initialAttempt)
  );
  const answerMode: WritingMode = initialAttempt.writing_mode === "practice" ? "practice" : "exam";
  const [elapsedSeconds, setElapsedSeconds] = useState(() =>
    initialAttempt.status === "submitted"
      ? initialAttempt.elapsed_seconds ?? 0
      : writingElapsedSeconds(initialAttempt.started_at)
  );
  const [lastSavedText, setLastSavedText] = useState(initialAttempt.response_text);
  const [lastSavedRanges, setLastSavedRanges] = useState(() =>
    normalizeWritingOvertimeRanges(initialAttempt.overtime_ranges, initialAttempt.response_text.length)
  );
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [exitPromptOpen, setExitPromptOpen] = useState(false);
  const submitStartedRef = useRef(false);
  const remainingRef = useRef(remainingSeconds);
  const elapsedRef = useRef(elapsedSeconds);
  const textRef = useRef(initialAttempt.response_text);
  const overtimeRangesRef = useRef(lastSavedRanges);
  const editor = useWritingEditor(
    initialAttempt.response_text,
    lastSavedRanges,
    (text, ranges) => {
      textRef.current = text;
      overtimeRangesRef.current = ranges;
    },
    () =>
      answerMode === "practice" &&
      writingElapsedSeconds(initialAttempt.started_at) >=
        initialAttempt.time_limit_seconds,
    allowExternalPaste
  );
  const dirty = editor.text !== lastSavedText || JSON.stringify(editor.overtimeRanges) !== JSON.stringify(lastSavedRanges);
  const listHref = `${WRITING_TASK_CONFIG[taskType].listHref}/${question.year_month}`;
  const retakeHref = `${WRITING_TASK_CONFIG[taskType].practiceHref}/${encodeURIComponent(
    question.question_id
  )}?new=1`;
  const readOnly = requestedReadOnly || attempt.status === "submitted";
  const reviewHref = reviewPublished
    ? writingReviewResultHref(
        attempt.attempt_id,
        `${WRITING_TASK_CONFIG[taskType].submissionHref}/${encodeURIComponent(attempt.attempt_id)}`
      )
    : undefined;

  useEffect(() => {
    remainingRef.current = remainingSeconds;
  }, [remainingSeconds]);

  useEffect(() => {
    elapsedRef.current = elapsedSeconds;
  }, [elapsedSeconds]);

  useEffect(() => {
    if (readOnly || attempt.status !== "draft") return;
    const updateTimer = () => {
      const elapsed = writingElapsedSeconds(attempt.started_at);
      setElapsedSeconds(elapsed);
      if (answerMode === "exam") {
        setRemainingSeconds(
          Math.min(attempt.remaining_seconds, Math.max(0, attempt.time_limit_seconds - elapsed))
        );
      }
    };
    updateTimer();
    const timer = window.setInterval(updateTimer, 250);
    return () => window.clearInterval(timer);
  }, [answerMode, attempt.remaining_seconds, attempt.started_at, attempt.status, attempt.time_limit_seconds, readOnly]);

  const requestUpdate = useCallback(
    async (
      action: "sync" | "save" | "submit",
      options?: { keepalive?: boolean; responseText?: string }
    ) => {
      const response = await fetch(`/api/writing/attempts/${encodeURIComponent(attempt.attempt_id)}`, {
        method: "PATCH",
        cache: "no-store",
        keepalive: options?.keepalive,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          action,
          elapsedSeconds: elapsedRef.current,
          overtimeRanges: overtimeRangesRef.current,
          remainingSeconds: remainingRef.current,
          responseText: options?.responseText ?? textRef.current
        })
      });
      const result = (await response.json()) as { attempt?: WritingAttempt; error?: string };
      if (!response.ok || result.error || !result.attempt) {
        throw new Error(result.error ?? "写作记录保存失败。");
      }
      return result.attempt;
    },
    [accessToken, attempt.attempt_id]
  );

  useEffect(() => {
    if (readOnly || attempt.status !== "draft") return;
    const sync = window.setInterval(() => {
      void requestUpdate("sync").catch(() => undefined);
    }, 8000);
    return () => window.clearInterval(sync);
  }, [attempt.status, readOnly, requestUpdate]);

  useEffect(() => {
    if (readOnly || attempt.status !== "draft") return;
    const onPageHide = () => {
      void requestUpdate("sync", { keepalive: true }).catch(() => undefined);
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [attempt.status, dirty, readOnly, requestUpdate]);

  const invalidateWritingData = useCallback(() => {
    cache.invalidate(STUDENT_WRITING_CACHE_PREFIX);
    cache.invalidate(STUDENT_PRACTICE_HISTORY_CACHE_PREFIX);
  }, [cache]);

  const saveDraft = useCallback(async () => {
    setSaving(true);
    setError("");
    try {
      const savedAttempt = await requestUpdate("save", { responseText: textRef.current });
      setAttempt(savedAttempt);
      setLastSavedText(textRef.current);
      setLastSavedRanges([...overtimeRangesRef.current]);
      setMessage("草稿已保存");
      invalidateWritingData();
      window.setTimeout(() => setMessage(""), 2200);
      return true;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "草稿保存失败。");
      return false;
    } finally {
      setSaving(false);
    }
  }, [invalidateWritingData, requestUpdate]);

  const submit = useCallback(
    async (automatic = false) => {
      if (submitStartedRef.current || attempt.status !== "draft") return;
      submitStartedRef.current = true;
      setSubmitting(true);
      setError("");
      try {
        const submittedAttempt = await requestUpdate("submit", { responseText: textRef.current });
        setAttempt(submittedAttempt);
        setLastSavedText(textRef.current);
        setLastSavedRanges([...overtimeRangesRef.current]);
        invalidateWritingData();
        setMessage(automatic ? "时间到，答案已自动提交" : "提交成功");
        router.replace(
          `${WRITING_TASK_CONFIG[taskType].submissionHref}/${encodeURIComponent(
            submittedAttempt.attempt_id
          )}`
        );
      } catch (submitError) {
        submitStartedRef.current = false;
        setError(submitError instanceof Error ? submitError.message : "提交失败。");
      } finally {
        setSubmitting(false);
      }
    }, [attempt.status, invalidateWritingData, requestUpdate, router, taskType]
  );

  useEffect(() => {
    if (answerMode === "exam" && !readOnly && attempt.status === "draft" && remainingSeconds === 0) void submit(true);
  }, [answerMode, attempt.status, readOnly, remainingSeconds, submit]);

  async function leavePractice(saveChanges: boolean) {
    setExitPromptOpen(false);
    if (saveChanges && dirty) {
      const saved = await saveDraft();
      if (!saved) return;
    } else {
      try {
        await requestUpdate("sync");
      } catch {
        // pagehide will make one final best-effort sync as navigation starts.
      }
    }
    router.push(listHref);
  }

  function requestExit() {
    if (readOnly) {
      router.push(listHref);
    } else if (dirty) {
      setExitPromptOpen(true);
    } else {
      void leavePractice(false);
    }
  }

  function requestManualSubmit() {
    if (
      window.confirm("确定提交本次写作吗？\n提交后本次作答将不能继续修改。")
    ) {
      void submit(false);
    }
  }

  return (
    <div className="writing-practice h-[100dvh] overflow-hidden bg-[#fbfbfe] text-student-text">
      <WritingPracticeHeader
        answerMode={answerMode}
        elapsedSeconds={elapsedSeconds}
        onBack={requestExit}
        onExit={requestExit}
        readOnly={readOnly}
        remainingSeconds={remainingSeconds}
        setTitle={question.set_title}
      />
      <main className="mx-auto flex h-[calc(100dvh-76px)] min-h-0 max-w-[1560px] flex-col overflow-hidden px-4 py-3 sm:px-6 lg:px-8">
        <div className="grid h-full min-h-0 grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-4 overflow-hidden">
          {taskType === "email" ? (
            <EmailPrompt question={question as EmailQuestion} />
          ) : (
            <AcademicPrompt
              avatarMap={avatarMap}
              avatarMapReady={avatarMapReady}
              question={question as AcademicDiscussionQuestion}
            />
          )}
          <section className="h-full min-h-0 overflow-hidden">
            {taskType === "email" ? (
              <EmailResponsePanel
                actions={editor}
                disabled={saving || submitting}
                listHref={listHref}
                onSave={() => void saveDraft()}
                onSubmit={requestManualSubmit}
                question={question as EmailQuestion}
                readOnly={readOnly}
                reviewHref={reviewHref}
                retakeHref={retakeHref}
                wordCount={readOnly ? attempt.word_count : undefined}
              />
            ) : (
              <AcademicResponsePanel
                actions={editor}
                avatarMap={avatarMap}
                avatarMapReady={avatarMapReady}
                disabled={saving || submitting}
                listHref={listHref}
                onSave={() => void saveDraft()}
                onSubmit={requestManualSubmit}
                question={question as AcademicDiscussionQuestion}
                readOnly={readOnly}
                reviewHref={reviewHref}
                retakeHref={retakeHref}
                wordCount={readOnly ? attempt.word_count : undefined}
              />
            )}
          </section>
        </div>
      </main>
      {message ? <WritingToast tone="success" text={message} /> : null}
      {error ? <WritingToast tone="error" text={error} /> : null}
      {!readOnly && exitPromptOpen ? (
        <ExitPrompt
          onCancel={() => setExitPromptOpen(false)}
          onDiscard={() => void leavePractice(false)}
          onSave={() => void leavePractice(true)}
          saving={saving}
        />
      ) : null}
    </div>
  );
}

function WritingPracticeHeader({
  answerMode,
  elapsedSeconds,
  onBack,
  onExit,
  readOnly,
  reviewHref,
  remainingSeconds,
  setTitle
}: {
  answerMode: WritingMode;
  elapsedSeconds: number;
  onBack: () => void;
  onExit: () => void;
  readOnly: boolean;
  reviewHref?: string;
  remainingSeconds: number;
  setTitle: string;
}) {
  return (
    <header className="grid h-[76px] grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 border-b border-student-border bg-white px-4 sm:px-7 lg:px-10">
      <button className="writing-header-back justify-self-start" onClick={onBack} type="button">
        <ArrowLeft aria-hidden="true" size={20} strokeWidth={2.2} />
        <span>Back</span>
      </button>
      <span className="inline-flex min-h-11 items-center justify-self-center rounded-xl border border-student-primary-border bg-student-primary-soft px-4 text-sm font-bold text-student-primary">
        {setTitle}
      </span>
      <div className="flex items-center justify-self-end gap-3">
        {readOnly ? (
          <span className="inline-flex min-h-9 items-center whitespace-nowrap rounded-xl border border-student-primary-border bg-white px-3 text-xs font-bold text-student-primary">
            已提交 · 只读
          </span>
        ) : null}
        <div className="hidden min-h-[54px] items-center gap-3 rounded-xl border border-student-primary-border bg-student-primary-soft px-4 text-student-primary sm:flex">
          <Clock3 aria-hidden="true" size={20} />
          <div className="text-center">
            <p className="text-[10px] font-semibold uppercase tracking-[0.08em]">
              {answerMode === "practice" ? "Elapsed" : "Time Left"}
            </p>
            <p className="font-mono text-lg font-bold leading-5 tabular-nums text-student-text">
              {formatWritingTimer(answerMode === "practice" ? elapsedSeconds : remainingSeconds)}
            </p>
          </div>
        </div>
        <button className="writing-exit-button" onClick={onExit} type="button">
          <DoorOpen aria-hidden="true" size={19} />
          <span className="hidden sm:inline">Exit Practice</span>
        </button>
      </div>
    </header>
  );
}

type EditorActions = ReturnType<typeof useWritingEditor>;

function EmailResponsePanel({
  actions,
  disabled,
  listHref,
  onSave,
  onSubmit,
  question,
  readOnly,
  reviewHref,
  retakeHref,
  wordCount
}: {
  actions: EditorActions;
  disabled: boolean;
  listHref: string;
  onSave: () => void;
  onSubmit: () => void;
  question: EmailQuestion;
  readOnly: boolean;
  reviewHref?: string;
  retakeHref: string;
  wordCount?: number;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden">
      <div className="shrink-0 rounded-2xl border border-student-border bg-white px-5 py-3 shadow-[0_1px_2px_rgba(23,32,51,0.025)]">
        <h2 className="font-bold text-student-primary">Your Response:</h2>
        <p className="mt-3 text-[15px] leading-[1.45]"><strong className="mr-3">To:</strong>{question.recipient}</p>
        <p className="mt-2 text-[15px] leading-[1.45]"><strong className="mr-3">Subject:</strong>{question.subject}</p>
      </div>
      <WritingEditor
        actions={actions}
        compact
        disabled={disabled}
        readOnly={readOnly}
        wordCount={wordCount}
      />
      {readOnly ? (
        <WritingReadonlyActions listHref={listHref} retakeHref={retakeHref} reviewHref={reviewHref} />
      ) : (
        <WritingPracticeActions compact disabled={disabled} onSave={onSave} onSubmit={onSubmit} />
      )}
    </div>
  );
}

function AcademicResponsePanel({
  actions,
  avatarMap,
  avatarMapReady,
  disabled,
  listHref,
  onSave,
  onSubmit,
  question,
  readOnly,
  reviewHref,
  retakeHref,
  wordCount
}: {
  actions: EditorActions;
  avatarMap: AcademicDiscussionAvatarMap;
  avatarMapReady: boolean;
  disabled: boolean;
  listHref: string;
  onSave: () => void;
  onSubmit: () => void;
  question: AcademicDiscussionQuestion;
  readOnly: boolean;
  reviewHref?: string;
  retakeHref: string;
  wordCount?: number;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden">
      <div className="max-h-[55%] min-h-0 shrink-0 overflow-y-auto rounded-2xl border border-student-border bg-white px-6">
        <AcademicStudentPost
          avatarMap={avatarMap}
          avatarMapReady={avatarMapReady}
          name={question.student_1_name}
          response={question.student_1_response}
        />
        <div className="h-px bg-student-border" />
        <AcademicStudentPost
          avatarMap={avatarMap}
          avatarMapReady={avatarMapReady}
          name={question.student_2_name}
          response={question.student_2_response}
        />
      </div>
      <WritingEditor
        actions={actions}
        compact
        disabled={disabled}
        readOnly={readOnly}
        wordCount={wordCount}
      />
      {readOnly ? (
        <WritingReadonlyActions listHref={listHref} retakeHref={retakeHref} reviewHref={reviewHref} />
      ) : (
        <WritingPracticeActions compact disabled={disabled} onSave={onSave} onSubmit={onSubmit} />
      )}
    </div>
  );
}

function WritingEditor({
  actions,
  compact = false,
  disabled,
  readOnly = false,
  wordCount
}: {
  actions: EditorActions;
  compact?: boolean;
  disabled: boolean;
  readOnly?: boolean;
  wordCount?: number;
}) {
  return (
    <div
      className={`flex flex-col overflow-hidden rounded-2xl border border-student-primary-border bg-white focus-within:border-student-primary focus-within:shadow-[0_0_0_3px_rgba(107,92,246,0.1)] ${
        compact ? "min-h-0 flex-1" : "h-full min-h-[360px]"
      }`}
    >
      <WritingEditorToolbar
        actions={actions}
        compact={compact}
        disabled={disabled || readOnly}
        wordCount={wordCount}
      />
      <div className="relative min-h-0 flex-1 overflow-hidden bg-white">
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-student-text ${
            compact ? "px-4 py-3 text-[15px] leading-[1.45]" : "px-5 py-4 text-base leading-7"
          }`}
          ref={actions.mirrorRef}
        >
          <WritingOvertimeText ranges={actions.overtimeRanges} text={actions.text} />
          {actions.text.endsWith("\n") ? "\u200b" : null}
        </div>
        <textarea
          aria-label="Writing response"
          autoCapitalize="sentences"
          autoComplete="off"
          className={`absolute inset-0 h-full w-full resize-none border-0 bg-transparent text-transparent caret-[#172033] outline-none selection:bg-violet-200/70 ${
            compact ? "px-4 py-3 text-[15px] leading-[1.45]" : "px-5 py-4 text-base leading-7"
          }`}
          disabled={disabled}
          onBeforeInput={readOnly ? undefined : actions.onBeforeInput}
          onCut={readOnly ? preventReadonlyClipboardEvent : actions.onCut}
          onDrop={readOnly ? undefined : actions.onDrop}
          onInput={readOnly ? undefined : actions.onChange}
          onKeyDown={readOnly ? preventReadonlyEditingShortcut : actions.onKeyDown}
          onPaste={readOnly ? preventReadonlyClipboardEvent : actions.onPaste}
          onScroll={actions.onScroll}
          onSelect={readOnly ? undefined : actions.onSelect}
          readOnly={readOnly}
          ref={actions.textareaRef}
          spellCheck={false}
          value={actions.text}
        />
      </div>
    </div>
  );
}

function preventReadonlyClipboardEvent(event: ClipboardEvent<HTMLTextAreaElement>) {
  event.preventDefault();
}

function preventReadonlyEditingShortcut(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (!(event.metaKey || event.ctrlKey)) return;
  if (["v", "x", "y", "z"].includes(event.key.toLocaleLowerCase())) {
    event.preventDefault();
  }
}

function WritingEditorToolbar({
  actions,
  compact,
  disabled,
  wordCount
}: {
  actions: EditorActions;
  compact: boolean;
  disabled: boolean;
  wordCount?: number;
}) {
  return (
    <div
      className={`flex items-center border-b border-student-primary-border bg-student-primary-soft/45 text-student-primary ${
        compact
          ? "h-10 min-h-10 flex-nowrap gap-0 px-2 py-0"
          : "min-h-[64px] flex-wrap gap-1 px-3 py-2 sm:gap-2 sm:px-4"
      }`}
    >
      <EditorButton compact={compact} disabled={disabled || !actions.text} icon={Scissors} label="Cut" onClick={actions.cut} />
      <EditorButton compact={compact} disabled={disabled || !actions.internalClipboard} icon={ClipboardPaste} label="Paste" onClick={actions.pasteInternal} />
      <EditorButton compact={compact} disabled={disabled || !actions.canUndo} icon={Undo2} label="Undo" onClick={actions.undo} />
      <EditorButton compact={compact} disabled={disabled || !actions.canRedo} icon={Redo2} label="Redo" onClick={actions.redo} />
      <div className={`ml-auto flex shrink-0 items-center whitespace-nowrap font-semibold ${compact ? "gap-1.5 px-2 text-[13px]" : "gap-2 px-2 text-sm"}`}>
        <List aria-hidden="true" size={compact ? 16 : 18} />
        <span>Word Count</span>
        <span className="min-w-6 text-right tabular-nums text-student-text">
          {wordCount ?? actions.wordCount}
        </span>
      </div>
    </div>
  );
}

function EditorButton({
  compact,
  disabled,
  icon: Icon,
  label,
  onClick
}: {
  compact: boolean;
  disabled: boolean;
  icon: typeof Scissors;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`inline-flex items-center rounded-lg font-semibold transition hover:bg-white disabled:pointer-events-none disabled:opacity-35 ${
        compact
          ? "min-h-8 gap-1.5 px-2 text-[13px]"
          : "min-h-10 gap-2 px-3 text-sm"
      }`}
      disabled={disabled}
      onClick={onClick}
      onMouseDown={(event) => event.preventDefault()}
      type="button"
    >
      <Icon aria-hidden="true" size={compact ? 16 : 18} />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

function WritingPracticeActions({
  compact = false,
  disabled,
  onSave,
  onSubmit
}: {
  compact?: boolean;
  disabled: boolean;
  onSave: () => void;
  onSubmit: () => void;
}) {
  return (
    <div
      className={`flex shrink-0 items-center justify-end gap-3 ${
        compact ? "px-0 py-1" : "px-4 py-4 sm:px-5"
      }`}
    >
      <button className="writing-action-secondary" disabled={disabled} onClick={onSave} type="button">
        <Save aria-hidden="true" size={19} />
        Save Draft
      </button>
      <button className="writing-action-primary" disabled={disabled} onClick={onSubmit} type="button">
        <Send aria-hidden="true" size={19} />
        Submit
      </button>
    </div>
  );
}

function WritingReadonlyActions({
  listHref,
  retakeHref,
  reviewHref
}: {
  listHref: string;
  retakeHref: string;
  reviewHref?: string;
}) {
  const router = useRouter();
  return (
    <div className="flex shrink-0 items-center justify-end gap-3 px-0 py-1">
      {reviewHref ? (
        <button
          className="writing-action-primary"
          onClick={() => router.push(reviewHref)}
          type="button"
        >
          <List aria-hidden="true" size={19} />
          查看批改
        </button>
      ) : null}
      <button
        className="writing-action-secondary"
        onClick={() => router.push(listHref)}
        type="button"
      >
        <List aria-hidden="true" size={19} />
        返回题目列表
      </button>
      <button
        className={reviewHref ? "writing-action-secondary" : "writing-action-primary"}
        onClick={() => router.push(retakeHref)}
        type="button"
      >
        <RotateCcw aria-hidden="true" size={19} />
        重新练习
      </button>
    </div>
  );
}

type EditorSnapshot = {
  overtimeRanges: WritingOvertimeRange[];
  selectionEnd: number;
  selectionStart: number;
  text: string;
};

function useWritingEditor(
  initialText: string,
  initialRanges: WritingOvertimeRange[],
  onTextChange: (text: string, ranges: WritingOvertimeRange[]) => void,
  isOvertime: () => boolean,
  allowExternalPaste: boolean
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const [history, setHistory] = useState<{ current: EditorSnapshot; future: EditorSnapshot[]; past: EditorSnapshot[] }>(() => ({
    current: {
      overtimeRanges: initialRanges,
      selectionEnd: initialText.length,
      selectionStart: initialText.length,
      text: initialText
    },
    future: [],
    past: []
  }));
  const [internalClipboard, setInternalClipboard] = useState("");
  const [selection, setSelection] = useState({ end: initialText.length, start: initialText.length });
  const currentText = history.current.text;
  const currentRanges = history.current.overtimeRanges;

  const focusSelection = useCallback((start: number, end = start) => {
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(start, end);
      setSelection({ start, end });
    });
  }, []);

  const commit = useCallback(
    (snapshot: EditorSnapshot) => {
      setHistory((value) => ({
        current: snapshot,
        future: [],
        past: [...value.past, value.current].slice(-250)
      }));
      onTextChange(snapshot.text, snapshot.overtimeRanges);
      focusSelection(snapshot.selectionStart, snapshot.selectionEnd);
    },
    [focusSelection, onTextChange]
  );

  const undo = useCallback(() => {
    setHistory((value) => {
      const previous = value.past[value.past.length - 1];
      if (!previous) return value;
      onTextChange(previous.text, previous.overtimeRanges);
      focusSelection(previous.selectionStart, previous.selectionEnd);
      return {
        current: previous,
        future: [value.current, ...value.future],
        past: value.past.slice(0, -1)
      };
    });
  }, [focusSelection, onTextChange]);

  const redo = useCallback(() => {
    setHistory((value) => {
      const next = value.future[0];
      if (!next) return value;
      onTextChange(next.text, next.overtimeRanges);
      focusSelection(next.selectionStart, next.selectionEnd);
      return {
        current: next,
        future: value.future.slice(1),
        past: [...value.past, value.current]
      };
    });
  }, [focusSelection, onTextChange]);

  const cut = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea || textarea.selectionStart === textarea.selectionEnd) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    setInternalClipboard(currentText.slice(start, end));
    commit({
      overtimeRanges: updateWritingOvertimeRanges({
        nextText: currentText.slice(0, start) + currentText.slice(end),
        overtime: false,
        previousRanges: currentRanges,
        previousText: currentText
      }),
      text: currentText.slice(0, start) + currentText.slice(end),
      selectionStart: start,
      selectionEnd: start
    });
  }, [commit, currentRanges, currentText]);

  const pasteInternal = useCallback(() => {
    if (!internalClipboard) return;
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? selection.start;
    const end = textarea?.selectionEnd ?? selection.end;
    const cursor = start + internalClipboard.length;
    const nextText = currentText.slice(0, start) + internalClipboard + currentText.slice(end);
    commit({
      overtimeRanges: updateWritingOvertimeRanges({
        nextText,
        overtime: isOvertime(),
        previousRanges: currentRanges,
        previousText: currentText
      }),
      text: nextText,
      selectionStart: cursor,
      selectionEnd: cursor
    });
  }, [commit, currentRanges, currentText, internalClipboard, isOvertime, selection.end, selection.start]);

  function onChange(event: FormEvent<HTMLTextAreaElement>) {
    const target = event.currentTarget;
    commit({
      overtimeRanges: updateWritingOvertimeRanges({
        nextText: target.value,
        overtime: isOvertime(),
        previousRanges: currentRanges,
        previousText: currentText
      }),
      text: target.value,
      selectionStart: target.selectionStart,
      selectionEnd: target.selectionEnd
    });
  }

  function onSelect(event: FormEvent<HTMLTextAreaElement>) {
    setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd });
  }

  function onScroll(event: FormEvent<HTMLTextAreaElement>) {
    if (!mirrorRef.current) return;
    mirrorRef.current.scrollTop = event.currentTarget.scrollTop;
    mirrorRef.current.scrollLeft = event.currentTarget.scrollLeft;
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    event.preventDefault();
    if (!allowExternalPaste) return;
    const pastedText = event.clipboardData.getData("text/plain");
    if (!pastedText) return;
    const start = event.currentTarget.selectionStart;
    const end = event.currentTarget.selectionEnd;
    commit(
      applyExternalWritingPaste({
        currentText,
        end,
        overtime: isOvertime(),
        pastedText,
        previousRanges: currentRanges,
        start
      })
    );
  }

  function onCut(event: ClipboardEvent<HTMLTextAreaElement>) {
    event.preventDefault();
    cut();
  }

  function onDrop(event: React.DragEvent<HTMLTextAreaElement>) {
    event.preventDefault();
  }

  function onBeforeInput(event: FormEvent<HTMLTextAreaElement>) {
    const nativeEvent = event.nativeEvent as InputEvent;
    if (
      nativeEvent.inputType === "insertFromDrop" ||
      (nativeEvent.inputType === "insertFromPaste" && !allowExternalPaste)
    ) {
      event.preventDefault();
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!(event.metaKey || event.ctrlKey)) return;
    const key = event.key.toLocaleLowerCase();
    if (key === "v") {
      if (!allowExternalPaste) event.preventDefault();
      return;
    }
    if (key === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (key === "y") {
      event.preventDefault();
      redo();
    }
  }

  return {
    canRedo: history.future.length > 0,
    canUndo: history.past.length > 0,
    cut,
    hasSelection: selection.start !== selection.end,
    internalClipboard,
    mirrorRef,
    onBeforeInput,
    onChange,
    onCut,
    onDrop,
    onKeyDown,
    onPaste,
    onScroll,
    onSelect,
    pasteInternal,
    redo,
    textareaRef,
    text: history.current.text,
    overtimeRanges: history.current.overtimeRanges,
    undo,
    wordCount: countEnglishWords(history.current.text)
  };
}

function ExitPrompt({
  onCancel,
  onDiscard,
  onSave,
  saving
}: {
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-student-text/25 px-5" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-2xl border border-student-border bg-white p-6 shadow-2xl">
        <h2 className="text-xl font-bold">你有未保存的修改</h2>
        <p className="mt-2 text-sm leading-6 text-student-muted">离开前是否保存当前答案？倒计时剩余时间会保留。</p>
        <div className="mt-6 grid gap-2 sm:grid-cols-3">
          <button className="student-button-secondary" onClick={onCancel} type="button">取消</button>
          <button className="student-button-secondary" onClick={onDiscard} type="button">放弃修改</button>
          <button className="student-button-primary" disabled={saving} onClick={onSave} type="button">保存并退出</button>
        </div>
      </div>
    </div>
  );
}

function WritingToast({ tone, text }: { tone: "error" | "success"; text: string }) {
  return (
    <div className={`fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-xl border px-4 py-3 text-sm font-semibold shadow-lg ${
      tone === "error"
        ? "border-student-error-border bg-student-error-soft text-student-error"
        : "border-student-primary-border bg-white text-student-primary"
    }`} role="status">
      {text}
    </div>
  );
}

function PracticeMessage({ description, title }: { description: string; title: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#fbfbfe] px-5">
      <div className="student-card max-w-md text-center">
        <h1 className="text-xl font-bold">{title}</h1>
        <p className="mt-2 text-sm text-student-muted">{description}</p>
      </div>
    </div>
  );
}

function WritingModeChoice({
  onCancel,
  onSelect,
  taskType
}: {
  onCancel: () => void;
  onSelect: (mode: WritingMode) => void;
  taskType: WritingTaskType;
}) {
  const minutes = WRITING_TASK_CONFIG[taskType].timeLimitSeconds / 60;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-student-text/25 px-5" role="dialog" aria-modal="true" aria-labelledby="writing-mode-title">
      <div className="w-full max-w-lg rounded-2xl border border-student-border bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-student-text" id="writing-mode-title">选择练习模式</h1>
            <p className="mt-1 text-sm text-student-muted">选择后才会创建本次作答记录并开始计时。</p>
          </div>
          <button aria-label="取消" className="rounded-lg px-2 py-1 text-student-muted hover:bg-student-primary-soft" onClick={onCancel} type="button">×</button>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <button className="rounded-2xl border border-student-primary-border p-5 text-left transition hover:border-student-primary hover:bg-student-primary-soft/45" onClick={() => onSelect("exam")} type="button">
            <span className="block font-bold text-student-primary">模考模式</span>
            <span className="mt-2 block text-lg font-bold text-student-text">{minutes} 分钟</span>
            <span className="mt-1 block text-sm text-student-muted">按正式考试时间作答</span>
          </button>
          <button className="rounded-2xl border border-student-primary-border p-5 text-left transition hover:border-student-primary hover:bg-student-primary-soft/45" onClick={() => onSelect("practice")} type="button">
            <span className="block font-bold text-student-primary">练习模式</span>
            <span className="mt-2 block text-lg font-bold text-student-text">不限时</span>
            <span className="mt-1 block text-sm leading-6 text-student-muted">正计时 · {minutes} 分钟后新增内容标红</span>
          </button>
        </div>
        <button className="student-button-secondary mt-5 w-full justify-center" onClick={onCancel} type="button">取消</button>
      </div>
    </div>
  );
}

function initialRemainingSeconds(attempt: WritingAttempt) {
  return Math.min(
    attempt.remaining_seconds,
    Math.max(0, attempt.time_limit_seconds - writingElapsedSeconds(attempt.started_at))
  );
}
