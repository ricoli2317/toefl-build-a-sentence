"use client";

import { ArrowLeft, ChevronLeft, ChevronRight, DoorOpen } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { ReadingCorrectionAnswerValue } from "@/components/reading/ReadingCorrectionAnswerValue";
import { ReadingFullSetQuestionNavigator } from "@/components/reading/ReadingFullSetQuestionNavigator";
import {
  STUDENT_PRACTICE_HISTORY_CACHE_PREFIX,
  STUDENT_READING_HISTORY_CACHE_PREFIX,
  studentReadingCatalogCacheKey,
  useStudentCachedData,
  useStudentDataCache
} from "@/components/StudentDataCache";
import type { StudentCacheSession } from "@/components/StudentDataCache";
import { formatWritingTimer } from "@/lib/writing";
import {
  buildReadingSubmissionAnswers,
  isReadingAttemptSummary,
  type ReadingAttemptSummary
} from "@/lib/reading/attempts";
import {
  calculateReadingElapsedSeconds,
  backspaceCtwLetter,
  createCtwSlotAnswers,
  createReadingNavigation,
  deleteCtwLetter,
  enterCtwLetter,
  firstCtwPosition,
  moveReadingNavigation,
  setReadingAnswer,
  type CtwPosition,
  type CtwSlotAnswers,
  type ReadingAnswer,
  type ReadingAnswerState,
  type ReadingNavigationState
} from "@/lib/reading/practiceState";
import type {
  StudentChoiceOption,
  StudentCtwQuestion,
  StudentRdlQuestion,
  StudentRapHighlightRange,
  StudentRapQuestion,
  StudentReadingPracticePayload
} from "@/lib/reading/studentPractice";
import {
  calculateRdlContainRect,
  createRdlLookupRequest,
  flattenRdlCharacters,
  hitTestRdlCharacter,
  normalizeRdlSelectionRange,
  rdlSelectedCharacters,
  rdlSelectedText,
  rdlWordRangeAt,
  validateRdlImageBinding,
  type RdlContainRect,
  type RdlSelectionMap,
  type RdlSelectionRange
} from "@/lib/reading/rdlSelection";
import {
  insertionAnchorAtBoundary,
  isRapSentenceSelectable,
  rapSentenceSelectionInstruction,
  rapSentenceSelectionStem,
  rapVisibleHighlightRanges,
  validateRapInsertionAnchors,
  validateRapSentenceTarget
} from "@/lib/reading/rapInteraction";
import { rdlMaterialInstruction } from "@/lib/reading/materialTypes";
import {
  readingLookupEnabled,
  type ReadingPracticeMode
} from "@/lib/reading/lookupCapabilities";
import type {
  SubmittedReadingReviewItem,
  SubmittedReadingReviewPayload
} from "@/lib/reading/review";
import {
  readingCorrectionMarkState,
  type ReadingCorrectionAnswerPresentation
} from "@/lib/reading/correctionResult";
import {
  findReadingFullSetReviewIndex,
  type ReadingFullSetReviewPayload
} from "@/lib/reading/fullSetReview";
import { storeReadingQuestionTimes } from "@/lib/reading/resultSession";
import {
  readingWrongbookEditableSlotIds,
  selectReadingWrongbookSubmissionAnswers
} from "@/lib/reading/wrongbook";
import type { ReadingWrongbookTarget } from "@/lib/wrongQuestions";
import { invalidateStudentWrongbook } from "@/lib/studentCacheEvents";

type PracticeResponse = { practice?: StudentReadingPracticePayload; error?: string };
type AttemptResponse = { attempt?: ReadingAttemptSummary; error?: string };
type ReviewResponse = Partial<SubmittedReadingReviewPayload> & { error?: string };
type FullSetReviewResponse = Partial<ReadingFullSetReviewPayload> & { error?: string };

export const readingTwoColumnScaleStyle = {
  "--reading-scale-unit": "clamp(0.875px, min(calc(0.5px + 0.034722vw), calc(0.4px + 0.066667vh)), 1.12px)",
  fontSize: "var(--reading-scale-unit)",
  maxWidth: "1600em",
  paddingBottom: "12px",
  paddingLeft: "16em",
  paddingRight: "16em",
  paddingTop: "12px"
} as CSSProperties;

const readingTitleStyle = {
  fontSize: "24em",
  lineHeight: 4 / 3,
  padding: "1em 1.333333em 0.666667em"
} as CSSProperties;

const readingColumnStyle = {
  paddingBottom: "40em",
  paddingLeft: "32em",
  paddingRight: "32em",
  paddingTop: "12em"
} as CSSProperties;

const readingMaterialStageStyle = {
  paddingBottom: "28em",
  paddingLeft: "32em",
  paddingRight: "32em",
  paddingTop: "12em"
} as CSSProperties;

const readingQuestionTextStyle = {
  fontSize: "17em",
  lineHeight: 32 / 17
} as CSSProperties;

const readingChoiceListStyle = {
  gap: "24em",
  marginTop: "24em"
} as CSSProperties;

const readingChoiceStyle = {
  columnGap: `${12 / 17}em`,
  padding: `${10 / 17}em ${4 / 17}em`
} as CSSProperties;

const readingRadioStyle = {
  borderWidth: `${2 / 17}em`,
  height: `${20 / 17}em`,
  marginTop: `${5 / 17}em`,
  width: `${20 / 17}em`
} as CSSProperties;

const readingRadioDotStyle = {
  height: `${8 / 17}em`,
  width: `${8 / 17}em`
} as CSSProperties;

const readingPassageTextStyle = {
  fontSize: "17em",
  lineHeight: 28 / 17
} as CSSProperties;

const readingSpecialNoticeStyle = {
  fontSize: "14em",
  lineHeight: 12 / 7,
  marginTop: "2em",
  paddingBottom: `${20 / 14}em`,
  paddingTop: `${20 / 14}em`
} as CSSProperties;

const rapFramelessInteractionStyle = {
  appearance: "none",
  background: "transparent",
  border: 0,
  borderRadius: 0,
  boxShadow: "none",
  outline: "none",
  padding: 0,
  textDecoration: "none",
  WebkitAppearance: "none"
} as CSSProperties;

export function ReadingPractice({ itemId }: { itemId: string }) {
  const router = useRouter();
  const { invalidate } = useStudentDataCache();
  const [practice, setPractice] = useState<StudentReadingPracticePayload | null>(null);
  const [attempt, setAttempt] = useState<ReadingAttemptSummary | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const supabase = createBrowserSupabase();
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error("请先登录后再开始阅读练习。");
        const headers = {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json"
        };
        const [practiceResponse, attemptResponse] = await Promise.all([
          fetch(`/api/reading/practice/${encodeURIComponent(itemId)}`, {
            cache: "no-store",
            headers
          }),
          fetch("/api/reading/attempts", {
            method: "POST",
            cache: "no-store",
            headers,
            body: JSON.stringify({ logicalItemId: itemId })
          })
        ]);
        const result = await practiceResponse.json().catch(() => ({})) as PracticeResponse;
        const attemptResult = await attemptResponse.json().catch(() => ({})) as AttemptResponse;
        if (!practiceResponse.ok || !result.practice) {
          throw new Error(result.error ?? "阅读练习加载失败，请稍后重试。");
        }
        if (!attemptResponse.ok || !isReadingAttemptSummary(attemptResult.attempt)) {
          throw new Error(attemptResult.error ?? "阅读练习记录加载失败，请稍后重试。");
        }
        if (
          result.practice.item.itemId !== itemId
          || attemptResult.attempt.logicalItemId !== itemId
          || attemptResult.attempt.taskType !== result.practice.item.module
        ) {
          throw new Error("这个阅读练习暂时无法打开。");
        }
        if (!cancelled) {
          setPractice(result.practice);
          setAttempt(attemptResult.attempt);
          invalidate(studentReadingCatalogCacheKey(attemptResult.attempt.taskType));
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "阅读练习加载失败，请稍后重试。");
        }
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [invalidate, itemId]);

  if (error) {
    return (
      <ReadingPracticeMessage
        description={error}
        onLeave={() => router.push("/student/sets")}
        title="无法进入阅读练习"
      />
    );
  }
  if (!practice || !attempt) {
    return <ReadingPracticeMessage description="正在加载练习内容..." title="正在准备阅读练习" />;
  }
  return (
    <ReadingPracticeShell
      attempt={attempt}
      onBack={() => router.back()}
      onExit={() => router.push(`/student/reading/${practice.item.module}`)}
      practice={practice}
    />
  );
}

export function ReadingSubmittedReview({
  attemptId,
  initialQuestionIndex
}: {
  attemptId: string;
  initialQuestionIndex: number;
}) {
  const router = useRouter();
  const [review, setReview] = useState<SubmittedReadingReviewPayload | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const { data: { session } } = await createBrowserSupabase().auth.getSession();
        if (!session) throw new Error("请先登录后再查看阅读作答。");
        const response = await fetch(
          `/api/reading/attempts/${encodeURIComponent(attemptId)}/review`,
          {
            cache: "no-store",
            headers: { Authorization: `Bearer ${session.access_token}` }
          }
        );
        const payload = await response.json().catch(() => ({})) as ReviewResponse;
        if (
          !response.ok
          || payload.error
          || !payload.practice
          || !isReadingAttemptSummary(payload.attempt)
          || !payload.answers
          || !payload.disclosures
          || !Array.isArray(payload.reviewItems)
        ) {
          throw new Error(payload.error ?? "阅读作答加载失败，请稍后重试。");
        }
        if (payload.attempt.status !== "submitted" || payload.attempt.attemptId !== attemptId) {
          throw new Error("这次阅读作答暂时无法显示。");
        }
        if (!cancelled) {
          setReview({
            answers: payload.answers,
            attempt: payload.attempt,
            disclosures: payload.disclosures,
            practice: payload.practice,
            reviewItems: payload.reviewItems
          });
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "阅读作答加载失败，请稍后重试。");
        }
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [attemptId]);

  if (error) {
    return (
      <ReadingPracticeMessage
        description={error}
        onLeave={() => router.push(`/student/reading/results/${encodeURIComponent(attemptId)}`)}
        title="无法打开阅读作答"
      />
    );
  }
  if (!review) {
    return <ReadingPracticeMessage description="正在加载作答内容..." title="正在准备阅读作答" />;
  }
  return (
    <ReadingPracticeShell
      attempt={review.attempt}
      initialAnswers={review.answers}
      initialQuestionIndex={initialQuestionIndex}
      initialReviewIndex={initialQuestionIndex}
      mode="submitted_review"
      onBack={() => router.push(`/student/reading/results/${encodeURIComponent(attemptId)}`)}
      practice={review.practice}
      reviewDisclosureLabel="正确答案"
      reviewDisclosures={review.disclosures}
      reviewItems={review.reviewItems}
    />
  );
}

