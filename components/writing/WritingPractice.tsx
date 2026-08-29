"use client";

import {
  ClipboardPaste,
  Clock3,
  DoorOpen,
  List,
  Scissors,
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
  STUDENT_WRITING_OVERVIEW_CACHE_KEY,
  STUDENT_WRITING_MODE_POLICY_CACHE_KEY,
  STUDENT_WRITING_CACHE_PREFIX,
  studentWritingAttemptCacheKey,
  useStudentCachedData,
  useStudentDataCache,
} from "@/components/StudentDataCache";
import {
  loadAcademicDiscussionAvatars,
  resolveCustomAcademicDiscussionAvatar,
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
import type { StudentWritingModeAvailability } from "@/lib/writingModePolicy";
import { calculateActiveWritingTimer } from "@/lib/writingTimer";
import { publishCacheInvalidation } from "@/lib/cacheInvalidation";
import {
  logStudentPerformance,
  measureStudentRequest
} from "@/lib/studentPerformance.client";
import { WritingPracticeActions } from "@/components/writing/WritingPracticeActions";

type PracticePayload = {
  assignment_available?: boolean;
  attempt?: WritingAttempt;
  question?: WritingQuestion;
  display_name?: string;
  has_published_review?: boolean;
  question_source?: "question_bank" | "custom";
  error?: string;
};

const EMPTY_ACADEMIC_DISCUSSION_AVATAR_MAP: AcademicDiscussionAvatarMap = {};
const submittedReadonlyStarts = new Map<string, number>();

export function WritingPractice({
  assignmentId,
  attemptId,
  forceNew,
  mode = "practice",
  questionId,
  taskType
}: {
  assignmentId?: string;
  attemptId?: string;
  forceNew?: boolean;
  mode?: "practice" | "readonly";
  questionId?: string;
  taskType: WritingTaskType;
}) {
  const router = useRouter();
  const { getEntry } = useStudentDataCache();
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
  const modePolicyState = useStudentCachedData<StudentWritingModeAvailability>(
    STUDENT_WRITING_MODE_POLICY_CACHE_KEY,
    loadWritingModePolicy,
    { enabled: mode === "practice" && !attemptId }
  );
  const cachedReadonlyEntry =
    mode === "readonly" && attemptId
      ? getEntry(studentWritingAttemptCacheKey(attemptId))
      : undefined;
  const cachedReadonlyPayload =
    cachedReadonlyEntry?.status === "success"
      ? cachedReadonlyEntry.data as PracticePayload
      : null;

  useEffect(() => {
    if (mode === "readonly" && attemptId) {
      logStudentPerformance({ event: "readonly_render_start", attemptId, source: cachedReadonlyPayload ? "submitted_attempt_cache" : "api_reload" });
    }
  }, [attemptId, cachedReadonlyPayload, mode]);

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
        if (cachedReadonlyPayload) {
          if (!ignore) setPayload(cachedReadonlyPayload);
          return;
        }
        const supabase = createBrowserSupabase();
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token ?? "";
        if (!token) throw new Error("登录状态已失效，请重新登录。");
        const detailUrl = attemptId
          ? `/api/writing/attempts/${encodeURIComponent(attemptId)}${
              mode === "readonly" ? "?mode=submission" : ""
            }`
          : "/api/writing/attempts";
        const response = await measureStudentRequest(
          `${attemptId ? "GET" : "POST"} ${detailUrl}`,
          async (captureResponse) => {
            const detailResponse = attemptId
              ? await fetch(detailUrl, {
                  cache: "no-store",
                  headers: { Authorization: `Bearer ${token}` }
                })
              : await fetch(detailUrl, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`
                  },
                  body: JSON.stringify({
                    assignmentId,
                    forceNew: Boolean(forceNew),
                    questionId,
                    taskType,
                    writingMode: selectedWritingMode
                  })
                });
            captureResponse(detailResponse);
            return detailResponse;
          }
        );
        const result = (await response.json()) as PracticePayload;
        if (!response.ok || result.error || !result.attempt || !result.question) {
          throw new Error(result.error ?? "无法进入写作练习。");
        }
        if (
          result.attempt.task_type !== taskType ||
          (questionId && result.attempt.question_id !== questionId) ||
          (assignmentId && result.attempt.assignment_id !== assignmentId)
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
            publishCacheInvalidation({
              type: "WRITING_DRAFT_UPDATED",
              studentId: result.attempt.user_id,
              attemptId: result.attempt.attempt_id,
              assignmentId: result.attempt.assignment_id ?? null
            });
            router.replace(
              assignmentId
                ? `/student/assignments/${encodeURIComponent(assignmentId)}?attempt=${encodeURIComponent(result.attempt.attempt_id)}`
                : `${WRITING_TASK_CONFIG[taskType].practiceHref}/${encodeURIComponent(
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
  }, [
    assignmentId,
    attemptId,
    cachedReadonlyPayload,
    forceNew,
    mode,
    questionId,
    router,
    selectedWritingMode,
    taskType
  ]);

  useEffect(() => {
    if (
      mode !== "readonly" ||
      !attemptId ||
      payload?.attempt?.status !== "submitted"
    ) {
      return;
    }
    const startedAt = submittedReadonlyStarts.get(attemptId);
    if (startedAt === undefined) return;
    submittedReadonlyStarts.delete(attemptId);
    logStudentPerformance({
      event: "writing_readonly_ready",
      source: cachedReadonlyPayload ? "submitted_attempt_cache" : "api_reload",
      totalMs: Math.round((performance.now() - startedAt) * 10) / 10
    });
  }, [accessToken, attemptId, cachedReadonlyPayload, mode, payload?.attempt?.status]);

  if (mode === "practice" && !attemptId && !selectedWritingMode) {
    if (modePolicyState.loading) {
      return <PracticeMessage title="正在准备练习" description="正在加载可用写作模式..." />;
    }
    if (modePolicyState.error || !modePolicyState.data) {
      return <PracticeMessage title="无法进入练习" description={modePolicyState.error || "无法加载可用写作模式。"} />;
    }
    return (
      <WritingModeChoice
        availability={modePolicyState.data}
        onCancel={() => router.back()}
        onSelect={setSelectedWritingMode}
        taskType={taskType}
      />
    );
  }

  if (error) {
    return <PracticeMessage title="无法进入练习" description={error} />;
  }
  if (!payload?.attempt || !payload.question || (!accessToken && mode !== "readonly")) {
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
      assignmentAvailable={payload.assignment_available !== false}
      assignmentQuestionSource={payload.question_source}
      attempt={payload.attempt}
      displayName={payload.display_name}
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
  assignmentAvailable,
  assignmentQuestionSource,
  attempt: initialAttempt,
  displayName,
  readOnly: requestedReadOnly,
  reviewPublished,
  question,
  taskType
}: {
  accessToken: string;
  allowExternalPaste: boolean;
  avatarMap: AcademicDiscussionAvatarMap;
  avatarMapReady: boolean;
  assignmentAvailable: boolean;
  assignmentQuestionSource?: "question_bank" | "custom";
  attempt: WritingAttempt;
  displayName?: string;
  readOnly: boolean;
  reviewPublished: boolean;
  question: WritingQuestion;
  taskType: WritingTaskType;
}) {
  const router = useRouter();
  const { invalidate, setData } = useStudentDataCache();
  const [attempt, setAttempt] = useState(initialAttempt);
  const [remainingSeconds, setRemainingSeconds] = useState(() =>
    initialAttempt.remaining_seconds
  );
  const answerMode: WritingMode = initialAttempt.writing_mode === "practice" ? "practice" : "exam";
  const [elapsedSeconds, setElapsedSeconds] = useState(() =>
    initialAttempt.elapsed_seconds ?? 0
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
  const submittingRef = useRef(false);
  const remainingRef = useRef(remainingSeconds);
  const elapsedRef = useRef(elapsedSeconds);
  const sessionStartedAtRef = useRef(Date.now());
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
      elapsedRef.current >= initialAttempt.time_limit_seconds,
    allowExternalPaste
  );
  const dirty = editor.text !== lastSavedText || JSON.stringify(editor.overtimeRanges) !== JSON.stringify(lastSavedRanges);
  const listHref = initialAttempt.assignment_id
    ? "/student/assignments"
    : WRITING_TASK_CONFIG[taskType].listHref;
  const retakeHref = initialAttempt.assignment_id
    ? assignmentAvailable
      ? `/student/assignments/${encodeURIComponent(initialAttempt.assignment_id)}?new=1`
      : undefined
    : `${WRITING_TASK_CONFIG[taskType].practiceHref}/${encodeURIComponent(
        question.question_id
      )}?new=1`;
  const readOnly = requestedReadOnly || attempt.status === "submitted";
  const reviewHref = reviewPublished
    ? writingReviewResultHref(
        attempt.attempt_id,
        `${WRITING_TASK_CONFIG[taskType].submissionHref}/${encodeURIComponent(attempt.attempt_id)}`
      )
    : undefined;

  const readActiveTimer = useCallback(() => {
    if (readOnly || attempt.status !== "draft") {
      return {
        elapsedSeconds: elapsedRef.current,
        remainingSeconds: remainingRef.current
      };
    }
    const snapshot = calculateActiveWritingTimer({
      persistedElapsedSeconds: initialAttempt.elapsed_seconds,
      persistedRemainingSeconds: initialAttempt.remaining_seconds,
      sessionStartedAtMs: sessionStartedAtRef.current,
      writingMode: answerMode
    });
    elapsedRef.current = snapshot.elapsedSeconds;
    remainingRef.current = snapshot.remainingSeconds;
    return snapshot;
  }, [answerMode, attempt.status, initialAttempt.elapsed_seconds, initialAttempt.remaining_seconds, readOnly]);
  const updateActiveTimer = useCallback(() => {
    const snapshot = readActiveTimer();
    setElapsedSeconds(snapshot.elapsedSeconds);
    setRemainingSeconds(snapshot.remainingSeconds);
    return snapshot;
  }, [readActiveTimer]);

  useEffect(() => {
    if (readOnly || attempt.status !== "draft") return;
    updateActiveTimer();
    const timer = window.setInterval(updateActiveTimer, 250);
    return () => window.clearInterval(timer);
  }, [attempt.status, readOnly, updateActiveTimer]);

  const requestUpdate = useCallback(
    async (
      action: "sync" | "save" | "submit",
      options?: { keepalive?: boolean; responseText?: string }
    ) => {
      const timerSnapshot = readActiveTimer();
      const detailUrl = `/api/writing/attempts/${encodeURIComponent(attempt.attempt_id)}`;
      if (action === "submit") logStudentPerformance({ event: "patch_request_start", attemptId: attempt.attempt_id });
      const response = await measureStudentRequest(
        `PATCH ${detailUrl} (${action})`,
        async (captureResponse) => {
          const updateResponse = await fetch(detailUrl, {
            method: "PATCH",
            cache: "no-store",
            keepalive: options?.keepalive,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${accessToken}`
            },
            body: JSON.stringify({
              action,
              elapsedSeconds: timerSnapshot.elapsedSeconds,
              overtimeRanges: overtimeRangesRef.current,
              remainingSeconds: timerSnapshot.remainingSeconds,
              responseText: options?.responseText ?? textRef.current
            })
          });
          captureResponse(updateResponse);
          return updateResponse;
        }
      );
      const result = (await response.json()) as { attempt?: WritingAttempt; error?: string };
      if (action === "submit") logStudentPerformance({ event: "patch_request_complete", attemptId: attempt.attempt_id });
      if (!response.ok || result.error || !result.attempt) {
        throw new Error(result.error ?? "写作记录保存失败。");
      }
      return result.attempt;
    },
    [accessToken, attempt.attempt_id, readActiveTimer]
  );

  useEffect(() => {
    if (readOnly || submitting || attempt.status !== "draft") return;
    const sync = window.setInterval(() => {
      if (submittingRef.current) return;
      void requestUpdate("sync").catch(() => undefined);
    }, 8000);
    return () => window.clearInterval(sync);
  }, [attempt.status, readOnly, requestUpdate, submitting]);

  useEffect(() => {
    if (readOnly || attempt.status !== "draft") return;
    const onPageHide = () => {
      if (submittingRef.current) return;
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

  const persistOnUnmountRef = useRef(!readOnly && attempt.status === "draft");
  const requestUpdateRef = useRef(requestUpdate);
  useEffect(() => {
    persistOnUnmountRef.current = !readOnly && attempt.status === "draft";
    requestUpdateRef.current = requestUpdate;
  }, [attempt.status, readOnly, requestUpdate]);
  useEffect(
    () => () => {
      if (!persistOnUnmountRef.current || submittingRef.current) return;
      void requestUpdateRef.current("sync", { keepalive: true }).catch(() => undefined);
    },
    []
  );

  const invalidateWritingData = useCallback(() => {
    if (initialAttempt.assignment_id) {
      invalidate(STUDENT_WRITING_OVERVIEW_CACHE_KEY);
    } else {
      invalidate(STUDENT_WRITING_CACHE_PREFIX);
    }
    invalidate(STUDENT_PRACTICE_HISTORY_CACHE_PREFIX);
  }, [initialAttempt.assignment_id, invalidate]);

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
      publishCacheInvalidation({
        type: "WRITING_DRAFT_UPDATED",
        studentId: savedAttempt.user_id,
        attemptId: savedAttempt.attempt_id,
        assignmentId: savedAttempt.assignment_id ?? null
      });
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
      logStudentPerformance({ event: "submit_click", attemptId: attempt.attempt_id });
      submittingRef.current = true;
      const submitStartedAt = performance.now();
      setSubmitting(true);
      setError("");
      try {
        const submittedAttempt = await requestUpdate("submit", { responseText: textRef.current });
        persistOnUnmountRef.current = false;
        submittedReadonlyStarts.set(submittedAttempt.attempt_id, submitStartedAt);
        setAttempt(submittedAttempt);
        setLastSavedText(textRef.current);
        setLastSavedRanges([...overtimeRangesRef.current]);
        // Invalidation for standalone writing uses the broad "writing" prefix.
        // Run it before storing the readonly handoff so it cannot evict the
        // submitted payload that the destination page consumes.
        invalidateWritingData();
        setData(studentWritingAttemptCacheKey(submittedAttempt.attempt_id), {
          assignment_available: assignmentAvailable,
          attempt: submittedAttempt,
          display_name: displayName,
          has_published_review: false,
          question,
          question_source: assignmentQuestionSource
        } satisfies PracticePayload);
        logStudentPerformance({ event: "submitted_cache_write_complete", attemptId: submittedAttempt.attempt_id });
        publishCacheInvalidation({
          type: "WRITING_ATTEMPT_SUBMITTED",
          studentId: submittedAttempt.user_id,
          attemptId: submittedAttempt.attempt_id,
          assignmentId: submittedAttempt.assignment_id ?? null,
          taskType: submittedAttempt.task_type,
          questionId: submittedAttempt.question_id
        });
        setMessage(automatic ? "时间到，答案已自动提交" : "提交成功");
        router.replace(
          `${WRITING_TASK_CONFIG[taskType].submissionHref}/${encodeURIComponent(
            submittedAttempt.attempt_id
          )}`
        );
      } catch (submitError) {
        submitStartedRef.current = false;
        submittingRef.current = false;
        setError(submitError instanceof Error ? submitError.message : "提交失败。");
      } finally {
        setSubmitting(false);
      }
    }, [
      assignmentAvailable,
      assignmentQuestionSource,
      attempt.status,
      displayName,
      invalidateWritingData,
      question,
      requestUpdate,
      router,
      setData,
      taskType
    ]
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
        setTitle={displayName ?? question.set_title}
      />
      <main className="mx-auto flex h-[calc(100dvh-76px)] min-h-0 max-w-[1560px] flex-col overflow-hidden px-4 py-3 sm:px-6 lg:px-8">
        <div className="grid h-full min-h-0 grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-4 overflow-hidden">
          {taskType === "email" ? (
            <EmailPrompt question={question as EmailQuestion} />
          ) : (
            <AcademicPrompt
              avatarMap={avatarMap}
              avatarMapReady={avatarMapReady}
              avatarPathOverride={assignmentQuestionSource === "custom"
                ? resolveCustomAcademicDiscussionAvatar(
                    (question as AcademicDiscussionQuestion).professor_avatar_type,
                    "professor"
                  )
                : undefined}
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
                customAvatars={assignmentQuestionSource === "custom"}
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
  retakeHref?: string;
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
  customAvatars,
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
  customAvatars: boolean;
  disabled: boolean;
  listHref: string;
  onSave: () => void;
  onSubmit: () => void;
  question: AcademicDiscussionQuestion;
  readOnly: boolean;
  reviewHref?: string;
  retakeHref?: string;
  wordCount?: number;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden">
      <div className="max-h-[55%] min-h-0 shrink-0 overflow-y-auto rounded-2xl border border-student-border bg-white px-6">
        <AcademicStudentPost
          avatarMap={avatarMap}
          avatarMapReady={avatarMapReady}
          avatarPathOverride={customAvatars
            ? resolveCustomAcademicDiscussionAvatar(question.student_1_avatar_type, "student")
            : undefined}
          name={question.student_1_name}
          response={question.student_1_response}
        />
        <div className="h-px bg-student-border" />
        <AcademicStudentPost
          avatarMap={avatarMap}
          avatarMapReady={avatarMapReady}
          avatarPathOverride={customAvatars
            ? resolveCustomAcademicDiscussionAvatar(question.student_2_avatar_type, "student")
            : undefined}
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

function WritingReadonlyActions({
  listHref,
  retakeHref,
  reviewHref
}: {
  listHref: string;
  retakeHref?: string;
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
      {retakeHref ? (
        <button
          className={reviewHref ? "writing-action-secondary" : "writing-action-primary"}
          onClick={() => router.push(retakeHref)}
          type="button"
        >
          <RotateCcw aria-hidden="true" size={19} />
          重新练习
        </button>
      ) : null}
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
  availability,
  onCancel,
  onSelect,
  taskType
}: {
  availability: StudentWritingModeAvailability;
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
          {availability.mockModeEnabled ? (
            <button className="rounded-2xl border border-student-primary-border p-5 text-left transition hover:border-student-primary hover:bg-student-primary-soft/45" onClick={() => onSelect("exam")} type="button">
              <span className="block font-bold text-student-primary">模考模式</span>
              <span className="mt-2 block text-lg font-bold text-student-text">{minutes} 分钟</span>
              <span className="mt-1 block text-sm text-student-muted">按正式考试时间作答</span>
            </button>
          ) : null}
          {availability.practiceModeEnabled ? (
            <button className="rounded-2xl border border-student-primary-border p-5 text-left transition hover:border-student-primary hover:bg-student-primary-soft/45" onClick={() => onSelect("practice")} type="button">
              <span className="block font-bold text-student-primary">练习模式</span>
              <span className="mt-2 block text-lg font-bold text-student-text">不限时</span>
              <span className="mt-1 block text-sm leading-6 text-student-muted">正计时 · {minutes} 分钟后新增内容标红</span>
            </button>
          ) : null}
        </div>
        <button className="student-button-secondary mt-5 w-full justify-center" onClick={onCancel} type="button">取消</button>
      </div>
    </div>
  );
}

async function loadWritingModePolicy(session: { accessToken: string }) {
  const response = await fetch("/api/writing/mode-policy", {
    cache: "no-store",
    headers: { Authorization: `Bearer ${session.accessToken}` }
  });
  const payload = (await response.json()) as StudentWritingModeAvailability & {
    error?: string;
  };
  if (!response.ok || payload.error) {
    throw new Error(payload.error ?? "无法加载可用写作模式。");
  }
  return payload;
}
