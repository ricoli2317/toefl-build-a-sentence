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
  type MouseEvent,
  type ReactNode
} from "react";
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
import { resolveMirrorScrollTop, writingScrollbarWidth } from "@/lib/writingEditorScroll";
import { WritingOvertimeText } from "@/components/writing/WritingOvertimeText";
import {
  getWritingResultNavigation,
  safeStudentReturnTo,
  withStudentReturnTo,
  writingReviewResultHref,
  writingSubmissionResultHref
} from "@/lib/studentNavigation";
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
import {
  getWritingClientSession,
  refreshWritingClientSession,
  signOutWritingClientSession
} from "@/lib/writingClientSession";
import {
  isWritingSessionError,
  sendWritingRequestWithSession
} from "@/lib/writingRequestSession";
import {
  applyWritingRecoveryBackup,
  clearWritingRecoveryBackup,
  createWritingRecoveryBackup,
  getWritingRecoveryStorage,
  readWritingRecoveryBackup,
  writeWritingRecoveryBackup,
  writingRecoveryMatchesAttempt
} from "@/lib/writingRecovery";

type PracticePayload = {
  assignment_available?: boolean;
  attempt?: WritingAttempt;
  question?: WritingQuestion;
  /**
   * The resolver-produced display title (题目NNN + 小标题 / custom assignment
   * title). Every attempt API response carries it; it is the only title the
   * practice header renders — the historical question set_title is never a
   * fallback.
   */
  display_name: string;
  has_published_review?: boolean;
  question_source?: "question_bank" | "custom";
  error?: string;
};

const EMPTY_ACADEMIC_DISCUSSION_AVATAR_MAP: AcademicDiscussionAvatarMap = {};
const submittedReadonlyStarts = new Map<string, number>();
const WRITING_SESSION_DEPENDENCIES = {
  getSession: getWritingClientSession,
  refreshSession: refreshWritingClientSession
};

type SaveRecoveryState = {
  stage: "manual" | "backup";
  authRelated: boolean;
  busy: boolean;
  backupWriteFailed: boolean;
};