export function ReadingFullSetSubmittedReview({
  attemptId,
  fullSetId,
  questionIndex
}: {
  attemptId: string;
  fullSetId: string;
  questionIndex: number;
}) {
  const router = useRouter();
  const state = useStudentCachedData<ReadingFullSetReviewPayload>(
    `reading:full-sets:review:${attemptId}`,
    (session) => loadReadingFullSetReview(fullSetId, attemptId, session)
  );
  const resultHref = `/student/reading/full-sets/${encodeURIComponent(fullSetId)}/result/${encodeURIComponent(attemptId)}`;
  if (state.error) return <ReadingPracticeMessage description={state.error} onLeave={() => router.push(resultHref)} title="无法打开套题作答" />;
  if (state.loading || !state.data) return <ReadingPracticeMessage description="正在加载作答内容..." title="正在准备套题作答" />;
  return (
    <ReadingFullSetReviewShell
      initialSourceAnswerIndex={questionIndex}
      onBack={() => router.push(resultHref)}
      payload={state.data}
    />
  );
}

async function loadReadingFullSetReview(
  fullSetId: string,
  attemptId: string,
  session: StudentCacheSession
) {
  const response = await fetch(
    `/api/reading/full-sets/${encodeURIComponent(fullSetId)}/results/${encodeURIComponent(attemptId)}/review`,
    { cache: "no-store", headers: { Authorization: `Bearer ${session.accessToken}` } }
  );
  const result = await response.json().catch(() => ({})) as FullSetReviewResponse;
  if (
    !response.ok || result.error || !result.attempt || !result.disclosures
    || !Array.isArray(result.occurrences) || !Array.isArray(result.reviewItems)
  ) {
    throw new Error(result.error ?? "套题作答加载失败，请稍后重试。");
  }
  if (result.attempt.attemptId !== attemptId || result.attempt.fullSetId !== fullSetId) {
    throw new Error("这次套题作答暂时无法显示。");
  }
  return result as ReadingFullSetReviewPayload;
}

function ReadingFullSetReviewShell({
  initialSourceAnswerIndex,
  onBack,
  payload
}: {
  initialSourceAnswerIndex: number;
  onBack: () => void;
  payload: ReadingFullSetReviewPayload;
}) {
  const [activeIndex, setActiveIndex] = useState(() =>
    findReadingFullSetReviewIndex(payload.reviewItems, initialSourceAnswerIndex)
  );

  useEffect(() => {
    for (const occurrence of payload.occurrences) {
      const imageUrl = occurrence.practice.material?.imageUrl;
      if (imageUrl) {
        const image = new Image();
        image.src = imageUrl;
      }
    }
  }, [payload.occurrences]);

  useEffect(() => {
    const selectFromHistory = () => {
      const sourceIndex = Number(window.location.pathname.split("/").pop());
      if (Number.isInteger(sourceIndex) && sourceIndex >= 0) {
        setActiveIndex(findReadingFullSetReviewIndex(payload.reviewItems, sourceIndex));
      }
    };
    window.addEventListener("popstate", selectFromHistory);
    return () => window.removeEventListener("popstate", selectFromHistory);
  }, [payload.reviewItems]);

  const selectReviewItem = useCallback((index: number) => {
    const bounded = Math.max(0, Math.min(payload.reviewItems.length - 1, index));
    const target = payload.reviewItems[bounded];
    if (!target) return;
    setActiveIndex(bounded);
    if (target.href && window.location.pathname !== target.href) {
      window.history.pushState({ readingFullSetReviewIndex: bounded }, "", target.href);
    }
  }, [payload.reviewItems]);

  const currentItem = payload.reviewItems[activeIndex] ?? payload.reviewItems[0];
  const currentOccurrence = currentItem
    ? payload.occurrences.find((occurrence) => occurrence.occurrenceId === currentItem.occurrenceId)
    : null;
  const currentQuestion = currentOccurrence && currentItem
    ? currentOccurrence.practice.questions.find((question) => question.questionId === currentItem.questionId)
      ?? currentOccurrence.practice.questions[0]
    : null;

  if (!currentItem || !currentOccurrence || !currentQuestion) {
    return <ReadingPracticeMessage description="套题作答内容不完整。" onLeave={onBack} title="无法打开套题作答" />;
  }

  const activeSlotReview = currentItem.slotReviews.find(
    (item) => item.index === currentItem.sourceAnswerIndex
  );
  const workspaceReviewItems: SubmittedReadingReviewItem[] = currentItem.slotReviews;
  const selectedReviewItem = currentItem.taskType === "ctw"
    ? activeSlotReview ?? null
    : workspaceReviewItems[0] ?? null;
  const disclosure = selectedReviewItem
    ? payload.disclosures[selectedReviewItem.answerId]
    : undefined;
  const progressLabel = `Module ${currentItem.moduleNumber} · Question ${currentItem.orderStart} / ${currentItem.moduleNumber === 1 ? 35 : 15}`;

  return (
    <div className="min-h-[100dvh] bg-[#fbfbfe] text-student-text">
      <ReadingPracticeHeader
        elapsedSeconds={0}
        onBack={onBack}
        progressLabel={progressLabel}
        showElapsed={false}
        title={payload.attempt.title}
      />
      <main
        className="mx-auto min-h-[calc(100dvh-68px)]"
        style={readingTwoColumnScaleStyle}
      >
        <div className="mb-3">
          <ReadingFullSetQuestionNavigator
            currentIndex={activeIndex}
            items={payload.reviewItems}
            onSelect={selectReviewItem}
            showCurrentStatus
          >
            <ReadingAnswerDisclosure disclosure={disclosure} />
          </ReadingFullSetQuestionNavigator>
        </div>
        <ReadingQuestionViewport
          canGoNext={activeIndex < payload.reviewItems.length - 1}
          canGoPrevious={activeIndex > 0}
          module={currentOccurrence.practice.item.module}
          onNext={() => selectReviewItem(activeIndex + 1)}
          onPrevious={() => selectReviewItem(activeIndex - 1)}
          readOnly
        >
          <ReadingWorkspaceRouter
            answers={currentOccurrence.answers}
            currentQuestion={currentQuestion}
            lookupEnabled={readingLookupEnabled("submitted_review", currentOccurrence.practice.item.module)}
            onAnswerChange={() => undefined}
            practice={currentOccurrence.practice}
            readOnly
            reviewPresentation={disclosure}
            reviewItems={workspaceReviewItems}
            selectedReviewItem={selectedReviewItem}
          />
        </ReadingQuestionViewport>
      </main>
    </div>
  );
}

export function ReadingPracticeShell({
  attempt: initialAttempt,
  initialAnswers = {},
  initialQuestionIndex = 0,
  initialReviewIndex = 0,
  mode = "active",
  onBack,
  onExit,
  practice,
  reviewItems = [],
  reviewDisclosureLabel,
  reviewDisclosures = {},
  reviewTitle,
  wrongbook
}: {
  attempt: ReadingAttemptSummary;
  initialAnswers?: ReadingAnswerState;
  initialQuestionIndex?: number;
  initialReviewIndex?: number;
  mode?: ReadingPracticeMode;
  onBack: () => void;
  onExit?: () => void;
  practice: StudentReadingPracticePayload;
  reviewItems?: SubmittedReadingReviewItem[];
  reviewDisclosureLabel?: string;
  reviewDisclosures?: Record<string, ReadingCorrectionAnswerPresentation>;
  reviewTitle?: string;
  wrongbook?: {
    onSubmitted: (attempt: ReadingAttemptSummary) => void;
    targets: ReadingWrongbookTarget[];
  };
}) {
  const router = useRouter();
  const { invalidate } = useStudentDataCache();
  const sessionStartedAtRef = useRef(Date.now());
  const attempt = initialAttempt;
  const [elapsedSeconds, setElapsedSeconds] = useState(initialAttempt.elapsedSeconds);
  const readOnly = mode === "submitted_review";
  const lookupEnabled = readingLookupEnabled(mode, practice.item.module);
  const wrongbookTargets = wrongbook?.targets;
  const editableSlotIds = useMemo(
    () => wrongbookTargets ? readingWrongbookEditableSlotIds(wrongbookTargets) : undefined,
    [wrongbookTargets]
  );
  const [answers, setAnswers] = useState<ReadingAnswerState>(initialAnswers);
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [navigation, setNavigation] = useState<ReadingNavigationState>(() => {
    const created = createReadingNavigation(
      practice.item.module,
      practice.item.questionCount,
      practice.item.scoringPointCount
    );
    return {
      ...created,
      currentIndex: Math.max(0, Math.min(created.workspaceCount - 1, initialQuestionIndex))
    };
  });
  const [reviewIndex, setReviewIndex] = useState(() =>
    Math.max(0, Math.min(reviewItems.length - 1, initialReviewIndex))
  );
  const questionTimesRef = useRef<Record<string, number>>({});
  const activeQuestionIdRef = useRef(practice.questions[navigation.currentIndex]?.questionId ?? "");
  const questionStartedAtRef = useRef(Date.now());
  const updateElapsed = useCallback(() => {
    setElapsedSeconds(
      initialAttempt.elapsedSeconds
      + calculateReadingElapsedSeconds(sessionStartedAtRef.current)
    );
  }, [initialAttempt.elapsedSeconds]);

  useEffect(() => {
    if (readOnly || attempt.status === "submitted") return;
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 250);
    return () => window.clearInterval(timer);
  }, [attempt.status, readOnly, updateElapsed]);

  useEffect(() => {
    if (readOnly || attempt.status !== "submitted") return;
    router.replace(`/student/reading/results/${encodeURIComponent(attempt.attemptId)}`);
  }, [attempt.attemptId, attempt.status, readOnly, router]);

  const currentReviewItem = reviewItems[reviewIndex] ?? null;
  const reviewQuestionIndex = currentReviewItem
    ? practice.questions.findIndex((question) => question.questionId === currentReviewItem.questionId)
    : -1;
  const effectiveQuestionIndex = readOnly && reviewQuestionIndex >= 0
    ? reviewQuestionIndex
    : navigation.currentIndex;
  const currentQuestion = practice.questions[effectiveQuestionIndex] ?? practice.questions[0];
  const progressLabel = readOnly && currentReviewItem
    ? `Question ${currentReviewItem.order} / ${reviewItems.length}`
    : practice.item.module === "ctw"
      ? `Questions 1–${navigation.scoringPointCount} / ${navigation.scoringPointCount}`
      : `Question ${navigation.currentIndex + 1} / ${navigation.workspaceCount}`;
  const captureCurrentQuestionTime = useCallback(() => {
    const questionId = activeQuestionIdRef.current;
    const elapsed = Math.max(0, Math.round((Date.now() - questionStartedAtRef.current) / 1000));
    if (questionId) {
      questionTimesRef.current = {
        ...questionTimesRef.current,
        [questionId]: (questionTimesRef.current[questionId] ?? 0) + elapsed
      };
    }
    questionStartedAtRef.current = Date.now();
    return questionTimesRef.current;
  }, []);
  const selectReviewItem = (index: number) => {
    const target = reviewItems[index];
    if (target?.href) {
      router.push(target.href);
      return;
    }
    setReviewIndex(index);
  };
  const move = (direction: -1 | 1) => {
    if (readOnly && reviewItems.length) {
      selectReviewItem(Math.max(0, Math.min(reviewItems.length - 1, reviewIndex + direction)));
      return;
    }
    if (!readOnly) captureCurrentQuestionTime();
    setNavigation((current) => {
      const next = moveReadingNavigation(current, direction);
      activeQuestionIdRef.current = practice.questions[next.currentIndex]?.questionId ?? "";
      questionStartedAtRef.current = Date.now();
      return next;
    });
  };
  const updateAnswer = useCallback((questionId: string, answer: ReadingAnswer) => {
    if (readOnly) return;
    setAnswers((current) => setReadingAnswer(current, questionId, answer));
  }, [readOnly]);

  const submit = useCallback(async () => {
    if (readOnly || submitting || attempt.status === "submitted") return;
    setSubmitting(true);
    setSubmitError("");
    const questionTimes = captureCurrentQuestionTime();
    try {
      const supabase = createBrowserSupabase();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("请先登录后再提交阅读练习。");
      const response = await fetch(
        wrongbook
          ? `/api/reading/wrongbook-attempts/${encodeURIComponent(attempt.attemptId)}/submit`
          : `/api/reading/attempts/${encodeURIComponent(attempt.attemptId)}/submit`,
        {
          method: "POST",
          cache: "no-store",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            logicalItemId: practice.item.itemId,
            elapsedSeconds,
            answers: wrongbook
              ? selectReadingWrongbookSubmissionAnswers(
                  buildReadingSubmissionAnswers(practice, answers, questionTimes),
                  wrongbook.targets
                )
              : buildReadingSubmissionAnswers(practice, answers, questionTimes)
          })
        }
      );
      const result = await response.json().catch(() => ({})) as AttemptResponse;
      if (!response.ok || !isReadingAttemptSummary(result.attempt)) {
        throw new Error(result.error ?? "阅读答案提交失败，请稍后重试。");
      }
      if (wrongbook) {
        invalidateStudentWrongbook(session.user.id);
        wrongbook.onSubmitted(result.attempt);
      } else {
        storeReadingQuestionTimes(result.attempt.attemptId, questionTimes);
        invalidate(STUDENT_READING_HISTORY_CACHE_PREFIX);
        invalidate(STUDENT_PRACTICE_HISTORY_CACHE_PREFIX);
        invalidate(studentReadingCatalogCacheKey(result.attempt.taskType));
        invalidateStudentWrongbook(session.user.id);
        router.replace(`/student/reading/results/${encodeURIComponent(result.attempt.attemptId)}`);
      }
    } catch (submitFailure) {
      setSubmitError(
        submitFailure instanceof Error
          ? submitFailure.message
          : "阅读答案提交失败，请稍后重试。"
      );
    } finally {
      setSubmitting(false);
    }
  }, [answers, attempt, captureCurrentQuestionTime, elapsedSeconds, invalidate, practice, readOnly, router, submitting, wrongbook]);

  if (!readOnly && attempt.status === "submitted") {
    return <ReadingPracticeMessage description="正在打开已提交的练习结果..." title="正在打开练习结果" />;
  }

  return (
    <div className={`${readOnly ? "min-h-[100dvh]" : "h-[100dvh] overflow-hidden"} bg-[#fbfbfe] text-student-text`}>
      <ReadingPracticeHeader
        elapsedSeconds={elapsedSeconds}
        onBack={onBack}
        onExit={onExit}
        progressLabel={progressLabel}
        showElapsed={!readOnly}
        title={reviewTitle ?? practice.item.title}
      />
      <main
        className={`mx-auto ${readOnly ? "min-h-[calc(100dvh-68px)]" : "h-[calc(100dvh-68px)] min-h-0"}`}
        style={readingTwoColumnScaleStyle}
      >
        {readOnly && currentReviewItem ? (
          <ReadingReviewStatusBar
            currentIndex={reviewIndex}
            disclosure={reviewDisclosures[currentReviewItem.answerId]}
            disclosureLabel={reviewDisclosureLabel}
            items={reviewItems}
            onSelect={selectReviewItem}
          />
        ) : null}
        <ReadingQuestionViewport
          canGoNext={readOnly ? reviewIndex < reviewItems.length - 1 : navigation.currentIndex < navigation.workspaceCount - 1}
          canGoPrevious={readOnly ? reviewIndex > 0 : navigation.currentIndex > 0}
          module={practice.item.module}
          onNext={() => move(1)}
          onPrevious={() => move(-1)}
          onSubmit={submit}
          readOnly={readOnly}
          submitError={submitError}
          submitting={submitting}
        >
          <ReadingWorkspaceRouter
            answers={answers}
            currentQuestion={currentQuestion}
            editableSlotIds={editableSlotIds}
            lookupEnabled={lookupEnabled}
            onAnswerChange={updateAnswer}
            practice={practice}
            readOnly={readOnly}
            reviewPresentation={readOnly && currentReviewItem
              ? reviewDisclosures[currentReviewItem.answerId]
              : undefined}
            reviewItems={reviewItems.filter((item) => item.questionId === currentQuestion.questionId)}
            selectedReviewItem={currentReviewItem}
          />
        </ReadingQuestionViewport>
      </main>
    </div>
  );
}

export function ReadingPracticePendingShell({
  onBack,
  onExit,
  practice,
  reviewTitle
}: {
  onBack: () => void;
  onExit?: () => void;
  practice: StudentReadingPracticePayload;
  reviewTitle?: string;
}) {
  const currentQuestion = practice.questions[0];
  if (!currentQuestion) {
    return <ReadingPracticeMessage description="原题内容不完整，请稍后重试。" title="无法显示原题" />;
  }
  return (
    <div className="min-h-[100dvh] bg-[#fbfbfe] text-student-text" data-testid="reading-wrongbook-preview">
      <ReadingPracticeHeader
        elapsedSeconds={0}
        onBack={onBack}
        onExit={onExit}
        progressLabel={practice.item.module === "ctw"
          ? `Questions 1–${practice.item.scoringPointCount} / ${practice.item.scoringPointCount}`
          : `Question 1 / ${practice.item.questionCount}`}
        showElapsed={false}
        title={reviewTitle ?? practice.item.title}
      />
      <main
        className="mx-auto min-h-[calc(100dvh-68px)]"
        style={readingTwoColumnScaleStyle}
      >
        <p className="mb-3 rounded-xl border border-student-primary-border bg-student-primary-soft px-4 py-3 text-sm font-semibold text-student-primary">
          原题已载入，正在准备订正记录；准备完成前题面只读。
        </p>
        <ReadingQuestionViewport module={practice.item.module} readOnly>
          <ReadingWorkspaceRouter
            answers={{}}
            currentQuestion={currentQuestion}
            lookupEnabled={false}
            onAnswerChange={() => undefined}
            practice={practice}
            readOnly
          />
        </ReadingQuestionViewport>
      </main>
    </div>
  );
}