export function WritingPractice({
  assignmentId,
  attemptId,
  forceNew,
  mode = "practice",
  questionId,
  returnTo,
  taskType
}: {
  assignmentId?: string;
  attemptId?: string;
  forceNew?: boolean;
  mode?: "practice" | "readonly";
  questionId?: string;
  returnTo?: string;
  taskType: WritingTaskType;
}) {
  const router = useRouter();
  const { getEntry } = useStudentDataCache();
  const [selectedWritingMode, setSelectedWritingMode] = useState<WritingMode | null>(null);
  const [payload, setPayload] = useState<PracticePayload | null>(null);
  const [viewer, setViewer] = useState<{ email: string | null; studentId: string } | null>(null);
  const [recoveryApplied, setRecoveryApplied] = useState(false);
  const [blockedRecoveryText, setBlockedRecoveryText] = useState<string | null>(null);
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
    let loadedStudentId: string | null = null;
    async function revealUnavailableRecovery() {
      if (!attemptId) return;
      const backup = readWritingRecoveryBackup(getWritingRecoveryStorage(), attemptId);
      if (!backup) return;
      const studentId = loadedStudentId
        ?? (await getWritingClientSession())?.studentId
        ?? null;
      if (!studentId || backup.studentId !== studentId) return;
      if (!ignore) setBlockedRecoveryText(backup.text);
    }
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
        const detailUrl = attemptId
          ? `/api/writing/attempts/${encodeURIComponent(attemptId)}${
              mode === "readonly" ? "?mode=submission" : ""
            }`
          : "/api/writing/attempts";
        const { response, session } = await measureStudentRequest(
          `${attemptId ? "GET" : "POST"} ${detailUrl}`,
          async (captureResponse) =>
            sendWritingRequestWithSession(
              async (token) => {
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
              },
              WRITING_SESSION_DEPENDENCIES
            )
        );
        loadedStudentId = session.studentId;
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
          setViewer({ email: session.email, studentId: session.studentId });
          setAllowExternalPaste(
            canUseExternalWritingPaste(session.email, taskType)
          );
          let nextPayload = result;
          let nextRecoveryApplied = false;
          let nextBlockedRecoveryText: string | null = null;
          if (attemptId) {
            const backup = readWritingRecoveryBackup(getWritingRecoveryStorage(), attemptId);
            if (
              backup &&
              writingRecoveryMatchesAttempt({
                attempt: result.attempt,
                backup,
                studentId: session.studentId
              })
            ) {
              if (result.attempt.status === "draft") {
                nextPayload = {
                  ...result,
                  attempt: applyWritingRecoveryBackup(result.attempt, backup)
                };
                nextRecoveryApplied = true;
              } else {
                // A submitted / read-only attempt is never overwritten; the
                // backup stays in this tab and the editor offers a copy.
                nextBlockedRecoveryText = backup.text;
              }
            }
          }
          setRecoveryApplied(nextRecoveryApplied);
          setBlockedRecoveryText(nextBlockedRecoveryText);
          setPayload(nextPayload);
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
        if (ignore) return;
        setError(loadError instanceof Error ? loadError.message : "无法进入写作练习。");
        if (attemptId) void revealUnavailableRecovery();
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
  }, [viewer, attemptId, cachedReadonlyPayload, mode, payload?.attempt?.status]);

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
    return (
      <PracticeMessage title="无法进入练习" description={error}>
        {blockedRecoveryText ? <RecoveryCopyNotice text={blockedRecoveryText} /> : null}
      </PracticeMessage>
    );
  }
  if (!payload?.attempt || !payload.question || (!viewer && mode !== "readonly")) {
    return <PracticeMessage title="正在准备练习" description="正在加载题目和草稿..." />;
  }

  return (
    <WritingPracticeSession
      allowExternalPaste={allowExternalPaste}
      avatarMap={
        avatarState.data?.avatars ?? EMPTY_ACADEMIC_DISCUSSION_AVATAR_MAP
      }
      avatarMapReady={Boolean(avatarState.data)}
      assignmentAvailable={payload.assignment_available !== false}
      assignmentQuestionSource={payload.question_source}
      attempt={payload.attempt}
      blockedRecoveryText={blockedRecoveryText}
      displayName={payload.display_name}
      readOnly={mode === "readonly"}
      recoveryApplied={recoveryApplied}
      reviewPublished={payload.has_published_review === true}
      question={payload.question}
      returnTo={returnTo}
      taskType={taskType}
    />
  );
}

function WritingPracticeSession({
  allowExternalPaste,
  avatarMap,
  avatarMapReady,
  assignmentAvailable,
  assignmentQuestionSource,
  attempt: initialAttempt,
  blockedRecoveryText,
  displayName,
  readOnly: requestedReadOnly,
  recoveryApplied,
  reviewPublished,
  question,
  returnTo,
  taskType
}: {
  allowExternalPaste: boolean;
  avatarMap: AcademicDiscussionAvatarMap;
  avatarMapReady: boolean;
  assignmentAvailable: boolean;
  assignmentQuestionSource?: "question_bank" | "custom";
  attempt: WritingAttempt;
  blockedRecoveryText: string | null;
  displayName: string;
  readOnly: boolean;
  recoveryApplied: boolean;
  reviewPublished: boolean;
  question: WritingQuestion;
  returnTo?: string;
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
  const [saveRecovery, setSaveRecovery] = useState<SaveRecoveryState | null>(null);
  const [exitPromptOpen, setExitPromptOpen] = useState(false);
  const submitStartedRef = useRef(false);
  const submittingRef = useRef(false);
  const saveRecoveryBusyRef = useRef(false);
  const recoverySaveStartedRef = useRef(false);
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
    ? safeStudentReturnTo(returnTo) ?? "/student/assignments"
    : WRITING_TASK_CONFIG[taskType].listHref;
  const retakeHref = initialAttempt.assignment_id
    ? assignmentAvailable
      ? withStudentReturnTo(`/student/assignments/${encodeURIComponent(initialAttempt.assignment_id)}?new=1`, returnTo)
      : undefined
    : `${WRITING_TASK_CONFIG[taskType].practiceHref}/${encodeURIComponent(
        question.question_id
      )}?new=1`;
  const readOnly = requestedReadOnly || attempt.status === "submitted";
  const resultNavigation = getWritingResultNavigation(
    taskType,
    initialAttempt.assignment_id,
    requestedReadOnly ? returnTo : undefined
  );
  const exitHref = readOnly ? resultNavigation.backHref : listHref;
  const reviewHref = reviewPublished
    ? writingReviewResultHref(
        attempt.attempt_id,
        writingSubmissionResultHref(
          taskType,
          attempt.attempt_id,
          requestedReadOnly ? returnTo : undefined
        )
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

  /**
   * Silent background recovery failed. The first failure only arms the
   * persistent "重新连接并保存" prompt; a manual attempt that also fails moves
   * the student to the explicitly described backup/re-login resolution.
   */
  const markSaveFailure = useCallback((recoveryError: unknown) => {
    setSaveRecovery((current) =>
      current?.stage === "backup"
        ? current
        : {
            stage: "manual",
            authRelated: isWritingSessionError(recoveryError),
            busy: false,
            backupWriteFailed: false
          }
    );
  }, []);

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
      const responseText = options?.responseText ?? textRef.current;
      const { response } = await measureStudentRequest(
        `PATCH ${detailUrl} (${action})`,
        async (captureResponse) =>
          sendWritingRequestWithSession(
            async (token) => {
              const updateResponse = await fetch(detailUrl, {
                method: "PATCH",
                cache: "no-store",
                keepalive: options?.keepalive,
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({
                  action,
                  elapsedSeconds: timerSnapshot.elapsedSeconds,
                  overtimeRanges: overtimeRangesRef.current,
                  remainingSeconds: timerSnapshot.remainingSeconds,
                  responseText
                })
              });
              captureResponse(updateResponse);
              return updateResponse;
            },
            WRITING_SESSION_DEPENDENCIES
          )
      );
      const result = (await response.json()) as { attempt?: WritingAttempt; error?: string };
      if (action === "submit") logStudentPerformance({ event: "patch_request_complete", attemptId: attempt.attempt_id });
      if (!response.ok || result.error || !result.attempt) {
        throw new Error(result.error ?? "写作记录保存失败。");
      }
      return result.attempt;
    },
    [attempt.attempt_id, readActiveTimer]
  );

  useEffect(() => {
    if (readOnly || submitting || attempt.status !== "draft") return;
    const sync = window.setInterval(() => {
      if (submittingRef.current) return;
      const syncSnapshot = textRef.current;
      void requestUpdate("sync")
        .then(() => {
          if (syncSnapshot === textRef.current) {
            // The current text is confirmed on the server; a one-time recovery
            // backup from an earlier failed flow is now stale.
            clearWritingRecoveryBackup(getWritingRecoveryStorage(), attempt.attempt_id);
          }
          // The server confirmed the latest draft; any recovery prompt is stale.
          setSaveRecovery(null);
        })
        .catch((syncError) => {
          markSaveFailure(syncError);
        });
    }, 8000);
    return () => window.clearInterval(sync);
  }, [attempt.attempt_id, attempt.status, markSaveFailure, readOnly, requestUpdate, submitting]);

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

  const applySavedAttempt = useCallback(
    (savedAttempt: WritingAttempt, snapshotText: string) => {
      setAttempt(savedAttempt);
      setLastSavedText(snapshotText);
      setLastSavedRanges([...overtimeRangesRef.current]);
      if (snapshotText === textRef.current) {
        // The newest text is confirmed on the server, so the one-time recovery
        // backup for this attempt can be removed.
        clearWritingRecoveryBackup(getWritingRecoveryStorage(), savedAttempt.attempt_id);
      }
      invalidateWritingData();
      publishCacheInvalidation({
        type: "WRITING_DRAFT_UPDATED",
        studentId: savedAttempt.user_id,
        attemptId: savedAttempt.attempt_id,
        assignmentId: savedAttempt.assignment_id ?? null
      });
    },
    [invalidateWritingData]
  );

  const saveDraft = useCallback(async () => {
    setSaving(true);
    setError("");
    try {
      const snapshotText = textRef.current;
      const savedAttempt = await requestUpdate("save", { responseText: snapshotText });
      applySavedAttempt(savedAttempt, snapshotText);
      setSaveRecovery(null);
      setMessage("草稿已保存");
      window.setTimeout(() => setMessage(""), 2200);
      return true;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "草稿保存失败。");
      markSaveFailure(saveError);
      return false;
    } finally {
      setSaving(false);
    }
  }, [applySavedAttempt, markSaveFailure, requestUpdate]);

  // A page that was reloaded from the one-time backup first saves the restored
  // text to the original attempt. It never auto-submits: the student still
  // clicks Submit themselves.
  useEffect(() => {
    if (!recoveryApplied || readOnly || attempt.status !== "draft") return;
    if (recoverySaveStartedRef.current) return;
    recoverySaveStartedRef.current = true;
    const snapshotText = textRef.current;
    void (async () => {
      try {
        const savedAttempt = await requestUpdate("save", { responseText: snapshotText });
        applySavedAttempt(savedAttempt, snapshotText);
        setSaveRecovery(null);
        setMessage("已恢复未保存的正文");
        window.setTimeout(() => setMessage(""), 2600);
      } catch (restoreError) {
        // The backup stays in sessionStorage; the editor offers reconnect or
        // backup-and-relogin again.
        markSaveFailure(restoreError);
      }
    })();
  }, [applySavedAttempt, attempt.status, markSaveFailure, readOnly, recoveryApplied, requestUpdate]);

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
        // A successful submission is final: no recovery backup is needed.
        clearWritingRecoveryBackup(getWritingRecoveryStorage(), submittedAttempt.attempt_id);
        setSaveRecovery(null);
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
        router.replace(withStudentReturnTo(
          `${WRITING_TASK_CONFIG[taskType].submissionHref}/${encodeURIComponent(
            submittedAttempt.attempt_id
          )}`,
          returnTo
        ));
      } catch (submitError) {
        submitStartedRef.current = false;
        submittingRef.current = false;
        setError(submitError instanceof Error ? submitError.message : "提交失败。");
        if (isWritingSessionError(submitError)) markSaveFailure(submitError);
      } finally {
        setSubmitting(false);
      }
    }, [
      assignmentAvailable,
      assignmentQuestionSource,
      attempt.attempt_id,
      attempt.status,
      displayName,
      invalidateWritingData,
      markSaveFailure,
      question,
      requestUpdate,
      returnTo,
      router,
      setData,
      taskType
    ]
  );

  useEffect(() => {
    // A restored backup always saves the draft first: the student reviews the
    // recovered text and submits manually instead of being auto-submitted.
    if (recoveryApplied) return;
    if (answerMode === "exam" && !readOnly && attempt.status === "draft" && remainingSeconds === 0) void submit(true);
  }, [answerMode, attempt.status, readOnly, recoveryApplied, remainingSeconds, submit]);

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
    router.push(exitHref);
  }

  function requestExit() {
    if (readOnly) {
      router.push(exitHref);
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

  async function copyRecoveryText(text: string) {
    const copied = await copyWritingRecoveryText(text);
    if (copied) {
      setMessage("已复制全文到剪贴板");
      window.setTimeout(() => setMessage(""), 2200);
    } else {
      setError("复制失败，请手动全选并复制正文。");
    }
  }

  async function reconnectAndSave() {
    if (saveRecoveryBusyRef.current) return;
    saveRecoveryBusyRef.current = true;
    setSaveRecovery((current) => (current ? { ...current, busy: true } : current));
    try {
      const snapshotText = textRef.current;
      const savedAttempt = await requestUpdate("save", { responseText: snapshotText });
      applySavedAttempt(savedAttempt, snapshotText);
      setSaveRecovery(null);
      setMessage("草稿已保存");
      window.setTimeout(() => setMessage(""), 2200);
    } catch (recoveryError) {
      setSaveRecovery({
        stage: "backup",
        authRelated: isWritingSessionError(recoveryError),
        busy: false,
        backupWriteFailed: false
      });
    } finally {
      saveRecoveryBusyRef.current = false;
    }
  }

  async function backupAndRelogin() {
    const storage = getWritingRecoveryStorage();
    const timerSnapshot = readActiveTimer();
    const backup = createWritingRecoveryBackup({
      attemptId: attempt.attempt_id,
      studentId: attempt.user_id,
      taskType: attempt.task_type,
      assignmentId: attempt.assignment_id ?? null,
      questionId: attempt.question_id,
      text: textRef.current,
      overtimeRanges: overtimeRangesRef.current,
      elapsedSeconds: timerSnapshot.elapsedSeconds,
      remainingSeconds: timerSnapshot.remainingSeconds,
      savedAt: new Date().toISOString()
    });
    const stored = writeWritingRecoveryBackup(storage, backup);
    if (!stored) {
      setSaveRecovery((current) => ({
        stage: "backup",
        authRelated: current?.authRelated ?? false,
        busy: false,
        backupWriteFailed: true
      }));
      return;
    }
    await signOutWritingClientSession();
    const returnTo = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }

  const recoveryBanner = blockedRecoveryText ? (
    <WritingBlockedRecoveryBanner
      onCopy={() => void copyRecoveryText(blockedRecoveryText)}
    />
  ) : saveRecovery ? (
    <WritingRecoveryBanner
      onBackupRelogin={() => void backupAndRelogin()}
      onCopyLatest={() => void copyRecoveryText(textRef.current)}
      onReconnect={() => void reconnectAndSave()}
      state={saveRecovery}
    />
  ) : null;

  return (
    <div className="writing-practice min-h-[100dvh] bg-[#fbfbfe] text-student-text lg:h-[100dvh] lg:overflow-hidden">
      <WritingPracticeHeader
        answerMode={answerMode}
        elapsedSeconds={elapsedSeconds}
        onBack={requestExit}
        onExit={requestExit}
        readOnly={readOnly}
        remainingSeconds={remainingSeconds}
        setTitle={displayName}
      />
      <main className="mx-auto flex min-h-[calc(100dvh-76px)] w-full max-w-[1920px] flex-col px-4 py-3 sm:px-6 lg:h-[calc(100dvh-76px)] lg:min-h-0 lg:overflow-hidden lg:px-8">
        <div className="grid min-h-0 grid-cols-1 gap-4 lg:h-full lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:overflow-hidden">
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
          <section className="min-h-[650px] overflow-hidden lg:h-full lg:min-h-0">
            {taskType === "email" ? (
              <EmailResponsePanel
                actions={editor}
                disabled={saving || submitting}
                backHref={resultNavigation.backHref}
                backLabel={resultNavigation.backLabel}
                onSave={() => void saveDraft()}
                onSubmit={requestManualSubmit}
                question={question as EmailQuestion}
                readOnly={readOnly}
                recovery={recoveryBanner}
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
                backHref={resultNavigation.backHref}
                backLabel={resultNavigation.backLabel}
                onSave={() => void saveDraft()}
                onSubmit={requestManualSubmit}
                question={question as AcademicDiscussionQuestion}
                readOnly={readOnly}
                recovery={recoveryBanner}
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
    <header className="grid h-[76px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-b border-student-border bg-white px-3 sm:gap-4 sm:px-7 lg:px-10">
      <button className="writing-header-back justify-self-start" onClick={onBack} type="button">
        <ArrowLeft aria-hidden="true" size={20} strokeWidth={2.2} />
        <span className="hidden sm:inline">Back</span>
      </button>
      <span className="inline-flex min-h-11 min-w-0 max-w-full items-center justify-self-center truncate rounded-xl border border-student-primary-border bg-student-primary-soft px-3 text-sm font-bold text-student-primary sm:px-4">
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
  backHref,
  backLabel,
  disabled,
  onSave,
  onSubmit,
  question,
  readOnly,
  recovery,
  reviewHref,
  retakeHref,
  wordCount
}: {
  actions: EditorActions;
  backHref: string;
  backLabel: string;
  disabled: boolean;
  onSave: () => void;
  onSubmit: () => void;
  question: EmailQuestion;
  readOnly: boolean;
  recovery?: ReactNode;
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
        recovery={recovery}
        wordCount={wordCount}
      />
      {readOnly ? (
        <WritingReadonlyActions
          backHref={backHref}
          backLabel={backLabel}
          retakeHref={retakeHref}
          reviewHref={reviewHref}
        />
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
  backHref,
  backLabel,
  customAvatars,
  disabled,
  onSave,
  onSubmit,
  question,
  readOnly,
  recovery,
  reviewHref,
  retakeHref,
  wordCount
}: {
  actions: EditorActions;
  avatarMap: AcademicDiscussionAvatarMap;
  avatarMapReady: boolean;
  backHref: string;
  backLabel: string;
  customAvatars: boolean;
  disabled: boolean;
  onSave: () => void;
  onSubmit: () => void;
  question: AcademicDiscussionQuestion;
  readOnly: boolean;
  recovery?: ReactNode;
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
        recovery={recovery}
        wordCount={wordCount}
      />
      {readOnly ? (
        <WritingReadonlyActions
          backHref={backHref}
          backLabel={backLabel}
          retakeHref={retakeHref}
          reviewHref={reviewHref}
        />
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
  recovery,
  wordCount
}: {
  actions: EditorActions;
  compact?: boolean;
  disabled: boolean;
  readOnly?: boolean;
  recovery?: ReactNode;
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
      {recovery ? (
        <div
          className="shrink-0 border-b border-student-error-border bg-student-error-soft px-4 py-2.5 text-sm leading-6 text-student-error"
          role="status"
        >
          {recovery}
        </div>
      ) : null}
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
  backHref,
  backLabel,
  retakeHref,
  reviewHref
}: {
  backHref: string;
  backLabel: string;
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
        onClick={() => router.push(backHref)}
        type="button"
      >
        <List aria-hidden="true" size={19} />
        {backLabel}
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

  /**
   * Aligns the mirror with the textarea's real geometry. Two defects are
   * repaired here: the mirror takes over exactly the width a layout scrollbar
   * consumes (0 on overlay platforms, so no extra right gap appears), and the
   * scroll position is copied from the live textarea including each layer's
   * own maximum, with the bottom edge pinned so the visible end of the text
   * always matches the caret.
   */
  const syncMirror = useCallback(() => {
    const textarea = textareaRef.current;
    const mirror = mirrorRef.current;
    if (!textarea || !mirror) return;
    const scrollbarWidth = writingScrollbarWidth(textarea.offsetWidth, textarea.clientWidth);
    const desiredRight = scrollbarWidth > 0 ? `${scrollbarWidth}px` : "0px";
    if ((mirror.style.right || "0px") !== desiredRight) mirror.style.right = desiredRight;
    mirror.scrollTop = resolveMirrorScrollTop({
      textareaScrollTop: textarea.scrollTop,
      textareaScrollHeight: textarea.scrollHeight,
      textareaClientHeight: textarea.clientHeight,
      mirrorScrollHeight: mirror.scrollHeight,
      mirrorClientHeight: mirror.clientHeight
    });
    mirror.scrollLeft = textarea.scrollLeft;
  }, []);

  const focusSelection = useCallback((start: number, end = start) => {
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(start, end);
      setSelection({ start, end });
      // Restoring a selection can move the textarea's own scroll position
      // without a scroll event; re-align the mirror in the same frame.
      syncMirror();
    });
  }, [syncMirror]);

  // Synchronization points that do not emit a textarea scroll event: first
  // layout, container/viewport resizes (including a layout scrollbar appearing
  // or disappearing), and returning from a background tab or page cache.
  useEffect(() => {
    syncMirror();
    const textarea = textareaRef.current;
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => syncMirror());
    if (textarea) observer?.observe(textarea);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") syncMirror();
    };
    const onPageShow = () => syncMirror();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [syncMirror]);

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

  function onScroll() {
    syncMirror();
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

function PracticeMessage({
  children,
  description,
  title
}: {
  children?: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#fbfbfe] px-5">
      <div className="student-card max-w-md text-center">
        <h1 className="text-xl font-bold">{title}</h1>
        <p className="mt-2 text-sm text-student-muted">{description}</p>
        {children}
      </div>
    </div>
  );
}

function WritingRecoveryBanner({
  onBackupRelogin,
  onCopyLatest,
  onReconnect,
  state
}: {
  onBackupRelogin: () => void;
  onCopyLatest: () => void;
  onReconnect: () => void;
  state: SaveRecoveryState;
}) {
  const buttonClass = "inline-flex min-h-9 items-center justify-center rounded-lg border border-student-error-border bg-white px-3 text-sm font-semibold text-student-error transition hover:bg-student-error-soft disabled:opacity-60";
  if (state.stage === "manual") {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-[220px] flex-1">
          草稿暂未保存。当前作文仍保留在编辑器中，请点击“重新连接并保存”。
        </p>
        <button
          className={buttonClass}
          disabled={state.busy}
          onClick={onReconnect}
          type="button"
        >
          {state.busy ? "正在重新连接..." : "重新连接并保存"}
        </button>
      </div>
    );
  }
  return (
    <div className="grid gap-1.5">
      <p>
        当前作文尚未成功保存到服务器。你可以先备份作文，再重新登录并恢复，无需重新输入全文。
      </p>
      {state.authRelated ? null : (
        <p className="text-xs">
          当前故障可能不是登录状态引起的；重新登录后若仍无法保存，请稍后重试，并可用“复制全文”自行保管。
        </p>
      )}
      {state.backupWriteFailed ? (
        <p className="text-xs font-semibold">
          临时备份写入失败。请先点击“复制全文”保存到本地，再重新登录。
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          className={buttonClass}
          disabled={state.busy}
          onClick={onBackupRelogin}
          type="button"
        >
          {state.busy ? "正在准备..." : "备份并重新登录"}
        </button>
        <button className={buttonClass} onClick={onCopyLatest} type="button">
          复制全文
        </button>
      </div>
    </div>
  );
}

function WritingBlockedRecoveryBanner({ onCopy }: { onCopy: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <p className="min-w-[220px] flex-1">
        本标签页中还有一份未同步的备份正文。本次作答已提交，无法自动覆盖；可先复制全文保存。
      </p>
      <button
        className="inline-flex min-h-9 items-center justify-center rounded-lg border border-student-error-border bg-white px-3 text-sm font-semibold text-student-error transition hover:bg-student-error-soft"
        onClick={onCopy}
        type="button"
      >
        复制全文
      </button>
    </div>
  );
}

function RecoveryCopyNotice({ text }: { text: string }) {
  const [copyState, setCopyState] = useState<"copied" | "failed" | "idle">("idle");
  return (
    <div className="mt-4 grid gap-2 text-left">
      <p className="text-sm leading-6">
        本标签页中还有一份未同步的备份正文；当前作答记录无法访问（可能已提交或已删除）。你可以先复制全文保存。
      </p>
      <button
        className="student-button-secondary justify-center"
        onClick={() =>
          void copyWritingRecoveryText(text).then((copied) =>
            setCopyState(copied ? "copied" : "failed")
          )
        }
        type="button"
      >
        {copyState === "copied"
          ? "已复制全文"
          : copyState === "failed"
            ? "复制失败，请手动复制"
            : "复制全文"}
      </button>
    </div>
  );
}

async function copyWritingRecoveryText(text: string) {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the selection based copy.
  }
  try {
    const helper = document.createElement("textarea");
    helper.value = text;
    helper.setAttribute("readonly", "");
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.appendChild(helper);
    helper.select();
    const copied = document.execCommand("copy");
    helper.remove();
    return copied;
  } catch {
    return false;
  }
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