export function ReadingPracticeHeader({
  elapsedSeconds,
  onBack,
  onExit,
  productName,
  progressLabel,
  progressTestId = "reading-navigation-status",
  showElapsed = true,
  timeLabel = "Elapsed",
  timeTestId = "reading-elapsed-time",
  timeValue,
  title
}: {
  elapsedSeconds: number;
  onBack: () => void;
  onExit?: () => void;
  productName?: string;
  progressLabel?: string;
  progressTestId?: string;
  showElapsed?: boolean;
  timeLabel?: string;
  timeTestId?: string;
  timeValue?: string;
  title: string;
}) {
  return (
    <header className="grid h-[68px] grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 border-b border-student-border bg-white px-4 sm:px-7 lg:px-10">
      <button className="writing-header-back justify-self-start" onClick={onBack} type="button">
        <ArrowLeft aria-hidden="true" size={20} strokeWidth={2.2} />
        <span>Back</span>
      </button>
      <div className="min-w-0 justify-self-center text-center">
        {productName ? <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-student-muted">{productName}</p> : null}
        <p className="max-w-[58vw] truncate text-sm font-bold text-student-text sm:text-base">
          {title}{progressLabel ? <> <span aria-hidden="true" className="text-student-muted">·</span> <span data-testid={progressTestId}>{progressLabel}</span></> : null}
        </p>
      </div>
      <div className="flex items-center justify-self-end gap-3">
        {showElapsed ? <div className="hidden items-baseline gap-2 whitespace-nowrap sm:flex">
          <span className="text-sm font-medium text-student-muted">{timeLabel}</span>
          <span className="font-mono text-base font-bold tabular-nums text-student-primary" data-testid={timeTestId}>
            {timeValue ?? formatWritingTimer(elapsedSeconds)}
          </span>
        </div> : null}
        {onExit ? (
          <button className="writing-exit-button" onClick={onExit} type="button">
            <DoorOpen aria-hidden="true" size={19} />
            <span className="hidden sm:inline">Exit Practice</span>
          </button>
        ) : null}
      </div>
    </header>
  );
}

export function ReadingWorkspaceRouter({
  answers,
  currentQuestion,
  editableSlotIds,
  lookupEnabled,
  layoutMode = "bounded",
  onAnswerChange,
  onReady,
  practice,
  readOnly,
  reviewPresentation,
  reviewItems = [],
  selectedReviewItem = null
}: {
  answers: ReadingAnswerState;
  currentQuestion: StudentReadingPracticePayload["questions"][number];
  editableSlotIds?: ReadonlySet<string>;
  lookupEnabled: boolean;
  layoutMode?: "bounded" | "natural";
  onAnswerChange: (questionId: string, answer: ReadingAnswer) => void;
  onReady?: () => void;
  practice: StudentReadingPracticePayload;
  readOnly: boolean;
  reviewPresentation?: ReadingCorrectionAnswerPresentation;
  reviewItems?: SubmittedReadingReviewItem[];
  selectedReviewItem?: SubmittedReadingReviewItem | null;
}) {
  if (practice.item.module === "ctw" && currentQuestion.questionType === "ctw") {
    return (
      <CtwPracticeWorkspace
        answer={answers[currentQuestion.questionId]}
        editableSlotIds={editableSlotIds}
        lookupEnabled={lookupEnabled}
        onAnswerChange={onAnswerChange}
        onReady={onReady}
        question={currentQuestion}
        readOnly={readOnly}
        reviewItems={reviewItems}
        selectedReviewItem={selectedReviewItem}
      />
    );
  }
  if (practice.item.module === "rdl" && currentQuestion.questionType === "rdl" && practice.material) {
    return (
      <RdlPracticeWorkspace
        answer={answers[currentQuestion.questionId]}
        lookupEnabled={lookupEnabled}
        naturalFlow={layoutMode === "natural"}
        material={practice.material}
        onAnswerChange={onAnswerChange}
        onReady={onReady}
        question={currentQuestion}
        readOnly={readOnly}
        reviewPresentation={reviewPresentation}
      />
    );
  }
  if (practice.item.module === "rap" && currentQuestion.questionType.startsWith("rap_") && practice.passage) {
    return (
      <RapPracticeWorkspace
        answer={answers[currentQuestion.questionId]}
        lookupEnabled={lookupEnabled}
        naturalFlow={layoutMode === "natural"}
        onAnswerChange={onAnswerChange}
        onReady={onReady}
        passage={practice.passage}
        question={currentQuestion as StudentRapQuestion}
        readOnly={readOnly}
        reviewPresentation={reviewPresentation}
      />
    );
  }
  return <p className="text-sm font-semibold text-student-error">这个阅读练习的数据尚未准备完整。</p>;
}

function DomTextLookupRegion({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  const [lookupQuery, setLookupQuery] = useState("");
  const [lookupAttempted, setLookupAttempted] = useState(false);
  const [open, setOpen] = useState(false);
  const regionRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setLookupQuery("");
    setLookupAttempted(false);
  }, []);

  useEffect(() => {
    if (!enabled) close();
  }, [close, enabled]);

  useEffect(() => {
    if (!enabled || !open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target) || regionRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, [close, enabled, open]);

  const captureSelection = () => {
    if (!enabled) return;
    const selection = window.getSelection();
    const region = regionRef.current;
    if (!selection || selection.isCollapsed || !selection.rangeCount || !region) {
      close();
      return;
    }
    const range = selection.getRangeAt(0);
    if (!region.contains(range.startContainer) || !region.contains(range.endContainer)) {
      close();
      return;
    }
    const query = selection.toString().replace(/\s+/g, " ").trim();
    if (!query) {
      close();
      return;
    }
    setLookupQuery(query);
    setLookupAttempted(false);
    setOpen(true);
  };
  const lookupRequest = createRdlLookupRequest(lookupQuery);

  return (
    <div
      className="contents"
      data-dom-lookup-enabled={enabled ? "true" : "false"}
      onMouseUp={(event) => {
        if (event.target instanceof Node && panelRef.current?.contains(event.target)) return;
        captureSelection();
      }}
      ref={regionRef}
    >
      {children}
      {enabled && open ? (
        <div
          className="fixed bottom-6 left-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-student-primary-border bg-white/95 p-3 shadow-lg backdrop-blur-sm"
          data-testid="dom-lookup-panel"
          ref={panelRef}
        >
          <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-student-primary">Selected text</p>
          <div className="mt-2 flex items-center gap-2">
            <label className="sr-only" htmlFor="dom-lookup-query">Lookup query</label>
            <input
              className="min-w-0 flex-1 rounded-lg border border-student-border bg-white px-3 py-2 text-sm text-student-text outline-none focus:border-student-primary focus:ring-2 focus:ring-student-primary-soft"
              id="dom-lookup-query"
              onChange={(event) => {
                setLookupQuery(event.target.value);
                setLookupAttempted(false);
              }}
              value={lookupQuery}
            />
            <button
              className="student-button-primary shrink-0"
              disabled={!lookupRequest}
              onClick={() => setLookupAttempted(Boolean(lookupRequest))}
              type="button"
            >
              Look Up
            </button>
          </div>
          {lookupAttempted ? (
            <p className="mt-2 text-xs leading-5 text-student-muted" role="status">
              Dictionary lookup is not configured yet. Your edited query is ready.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CtwPracticeWorkspace({
  answer,
  editableSlotIds,
  lookupEnabled,
  onAnswerChange,
  onReady,
  question,
  readOnly,
  reviewItems,
  selectedReviewItem
}: {
  answer: ReadingAnswer | undefined;
  editableSlotIds?: ReadonlySet<string>;
  lookupEnabled: boolean;
  onAnswerChange: (questionId: string, answer: ReadingAnswer) => void;
  onReady?: () => void;
  question: StudentCtwQuestion;
  readOnly: boolean;
  reviewItems: SubmittedReadingReviewItem[];
  selectedReviewItem: SubmittedReadingReviewItem | null;
}) {
  const emptySlots = useMemo(() => createCtwSlotAnswers(question.slots), [question.slots]);
  const slotAnswers = answer?.kind === "ctw" ? answer.slots : emptySlots;
  const interactionSlots = useMemo(
    () => editableSlotIds
      ? question.slots.filter((slot) => editableSlotIds.has(slot.slotId))
      : question.slots,
    [editableSlotIds, question.slots]
  );
  const slotById = useMemo(
    () => new Map(question.slots.map((slot) => [slot.slotId, slot])),
    [question.slots]
  );
  const positionRefs = useRef(new Map<string, HTMLSpanElement>());
  const keyboardInputRef = useRef<HTMLInputElement | null>(null);
  const activePositionRef = useRef<CtwPosition | null>(null);
  const [activePositionKey, setActivePositionKey] = useState<string | null>(null);
  const [keyboardInputFocused, setKeyboardInputFocused] = useState(false);
  const setActivePosition = useCallback((position: CtwPosition) => {
    activePositionRef.current = position;
    setActivePositionKey(ctwPositionKey(position));
  }, []);
  const focusPosition = useCallback((position: CtwPosition | null) => {
    if (!position) return;
    setActivePosition(position);
    if (document.activeElement === keyboardInputRef.current) return;
    positionRefs.current.get(ctwPositionKey(position))?.focus();
  }, [setActivePosition]);
  const focusKeyboardInput = useCallback((position: CtwPosition) => {
    setActivePosition(position);
    // This must stay directly inside the slot's click handler. iOS only opens
    // its software keyboard when an editable native control is focused during
    // the original user gesture.
    keyboardInputRef.current?.focus();
  }, [setActivePosition]);

  useEffect(() => {
    if (readOnly) return;
    focusPosition(firstCtwPosition(interactionSlots));
  }, [focusPosition, interactionSlots, question.questionId, readOnly]);

  useLayoutEffect(() => {
    if (readOnly) {
      onReady?.();
      return;
    }
    const firstPosition = firstCtwPosition(interactionSlots);
    if (firstPosition && positionRefs.current.has(ctwPositionKey(firstPosition))) onReady?.();
  }, [interactionSlots, onReady, question.questionId, readOnly]);

  const applyLetter = (position: CtwPosition, input: string) => {
    const result = enterCtwLetter(interactionSlots, slotAnswers, position, input);
    if (!result.accepted) return;
    onAnswerChange(question.questionId, { kind: "ctw", slots: result.slots });
    focusPosition(result.focus);
  };

  const applyBackspace = (position: CtwPosition) => {
    const result = backspaceCtwLetter(interactionSlots, slotAnswers, position);
    onAnswerChange(question.questionId, { kind: "ctw", slots: result.slots });
    focusPosition(result.focus);
  };

  const applyDelete = (position: CtwPosition) => {
    const result = deleteCtwLetter(interactionSlots, slotAnswers, position);
    onAnswerChange(question.questionId, { kind: "ctw", slots: result.slots });
    focusPosition(result.focus);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>, position: CtwPosition) => {
    if (event.nativeEvent.isComposing || event.key === "Process" || event.ctrlKey || event.metaKey || event.altKey) return;
    if (/^[A-Za-z]$/.test(event.key)) {
      event.preventDefault();
      applyLetter(position, event.key);
      return;
    }
    if (event.key === "Backspace") {
      event.preventDefault();
      applyBackspace(position);
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      applyDelete(position);
      return;
    }
    if (event.key.length === 1) event.preventDefault();
  };

  const handlePaste = (event: ClipboardEvent<HTMLElement>, position: CtwPosition) => {
    event.preventDefault();
    const pastedText = event.clipboardData.getData("text");
    if (/^[A-Za-z]$/.test(pastedText)) applyLetter(position, pastedText);
  };

  const handleKeyboardInput = (event: FormEvent<HTMLInputElement>) => {
    const position = activePositionRef.current;
    const input = event.currentTarget.value;
    event.currentTarget.value = "";
    if (position && !(event.nativeEvent as InputEvent).isComposing && /^[A-Za-z]$/.test(input)) {
      applyLetter(position, input);
    }
  };

  return (
    <DomTextLookupRegion enabled={lookupEnabled}>
    <div
      className={`mx-auto max-w-4xl py-[8em] ${lookupEnabled ? "" : "select-none"}`}
      data-lookup-enabled={lookupEnabled ? "true" : "false"}
    >
      {!readOnly ? (
        <input
          aria-label="Complete the Words letter input"
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          className="fixed bottom-0 left-0 h-px w-px border-0 p-0 text-base opacity-0"
          data-ctw-keyboard-input="true"
          inputMode="text"
          maxLength={1}
          onBlur={() => setKeyboardInputFocused(false)}
          onBeforeInput={(event) => {
            const position = activePositionRef.current;
            const inputType = (event.nativeEvent as InputEvent).inputType;
            if (!position || (inputType !== "deleteContentBackward" && inputType !== "deleteContentForward")) return;
            event.preventDefault();
            if (inputType === "deleteContentBackward") applyBackspace(position);
            else applyDelete(position);
          }}
          onFocus={() => setKeyboardInputFocused(true)}
          onInput={handleKeyboardInput}
          onKeyDown={(event) => {
            const position = activePositionRef.current;
            if (position) handleKeyDown(event, position);
          }}
          onPaste={(event) => {
            const position = activePositionRef.current;
            if (position) handlePaste(event, position);
          }}
          ref={keyboardInputRef}
          spellCheck={false}
          tabIndex={-1}
          type="text"
        />
      ) : null}
      <h1 className="text-center text-[20em] font-bold leading-[1.6] text-student-text">Fill in the missing letters in the paragraph.</h1>
      <article className="mt-[28em] text-[17em] leading-[1.75] text-student-text" data-testid="ctw-passage">
        {[...question.paragraphs]
          .sort((left, right) => left.paragraphOrder - right.paragraphOrder)
          .map((paragraph) => (
            <p className="mb-[20em] last:mb-0" key={paragraph.paragraphId}>
              {paragraph.segments.map((segment, segmentIndex) => {
                if (segment.kind === "text") {
                  return <span key={`${paragraph.paragraphId}:text:${segmentIndex}`}>{segment.text}</span>;
                }
                const slot = slotById.get(segment.slotId);
                if (!slot) return null;
                const reviewItem = reviewItems.find((item) => item.slotId === slot.slotId);
                return (
                  <CtwBlankWord
                    characters={slotAnswers[slot.slotId] ?? emptySlots[slot.slotId]}
                    activePositionKey={keyboardInputFocused ? activePositionKey : null}
                    key={`${paragraph.paragraphId}:blank:${slot.slotId}`}
                    onActivatePosition={focusKeyboardInput}
                    onFocusPosition={focusPosition}
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                    positionRefs={positionRefs}
                    prefix={slot.prefix}
                    readOnly={readOnly || Boolean(editableSlotIds && !editableSlotIds.has(slot.slotId))}
                    resultState={reviewItem ? reviewItem.isAnswered ? reviewItem.isCorrect ? "correct" : "incorrect" : "unanswered" : null}
                    selected={selectedReviewItem?.slotId === slot.slotId}
                    slotId={slot.slotId}
                    slotOrder={slot.slotOrder}
                  />
                );
              })}
            </p>
          ))}
      </article>
    </div>
    </DomTextLookupRegion>
  );
}

function CtwBlankWord({
  activePositionKey,
  characters,
  onActivatePosition,
  onFocusPosition,
  onKeyDown,
  onPaste,
  positionRefs,
  prefix,
  readOnly,
  resultState,
  selected,
  slotId,
  slotOrder
}: {
  activePositionKey: string | null;
  characters: string[];
  onActivatePosition: (position: CtwPosition) => void;
  onFocusPosition: (position: CtwPosition) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>, position: CtwPosition) => void;
  onPaste: (event: ClipboardEvent<HTMLElement>, position: CtwPosition) => void;
  positionRefs: { current: Map<string, HTMLSpanElement> };
  prefix: string;
  readOnly: boolean;
  resultState: "correct" | "incorrect" | "unanswered" | null;
  selected: boolean;
  slotId: string;
  slotOrder: number;
}) {
  return (
    <span
      className={`inline whitespace-nowrap rounded-[0.2em] ${selected ? "bg-amber-100 ring-2 ring-amber-400 ring-offset-1" : ""}`}
      data-ctw-slot={slotId}
      data-current-slot={selected ? "true" : undefined}
    >
      <span>{prefix}</span>
      <span
        className={`inline rounded-[0.15em] px-[0.08em] ${resultState === "correct"
          ? "bg-student-primary-soft text-student-primary"
          : resultState === "incorrect"
            ? "bg-student-error-soft text-student-error"
            : "bg-[#f1f2f5]"}`}
        data-answer-state={resultState ?? undefined}
        data-ctw-fill-region="true"
      >
        {characters.map((character, characterIndex) => {
        const position = { slotId, characterIndex };
        const key = ctwPositionKey(position);
        const keyboardActive = activePositionKey === key;
        const activeCaretClass = readOnly
          ? ""
          : `relative focus:after:pointer-events-none focus:after:absolute focus:after:right-full focus:after:top-1/2 focus:after:block focus:after:h-[1em] focus:after:w-[1.5px] focus:after:translate-x-[0.05em] focus:after:-translate-y-1/2 focus:after:animate-ctw-caret-blink focus:after:bg-student-text focus:after:content-[''] ${keyboardActive ? "after:pointer-events-none after:absolute after:right-full after:top-1/2 after:block after:h-[1em] after:w-[1.5px] after:translate-x-[0.05em] after:-translate-y-1/2 after:animate-ctw-caret-blink after:bg-student-text after:content-['']" : ""}`;
        return (
          <span
            aria-label={`Blank ${slotOrder}, letter ${characterIndex + 1} of ${characters.length}`}
            className={`${character
              ? `inline leading-[inherit] outline-none ${readOnly ? "cursor-default" : `cursor-text focus:rounded-[2px] focus:bg-amber-100 focus:shadow-[inset_0_-2px_0_#9a6b20] ${keyboardActive ? "rounded-[2px] bg-amber-100 shadow-[inset_0_-2px_0_#9a6b20]" : ""}`}`
              : `mx-[0.07em] inline-block h-[0.72em] w-[0.52em] border-b-[1.5px] border-student-muted align-baseline leading-none text-transparent outline-none ${readOnly ? "cursor-default" : `cursor-text focus:rounded-[2px] focus:border-student-primary focus:bg-student-primary-soft focus:shadow-[inset_0_-1px_0_currentColor] ${keyboardActive ? "rounded-[2px] border-student-primary bg-student-primary-soft shadow-[inset_0_-1px_0_currentColor]" : ""}`}`} ${activeCaretClass}`}
            data-character-index={characterIndex}
            data-ctw-position={key}
            data-filled={character ? "true" : "false"}
            key={key}
            onClick={readOnly ? undefined : () => onActivatePosition(position)}
            onFocus={readOnly ? undefined : () => onFocusPosition(position)}
            onKeyDown={readOnly ? undefined : (event) => onKeyDown(event, position)}
            onPaste={readOnly ? undefined : (event) => onPaste(event, position)}
            ref={(element) => {
              if (element) positionRefs.current.set(key, element);
              else positionRefs.current.delete(key);
            }}
            role={readOnly ? undefined : "textbox"}
            tabIndex={readOnly ? undefined : 0}
          >
            {character || null}
          </span>
        );
        })}
      </span>
    </span>
  );
}

function ReadingReviewStatusBar({
  currentIndex,
  disclosure,
  disclosureLabel,
  items,
  onSelect
}: {
  currentIndex: number;
  disclosure?: ReadingCorrectionAnswerPresentation;
  disclosureLabel?: string;
  items: SubmittedReadingReviewItem[];
  onSelect: (index: number) => void;
}) {
  const current = items[currentIndex];
  if (!current) return null;
  const currentState = !current.isAnswered ? "未作答" : current.isCorrect ? "正确" : "错误";
  const currentTone = current.isCorrect
    ? "text-student-primary"
    : current.isAnswered
      ? "text-student-error"
      : "text-student-muted";
  return (
    <section className="mb-3 shrink-0 rounded-2xl border border-student-border bg-white px-4 py-3 shadow-sm" data-testid="reading-review-status">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className={`text-sm font-bold ${currentTone}`}>
          第{current.order}题 · {currentState} · {formatReviewQuestionTime(current.questionTimeSeconds)}
        </p>
        <div className="flex max-w-full flex-wrap gap-1.5" aria-label="阅读作答题号导航">
          {items.map((item, index) => {
            const state = !item.isAnswered ? "unanswered" : item.isCorrect ? "correct" : "incorrect";
            return (
              <button
                aria-current={index === currentIndex ? "true" : undefined}
                className={`min-h-8 min-w-8 rounded-full border px-2 text-xs font-bold tabular-nums ${
                  index === currentIndex
                    ? "border-amber-500 bg-amber-100 text-student-text ring-2 ring-amber-200"
                    : state === "correct"
                      ? "border-student-primary-border bg-student-primary-soft text-student-primary"
                      : state === "incorrect"
                        ? "border-student-error-border bg-student-error-soft text-student-error"
                        : "border-student-border bg-student-bg text-student-muted"
                }`}
                data-answer-state={state}
                key={item.answerId}
                onClick={() => onSelect(index)}
                type="button"
              >
                {item.order}
              </button>
            );
          })}
        </div>
      </div>
      {disclosure && disclosureLabel ? (
        <ReadingAnswerDisclosure disclosure={disclosure} label={disclosureLabel} />
      ) : null}
    </section>
  );
}

export function ReadingAnswerDisclosure({
  disclosure,
  label = "正确答案"
}: {
  disclosure?: ReadingCorrectionAnswerPresentation;
  label?: string;
}) {
  if (!disclosure) return null;
  return (
    <dl className="mt-3 grid gap-3 border-t border-student-border pt-3 text-sm leading-6 sm:grid-cols-2" data-testid="reading-answer-disclosure">
      <div>
        <dt className="inline font-semibold text-student-muted">你的答案</dt>
        <dd className="ml-2 inline font-semibold text-student-text">{disclosure.studentAnswer}</dd>
      </div>
      <div>
        <dt className="inline font-semibold text-student-muted">{label}</dt>
        <dd className="ml-2 inline font-semibold text-student-text">
          <ReadingCorrectionAnswerValue answer={disclosure.correctAnswer} />
        </dd>
      </div>
    </dl>
  );
}

function formatReviewQuestionTime(seconds: number | null) {
  if (seconds === null) return "—";
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function ctwPositionKey(position: CtwPosition) {
  return `ctw-position:${position.slotId}:${position.characterIndex}`;
}

function ReadingTwoColumnPracticeShell({
  left,
  lookupEnabled,
  naturalFlow,
  ratio,
  right,
  testId,
  title,
  titleId
}: {
  left: ReactNode;
  lookupEnabled: boolean;
  naturalFlow: boolean;
  ratio: "rdl" | "rap";
  right: ReactNode;
  testId: "rdl-workspace" | "rap-workspace";
  title: string;
  titleId: string;
}) {
  const desktopColumns = ratio === "rdl"
    ? "lg:grid-cols-[minmax(0,52fr)_minmax(0,48fr)]"
    : "lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]";
  return (
    <div
      className={`flex min-h-0 flex-1 flex-col bg-white ${lookupEnabled ? "" : "select-none"}`}
      data-lookup-enabled={lookupEnabled ? "true" : "false"}
      data-testid={testId}
    >
      <h1
        className="shrink-0 text-center font-extrabold text-student-text"
        id={titleId}
        style={readingTitleStyle}
      >
        {title}
      </h1>
      <div className={`grid min-h-0 flex-1 grid-cols-1 ${naturalFlow ? "overflow-visible" : "overflow-y-auto lg:overflow-hidden"} ${desktopColumns}`}>
        <div className={naturalFlow ? "min-w-0" : "min-w-0 lg:h-full lg:min-h-0"}>{left}</div>
        <div className={naturalFlow ? "min-w-0" : "min-w-0 lg:h-full lg:min-h-0"}>{right}</div>
      </div>
    </div>
  );
}

function ReadingQuestionColumn({
  children,
  labelledBy,
  naturalFlow
}: {
  children: ReactNode;
  labelledBy: string;
  naturalFlow: boolean;
}) {
  return (
    <section
      aria-labelledby={labelledBy}
      className={naturalFlow
        ? "min-w-0 overflow-visible bg-white"
        : "min-w-0 overflow-visible bg-white lg:h-full lg:overflow-y-auto"}
      style={readingColumnStyle}
    >
      <div className="w-full">{children}</div>
    </section>
  );
}

function RdlPracticeWorkspace({
  answer,
  lookupEnabled,
  naturalFlow,
  material,
  onAnswerChange,
  onReady,
  question,
  readOnly,
  reviewPresentation
}: {
  answer: ReadingAnswer | undefined;
  lookupEnabled: boolean;
  naturalFlow: boolean;
  material: NonNullable<StudentReadingPracticePayload["material"]>;
  onAnswerChange: (questionId: string, answer: ReadingAnswer) => void;
  onReady?: () => void;
  question: StudentRdlQuestion;
  readOnly: boolean;
  reviewPresentation?: ReadingCorrectionAnswerPresentation;
}) {
  const [assetStatus, setAssetStatus] = useState<"loading" | "ready" | "error">("loading");
  const [selectionMap, setSelectionMap] = useState<RdlSelectionMap | null>(null);
  const [imageDimensions, setImageDimensions] = useState({ width: 0, height: 0 });
  const [selectionRect, setSelectionRect] = useState<RdlContainRect | null>(null);
  const [selectionRange, setSelectionRange] = useState<RdlSelectionRange | null>(null);
  const [selectionCommitted, setSelectionCommitted] = useState(false);
  const [lookupQuery, setLookupQuery] = useState("");
  const [lookupAttempted, setLookupAttempted] = useState(false);
  const imageStageRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const lookupPanelRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    anchorIndex: number;
    focusIndex: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const selectedOptionId = answer?.kind === "choice" ? answer.optionId : null;

  const finishImageLoad = useCallback(async (image: HTMLImageElement) => {
    try {
      if (typeof image.decode === "function") await image.decode();
      if (imageRef.current !== image || !image.naturalWidth || !image.naturalHeight) return;
      setImageDimensions({ width: image.naturalWidth, height: image.naturalHeight });
      setAssetStatus("ready");
    } catch {
      if (imageRef.current === image) setAssetStatus("error");
    }
  }, []);

  useLayoutEffect(() => {
    setAssetStatus("loading");
    setImageDimensions({ width: 0, height: 0 });
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth && image.naturalHeight) {
      void finishImageLoad(image);
    }
  }, [finishImageLoad, material.imageUrl]);

  useEffect(() => {
    setSelectionMap(null);
    try {
      if (!material.selectionMap || !material.imageSha256) throw new Error("RDL selection binding was not verified");
      const parsedMap = material.selectionMap;
      if (parsedMap.schemaVersion !== 2 || parsedMap.coordinateSpace !== "normalized_top_left_xywh_0_1") {
        throw new Error("Unsupported RDL selection-map contract");
      }
      if (parsedMap.imageSha256 !== material.imageSha256) {
        throw new Error("RDL image and selection map do not match");
      }
      setSelectionMap(parsedMap);
    } catch (selectionError) {
      console.error("RDL selection map load failed", selectionError);
    }
  }, [material.imageSha256, material.imageUrl, material.selectionMap, material.selectionMapUrl]);

  useEffect(() => {
    setSelectionRange(null);
    setSelectionCommitted(false);
    setLookupQuery("");
    setLookupAttempted(false);
    dragRef.current = null;
  }, [question.questionId]);

  useEffect(() => {
    if (!selectionCommitted) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && lookupPanelRef.current?.contains(target)) return;
      setSelectionRange(null);
      setSelectionCommitted(false);
      setLookupQuery("");
      setLookupAttempted(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, [selectionCommitted]);

  const bindingValid = Boolean(selectionMap && material.imageSha256 && validateRdlImageBinding(selectionMap, {
    imageFile: assetFileName(material.imageUrl),
    imageSha256: material.imageSha256,
    naturalWidth: imageDimensions.width,
    naturalHeight: imageDimensions.height
  }));

  const recalculateSelectionRect = useCallback(() => {
    const stage = imageStageRef.current;
    const image = imageRef.current;
    if (!stage || !image || !imageDimensions.width || !imageDimensions.height) {
      setSelectionRect(null);
      return;
    }
    const stageBounds = stage.getBoundingClientRect();
    const imageBounds = image.getBoundingClientRect();
    const contained = calculateRdlContainRect(
      image.clientWidth,
      image.clientHeight,
      imageDimensions.width,
      imageDimensions.height
    );
    const nextRect = {
      ...contained,
      left: imageBounds.left - stageBounds.left + contained.left,
      top: imageBounds.top - stageBounds.top
    };
    setSelectionRect((current) => current && sameRdlRect(current, nextRect) ? current : nextRect);
  }, [imageDimensions.height, imageDimensions.width]);

  useLayoutEffect(() => {
    recalculateSelectionRect();
    const stage = imageStageRef.current;
    const image = imageRef.current;
    if (!stage || !image) return;
    const observer = new ResizeObserver(recalculateSelectionRect);
    observer.observe(stage);
    observer.observe(image);
    window.addEventListener("resize", recalculateSelectionRect);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", recalculateSelectionRect);
    };
  }, [recalculateSelectionRect]);

  useLayoutEffect(() => {
    if (assetStatus === "ready" && bindingValid && selectionRect?.width && selectionRect.height) {
      onReady?.();
    }
  }, [assetStatus, bindingValid, onReady, question.questionId, selectionRect]);

  const selectedCharacters = useMemo(
    () => selectionMap ? rdlSelectedCharacters(selectionMap, selectionRange) : [],
    [selectionMap, selectionRange]
  );
  const selectedText = useMemo(
    () => selectionMap ? rdlSelectedText(selectionMap, selectionRange) : "",
    [selectionMap, selectionRange]
  );

  const pointerCharacter = (
    event: ReactPointerEvent<HTMLDivElement>,
    allowNearest: boolean
  ) => {
    if (!selectionMap || !bindingValid) return null;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;
    const x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    const y = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
    return hitTestRdlCharacter(selectionMap, x, y, allowNearest);
  };

  const applySelection = (range: RdlSelectionRange) => {
    if (!selectionMap) return;
    setSelectionRange(range);
    setSelectionCommitted(true);
    setLookupQuery(rdlSelectedText(selectionMap, range));
    setLookupAttempted(false);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const characterIndex = pointerCharacter(event, false);
    if (characterIndex === null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      anchorIndex: characterIndex,
      focusIndex: characterIndex,
      startX: event.clientX,
      startY: event.clientY,
      moved: false
    };
    setSelectionRange(normalizeRdlSelectionRange(characterIndex, characterIndex));
    setSelectionCommitted(false);
    setLookupAttempted(false);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const characterIndex = pointerCharacter(event, true);
    if (characterIndex === null) return;
    drag.focusIndex = characterIndex;
    drag.moved = drag.moved
      || characterIndex !== drag.anchorIndex
      || Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 4;
    setSelectionRange(normalizeRdlSelectionRange(drag.anchorIndex, characterIndex));
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !selectionMap) return;
    const characterIndex = pointerCharacter(event, true) ?? drag.focusIndex;
    const dragged = drag.moved || characterIndex !== drag.anchorIndex;
    const range = dragged
      ? normalizeRdlSelectionRange(drag.anchorIndex, characterIndex)
      : rdlWordRangeAt(selectionMap, drag.anchorIndex);
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (range) applySelection(range);
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setSelectionRange(null);
    setSelectionCommitted(false);
    setLookupQuery("");
  };

  const lookupRequest = createRdlLookupRequest(lookupQuery);

  return (
    <ReadingTwoColumnPracticeShell
      left={(
        <figure className={naturalFlow
          ? "flex min-h-[320px] flex-col bg-white"
          : "flex min-h-[320px] flex-col bg-white lg:h-full lg:min-h-0"}
        >
        <div
          className={naturalFlow
            ? "relative flex min-h-[320px] items-start justify-center overflow-visible"
            : "relative flex min-h-[320px] flex-1 items-start justify-center overflow-hidden lg:min-h-0"}
          ref={imageStageRef}
          style={readingMaterialStageStyle}
        >
          {assetStatus === "loading" ? (
            <p className="absolute inset-0 flex items-center justify-center text-sm font-semibold text-student-muted" role="status">
              正在加载阅读材料...
            </p>
          ) : null}
          {assetStatus === "error" ? (
            <p className="max-w-sm text-center text-sm font-semibold leading-6 text-student-muted" role="alert">
              阅读材料暂时无法显示，请稍后重试。
            </p>
          ) : (
            <img
              alt={material.title}
              className={`${naturalFlow ? "h-auto" : "h-full"} w-full object-contain ${assetStatus === "ready" ? "opacity-100" : "opacity-0"}`}
              onError={() => setAssetStatus("error")}
              onLoad={(event) => {
                void finishImageLoad(event.currentTarget);
              }}
              ref={imageRef}
              src={material.imageUrl}
              style={{ objectPosition: "center top" }}
            />
          )}
          {lookupEnabled && selectionMap && bindingValid && selectionRect?.width ? (
            <div
              aria-label="Selectable reading material text"
              className="absolute z-10 cursor-text touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-student-primary"
              data-testid="rdl-selection-surface"
              onPointerCancel={handlePointerCancel}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              role="region"
              style={{
                height: selectionRect.height,
                left: selectionRect.left,
                top: selectionRect.top,
                width: selectionRect.width
              }}
              tabIndex={0}
            >
              {selectedCharacters.map((character) => (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute rounded-[2px] bg-violet-400/30 shadow-[inset_0_-1px_0_rgba(109,40,217,0.45)]"
                  data-rdl-highlight="true"
                  key={character.id}
                  style={{
                    height: `${character.bbox.height * 100}%`,
                    left: `${character.bbox.x * 100}%`,
                    top: `${character.bbox.y * 100}%`,
                    width: `${character.bbox.width * 100}%`
                  }}
                />
              ))}
            </div>
          ) : null}
          {lookupEnabled && selectionCommitted && selectedText ? (
            <div className="absolute bottom-3 left-3 right-3 z-20 max-w-md rounded-xl border border-student-primary-border bg-white/95 p-3 shadow-lg backdrop-blur-sm" data-testid="rdl-lookup-panel" ref={lookupPanelRef}>
              <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-student-primary">Selected text</p>
              <p className="mt-1 line-clamp-2 text-sm font-semibold leading-5 text-student-text" data-testid="rdl-selected-text">{selectedText}</p>
              <div className="mt-2 flex items-center gap-2">
                <label className="sr-only" htmlFor="rdl-lookup-query">Lookup query</label>
                <input
                  className="min-w-0 flex-1 rounded-lg border border-student-border bg-white px-3 py-2 text-sm text-student-text outline-none focus:border-student-primary focus:ring-2 focus:ring-student-primary-soft"
                  id="rdl-lookup-query"
                  onChange={(event) => {
                    setLookupQuery(event.target.value);
                    setLookupAttempted(false);
                  }}
                  value={lookupQuery}
                />
                <button
                  className="student-button-primary shrink-0"
                  disabled={!lookupRequest}
                  onClick={() => setLookupAttempted(Boolean(lookupRequest))}
                  type="button"
                >
                  Look Up
                </button>
              </div>
              {lookupAttempted ? (
                <p className="mt-2 text-xs leading-5 text-student-muted" role="status">
                  Dictionary lookup is not configured yet. Your edited query is ready.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </figure>
      )}
      lookupEnabled={lookupEnabled}
      naturalFlow={naturalFlow}
      ratio="rdl"
      right={(
      <ReadingQuestionColumn labelledBy="rdl-question-stem" naturalFlow={naturalFlow}>
        <h2 className="font-bold text-student-text" id="rdl-question-stem" style={readingQuestionTextStyle}>
          {question.stem}
        </h2>
        <ChoiceOptionList
          labelledBy="rdl-question-stem"
          onSelect={(optionId) => onAnswerChange(question.questionId, { kind: "choice", optionId })}
          options={question.options}
          readOnly={readOnly}
          reviewPresentation={reviewPresentation}
          selectedOptionId={selectedOptionId}
        />
      </ReadingQuestionColumn>
      )}
      testId="rdl-workspace"
      title={material.materialType
        ? rdlMaterialInstruction(material.materialType)
        : "Reading material instruction unavailable."}
      titleId="rdl-material-title"
    />
  );
}

function sameRdlRect(left: RdlContainRect, right: RdlContainRect) {
  return Math.abs(left.left - right.left) < 0.25
    && Math.abs(left.top - right.top) < 0.25
    && Math.abs(left.width - right.width) < 0.25
    && Math.abs(left.height - right.height) < 0.25;
}

function assetFileName(assetUrl: string) {
  try {
    return decodeURIComponent(new URL(assetUrl).pathname.split("/").pop() ?? "");
  } catch {
    return "";
  }
}

function RapPracticeWorkspace({
  answer,
  lookupEnabled,
  naturalFlow,
  onAnswerChange,
  onReady,
  passage,
  question,
  readOnly,
  reviewPresentation
}: {
  answer: ReadingAnswer | undefined;
  lookupEnabled: boolean;
  naturalFlow: boolean;
  onAnswerChange: (questionId: string, answer: ReadingAnswer) => void;
  onReady?: () => void;
  passage: NonNullable<StudentReadingPracticePayload["passage"]>;
  question: StudentRapQuestion;
  readOnly: boolean;
  reviewPresentation?: ReadingCorrectionAnswerPresentation;
}) {
  const orderedParagraphs = useMemo(
    () => [...passage.paragraphs]
      .sort((left, right) => left.paragraphOrder - right.paragraphOrder)
      .map((paragraph) => ({
        ...paragraph,
        sentences: [...paragraph.sentences].sort((left, right) => left.sentenceOrder - right.sentenceOrder)
      })),
    [passage.paragraphs]
  );
  const sentenceStartOffsets = useMemo(() => {
    const offsets = new Map<string, number>();
    for (const paragraph of orderedParagraphs) {
      let utf16Cursor = 0;
      for (const sentence of paragraph.sentences) {
        const utf16Start = paragraph.text.indexOf(sentence.text, utf16Cursor);
        if (utf16Start < 0) continue;
        offsets.set(sentence.sentenceId, Array.from(paragraph.text.slice(0, utf16Start)).length);
        utf16Cursor = utf16Start + sentence.text.length;
      }
    }
    return offsets;
  }, [orderedParagraphs]);
  const selectedOptionId = answer?.kind === "choice" ? answer.optionId : null;
  const insertionValidation = useMemo(
    () => question.questionType === "rap_sentence_insertion"
      ? validateRapInsertionAnchors(passage, question.anchors)
      : null,
    [passage, question]
  );
  const sentenceTargetValidation = useMemo(
    () => question.questionType === "rap_sentence_selection"
      ? validateRapSentenceTarget(passage, question.targetParagraphId)
      : null,
    [passage, question]
  );
  const selectedAnchorId = answer?.kind === "insertion"
    && insertionValidation?.valid
    && insertionValidation.anchors.some((anchor) => anchor.anchorId === answer.anchorId)
    ? answer.anchorId
    : null;
  const selectedSentenceId = answer?.kind === "sentence_selection"
    && sentenceTargetValidation?.valid
    && sentenceTargetValidation.sentenceIds.includes(answer.sentenceId ?? "")
    ? answer.sentenceId
    : null;
  const visibleHighlightRanges = rapVisibleHighlightRanges(
    question.questionType,
    readOnly,
    question.highlightRanges
  );

  useLayoutEffect(() => {
    onReady?.();
  }, [onReady, passage.passageId, question.questionId]);

  const insertionBoundary = (paragraphId: string, boundaryIndex: number) => {
    if (question.questionType !== "rap_sentence_insertion" || !insertionValidation) return null;
    const anchor = insertionAnchorAtBoundary(insertionValidation, paragraphId, boundaryIndex);
    if (!anchor) return null;
    const selected = anchor.anchorId === selectedAnchorId;
    const correctionState = readOnly
      ? readingCorrectionMarkState(reviewPresentation, "insertion", anchor.anchorId)
      : null;
    const inserted = selected || correctionState !== null;
    const insertedClassName = correctionState === "correct"
      ? "font-bold text-student-primary"
      : correctionState === "incorrect"
        ? "font-bold text-student-error line-through decoration-2"
        : "font-bold";
    return (
      <Fragment key={`boundary:${paragraphId}:${boundaryIndex}`}>
        {inserted ? (
          <>
            <button
              aria-checked={selected}
              aria-label={`Insertion position ${anchor.anchorOrder} of 4`}
              className="sr-only"
              data-anchor-order={anchor.anchorOrder}
              data-testid="rap-insertion-anchor"
              disabled={readOnly}
              onClick={readOnly ? undefined : () => onAnswerChange(question.questionId, { kind: "insertion", anchorId: anchor.anchorId })}
              role="radio"
              style={rapFramelessInteractionStyle}
              type="button"
            />
            {boundaryIndex > 0 ? " " : null}
            <strong
              className={insertedClassName}
              data-correction-state={correctionState ?? undefined}
              data-strikethrough={correctionState === "incorrect" ? "true" : undefined}
              data-testid="rap-inserted-sentence"
            >
              {question.insertSentence}
            </strong>{" "}
          </>
        ) : (
          <button
            aria-checked="false"
            aria-label={`Insertion position ${anchor.anchorOrder} of 4`}
            className="mx-[0.3em] inline align-baseline leading-[inherit] text-student-primary"
            data-anchor-order={anchor.anchorOrder}
            data-testid="rap-insertion-anchor"
            disabled={readOnly}
            onClick={readOnly ? undefined : () => onAnswerChange(question.questionId, { kind: "insertion", anchorId: anchor.anchorId })}
            role="radio"
            style={rapFramelessInteractionStyle}
            type="button"
          >
            <RapInsertionMarker />
          </button>
        )}
      </Fragment>
    );
  };

  const renderSentence = (
    paragraph: (typeof orderedParagraphs)[number],
    sentence: (typeof orderedParagraphs)[number]["sentences"][number]
  ) => {
    const selectable = question.questionType === "rap_sentence_selection"
      && sentenceTargetValidation !== null
      && isRapSentenceSelectable(sentenceTargetValidation, paragraph.paragraphId, sentence.sentenceId);
    const selected = selectable && sentence.sentenceId === selectedSentenceId;
    const correctionState = selectable && readOnly
      ? readingCorrectionMarkState(reviewPresentation, "sentence_selection", sentence.sentenceId)
      : null;
    const highlightedText = correctionState
      ? sentence.text
      : renderRapHighlightedText(
          sentence.text,
          sentenceStartOffsets.get(sentence.sentenceId) ?? 0,
          visibleHighlightRanges.filter((range) => range.paragraphId === paragraph.paragraphId)
        );
    const sentenceClassName = correctionState === "correct"
      ? "font-bold text-student-primary"
      : correctionState === "incorrect"
        ? "font-bold text-student-error"
        : selected
          ? "font-bold text-inherit"
          : "font-normal text-inherit";
    if (selectable) {
      return (
        <span
          aria-checked={readOnly ? undefined : selected}
          className={`inline leading-[inherit] ${readOnly ? "cursor-text select-text" : "cursor-pointer"} ${sentenceClassName}`}
          data-correction-state={correctionState ?? undefined}
          data-sentence-id={sentence.sentenceId}
          data-sentence-order={sentence.sentenceOrder}
          data-testid="rap-selectable-sentence"
          onClick={readOnly ? undefined : () => onAnswerChange(question.questionId, { kind: "sentence_selection", sentenceId: sentence.sentenceId })}
          onKeyDown={readOnly ? undefined : (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            onAnswerChange(question.questionId, { kind: "sentence_selection", sentenceId: sentence.sentenceId });
          }}
          role={readOnly ? undefined : "radio"}
          style={readOnly ? undefined : rapFramelessInteractionStyle}
          tabIndex={readOnly ? undefined : 0}
        >
          {highlightedText}
        </span>
      );
    }
    return (
      <span data-sentence-id={sentence.sentenceId} data-sentence-order={sentence.sentenceOrder}>
        {highlightedText}
      </span>
    );
  };

  return (
    <ReadingTwoColumnPracticeShell
      left={(
      <DomTextLookupRegion enabled={lookupEnabled}>
      <article
        aria-labelledby="rap-passage-title"
        className={naturalFlow
          ? "min-w-0"
          : "min-w-0 lg:h-full lg:min-h-0 lg:overflow-y-auto"}
        data-passage-id={passage.passageId}
        data-testid="rap-passage"
        style={readingColumnStyle}
      >
        <div
          aria-label={question.questionType === "rap_sentence_insertion"
            ? "Candidate insertion positions"
            : question.questionType === "rap_sentence_selection"
              ? "Selectable passage sentences"
              : undefined}
          className="text-student-text"
          role={question.questionType === "rap_sentence_insertion" || question.questionType === "rap_sentence_selection"
            ? "radiogroup"
            : undefined}
          style={readingPassageTextStyle}
        >
          {orderedParagraphs.map((paragraph, paragraphIndex) => (
            <p
              className="last:mb-0"
              data-paragraph-id={paragraph.paragraphId}
              data-paragraph-order={paragraph.paragraphOrder}
              data-sentence-selection-target={sentenceTargetValidation?.valid
                && sentenceTargetValidation.paragraphId === paragraph.paragraphId
                ? "true"
                : undefined}
              key={paragraph.paragraphId}
              style={{ marginBottom: paragraphIndex === orderedParagraphs.length - 1 ? 0 : "1em" }}
            >
              {insertionBoundary(paragraph.paragraphId, 0)}
              {paragraph.sentences.map((sentence, sentenceIndex) => {
                const boundary = insertionBoundary(paragraph.paragraphId, sentenceIndex + 1);
                return (
                  <Fragment key={sentence.sentenceId}>
                    {renderSentence(paragraph, sentence)}
                    {boundary ?? (sentenceIndex < paragraph.sentences.length - 1 ? " " : null)}
                  </Fragment>
                );
              })}
            </p>
          ))}
        </div>
      </article>
      </DomTextLookupRegion>
      )}
      lookupEnabled={lookupEnabled}
      naturalFlow={naturalFlow}
      ratio="rap"
      right={(
      <ReadingQuestionColumn labelledBy="rap-question-stem" naturalFlow={naturalFlow}>
        {question.questionType === "rap_multiple_choice" ? (
          <>
            <h2 className="font-bold text-student-text" id="rap-question-stem" style={readingQuestionTextStyle}>
              {question.stem}
            </h2>
            <ChoiceOptionList
              labelledBy="rap-question-stem"
              onSelect={(optionId) => onAnswerChange(question.questionId, { kind: "choice", optionId })}
              options={question.options}
              readOnly={readOnly}
              reviewPresentation={reviewPresentation}
              selectedOptionId={selectedOptionId}
            />
          </>
        ) : question.questionType === "rap_sentence_insertion" && insertionValidation?.valid ? (
          <div className="font-normal text-student-text" data-testid="rap-insertion-instructions" style={readingQuestionTextStyle}>
            <p className="font-bold" id="rap-question-stem">
              There are four locations <RapInsertionMarker bracketed /> in the passage that indicate where the following sentence could be added.
            </p>
            <p data-testid="rap-insertion-prompt" style={{ marginTop: "1.75em" }}>
              {question.insertSentence}
            </p>
            <p style={{ marginTop: "1.75em" }}>
              Where would the sentence best fit? Select a location <RapInsertionMarker bracketed /> to add the sentence to the passage.
            </p>
          </div>
        ) : question.questionType === "rap_sentence_selection" && sentenceTargetValidation?.valid ? (
          <div className="font-bold text-student-text" data-testid="rap-sentence-selection-instructions" style={readingQuestionTextStyle}>
            <p id="rap-question-stem">{rapSentenceSelectionStem(question.stem)}</p>
            <p style={{ marginTop: "1.75em" }}>{rapSentenceSelectionInstruction()}</p>
          </div>
        ) : (
          <>
            <h2 className="font-bold text-student-text" id="rap-question-stem" style={readingQuestionTextStyle}>
              {question.stem}
            </h2>
            <p className="border-y border-student-border text-student-muted" data-testid="rap-interaction-unavailable" role="status" style={readingSpecialNoticeStyle}>
              这道题的文章定位暂时不可用，请稍后再试。
            </p>
          </>
        )}
      </ReadingQuestionColumn>
      )}
      testId="rap-workspace"
      title={passage.title}
      titleId="rap-passage-title"
    />
  );
}

function renderRapHighlightedText(
  text: string,
  sentenceStartOffset: number,
  ranges: StudentRapHighlightRange[]
) {
  const codePoints = Array.from(text);
  const sentenceEndOffset = sentenceStartOffset + codePoints.length;
  const overlapping = ranges.filter((range) =>
    range.startOffset < sentenceEndOffset && range.endOffset > sentenceStartOffset
  );
  if (overlapping.length === 0) return text;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  overlapping.forEach((range, index) => {
    const start = Math.max(range.startOffset, sentenceStartOffset) - sentenceStartOffset;
    const end = Math.min(range.endOffset, sentenceEndOffset) - sentenceStartOffset;
    if (start > cursor) nodes.push(codePoints.slice(cursor, start).join(""));
    nodes.push(
      <mark
        className="bg-student-primary font-bold text-white"
        data-testid="rap-source-highlight"
        key={`${range.paragraphId}:${range.startOffset}:${range.endOffset}:${index}`}
      >
        {codePoints.slice(start, end).join("")}
      </mark>
    );
    cursor = end;
  });
  if (cursor < codePoints.length) nodes.push(codePoints.slice(cursor).join(""));
  return nodes;
}

function RapInsertionMarker({ bracketed = false }: { bracketed?: boolean }) {
  const marker = <span className="inline text-student-primary" data-testid="rap-insertion-marker">■</span>;
  return <span aria-hidden="true" className="inline whitespace-nowrap">{bracketed ? <>[{marker}]</> : marker}</span>;
}

function ChoiceOptionList({
  labelledBy,
  onSelect,
  options,
  readOnly,
  reviewPresentation,
  selectedOptionId
}: {
  labelledBy: string;
  onSelect: (optionId: string) => void;
  options: StudentChoiceOption[];
  readOnly: boolean;
  reviewPresentation?: ReadingCorrectionAnswerPresentation;
  selectedOptionId: string | null;
}) {
  const orderedOptions = useMemo(
    () => [...options].sort((left, right) => left.optionOrder - right.optionOrder),
    [options]
  );

  return (
    <div aria-labelledby={labelledBy} className="flex flex-col" data-testid="reading-choice-options" role="radiogroup" style={readingChoiceListStyle}>
      {orderedOptions.map((option) => {
        const selected = selectedOptionId === option.optionId;
        const correctionState = readOnly
          ? readingCorrectionMarkState(reviewPresentation, "choice", option.optionId)
          : null;
        const optionTextClassName = correctionState === "correct"
          ? "font-bold text-student-primary"
          : correctionState === "incorrect"
            ? "font-bold text-student-error"
            : "font-normal text-inherit";
        return (
          <button
            aria-checked={selected}
            className="flex w-full items-start rounded-lg text-left font-normal text-student-text transition-colors hover:bg-student-primary-soft/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-student-primary"
            data-correction-state={correctionState ?? undefined}
            disabled={readOnly}
            key={option.optionId}
            onClick={readOnly ? undefined : () => onSelect(option.optionId)}
            role="radio"
            style={{ ...readingQuestionTextStyle, ...readingChoiceStyle }}
            type="button"
          >
            <span
              aria-hidden="true"
              className={`flex shrink-0 items-center justify-center rounded-full border-solid ${selected ? "border-student-primary" : "border-student-muted"}`}
              style={readingRadioStyle}
            >
              {selected ? <span className="rounded-full bg-student-primary" style={readingRadioDotStyle} /> : null}
            </span>
            <span className={optionTextClassName} data-option-text-state={correctionState ?? undefined}>{option.text}</span>
          </button>
        );
      })}
    </div>
  );
}

export function ReadingQuestionViewport({
  canGoNext = false,
  canGoPrevious = false,
  children,
  module,
  navigationDisabled = false,
  onNext = () => undefined,
  onPrevious = () => undefined,
  onSubmit,
  readOnly,
  submitError = "",
  submitDisabled = false,
  submitLabel = "Submit",
  submitting = false
}: {
  canGoNext?: boolean;
  canGoPrevious?: boolean;
  children: ReactNode;
  module: StudentReadingPracticePayload["item"]["module"];
  navigationDisabled?: boolean;
  onNext?: () => void;
  onPrevious?: () => void;
  onSubmit?: () => void;
  readOnly: boolean;
  submitError?: string;
  submitDisabled?: boolean;
  submitLabel?: string;
  submitting?: boolean;
}) {
  return (
    <div className="relative h-[calc(100dvh-92px)] min-h-0" data-testid="reading-question-viewport">
      <section className={module === "ctw"
        ? "mx-[52em] h-full overflow-y-auto rounded-2xl border border-student-border bg-white p-[28em] shadow-sm"
        : "mx-[52em] flex h-full min-h-0 flex-col overflow-hidden bg-white"}
      >
        {children}
      </section>
      <ReadingQuestionNavigation
        canGoNext={canGoNext}
        canGoPrevious={canGoPrevious}
        navigationDisabled={navigationDisabled}
        onNext={onNext}
        onPrevious={onPrevious}
        onSubmit={onSubmit}
        readOnly={readOnly}
        submitError={submitError}
        submitDisabled={submitDisabled}
        submitLabel={submitLabel}
        submitting={submitting}
      />
    </div>
  );
}

function ReadingQuestionNavigation({
  canGoNext,
  canGoPrevious,
  navigationDisabled,
  onNext,
  onPrevious,
  onSubmit,
  readOnly,
  submitError,
  submitDisabled,
  submitLabel,
  submitting,
}: {
  canGoNext: boolean;
  canGoPrevious: boolean;
  navigationDisabled: boolean;
  onNext: () => void;
  onPrevious: () => void;
  onSubmit?: () => void;
  readOnly: boolean;
  submitError: string;
  submitDisabled: boolean;
  submitLabel: string;
  submitting: boolean;
}) {
  const stepButtonClassName = "pointer-events-auto flex h-[72px] w-[48em] items-center justify-center bg-transparent text-student-primary transition-opacity hover:opacity-70 focus-visible:rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-student-primary disabled:cursor-default disabled:opacity-20";
  return (
    <nav
      aria-label="阅读题目导航"
      className="pointer-events-none absolute inset-0 z-20 flex items-center justify-between"
    >
      <button aria-label="Previous" className={stepButtonClassName} disabled={!canGoPrevious || navigationDisabled} onClick={onPrevious} type="button">
        <ChevronLeft aria-hidden="true" size="36em" strokeWidth={2.2} />
      </button>
      {canGoNext || readOnly ? (
        <button aria-label="Next" className={stepButtonClassName} disabled={!canGoNext || navigationDisabled} onClick={onNext} type="button">
          <ChevronRight aria-hidden="true" size="36em" strokeWidth={2.2} />
        </button>
      ) : (
        <button
          className="pointer-events-auto mr-[4em] min-h-[42px] rounded-xl bg-student-primary px-[14em] text-[14em] font-bold text-white shadow-sm disabled:opacity-60"
          disabled={submitDisabled || submitting}
          onClick={onSubmit}
          type="button"
        >
          {submitting ? "Submitting..." : submitLabel}
        </button>
      )}
      {submitError ? <p className="pointer-events-none absolute bottom-[4em] left-[52em] right-[52em] text-center text-[13em] font-semibold text-student-error">{submitError}</p> : null}
    </nav>
  );
}

export function ReadingPracticeMessage({
  description,
  onLeave,
  title
}: {
  description: string;
  onLeave?: () => void;
  title: string;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#fbfbfe] px-5">
      <section className="w-full max-w-md rounded-2xl border border-student-border bg-white p-8 text-center shadow-sm">
        <h1 className="text-xl font-bold text-student-text">{title}</h1>
        <p className="mt-3 text-sm leading-6 text-student-muted">{description}</p>
        {onLeave ? <button className="student-button-primary mt-6" onClick={onLeave} type="button">返回学生首页</button> : null}
      </section>
    </main>
  );
}
