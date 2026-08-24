"use client";

import clsx from "clsx";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Send,
  Sparkles,
  RefreshCw,
  Trash2,
  X
} from "lucide-react";
import Link from "next/link";
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject
} from "react";
import {
  TEACHER_WRITING_ASSIGNMENTS_CACHE_PREFIX,
  TEACHER_WRITING_REVIEWS_CACHE_KEY,
  TEACHER_WRITING_REVIEW_WORKSPACE_CACHE_PREFIX,
  useTeacherCachedData,
  useTeacherDataCache
} from "@/components/TeacherDataCache";
import {
  TeacherCard,
  TeacherDataError,
  TeacherLoadingRegion,
  TeacherSkeleton
} from "@/components/teacher/TeacherUI";
import { CollapsibleText } from "@/components/writing/CollapsibleText";
import { WritingRevisionMarkedText } from "@/components/writing/WritingRevisionMarkedText";
import { WritingOvertimeText } from "@/components/writing/WritingOvertimeText";
import { createBrowserSupabase } from "@/lib/supabase/client";
import type {
  AcademicDiscussionQuestion,
  EmailQuestion,
  WritingQuestion,
  WritingMode,
  WritingOvertimeRange,
  WritingTaskType
} from "@/lib/writing";
import { formatWritingAttemptSummary } from "@/lib/writing";
import type {
  WorkingContentFeedbackItem,
  WorkingLanguageEdit,
  WritingReviewWorkingDraft
} from "@/lib/writingReviewWorkspace";
import { recoverWritingReviewAfterUnknownOutcome } from "@/lib/writingReviewRequestRecovery";
import {
  TEACHER_REVIEW_CONTENT_REQUIRED_MESSAGE,
  hasTeacherContentFeedbackContent,
  hasTeacherLanguageEditContent,
  workingReviewItemSource
} from "@/lib/writingReviewWorkspace";
import {
  CONTENT_FEEDBACK_MARKER_CLASS,
  LANGUAGE_EDIT_OVERLAP_MESSAGE,
  adjacentLanguageEditId,
  buildWorkspaceAnnotationSegments,
  calculateContainedScrollTop,
  countTeacherEditedLanguageEdits,
  createTeacherContentFeedback,
  createTeacherLanguageEdit,
  filterLanguageEdits,
  hasWritingReviewTeacherContent,
  isLocatedContentFeedback,
  languageEditDisplayRange,
  languageEditSeverityLabel,
  languageEditSeverityMarkerClass,
  mergeRegeneratedDraftPreservingTeacherItems,
  mergeRegeneratedFeedback,
  overlapsLanguageEdit,
  selectionActionPosition,
  sourceTextSelection,
  updateDimensionScoreBasis,
  updateDimensionTeacherScore,
  updateOfficialScoreRationale,
  updateOfficialTeacherScore,
  writingDimensionDefinitions,
  writingFeedbackCategoryDefinitions,
  writingLanguageEditCategoryDefinitions,
  writingReviewCategoryLabel,
  type LanguageEditFilter,
  type SourceTextSelection
} from "@/lib/writingReviewWorkspaceUi";
import type { LanguageEditCategory } from "@/lib/writingReviewSchema";
import type { RubricScore } from "@/lib/writingReviewSchemaV2";
import { publishCacheInvalidation } from "@/lib/cacheInvalidation";
import {
  buildWritingRevisionComposition,
  hasApplicableContentRevision,
  type WritingRevisionComposition
} from "@/lib/writingReviewRevisionComposition";

type WorkspaceAttempt = {
  attempt_id: string;
  assignment_id: string | null;
  user_id: string;
  student_name: string;
  task_type: WritingTaskType;
  question_id: string;
  set_id: string;
  response_text: string;
  word_count: number;
  writing_mode: WritingMode | null;
  elapsed_seconds: number | null;
  overtime_ranges: WritingOvertimeRange[] | null;
  submitted_at: string | null;
};

type WorkspaceReview = WritingReviewWorkingDraft & {
  review_id: string | null;
  status: "pending" | "reviewing" | "published";
  has_ai_review: boolean;
  ai_model: string | null;
  ai_generated_at: string | null;
  ai_review_raw: unknown;
  published_content_feedback?: unknown;
  published_language_edits?: unknown;
  published_scores?: unknown;
  published_teacher_comment?: string | null;
  published_at: string | null;
  updated_at: string | null;
};

type WorkspacePayload = {
  attempt: WorkspaceAttempt;
  displayName: string;
  logicalDisplay: {
    itemId: string | null;
    displayNumber: string | null;
    displayTitle: string | null;
    displayName: string;
  } | null;
  question: WritingQuestion;
  question_source: "question_bank" | "custom" | null;
  reviewContext: "free_practice" | "assignment_question_bank" | "assignment_custom";
  review: WorkspaceReview;
};

type ErrorPayload = { code?: string; message?: string };
type WorkspaceMode = "workspace" | "original" | "revised";
type AiGenerationTeacherContentMode = "preserve" | "overwrite";
type InspectorPosition = { left: number; top: number };
type PositionedSourceSelection = SourceTextSelection & InspectorPosition;

const SCORE_OPTIONS = [0, 1, 2, 3, 4, 5] as const;
const FILTERS: Array<{ value: LanguageEditFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "major", label: "严重" },
  { value: "moderate", label: "一般" },
  { value: "minor", label: "轻微" }
];

export function TeacherWritingReviewWorkspace({
  attemptId,
  returnTo
}: {
  attemptId: string;
  returnTo: string;
}) {
  const cacheKey = `${TEACHER_WRITING_REVIEW_WORKSPACE_CACHE_PREFIX}:${attemptId}`;
  const cache = useTeacherDataCache();
  const { data, error, loading } = useTeacherCachedData<WorkspacePayload>(
    cacheKey,
    () => loadWorkspace(attemptId),
    { refreshOnMount: true }
  );
  const [draft, setDraft] = useState<WritingReviewWorkingDraft | null>(null);
  const [mode, setMode] = useState<WorkspaceMode>("workspace");
  const [showRevisionMarks, setShowRevisionMarks] = useState(true);
  const [filter, setFilter] = useState<LanguageEditFilter>("all");
  const [selectedEditId, setSelectedEditId] = useState<string | null>(null);
  const [selectedFeedbackId, setSelectedFeedbackId] = useState<string | null>(null);
  const [editingReplacement, setEditingReplacement] = useState(false);
  const [replacementText, setReplacementText] = useState("");
  const [editCategory, setEditCategory] = useState<LanguageEditCategory>("grammar");
  const [editExplanation, setEditExplanation] = useState("");
  const [inspectorPosition, setInspectorPosition] = useState<InspectorPosition | null>(null);
  const [pendingSelection, setPendingSelection] =
    useState<PositionedSourceSelection | null>(null);
  const [addReviewOpen, setAddReviewOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [operation, setOperation] = useState<"save" | "publish" | "regenerate" | null>(null);
  const operationRef = useRef<"save" | "publish" | "regenerate" | null>(null);
  const [teacherContentConfirmOpen, setTeacherContentConfirmOpen] = useState(false);
  const [highlightedEssayFeedbackId, setHighlightedEssayFeedbackId] = useState<string | null>(null);
  const essayHighlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [message, setMessage] = useState("");
  const [requestError, setRequestError] = useState("");
  const articleRef = useRef<HTMLDivElement>(null);
  const articleScrollRef = useRef<HTMLDivElement>(null);
  const rightColumnRef = useRef<HTMLElement>(null);
  const feedbackRefs = useRef<Record<string, HTMLElement | null>>({});
  const addReviewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!data) return;
    setDraft(toDraft(data.review));
    setSelectedEditId(data.review.language_edits[0]?.edit_id ?? null);
  }, [data]);
  useEffect(() => {
    function closeOnOutsidePointer(event: MouseEvent) {
      if (addReviewRef.current?.contains(event.target as Node)) return;
      setPendingSelection(null);
      setAddReviewOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setPendingSelection(null);
      setAddReviewOpen(false);
      window.getSelection()?.removeAllRanges();
    }
    document.addEventListener("mousedown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);
  useEffect(() => {
    if (!pendingSelection || addReviewOpen || !data) return;
    const responseText = data.attempt.response_text;
    let frame: number | null = null;
    function refreshSelectionPosition() {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!articleRef.current) return;
        const selection = window.getSelection();
        const mapped = mapBrowserSelectionToSource(
          selection,
          articleRef.current,
          responseText
        );
        const rect = selectionRangeRect(selection);
        if (!mapped || !rect) {
          setPendingSelection(null);
          return;
        }
        setPendingSelection({
          ...mapped,
          ...resolveSelectionActionPosition(rect)
        });
      });
    }
    window.addEventListener("resize", refreshSelectionPosition);
    window.addEventListener("scroll", refreshSelectionPosition, true);
    document.addEventListener("selectionchange", refreshSelectionPosition);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener("resize", refreshSelectionPosition);
      window.removeEventListener("scroll", refreshSelectionPosition, true);
      document.removeEventListener("selectionchange", refreshSelectionPosition);
    };
  }, [addReviewOpen, data, pendingSelection]);

  const filteredEdits = useMemo(
    () => (draft ? filterLanguageEdits(draft.language_edits, filter) : []),
    [draft, filter]
  );
  const selectedEdit = draft?.language_edits.find(
    (edit) => edit.edit_id === selectedEditId
  );
  const annotationSegments = useMemo(
    () =>
      data && draft
        ? buildWorkspaceAnnotationSegments(
            data.attempt.response_text,
            draft.language_edits,
            draft.content_feedback.items
          )
        : [],
    [data, draft]
  );
  const revisionComposition = useMemo(
    () =>
      data && draft
        ? buildWritingRevisionComposition(
            data.attempt.response_text,
            draft.language_edits,
            draft.content_feedback.items
          )
        : null,
    [data, draft]
  );
  const editedCount = useMemo(
    () =>
      data && draft
        ? countTeacherEditedLanguageEdits(data.review.ai_review_raw, draft.language_edits)
        : null,
    [data, draft]
  );

  function changeDraft(
    update: (current: WritingReviewWorkingDraft) => WritingReviewWorkingDraft
  ) {
    if (operation === "regenerate") return;
    setDraft((current) => (current ? update(current) : current));
    setDirty(true);
    setMessage("");
    setRequestError("");
  }

  function selectEdit(edit: WorkingLanguageEdit, anchorRect?: DOMRect) {
    setSelectedEditId(edit.edit_id);
    setEditingReplacement(false);
    setReplacementText(edit.replacement_text);
    setEditCategory(normalizeTeacherLanguageEditCategory(edit.category));
    setEditExplanation(edit.explanation);
    if (anchorRect) setInspectorPosition(resolveInspectorPosition(anchorRect));
  }

  function updateSelectedEdit(update: Partial<WorkingLanguageEdit>) {
    if (!selectedEditId) return;
    changeDraft((current) => ({
      ...current,
      language_edits: current.language_edits.map((edit) =>
        edit.edit_id === selectedEditId ? { ...edit, ...update } : edit
      )
    }));
  }

  function clearPendingSelection(clearBrowserSelection = false) {
    setPendingSelection(null);
    setAddReviewOpen(false);
    if (clearBrowserSelection) window.getSelection()?.removeAllRanges();
  }

  function addTeacherLanguageReview(input: {
    category: LanguageEditCategory;
    replacementText: string;
    explanation: string;
  }) {
    if (!pendingSelection || !draft) return "未找到有效原文选区。";
    if (overlapsLanguageEdit(pendingSelection, draft.language_edits)) {
      return LANGUAGE_EDIT_OVERLAP_MESSAGE;
    }
    const edit = createTeacherLanguageEdit({
      ...pendingSelection,
      category: input.category,
      replacementText: input.replacementText,
      explanation: input.explanation
    });
    changeDraft((current) => ({
      ...current,
      language_edits: [...current.language_edits, edit].sort(
        (left, right) => left.start - right.start || left.end - right.end
      )
    }));
    setSelectedEditId(edit.edit_id);
    clearPendingSelection(true);
    return null;
  }

  function addTeacherContentReview(input: {
    category: string;
    issue: string;
    suggestion: string;
    proposedRevision: string;
  }) {
    if (!pendingSelection) return "未找到有效原文选区。";
    const feedback = createTeacherContentFeedback({
      ...pendingSelection,
      category: input.category,
      issue: input.issue,
      suggestion: input.suggestion,
      proposedRevision: input.proposedRevision
    });
    changeDraft((current) => ({
      ...current,
      content_feedback: {
        ...current.content_feedback,
        items: [...current.content_feedback.items, feedback]
      }
    }));
    setSelectedFeedbackId(feedback.feedback_id);
    clearPendingSelection(true);
    return null;
  }

  function captureArticleSelection() {
    if (!data || !articleRef.current) return;
    const browserSelection = window.getSelection();
    const mapped = mapBrowserSelectionToSource(
      browserSelection,
      articleRef.current,
      data.attempt.response_text
    );
    if (!mapped || !browserSelection || browserSelection.rangeCount === 0) {
      clearPendingSelection();
      return;
    }
    const rect = selectionRangeRect(browserSelection);
    if (!rect) {
      clearPendingSelection();
      return;
    }
    const position = resolveSelectionActionPosition(rect);
    setPendingSelection({ ...mapped, ...position });
    setAddReviewOpen(false);
  }

  function moveEdit(direction: -1 | 1) {
    const nextId = adjacentLanguageEditId(filteredEdits, selectedEditId, direction);
    if (!nextId || !draft) return;
    const next = draft.language_edits.find((edit) => edit.edit_id === nextId);
    requestAnimationFrame(() => {
      const marker = document.querySelector<HTMLElement>(`[data-edit-id="${cssEscape(nextId)}"]`);
      marker?.scrollIntoView({
        behavior: "smooth",
        block: "center"
      });
      if (next) selectEdit(next, marker?.getBoundingClientRect());
    });
  }

  function selectFeedbackFromArticle(feedbackId: string) {
    setSelectedFeedbackId(feedbackId);
    requestAnimationFrame(() =>
      scrollTargetWithinContainer(rightColumnRef.current, feedbackRefs.current[feedbackId], 18)
    );
  }

  function openFeedbackFromRevisedEssay(feedbackId: string) {
    setMode("workspace");
    setSelectedFeedbackId(feedbackId);
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        scrollTargetWithinContainer(
          rightColumnRef.current,
          feedbackRefs.current[feedbackId],
          18
        )
      )
    );
  }

  function locateFeedbackInArticle(feedbackId: string) {
    setSelectedFeedbackId(feedbackId);
    if (essayHighlightTimer.current) clearTimeout(essayHighlightTimer.current);
    setHighlightedEssayFeedbackId(feedbackId);
    essayHighlightTimer.current = setTimeout(
      () => setHighlightedEssayFeedbackId(null),
      1100
    );
    requestAnimationFrame(() => {
      const target = articleRef.current?.querySelector<HTMLElement>(
        `[data-feedback-range~="${cssEscape(feedbackId)}"]`
      );
      scrollTargetWithinContainer(
        articleScrollRef.current,
        target ?? null,
        Math.round((articleScrollRef.current?.clientHeight ?? 0) * 0.25)
      );
    });
  }

  function requestAiGeneration() {
    if (!data || !draft || operationRef.current) return;
    if (
      dirty ||
      hasWritingReviewTeacherContent(
        draft,
        data.review.ai_review_raw,
        data.review.has_ai_review
      )
    ) {
      setTeacherContentConfirmOpen(true);
      return;
    }
    void regenerateAll("preserve");
  }

  async function regenerateAll(teacherContentMode: AiGenerationTeacherContentMode) {
    if (!data || !draft || operationRef.current) return;
    const hadAiReview = data.review.has_ai_review;
    operationRef.current = "regenerate";
    setTeacherContentConfirmOpen(false);
    setOperation("regenerate");
    setMessage("");
    setRequestError("");
    try {
      let currentPayload = data;
      let currentDraft = draft;
      if (teacherContentMode === "preserve" && dirty) {
        const savedReview = await mutateWorkspace(attemptId, draft, false);
        currentPayload = { ...data, review: savedReview };
        currentDraft = toDraft(savedReview);
        publishCacheInvalidation({
          type: "WRITING_REVIEW_UPDATED",
          studentId: data.attempt.user_id,
          attemptId,
          assignmentId: data.attempt.assignment_id
        });
        cache.set(cacheKey, currentPayload);
        updateCachedListStatus(cache, attemptId, "reviewing");
        setDraft(currentDraft);
        setDirty(false);
      }
      let review: WorkspaceReview;
      try {
        review = hadAiReview
          ? await regenerateFullReview(attemptId, teacherContentMode)
          : await generateInitialReview(attemptId, teacherContentMode);
      } catch (generationError) {
        if (
          hadAiReview ||
          !(generationError instanceof WritingReviewNetworkOutcomeUnknownError)
        ) {
          throw generationError;
        }
        const recovered = await confirmUnknownWritingReviewOutcome(
          "generate",
          attemptId,
          null
        );
        if (!recovered) throw generationError;
        review = recovered;
      }
      const nextPayload = { ...currentPayload, review };
      publishCacheInvalidation({
        type: "WRITING_REVIEW_UPDATED",
        studentId: data.attempt.user_id,
        attemptId,
        assignmentId: data.attempt.assignment_id
      });
      cache.set(cacheKey, nextPayload);
      updateCachedListStatus(cache, attemptId, review.status);
      const regeneratedDraft = toDraft(review);
      const nextDraft = teacherContentMode === "preserve"
        ? mergeRegeneratedDraftPreservingTeacherItems(
            data.attempt.response_text,
            regeneratedDraft,
            currentDraft
          )
        : regeneratedDraft;
      const preservedLocalTeacherItems =
        teacherContentMode === "preserve" &&
        (
          JSON.stringify(nextDraft.language_edits) !==
            JSON.stringify(regeneratedDraft.language_edits) ||
          JSON.stringify(nextDraft.content_feedback.items) !==
            JSON.stringify(regeneratedDraft.content_feedback.items)
        );
      setDraft(nextDraft);
      setSelectedEditId(null);
      setSelectedFeedbackId(null);
      setHighlightedEssayFeedbackId(null);
      setFilter("all");
      setInspectorPosition(null);
      setEditingReplacement(false);
      setDirty(preservedLocalTeacherItems);
      setMessage(
        preservedLocalTeacherItems
          ? "AI 初批已完成 · 教师手动批改已保留，请保存"
          : review.status === "published"
          ? "AI 初批已完成 · 有未发布修改"
          : hadAiReview
            ? "AI 初批已重新生成"
            : "AI 初批已完成"
      );
    } catch (regenerationError) {
      setRequestError(
        regenerationError instanceof Error
          ? regenerationError.message
          : "AI 初批失败，当前批改未改变。"
      );
    } finally {
      operationRef.current = null;
      setOperation(null);
    }
  }

  async function persist(publish: boolean) {
    if (!draft || !data || operationRef.current) return;
    const nextOperation = publish ? "publish" : "save";
    operationRef.current = nextOperation;
    setOperation(nextOperation);
    setMessage("");
    setRequestError("");
    try {
      let review: WorkspaceReview;
      try {
        review = await mutateWorkspace(attemptId, draft, publish);
      } catch (mutationError) {
        if (!(mutationError instanceof WritingReviewNetworkOutcomeUnknownError)) {
          throw mutationError;
        }
        const recovered = await confirmUnknownWritingReviewOutcome(
          publish ? "publish" : "save",
          attemptId,
          draft
        );
        if (!recovered) throw mutationError;
        review = recovered;
      }
      const nextPayload = { ...data, review };
      publishCacheInvalidation({
        type: publish ? "WRITING_REVIEW_PUBLISHED" : "WRITING_REVIEW_UPDATED",
        studentId: data.attempt.user_id,
        attemptId,
        assignmentId: data.attempt.assignment_id
      });
      cache.set(cacheKey, nextPayload);
      updateCachedListStatus(cache, attemptId, review.status);
      setDraft(toDraft(review));
      setDirty(false);
      setMessage(publish ? "已发布" : "已保存");
    } catch (mutationError) {
      setRequestError(
        mutationError instanceof Error
          ? mutationError.message
          : publish
            ? "发布失败，请稍后重试。"
            : "保存失败，请稍后重试。"
      );
    } finally {
      operationRef.current = null;
      setOperation(null);
    }
  }

  if (loading || !data || !draft) return <WorkspaceSkeleton error={error} />;

  const restoredCount = draft.language_edits.filter((edit) => edit.restored).length;
  const aiEditCount = draft.language_edits.filter(
    (edit) => workingReviewItemSource(edit) === "ai"
  ).length;
  const teacherEditCount = draft.language_edits.length - aiEditCount;
  const publishedWithLaterChanges =
    data.review.status === "published" &&
    (dirty || isLater(data.review.updated_at, data.review.published_at));
  function changeMode(nextMode: WorkspaceMode) {
    setMode(nextMode);
    setInspectorPosition(null);
    setEditingReplacement(false);
  }

  return (
    <div className="flex h-[calc(100dvh-24px)] min-h-0 flex-col overflow-hidden rounded-xl border border-student-border bg-white shadow-[0_2px_14px_rgba(60,47,119,0.06)]">
      <WorkspaceToolbar
        data={data}
        dirty={dirty}
        message={message}
        mode={mode}
        operation={operation}
        publishedWithLaterChanges={publishedWithLaterChanges}
        requestError={requestError}
        returnTo={returnTo}
        showRevisionMarks={showRevisionMarks}
        setMode={changeMode}
        setShowRevisionMarks={setShowRevisionMarks}
        onPersist={persist}
        onRegenerate={requestAiGeneration}
      />
      <StudentInfoBar data={data} />

      {mode === "original" ? (
        <FullscreenArticle title="学生原文">
          <p className="whitespace-pre-wrap">
            <WritingOvertimeText ranges={data.attempt.overtime_ranges} text={data.attempt.response_text} />
          </p>
        </FullscreenArticle>
      ) : mode === "revised" ? (
        <FullscreenArticle title="批改稿">
          {revisionComposition ? (
            <WritingRevisionMarkedText
              composition={revisionComposition}
              markerSegments={annotationSegments}
              marksVisible={showRevisionMarks}
              onSelectContentFeedback={openFeedbackFromRevisedEssay}
              onSelectLanguageEdit={selectEdit}
              selectedId={highlightedEssayFeedbackId ?? selectedEditId}
            />
          ) : null}
        </FullscreenArticle>
      ) : (
        <div className="writing-review-grid min-h-0 flex-1 bg-[#f8f7fc] p-2">
          <QuestionColumn question={data.question} taskType={data.attempt.task_type} />

          <section className="writing-review-column min-w-0 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-student-border px-3 py-2.5">
              <div>
                <h2 className="text-sm font-bold">学生原文（批改标记）</h2>
                <p className="mt-0.5 text-[11px] text-student-muted">
                  AI 修改 {aiEditCount} 处
                  {teacherEditCount > 0 ? ` · 教师修改 ${teacherEditCount} 处` : ""}
                  {editedCount !== null ? ` · 已编辑 ${editedCount} 处` : ""}
                  {` · 已恢复原文 ${restoredCount} 处`}
                </p>
              </div>
              <EditFilter
                edits={draft.language_edits}
                filter={filter}
                onChange={(value) => {
                  setFilter(value);
                  const next = filterLanguageEdits(draft.language_edits, value)[0];
                  if (next) selectEdit(next);
                }}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-5" ref={articleScrollRef}>
              <div
                className="mx-auto min-h-full max-w-[860px] whitespace-pre-wrap text-[15px] leading-8 text-student-text"
                onMouseUp={captureArticleSelection}
                ref={articleRef}
              >
              <AnnotatedText
                activeEditIds={new Set(filteredEdits.map((edit) => edit.edit_id))}
                marksVisible
                onSelectEdit={selectEdit}
                onSelectFeedback={selectFeedbackFromArticle}
                overtimeRanges={data.attempt.overtime_ranges}
                segments={annotationSegments}
                selectedEditId={selectedEditId}
                selectedFeedbackId={highlightedEssayFeedbackId}
                showFeedback
              />
              </div>
            </div>
          </section>

          <aside className="writing-review-column min-w-0 overflow-y-auto bg-white p-2.5" ref={rightColumnRef}>
            <ScorePanel
              hasAiReview={data.review.has_ai_review}
              onChange={(scores) => changeDraft((current) => ({ ...current, scores }))}
              scores={draft.scores}
              taskType={data.attempt.task_type}
            />
            <FeedbackPanel
              attemptId={attemptId}
              feedbackRefs={feedbackRefs}
              rightColumnRef={rightColumnRef}
              items={draft.content_feedback.items}
              onChange={changeDraft}
              onLocate={locateFeedbackInArticle}
              onRequestError={setRequestError}
              onSelectFeedbackId={setSelectedFeedbackId}
              selectedFeedbackId={selectedFeedbackId}
              taskType={data.attempt.task_type}
            />
            <CompactSection title="总体评价">
              <textarea
                className="min-h-24 w-full resize-y rounded-lg border border-student-border bg-white p-2.5 text-xs leading-5 focus:border-student-primary"
                onChange={(event) =>
                  changeDraft((current) => ({
                    ...current,
                    content_feedback: {
                      ...current.content_feedback,
                      overall_feedback: event.target.value
                    }
                  }))
                }
                placeholder="输入总体评价（选填）"
                value={draft.content_feedback.overall_feedback}
              />
            </CompactSection>
          </aside>
        </div>
      )}
      {pendingSelection ? (
        <div
          className="fixed z-[95]"
          ref={addReviewRef}
          style={{ left: pendingSelection.left, top: pendingSelection.top }}
        >
          {addReviewOpen ? (
            <AddReviewForm
              onAddContent={addTeacherContentReview}
              onAddLanguage={addTeacherLanguageReview}
              onCancel={() => clearPendingSelection(true)}
              selection={pendingSelection}
              taskType={data.attempt.task_type}
            />
          ) : (
            <button
              className="inline-flex items-center gap-1 rounded-lg border border-student-primary-border bg-white px-2.5 py-1.5 text-xs font-semibold text-student-primary shadow-[0_8px_24px_rgba(36,25,83,0.2)] hover:bg-student-primary-soft"
              onClick={() => {
                const rect = selectionRangeRect(window.getSelection());
                if (rect) {
                  setPendingSelection((current) => current ? {
                    ...current,
                    ...resolveSelectionFormPosition(rect)
                  } : current);
                }
                setAddReviewOpen(true);
              }}
              onMouseDown={(event) => event.preventDefault()}
              type="button"
            >
              <Plus size={13} />添加批改
            </button>
          )}
        </div>
      ) : null}
      {selectedEdit && inspectorPosition ? (
        <LanguageEditInspector
          coveredByContentRevision={Boolean(
            revisionComposition?.suppressedLanguageEditIds.has(selectedEdit.edit_id)
          )}
          edit={selectedEdit}
          editCategory={editCategory}
          editExplanation={editExplanation}
          filteredEdits={filteredEdits}
          editing={editingReplacement}
          onCancelEdit={() => setEditingReplacement(false)}
          onClose={() => {
            setInspectorPosition(null);
            setEditingReplacement(false);
          }}
          onEdit={() => {
            setReplacementText(selectedEdit.replacement_text);
            setEditCategory(normalizeTeacherLanguageEditCategory(selectedEdit.category));
            setEditExplanation(selectedEdit.explanation);
            setEditingReplacement(true);
          }}
          onCategoryChange={setEditCategory}
          onExplanationChange={setEditExplanation}
          onMove={moveEdit}
          onRestore={() => updateSelectedEdit({ restored: !selectedEdit.restored })}
          onDelete={
            workingReviewItemSource(selectedEdit) === "teacher"
              ? () => {
                  changeDraft((current) => ({
                    ...current,
                    language_edits: current.language_edits.filter(
                      (edit) => edit.edit_id !== selectedEdit.edit_id
                    )
                  }));
                  setSelectedEditId(null);
                  setInspectorPosition(null);
                }
              : undefined
          }
          onSaveEdit={() => {
            if (
              workingReviewItemSource(selectedEdit) === "teacher" &&
              !hasTeacherLanguageEditContent({
                replacement_text: replacementText,
                explanation: editExplanation
              })
            ) {
              return TEACHER_REVIEW_CONTENT_REQUIRED_MESSAGE;
            }
            updateSelectedEdit({
              replacement_text: replacementText,
              category: editCategory,
              explanation: editExplanation,
              restored: false
            });
            setEditingReplacement(false);
            return null;
          }}
          onTextChange={setReplacementText}
          position={inspectorPosition}
          replacementText={replacementText}
        />
      ) : null}
      {teacherContentConfirmOpen ? (
        <AiGenerationTeacherContentDialog
          onCancel={() => setTeacherContentConfirmOpen(false)}
          onOverwrite={() => void regenerateAll("overwrite")}
          onPreserve={() => void regenerateAll("preserve")}
        />
      ) : null}
    </div>
  );
}

function WorkspaceToolbar({
  data,
  dirty,
  message,
  mode,
  operation,
  publishedWithLaterChanges,
  requestError,
  returnTo,
  showRevisionMarks,
  setMode,
  setShowRevisionMarks,
  onPersist,
  onRegenerate
}: {
  data: WorkspacePayload;
  dirty: boolean;
  message: string;
  mode: WorkspaceMode;
  operation: "save" | "publish" | "regenerate" | null;
  publishedWithLaterChanges: boolean;
  requestError: string;
  returnTo: string;
  showRevisionMarks: boolean;
  setMode: (mode: WorkspaceMode) => void;
  setShowRevisionMarks: (show: boolean) => void;
  onPersist: (publish: boolean) => Promise<void>;
  onRegenerate: () => void;
}) {
  return (
    <header className="z-10 flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-student-border bg-white px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <Link
          aria-label="返回来源页面"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-student-primary hover:bg-student-primary-soft"
          href={returnTo}
        >
          <ArrowLeft aria-hidden="true" size={17} />
        </Link>
        <strong className="text-sm">写作批改</strong>
        <span className="text-student-muted">/</span>
        <span className="font-semibold text-student-primary">
          {data.review.status === "published"
            ? "已发布"
            : data.review.status === "pending"
              ? "待批改"
              : "批改中"}
        </span>
        <span className="hidden truncate text-student-muted sm:inline">
          / {data.displayName}
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Link
          className="teacher-button-secondary !min-h-8 !px-3 !py-1 text-xs"
          href={`/teacher/writing/reviews/logs?attempt_id=${encodeURIComponent(data.attempt.attempt_id)}`}
        >
          查看 AI 日志
        </Link>
        <div className="flex rounded-lg bg-student-bg p-0.5 text-xs font-semibold">
          {mode !== "workspace" ? (
            <ModeButton active={false} onClick={() => setMode("workspace")}>
              返回工作台
            </ModeButton>
          ) : null}
          <ModeButton active={mode === "original"} onClick={() => setMode("original")}>
            学生原文
          </ModeButton>
          <ModeButton active={mode === "revised"} onClick={() => setMode("revised")}>
            批改稿
          </ModeButton>
        </div>
        {mode === "revised" ? (
          <button
            className="rounded-md border border-student-primary-border bg-white px-2.5 py-1.5 text-xs font-semibold text-student-primary"
            onClick={() => setShowRevisionMarks(!showRevisionMarks)}
            type="button"
          >
            {showRevisionMarks ? "隐藏修改标记" : "显示修改标记"}
          </button>
        ) : null}
        <button
          className="teacher-button-secondary !min-h-8 !px-3 !py-1 text-xs"
          disabled={operation !== null}
          onClick={onRegenerate}
          type="button"
        >
          <RefreshCw aria-hidden="true" size={14} />
          {operation === "regenerate"
            ? data.review.has_ai_review
              ? "正在重新生成..."
              : "正在初批..."
            : data.review.has_ai_review
              ? "重新生成 AI 初批"
              : "AI 初批"}
        </button>
        <span className={clsx("text-[11px]", requestError ? "text-red-600" : "text-student-muted")}>
          {requestError ||
            (operation === "save"
              ? "保存中..."
              : operation === "publish"
                ? "发布中..."
                : operation === "regenerate"
                  ? data.review.has_ai_review
                    ? "正在重新生成..."
                    : "正在初批..."
                  : message ||
                  (dirty || publishedWithLaterChanges
                    ? "有未发布修改"
                    : data.review.status === "pending"
                      ? "尚未保存"
                      : "已保存"))}
        </span>
        <button
          className="teacher-button-secondary !min-h-8 !px-3 !py-1 text-xs"
          disabled={!dirty || operation !== null}
          onClick={() => void onPersist(false)}
          type="button"
        >
          <Save aria-hidden="true" size={14} />保存
        </button>
        <button
          className="teacher-button-primary !min-h-8 !px-3 !py-1 text-xs"
          disabled={operation !== null}
          onClick={() => void onPersist(true)}
          type="button"
        >
          <Send aria-hidden="true" size={14} />发布
        </button>
      </div>
    </header>
  );
}

function StudentInfoBar({ data }: { data: WorkspacePayload }) {
  const source = data.reviewContext === "free_practice"
    ? data.displayName
    : data.reviewContext === "assignment_question_bank"
      ? data.logicalDisplay
        ? `作业题目 · ${data.logicalDisplay.displayName}`
        : "作业题目"
      : "自定义作业题目";
  const items = [
    ["学生信息", data.attempt.student_name],
    ["题目类型", taskTypeLabel(data.attempt.task_type)],
    ["题目来源", source],
    ["提交时间", formatDate(data.attempt.submitted_at)],
    ["字数", String(data.attempt.word_count)],
    ["作答情况", formatWritingAttemptSummary(data.attempt.writing_mode, data.attempt.elapsed_seconds)],
    ["AI 初批时间", formatDate(data.review.ai_generated_at)]
  ];
  return (
    <div className="grid shrink-0 grid-cols-2 border-b border-student-border bg-[#fcfbff] sm:grid-cols-3 xl:grid-cols-7">
      {items.map(([label, value]) => (
        <div className="border-r border-student-border px-3 py-2 last:border-r-0" key={label}>
          <p className="text-[10px] font-medium text-student-muted">{label}</p>
          <p className="mt-0.5 truncate text-xs font-semibold text-student-text" title={value}>
            {value}
          </p>
        </div>
      ))}
    </div>
  );
}

function FullscreenArticle({
  children,
  title
}: {
  children: React.ReactNode;
  title: string;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-[#fbfaff] p-3 lg:p-5">
      <article className="mx-auto w-[min(1400px,calc(100vw-100px))] max-w-full rounded-xl border border-student-border bg-white p-5 text-[16px] leading-7 text-student-text shadow-sm lg:p-6">
        <h2 className="mb-3 text-base font-bold">{title}</h2>
        <div className="whitespace-pre-wrap">{children}</div>
      </article>
    </div>
  );
}

function QuestionColumn({
  question,
  taskType
}: {
  question: WritingQuestion;
  taskType: WritingTaskType;
}) {
  return (
    <aside className="writing-review-column min-w-0 overflow-y-auto bg-white p-2.5">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-bold">题目</h2>
        <span className="text-[11px] text-student-muted">({taskTypeLabel(taskType)})</span>
      </div>
      {taskType === "email" ? (
        <CompactEmailQuestion question={question as EmailQuestion} />
      ) : (
        <AcademicQuestionContent question={question as AcademicDiscussionQuestion} />
      )}
    </aside>
  );
}

function CompactEmailQuestion({ question }: { question: EmailQuestion }) {
  return (
    <div className="rounded-lg border border-student-border p-3 text-xs leading-5">
      <p>{question.scenario}</p>
      <p className="mt-3 font-bold">{question.task_instruction}</p>
      <ul className="mt-2 list-disc space-y-1.5 pl-4">
        <li>{question.requirement_1}</li>
        <li>{question.requirement_2}</li>
        <li>{question.requirement_3}</li>
      </ul>
    </div>
  );
}

function AcademicQuestionContent({ question }: { question: AcademicDiscussionQuestion }) {
  return (
    <div className="divide-y divide-student-border rounded-lg border border-student-border px-3 text-xs leading-5">
      <CompactSourcePost name={question.professor_name} text={question.professor_prompt} />
      <CompactSourcePost name={question.student_1_name} text={question.student_1_response} />
      <CompactSourcePost name={question.student_2_name} text={question.student_2_response} />
    </div>
  );
}

function CompactSourcePost({ name, text }: { name: string; text: string }) {
  return (
    <section className="py-3">
      <p className="font-bold">{name}</p>
      <p className="mt-1.5 whitespace-pre-wrap">{text}</p>
    </section>
  );
}

function AnnotatedText({
  activeEditIds,
  marksVisible,
  onSelectEdit,
  onSelectFeedback,
  overtimeRanges,
  segments,
  selectedEditId,
  selectedFeedbackId,
  showFeedback
}: {
  activeEditIds: Set<string>;
  marksVisible: boolean;
  onSelectEdit: (edit: WorkingLanguageEdit, anchorRect?: DOMRect) => void;
  onSelectFeedback: (feedbackId: string) => void;
  overtimeRanges: WritingOvertimeRange[] | null;
  segments: ReturnType<typeof buildWorkspaceAnnotationSegments>;
  selectedEditId: string | null;
  selectedFeedbackId: string | null;
  showFeedback: boolean;
}) {
  return (
    <>
        {segments.map((segment, index) => {
          const feedbackSelected = segment.feedbackIds.includes(selectedFeedbackId ?? "");
          const content = segment.edit && marksVisible ? (
            <>
              {showFeedback && segment.feedbackIds.length > 0 ? (
                <span aria-hidden="true" data-feedback-range={segment.feedbackIds.join(" ")} />
              ) : null}
              <WorkspaceEditMarker
                active={activeEditIds.has(segment.edit.edit_id)}
                edit={segment.edit}
                end={segment.end}
                index={indexForEdit(segments, segment.edit.edit_id)}
                onSelectEdit={onSelectEdit}
                overtimeRanges={overtimeRanges}
                selected={selectedEditId === segment.edit.edit_id}
                start={segment.start}
              />
            </>
          ) : (
            <span
              className={clsx(
                showFeedback && segment.feedbackIds.length > 0 && "border-b border-dashed border-student-primary/45",
                showFeedback && feedbackSelected && "bg-violet-100"
              )}
              data-feedback-range={showFeedback && segment.feedbackIds.length ? segment.feedbackIds.join(" ") : undefined}
              data-source-end={segment.end}
              data-source-start={segment.start}
              data-source-text
            >
              <WritingOvertimeText
                ranges={overtimeRanges}
                sourceStart={segment.start}
                text={segment.originalText}
              />
            </span>
          );
          return (
            <Fragment key={`${segment.start}-${segment.end}-${index}`}>
              {showFeedback ? segment.feedbackStarts.map((feedbackId) => (
                <button
                  className={clsx(
                    CONTENT_FEEDBACK_MARKER_CLASS,
                    selectedFeedbackId === feedbackId && "bg-violet-200"
                  )}
                  data-feedback-id={feedbackId}
                  key={feedbackId}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectFeedback(feedbackId);
                  }}
                  type="button"
                >
                  F{feedbackOrdinal(segments, feedbackId)}
                </button>
              )) : null}
              {content}
            </Fragment>
          );
        })}
    </>
  );
}

function WorkspaceRevisionText({
  activeEditIds,
  allEdits,
  composition,
  highlightedFeedbackId,
  onSelectEdit,
  onSelectFeedback,
  selectedEditId
}: {
  activeEditIds: Set<string>;
  allEdits: WorkingLanguageEdit[];
  composition: WritingRevisionComposition;
  highlightedFeedbackId: string | null;
  onSelectEdit: (edit: WorkingLanguageEdit, anchorRect?: DOMRect) => void;
  onSelectFeedback: (feedbackId: string) => void;
  selectedEditId: string | null;
}) {
  return (
    <>
      {composition.workspaceSegments.map((segment, index) => {
        if (segment.kind === "text") return segment.revisedText;
        if (segment.kind === "feedback_sentence") {
          const selected = highlightedFeedbackId === segment.feedback.feedback_id;
          return (
            <span
              className={clsx(
                "relative rounded-sm border-b border-dashed border-student-primary/45 transition-shadow",
                selected && "bg-violet-100 shadow-[0_0_0_3px_rgba(124,88,210,0.28)]"
              )}
              data-feedback-range={segment.feedback.feedback_id}
              key={`feedback-${segment.start}-${index}`}
            >
              <button
                className="mr-0.5 inline-flex translate-y-[-1px] items-center rounded bg-violet-100 px-1 py-0.5 text-[9px] font-bold leading-none text-student-primary hover:bg-violet-200"
                data-feedback-id={segment.feedback.feedback_id}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectFeedback(segment.feedback.feedback_id);
                }}
                type="button"
              >
                F{composition.workspaceSegments
                  .filter((item) => item.kind === "feedback_sentence")
                  .findIndex((item) => item.feedback.feedback_id === segment.feedback.feedback_id) + 1}
              </button>
              {segment.children.map((child, childIndex) =>
                child.kind === "text" ? child.revisedText : (
                  <WorkspaceEditMarker
                    active={activeEditIds.has(child.edit.edit_id)}
                    edit={child.edit}
                    end={child.end}
                    index={allEdits.findIndex((item) => item.edit_id === child.edit.edit_id) + 1}
                    key={`${child.edit.edit_id}-${childIndex}`}
                    onSelectEdit={onSelectEdit}
                    selected={selectedEditId === child.edit.edit_id}
                    start={child.start}
                  />
                )
              )}
            </span>
          );
        }
        return <WorkspaceEditMarker
          active={activeEditIds.has(segment.edit.edit_id)}
          edit={segment.edit}
          end={segment.end}
          index={allEdits.findIndex((item) => item.edit_id === segment.edit.edit_id) + 1}
          key={`edit-${segment.start}-${index}`}
          onSelectEdit={onSelectEdit}
          selected={selectedEditId === segment.edit.edit_id}
          start={segment.start}
        />;
      })}
    </>
  );
}

function WorkspaceEditMarker({
  active,
  edit,
  end,
  index,
  onSelectEdit,
  overtimeRanges,
  selected,
  start
}: {
  active: boolean;
  edit: WorkingLanguageEdit;
  end: number;
  index: number;
  onSelectEdit: (edit: WorkingLanguageEdit, anchorRect?: DOMRect) => void;
  overtimeRanges?: WritingOvertimeRange[] | null;
  selected: boolean;
  start: number;
}) {
  const displayRange = languageEditDisplayRange(edit);
  return (
    <span
      className="inline cursor-pointer p-0 align-baseline leading-[inherit] text-inherit"
      data-edit-id={edit.edit_id}
      onClick={(event) => {
        event.stopPropagation();
        onSelectEdit(edit, event.currentTarget.getBoundingClientRect());
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          onSelectEdit(edit, event.currentTarget.getBoundingClientRect());
        }
      }}
      role="button"
      tabIndex={0}
    >
      {displayRange.prefix ? (
        <span
          data-source-end={displayRange.sourceStart}
          data-source-start={start}
          data-source-text
        >
          <WritingOvertimeText ranges={overtimeRanges} sourceStart={start} text={displayRange.prefix} />
        </span>
      ) : null}
      <span className={editChangedTextClass(edit, active, selected)}>
        <span
          aria-label={displayRange.insertion ? "此处有插入修改" : undefined}
          className={displayRange.insertion ? "inline-block min-w-[3px] border-b-2 border-amber-500" : undefined}
          data-source-end={displayRange.sourceEnd}
          data-source-start={displayRange.sourceStart}
          data-source-text
        >
          {displayRange.changedOriginal ? (
            <WritingOvertimeText
              ranges={overtimeRanges}
              sourceStart={displayRange.sourceStart}
              text={displayRange.changedOriginal}
            />
          ) : displayRange.insertion ? "\u200b" : ""}
        </span>
        {!edit.restored && active ? (
          <sup
            className={clsx("ml-0.5 select-none text-[9px] font-bold leading-[0]", selected && "text-student-primary")}
          >
            {index}
          </sup>
        ) : null}
      </span>
      {displayRange.suffix ? (
        <span
          data-source-end={end}
          data-source-start={displayRange.sourceEnd}
          data-source-text
        >
          <WritingOvertimeText
            ranges={overtimeRanges}
            sourceStart={displayRange.sourceEnd}
            text={displayRange.suffix}
          />
        </span>
      ) : null}
    </span>
  );
}

function AddReviewForm({
  onAddContent,
  onAddLanguage,
  onCancel,
  selection,
  taskType
}: {
  onAddContent: (input: {
    category: string;
    issue: string;
    suggestion: string;
    proposedRevision: string;
  }) => string | null;
  onAddLanguage: (input: {
    category: LanguageEditCategory;
    replacementText: string;
    explanation: string;
  }) => string | null;
  onCancel: () => void;
  selection: SourceTextSelection;
  taskType: WritingTaskType;
}) {
  const languageCategories = writingLanguageEditCategoryDefinitions();
  const feedbackCategories = writingFeedbackCategoryDefinitions(taskType);
  const [type, setType] = useState(`language:${languageCategories[0].key}`);
  const [replacementText, setReplacementText] = useState("");
  const [explanation, setExplanation] = useState("");
  const [issue, setIssue] = useState("");
  const [suggestion, setSuggestion] = useState("");
  const [proposedRevision, setProposedRevision] = useState("");
  const [formError, setFormError] = useState("");
  const language = type.startsWith("language:");

  function save() {
    const [, category] = type.split(":", 2);
    const error = language
      ? hasTeacherLanguageEditContent({
          replacement_text: replacementText,
          explanation
        })
        ? onAddLanguage({
            category: category as LanguageEditCategory,
            replacementText,
            explanation
          })
        : TEACHER_REVIEW_CONTENT_REQUIRED_MESSAGE
      : hasTeacherContentFeedbackContent({
          issue,
          suggestion,
          proposed_revision: proposedRevision
        })
        ? onAddContent({ category, issue, suggestion, proposedRevision })
        : TEACHER_REVIEW_CONTENT_REQUIRED_MESSAGE;
    setFormError(error ?? "");
  }

  return (
    <div className="max-h-[min(620px,calc(100dvh-24px))] w-[360px] overflow-y-auto rounded-xl border border-student-primary-border bg-white p-3 text-xs shadow-[0_16px_48px_rgba(36,25,83,0.24)]">
      <div className="flex items-center justify-between gap-2">
        <strong>添加批改</strong>
        <button aria-label="关闭新增批改" onClick={onCancel} type="button">
          <X size={15} />
        </button>
      </div>
      <p className="mt-2 text-[10px] font-semibold text-student-muted">对应原文</p>
      <p className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap rounded-lg bg-student-bg p-2 leading-5">
        {selection.originalText}
      </p>
      <label className="mt-3 block text-[10px] font-semibold">
        修改类型
        <select
          className="mt-1 w-full rounded-lg border border-student-border bg-white p-2 text-xs"
          onChange={(event) => {
            setType(event.target.value);
            setFormError("");
          }}
          value={type}
        >
          <optgroup label="语言修改">
            {languageCategories.map((category) => (
              <option key={category.key} value={`language:${category.key}`}>
                {category.label}
              </option>
            ))}
          </optgroup>
          <optgroup label="内容与结构反馈">
            {feedbackCategories.map((category) => (
              <option key={category.key} value={`feedback:${category.key}`}>
                {category.label}
              </option>
            ))}
          </optgroup>
        </select>
      </label>
      {language ? (
        <>
          <FormTextarea
            label="修改为"
            onChange={setReplacementText}
            value={replacementText}
          />
          <FormTextarea
            label="修改说明"
            onChange={setExplanation}
            value={explanation}
          />
        </>
      ) : (
        <>
          <FormTextarea
            label="问题 / 修改意见"
            onChange={setIssue}
            value={issue}
          />
          <FormTextarea
            label="修改建议"
            onChange={setSuggestion}
            value={suggestion}
          />
          <FormTextarea
            label="建议改写"
            onChange={setProposedRevision}
            value={proposedRevision}
          />
        </>
      )}
      {formError ? (
        <p className="mt-2 rounded bg-red-50 p-2 text-[10px] text-red-700">
          {formError}
        </p>
      ) : null}
      <div className="mt-3 flex justify-end gap-1.5">
        <MiniButton onClick={onCancel}>取消</MiniButton>
        <MiniButton onClick={save} primary>保存</MiniButton>
      </div>
    </div>
  );
}

function FormTextarea({
  label,
  onChange,
  value
}: {
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="mt-3 block text-[10px] font-semibold">
      {label}
      <textarea
        className="mt-1 min-h-16 w-full resize-y rounded-lg border border-student-border bg-white p-2 text-xs leading-5"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      />
    </label>
  );
}

function LanguageEditInspector({
  coveredByContentRevision,
  edit,
  editCategory,
  editExplanation,
  filteredEdits,
  editing,
  onCancelEdit,
  onCategoryChange,
  onDelete,
  onEdit,
  onExplanationChange,
  onMove,
  onRestore,
  onSaveEdit,
  onTextChange,
  onClose,
  position,
  replacementText
}: {
  coveredByContentRevision: boolean;
  edit: WorkingLanguageEdit;
  editCategory: LanguageEditCategory;
  editExplanation: string;
  filteredEdits: WorkingLanguageEdit[];
  editing: boolean;
  onCancelEdit: () => void;
  onCategoryChange: (value: LanguageEditCategory) => void;
  onDelete?: () => void;
  onEdit: () => void;
  onExplanationChange: (value: string) => void;
  onMove: (direction: -1 | 1) => void;
  onRestore: () => void;
  onSaveEdit: () => string | null;
  onTextChange: (value: string) => void;
  onClose: () => void;
  position: InspectorPosition;
  replacementText: string;
}) {
  const itemPosition = filteredEdits.findIndex((item) => item.edit_id === edit.edit_id);
  const teacherSource = workingReviewItemSource(edit) === "teacher";
  const [validationError, setValidationError] = useState("");
  useEffect(() => setValidationError(""), [edit.edit_id, editing]);
  return (
    <aside
      className="fixed z-[90] max-h-[min(560px,calc(100dvh-24px))] w-[340px] overflow-y-auto rounded-xl border border-student-primary-border bg-white p-3 shadow-[0_16px_48px_rgba(36,25,83,0.24)]"
      data-floating-inspector
      style={{ left: position.left, top: position.top }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className={severityBadgeClass(edit.severity)}>{severityLabel(edit.severity)}</span>
          <SourceBadge source={workingReviewItemSource(edit)} />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-student-muted">第 {itemPosition >= 0 ? itemPosition + 1 : "—"} 项 / 共 {filteredEdits.length} 项</span>
          <button aria-label="关闭修改详情" className="text-student-muted hover:text-student-text" onClick={onClose} type="button"><X size={15} /></button>
        </div>
      </div>
      <div className="mt-2 flex gap-1">
        <MiniButton disabled={filteredEdits.length === 0} onClick={() => onMove(-1)}>
          <ChevronLeft size={13} />上一项
        </MiniButton>
        <MiniButton disabled={filteredEdits.length === 0} onClick={() => onMove(1)}>
          下一项<ChevronRight size={13} />
        </MiniButton>
      </div>
      {coveredByContentRevision ? (
        <p className="mt-2 rounded-lg bg-amber-50 p-2 text-[10px] leading-4 text-amber-800">
          该修改所在原句已采用内容建议改写；批改稿会优先使用整句改写，本条语言修改仍保留供单独查看。
        </p>
      ) : null}
      <Detail label="学生原文" value={edit.original_text} />
      <div className="mt-3">
        <p className="text-[10px] font-semibold text-student-muted">当前修改</p>
        {editing ? (
          <textarea
            className="mt-1 min-h-20 w-full rounded-lg border border-student-border bg-white p-2 text-xs leading-5"
            onChange={(event) => onTextChange(event.target.value)}
            value={replacementText}
          />
        ) : (
          <p className="mt-1 whitespace-pre-wrap text-xs leading-5">
            {edit.replacement_text || "（删除原文）"}
          </p>
        )}
      </div>
      {editing && teacherSource ? (
        <label className="mt-3 block text-[10px] font-semibold text-student-muted">
          错误类型
          <select
            className="mt-1 w-full rounded-lg border border-student-border bg-white p-2 text-xs text-student-text"
            onChange={(event) => onCategoryChange(event.target.value as LanguageEditCategory)}
            value={editCategory}
          >
            {writingLanguageEditCategoryDefinitions().map((category) => (
              <option key={category.key} value={category.key}>{category.label}</option>
            ))}
          </select>
        </label>
      ) : (
        <Detail label="错误类型" value={writingReviewCategoryLabel(edit.category)} />
      )}
      {editing && teacherSource ? (
        <FormTextarea
          label="修改说明"
          onChange={onExplanationChange}
          value={editExplanation}
        />
      ) : (
        <Detail label="修改说明" value={edit.explanation || "（未填写）"} />
      )}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {editing ? (
          <>
            <MiniButton
              primary
              onClick={() => setValidationError(onSaveEdit() ?? "")}
            >
              确定
            </MiniButton>
            <MiniButton onClick={onCancelEdit}>取消</MiniButton>
          </>
        ) : (
          <MiniButton onClick={onEdit}><Pencil size={13} />编辑修改</MiniButton>
        )}
        <MiniButton onClick={onRestore}>
          <RotateCcw size={13} />{edit.restored ? "恢复修改" : "恢复原文"}
        </MiniButton>
        {onDelete ? (
          <MiniButton onClick={onDelete}><Trash2 size={13} />删除</MiniButton>
        ) : null}
      </div>
      {validationError ? (
        <p className="mt-2 rounded bg-red-50 p-2 text-[10px] text-red-700">
          {validationError}
        </p>
      ) : null}
    </aside>
  );
}

function EditFilter({
  edits,
  filter,
  onChange
}: {
  edits: WorkingLanguageEdit[];
  filter: LanguageEditFilter;
  onChange: (filter: LanguageEditFilter) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1" aria-label="修改筛选">
      {FILTERS.map((item) => {
        const count = filterLanguageEdits(edits, item.value).length;
        return (
          <button
            className={clsx(
              "rounded-md border px-1.5 py-1 text-[10px] font-semibold",
              filter === item.value
                ? "border-student-primary bg-student-primary-soft text-student-primary"
                : "border-student-border bg-white text-student-muted"
            )}
            key={item.value}
            onClick={() => onChange(item.value)}
            type="button"
          >
            {item.label} {count}
          </button>
        );
      })}
    </div>
  );
}

function ScorePanel({
  hasAiReview,
  onChange,
  scores,
  taskType
}: {
  hasAiReview: boolean;
  onChange: (scores: WritingReviewWorkingDraft["scores"]) => void;
  scores: WritingReviewWorkingDraft["scores"];
  taskType: WritingTaskType;
}) {
  const definitions = writingDimensionDefinitions(taskType);
  return (
    <CompactSection title="评分" subtitle="依据 TOEFL 官方 Writing Rubric">
      {scores.dimension_scores ? (
        <div className="overflow-hidden rounded-lg border border-student-border">
          <div className="grid grid-cols-[minmax(104px,1.1fr)_44px_56px_minmax(130px,1.4fr)] bg-student-bg px-2 py-1.5 text-[9px] font-semibold text-student-muted">
            <span>评分维度</span><span>AI</span><span>教师</span><span>依据</span>
          </div>
          {definitions.map((definition, index) => {
            const dimension = scores.dimension_scores?.[definition.key as keyof typeof scores.dimension_scores];
            if (!dimension) return null;
            return (
              <div
                className="grid grid-cols-[minmax(104px,1.1fr)_44px_56px_minmax(130px,1.4fr)] items-start gap-1 border-t border-student-border px-2 py-2 text-[10px] leading-4"
                key={definition.key}
              >
                <div><strong>{index + 1}. {definition.zh}</strong><p className="text-[9px] text-student-muted">{definition.en}</p></div>
                <strong className="text-student-primary">
                  {hasAiReview ? dimension.ai_score : "—"}
                </strong>
                <ScoreSelect
                  onChange={(value) =>
                    onChange(updateDimensionTeacherScore(scores, definition.key, value))
                  }
                  value={dimension.teacher_score}
                />
                <textarea
                  aria-label={`${definition.zh}评分依据`}
                  className="h-14 w-full resize-none rounded-md border border-student-border bg-white px-2 py-1.5 text-[10px] leading-4 text-student-text focus:border-student-primary"
                  onChange={(event) =>
                    onChange(
                      updateDimensionScoreBasis(
                        scores,
                        definition.key,
                        event.target.value
                      )
                    )
                  }
                  placeholder="选填"
                  value={dimension.ai_basis}
                />
              </div>
            );
          })}
        </div>
      ) : (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-800">
          旧版批改数据：没有可用的四项诊断评分。
        </p>
      )}
      <div className="mt-2 rounded-lg border border-student-primary-border bg-student-primary-soft/30 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-xs font-bold">官方整体评分</p>
            <p className="mt-1 text-[10px] font-semibold text-student-primary">
              AI：{hasAiReview ? scores.official_score.ai_score : "—"}
            </p>
          </div>
          <label className="flex items-center gap-1 text-[10px] font-semibold">
            教师最终
            <ScoreSelect
              onChange={(value) => onChange(updateOfficialTeacherScore(scores, value))}
              value={scores.official_score.teacher_score}
            />
          </label>
        </div>
        <label className="mt-2 block text-[10px] font-semibold text-student-muted">
          参考
          <textarea
            aria-label="官方整体评分参考"
            className="mt-1 h-16 w-full resize-none rounded-md border border-student-border bg-white px-2 py-1.5 text-[10px] font-normal leading-4 text-student-text focus:border-student-primary"
            onChange={(event) =>
              onChange(updateOfficialScoreRationale(scores, event.target.value))
            }
            placeholder="选填"
            value={scores.official_score.rationale}
          />
        </label>
      </div>
    </CompactSection>
  );
}

function FeedbackPanel({
  attemptId,
  feedbackRefs,
  rightColumnRef,
  items,
  onChange,
  onLocate,
  onRequestError,
  onSelectFeedbackId,
  selectedFeedbackId,
  taskType
}: {
  attemptId: string;
  feedbackRefs: MutableRefObject<Record<string, HTMLElement | null>>;
  rightColumnRef: MutableRefObject<HTMLElement | null>;
  items: WorkingContentFeedbackItem[];
  onChange: (update: (current: WritingReviewWorkingDraft) => WritingReviewWorkingDraft) => void;
  onLocate: (feedbackId: string) => void;
  onRequestError: (message: string) => void;
  onSelectFeedbackId: (feedbackId: string) => void;
  selectedFeedbackId: string | null;
  taskType: WritingTaskType;
}) {
  const categories = writingFeedbackCategoryDefinitions(taskType).filter((category) =>
    items.some((item) => item.category === category.key)
  );
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [highlightedFeedbackId, setHighlightedFeedbackId] = useState<string | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const selected = items.find((item) => item.feedback_id === selectedFeedbackId);
    if (selected && selected.category !== activeCategory) {
      setActiveCategory(selected.category);
      return;
    }
    if (activeCategory && categories.some((category) => category.key === activeCategory)) return;
    setActiveCategory(categories[0]?.key ?? null);
  }, [activeCategory, categories, items, selectedFeedbackId]);
  useEffect(() => {
    if (!selectedFeedbackId) return;
    requestAnimationFrame(() => {
      scrollTargetWithinContainer(
        rightColumnRef.current,
        feedbackRefs.current[selectedFeedbackId],
        18
      );
      flashFeedback(selectedFeedbackId);
    });
  }, [activeCategory, feedbackRefs, rightColumnRef, selectedFeedbackId]);
  useEffect(
    () => () => {
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
    },
    []
  );
  function flashFeedback(feedbackId: string) {
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    setHighlightedFeedbackId(feedbackId);
    highlightTimer.current = setTimeout(() => setHighlightedFeedbackId(null), 1100);
  }
  function selectCategory(category: string) {
    setActiveCategory(category);
    const first = items.find((item) => item.category === category);
    if (!first) return;
    onSelectFeedbackId(first.feedback_id);
    requestAnimationFrame(() => {
      scrollTargetWithinContainer(rightColumnRef.current, feedbackRefs.current[first.feedback_id], 18);
      flashFeedback(first.feedback_id);
    });
  }
  const visibleItems = activeCategory
    ? items.filter((item) => item.category === activeCategory)
    : items;
  return (
    <CompactSection title="内容与结构反馈" subtitle="AI 与教师">
      {categories.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1">
          {categories.map((category) => (
            <button
              className={clsx(
                "rounded-md px-1.5 py-1 text-[10px] font-semibold",
                activeCategory === category.key
                  ? "bg-student-primary text-white"
                  : "bg-student-primary-soft text-student-primary"
              )}
              key={category.key}
              onClick={() => selectCategory(category.key)}
              type="button"
            >
              {category.label}（{items.filter((item) => item.category === category.key).length}）
            </button>
          ))}
        </div>
      ) : null}
      <div className="grid gap-2">
        {visibleItems.map((item) => (
          <FeedbackCard
            attemptId={attemptId}
            item={item}
            key={item.feedback_id}
            onChange={onChange}
            onLocate={onLocate}
            onRequestError={onRequestError}
            selected={selectedFeedbackId === item.feedback_id || highlightedFeedbackId === item.feedback_id}
            setRef={(element) => {
              feedbackRefs.current[item.feedback_id] = element;
            }}
            taskType={taskType}
          />
        ))}
        {items.length === 0 ? <p className="text-xs text-student-muted">暂无内容反馈。</p> : null}
      </div>
    </CompactSection>
  );
}

function FeedbackCard({
  attemptId,
  item,
  onChange,
  onLocate,
  onRequestError,
  selected,
  setRef,
  taskType
}: {
  attemptId: string;
  item: WorkingContentFeedbackItem;
  onChange: (update: (current: WritingReviewWorkingDraft) => WritingReviewWorkingDraft) => void;
  onLocate: (feedbackId: string) => void;
  onRequestError: (message: string) => void;
  selected: boolean;
  setRef: (element: HTMLElement | null) => void;
  taskType: WritingTaskType;
}) {
  const located = isLocatedContentFeedback(item);
  const teacherSource = workingReviewItemSource(item) === "teacher";
  const [formOpen, setFormOpen] = useState(false);
  const [teacherEditOpen, setTeacherEditOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [regenerating, setRegenerating] = useState(false);
  const [teacherCategory, setTeacherCategory] = useState(
    normalizeTeacherContentFeedbackCategory(taskType, item.category)
  );
  const [teacherIssue, setTeacherIssue] = useState(item.issue);
  const [teacherSuggestion, setTeacherSuggestion] = useState(item.suggestion);
  const [teacherRevision, setTeacherRevision] = useState(
    "proposed_revision" in item ? item.proposed_revision : ""
  );
  const [teacherEditError, setTeacherEditError] = useState("");
  async function regenerate() {
    if (!prompt.trim() || regenerating) return;
    setRegenerating(true);
    onRequestError("");
    try {
      const result = await regenerateFeedback(attemptId, item.feedback_id, prompt);
      onChange((current) => mergeRegeneratedFeedback(current, result));
      setFormOpen(false);
      setPrompt("");
    } catch (error) {
      onRequestError(error instanceof Error ? error.message : "重新生成失败，请稍后重试。");
    } finally {
      setRegenerating(false);
    }
  }
  return (
    <article
      className={clsx(
        "rounded-lg border p-2.5 text-[11px] leading-[1.55] transition",
        item.included ? "bg-white" : "bg-student-bg opacity-55",
        selected ? "border-student-primary ring-2 ring-violet-200" : "border-student-border"
      )}
      onClick={() => located && onLocate(item.feedback_id)}
      ref={setRef}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className="font-semibold text-student-primary">{writingReviewCategoryLabel(item.category)}</span>
          <SourceBadge source={workingReviewItemSource(item)} />
        </div>
        <span className="text-[9px] font-semibold text-student-muted">{item.included ? "已采用" : "未采用"}</span>
      </div>
      {located ? (
        <FeedbackLine label="对应原句" value={item.original_sentence} />
      ) : (
        <p className="mt-2 rounded bg-amber-50 p-1.5 text-[10px] text-amber-800">
          旧版反馈不支持句子定位
        </p>
      )}
      <FeedbackLine label="问题" value={item.issue} />
      <FeedbackLine label="建议" value={item.suggestion} />
      {hasApplicableContentRevision(item) ? (
        <FeedbackLine label="建议改写" value={item.proposed_revision} />
      ) : located && !teacherSource ? (
        <p className="mt-2 rounded bg-amber-50 p-1.5 text-[10px] text-amber-800">
          旧版反馈暂无可应用改写
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-1.5" onClick={(event) => event.stopPropagation()}>
        <MiniButton
          onClick={() =>
            onChange((current) => ({
              ...current,
              content_feedback: {
                ...current.content_feedback,
                items: current.content_feedback.items.map((currentItem) =>
                  currentItem.feedback_id === item.feedback_id
                    ? { ...currentItem, included: !currentItem.included }
                    : currentItem
                )
              }
            }))
          }
        >
          {item.included ? "不采用" : "恢复采用"}
        </MiniButton>
        {hasApplicableContentRevision(item) && !teacherSource ? (
          <MiniButton disabled={regenerating} onClick={() => setFormOpen((open) => !open)}>
            <Sparkles size={12} />{regenerating ? "正在重新生成..." : "重新生成"}
          </MiniButton>
        ) : null}
        {teacherSource ? (
          <>
            <MiniButton onClick={() => setTeacherEditOpen((open) => !open)}>
              <Pencil size={12} />编辑
            </MiniButton>
            <MiniButton
              onClick={() =>
                onChange((current) => ({
                  ...current,
                  content_feedback: {
                    ...current.content_feedback,
                    items: current.content_feedback.items.filter(
                      (currentItem) => currentItem.feedback_id !== item.feedback_id
                    )
                  }
                }))
              }
            >
              <Trash2 size={12} />删除
            </MiniButton>
          </>
        ) : null}
      </div>
      {teacherEditOpen ? (
        <div className="mt-2 rounded-lg border border-student-primary-border bg-student-primary-soft/25 p-2" onClick={(event) => event.stopPropagation()}>
          <label className="text-[10px] font-semibold">
            反馈类型
            <select
              className="mt-1 w-full rounded-md border border-student-border bg-white p-1.5 text-xs"
              onChange={(event) => setTeacherCategory(event.target.value)}
              value={teacherCategory}
            >
              {writingFeedbackCategoryDefinitions(taskType).map((category) => (
                <option key={category.key} value={category.key}>{category.label}</option>
              ))}
            </select>
          </label>
          <FormTextarea label="问题 / 修改意见" onChange={(value) => {
            setTeacherIssue(value);
            setTeacherEditError("");
          }} value={teacherIssue} />
          <FormTextarea label="修改建议" onChange={(value) => {
            setTeacherSuggestion(value);
            setTeacherEditError("");
          }} value={teacherSuggestion} />
          <FormTextarea label="建议改写" onChange={(value) => {
            setTeacherRevision(value);
            setTeacherEditError("");
          }} value={teacherRevision} />
          {teacherEditError ? (
            <p className="mt-2 rounded bg-red-50 p-2 text-[10px] text-red-700">
              {teacherEditError}
            </p>
          ) : null}
          <div className="mt-2 flex justify-end gap-1.5">
            <MiniButton onClick={() => setTeacherEditOpen(false)}>取消</MiniButton>
            <MiniButton
              onClick={() => {
                if (!hasTeacherContentFeedbackContent({
                  issue: teacherIssue,
                  suggestion: teacherSuggestion,
                  proposed_revision: teacherRevision
                })) {
                  setTeacherEditError(TEACHER_REVIEW_CONTENT_REQUIRED_MESSAGE);
                  return;
                }
                onChange((current) => ({
                  ...current,
                  content_feedback: {
                    ...current.content_feedback,
                    items: current.content_feedback.items.map((currentItem) =>
                      currentItem.feedback_id === item.feedback_id
                        ? {
                            ...currentItem,
                            category: teacherCategory,
                            issue: teacherIssue,
                            suggestion: teacherSuggestion,
                            proposed_revision: teacherRevision
                          } as WorkingContentFeedbackItem
                        : currentItem
                    )
                  }
                }));
                setTeacherEditOpen(false);
              }}
              primary
            >
              保存
            </MiniButton>
          </div>
        </div>
      ) : null}
      {formOpen ? (
        <div className="mt-2 rounded-lg border border-student-primary-border bg-student-primary-soft/25 p-2" onClick={(event) => event.stopPropagation()}>
          <label className="text-[10px] font-semibold">教师要求</label>
          <textarea
            className="mt-1 min-h-20 w-full resize-y rounded-md border border-student-border bg-white p-2 text-xs leading-5"
            maxLength={2000}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="例如：请重点分析这个例子为什么展开不足，并给出更具体的改写建议。"
            value={prompt}
          />
          <div className="mt-1.5 flex justify-end gap-1.5">
            <MiniButton onClick={() => setFormOpen(false)}>取消</MiniButton>
            <MiniButton disabled={!prompt.trim() || regenerating} onClick={() => void regenerate()} primary>
              {regenerating ? "正在重新生成..." : "重新生成"}
            </MiniButton>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function CompactSection({
  children,
  subtitle,
  title
}: {
  children: React.ReactNode;
  subtitle?: string;
  title: string;
}) {
  return (
    <section className="mb-2.5 rounded-lg border border-student-border bg-white p-2.5 last:mb-0">
      <div className="mb-2 flex items-baseline gap-1.5">
        <h2 className="text-sm font-bold">{title}</h2>
        {subtitle ? <span className="text-[10px] text-student-muted">（{subtitle}）</span> : null}
      </div>
      {children}
    </section>
  );
}

function AiGenerationTeacherContentDialog({
  onCancel,
  onOverwrite,
  onPreserve
}: {
  onCancel: () => void;
  onOverwrite: () => void;
  onPreserve: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-slate-950/30 p-4">
      <section className="w-full max-w-md rounded-xl border border-student-border bg-white p-5 shadow-2xl">
        <h2 className="text-base font-bold">生成 AI 初批</h2>
        <p className="mt-2 text-sm leading-6 text-student-muted">
          当前批改中已有教师输入内容。生成 AI 初批时如何处理？
        </p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button className="teacher-button-secondary" onClick={onCancel} type="button">
            取消
          </button>
          <button className="teacher-button-secondary text-red-700" onClick={onOverwrite} type="button">
            覆盖教师内容并生成
          </button>
          <button className="teacher-button-primary" onClick={onPreserve} type="button">
            保留教师内容并生成
          </button>
        </div>
      </section>
    </div>
  );
}

function ScoreSelect({
  onChange,
  value
}: {
  onChange: (value: RubricScore) => void;
  value: RubricScore;
}) {
  return (
    <select
      className="h-7 rounded-md border border-student-border bg-white px-1 text-xs font-bold text-student-primary"
      onChange={(event) => onChange(Number(event.target.value) as RubricScore)}
      value={value}
    >
      {SCORE_OPTIONS.map((score) => <option key={score} value={score}>{score}</option>)}
    </select>
  );
}

function ModeButton({
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
      className={clsx("rounded-md px-2.5 py-1.5", active ? "bg-white text-student-primary shadow-sm" : "text-student-muted")}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function MiniButton({
  children,
  disabled = false,
  onClick,
  primary = false
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      className={clsx(
        "inline-flex min-h-7 items-center justify-center gap-1 rounded-md border px-2 py-1 text-[10px] font-semibold disabled:opacity-45",
        primary
          ? "border-student-primary bg-student-primary text-white"
          : "border-student-primary-border bg-white text-student-primary"
      )}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-3">
      <p className="text-[10px] font-semibold text-student-muted">{label}</p>
      <p className="mt-0.5 whitespace-pre-wrap text-xs leading-5">{value}</p>
    </div>
  );
}

function FeedbackLine({ label, value }: { label: string; value: string }) {
  return <p className="mt-1.5"><strong>{label}：</strong>{value}</p>;
}

function SourceBadge({ source }: { source: "ai" | "teacher" }) {
  return (
    <span className="rounded bg-student-bg px-1.5 py-0.5 text-[9px] font-semibold text-student-muted">
      {source === "teacher" ? "教师" : "AI"}
    </span>
  );
}

function WorkspaceSkeleton({ error }: { error: string }) {
  return (
    <div className="flex h-[calc(100dvh-98px)] min-h-[660px] flex-col overflow-hidden rounded-2xl border border-student-border bg-white">
      <TeacherLoadingRegion label="正在加载写作批改工作台" />
      <div className="flex h-14 items-center justify-between border-b px-4">
        <TeacherSkeleton className="h-5 w-64" />
        <TeacherSkeleton className="h-8 w-72" />
      </div>
      <div className="grid h-14 grid-cols-6 border-b px-3 py-2">
        {Array.from({ length: 6 }, (_, index) => <TeacherSkeleton className="mx-2 h-8" key={index} />)}
      </div>
      {error ? <div className="p-3"><TeacherDataError text={error} /></div> : null}
      <div className="writing-review-grid min-h-0 flex-1 bg-[#f8f7fc] p-2">
        <TeacherCard className="p-3"><TeacherSkeleton className="h-full min-h-80" /></TeacherCard>
        <TeacherCard className="p-3"><TeacherSkeleton className="h-full min-h-80" /></TeacherCard>
        <TeacherCard className="p-3"><TeacherSkeleton className="h-full min-h-80" /></TeacherCard>
      </div>
    </div>
  );
}

function editChangedTextClass(
  edit: WorkingLanguageEdit,
  active: boolean,
  selected: boolean
) {
  if (edit.restored) return "bg-transparent";
  return active
    ? languageEditSeverityMarkerClass(edit.severity, selected)
    : "rounded-sm px-0.5 font-medium transition-colors bg-transparent";
}

function severityBadgeClass(value: string) {
  return clsx(
    "rounded px-1.5 py-0.5 text-[10px] font-bold",
    value === "major" && "bg-red-100 text-red-700",
    value === "moderate" && "bg-amber-100 text-amber-800",
    value === "minor" && "bg-emerald-100 text-emerald-700"
  );
}

function toDraft(review: WorkspaceReview): WritingReviewWorkingDraft {
  return {
    language_edits: structuredClone(review.language_edits),
    scores: structuredClone(review.scores),
    content_feedback: structuredClone(review.content_feedback),
    teacher_comment: review.teacher_comment
  };
}

async function loadWorkspace(attemptId: string): Promise<WorkspacePayload> {
  const response = await teacherFetch(`/api/teacher/writing/reviews/${encodeURIComponent(attemptId)}`);
  const payload = await readJson<WorkspacePayload | ErrorPayload>(response);
  if (!response.ok || !("review" in payload)) throw new Error(errorMessage(payload, "无法加载批改工作台。"));
  return payload;
}

async function mutateWorkspace(
  attemptId: string,
  draft: WritingReviewWorkingDraft,
  publish: boolean
): Promise<WorkspaceReview> {
  const suffix = publish ? "/publish" : "";
  const response = await teacherFetch(`/api/teacher/writing/reviews/${encodeURIComponent(attemptId)}${suffix}`, {
    method: publish ? "POST" : "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft)
  });
  const payload = await readJson<{ review?: WorkspaceReview } & ErrorPayload>(response);
  if (!response.ok || !payload.review) throw new Error(errorMessage(payload, publish ? "发布失败，请稍后重试。" : "保存失败，请稍后重试。"));
  return payload.review;
}

async function regenerateFullReview(
  attemptId: string,
  teacherContentMode: AiGenerationTeacherContentMode
): Promise<WorkspaceReview> {
  const response = await teacherFetch(
    `/api/teacher/writing/reviews/${encodeURIComponent(attemptId)}/regenerate-ai?teacher_content=${teacherContentMode}`,
    { method: "POST" }
  );
  const payload = await readJson<{ review?: WorkspaceReview } & ErrorPayload>(response);
  if (!response.ok || !payload.review) {
    throw new Error(
      errorMessage(payload, "AI 初批重新生成失败，原批改未改变。")
    );
  }
  return payload.review;
}

async function generateInitialReview(
  attemptId: string,
  teacherContentMode: AiGenerationTeacherContentMode
): Promise<WorkspaceReview> {
  const response = await teacherFetch(
    `/api/teacher/writing/reviews/${encodeURIComponent(attemptId)}/generate-ai?teacher_content=${teacherContentMode}`,
    { method: "POST" }
  );
  const payload = await readJson<{ review?: WorkspaceReview } & ErrorPayload>(response);
  if (!response.ok || !payload.review) {
    throw new Error(errorMessage(payload, "AI 初批失败，当前批改未改变。"));
  }
  return payload.review;
}

async function regenerateFeedback(attemptId: string, feedbackId: string, prompt: string) {
  const response = await teacherFetch(
    `/api/teacher/writing/reviews/${encodeURIComponent(attemptId)}/feedback/${encodeURIComponent(feedbackId)}/regenerate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt })
    }
  );
  const payload = await readJson<{
    feedback_id?: string;
    suggestion?: string;
    proposed_revision?: string;
  } & ErrorPayload>(response);
  if (
    !response.ok ||
    typeof payload.feedback_id !== "string" ||
    typeof payload.suggestion !== "string" ||
    typeof payload.proposed_revision !== "string"
  ) {
    throw new Error(errorMessage(payload, "重新生成失败，请稍后重试。"));
  }
  return {
    feedback_id: payload.feedback_id,
    suggestion: payload.suggestion,
    proposed_revision: payload.proposed_revision
  };
}

async function teacherFetch(input: string, init?: RequestInit) {
  const supabase = createBrowserSupabase();
  const { data: { session } } = await supabase.auth.getSession();
  try {
    return await fetch(input, {
      ...init,
      cache: "no-store",
      headers: { ...init?.headers, Authorization: `Bearer ${session?.access_token ?? ""}` }
    });
  } catch (cause) {
    throw new WritingReviewNetworkOutcomeUnknownError(cause);
  }
}

async function readJson<T>(response: Response): Promise<T> {
  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    throw new WritingReviewNetworkOutcomeUnknownError(cause);
  }
  if (!text) return {} as T;
  try { return JSON.parse(text) as T; } catch { throw new Error("服务器返回的数据格式无效，请稍后重试。"); }
}

class WritingReviewNetworkOutcomeUnknownError extends Error {
  cause?: unknown;

  constructor(cause?: unknown) {
    super("网络连接中断，且未能确认服务器操作结果，请稍后重试。");
    this.name = "WritingReviewNetworkOutcomeUnknownError";
    this.cause = cause;
  }
}

async function confirmUnknownWritingReviewOutcome(
  operation: "generate" | "save" | "publish",
  attemptId: string,
  draft: WritingReviewWorkingDraft | null
) {
  try {
    return await recoverWritingReviewAfterUnknownOutcome(
      operation,
      draft,
      async () => (await loadWorkspace(attemptId)).review
    ) as WorkspaceReview | null;
  } catch {
    return null;
  }
}

function errorMessage(payload: unknown, fallback: string) {
  if (typeof payload !== "object" || payload === null) return fallback;
  const message = (payload as ErrorPayload).message;
  return typeof message === "string" && /[\u3400-\u9fff]/.test(message) ? message : fallback;
}

function indexForEdit(
  segments: ReturnType<typeof buildWorkspaceAnnotationSegments>,
  editId: string
) {
  return Array.from(new Set(segments.flatMap((segment) => segment.edit?.edit_id ?? []))).indexOf(editId) + 1;
}

function feedbackOrdinal(
  segments: ReturnType<typeof buildWorkspaceAnnotationSegments>,
  feedbackId: string
) {
  return Array.from(new Set(segments.flatMap((segment) => segment.feedbackStarts))).indexOf(feedbackId) + 1;
}

function taskTypeLabel(taskType: WritingTaskType) {
  return taskType === "email" ? "Write an Email" : "Academic Discussion";
}

function severityLabel(value: string) {
  return languageEditSeverityLabel(value);
}

function normalizeTeacherLanguageEditCategory(value: LanguageEditCategory) {
  const categories = writingLanguageEditCategoryDefinitions();
  return categories.some((category) => category.key === value)
    ? value
    : categories[0].key as LanguageEditCategory;
}

function normalizeTeacherContentFeedbackCategory(
  taskType: WritingTaskType,
  value: string
) {
  const categories = writingFeedbackCategoryDefinitions(taskType);
  return categories.some((category) => category.key === value)
    ? value
    : categories[0].key;
}

function updateCachedListStatus(
  cache: ReturnType<typeof useTeacherDataCache>,
  attemptId: string,
  reviewStatus: WorkspaceReview["status"]
) {
  cache.invalidate(TEACHER_WRITING_ASSIGNMENTS_CACHE_PREFIX);
  const entry = cache.getEntry(TEACHER_WRITING_REVIEWS_CACHE_KEY);
  if (entry?.status !== "success") {
    cache.invalidate(TEACHER_WRITING_REVIEWS_CACHE_KEY);
    return;
  }
  const payload = entry.data as { attempts?: Array<{ attemptId: string; reviewStatus: string }> };
  if (!Array.isArray(payload.attempts)) {
    cache.invalidate(TEACHER_WRITING_REVIEWS_CACHE_KEY);
    return;
  }
  cache.set(TEACHER_WRITING_REVIEWS_CACHE_KEY, {
    ...payload,
    attempts: payload.attempts.map((attempt) =>
      attempt.attemptId === attemptId ? { ...attempt, reviewStatus } : attempt
    )
  });
}

function isLater(updatedAt: string | null, publishedAt: string | null) {
  return Boolean(updatedAt && publishedAt && new Date(updatedAt).getTime() > new Date(publishedAt).getTime());
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("zh-CN", {
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
      }).format(date);
}

function mapBrowserSelectionToSource(
  selection: Selection | null,
  article: HTMLElement,
  responseText: string
) {
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (
    !article.contains(range.startContainer) ||
    !article.contains(range.endContainer)
  ) {
    return null;
  }
  const start = sourceBoundaryOffset(
    article,
    range.startContainer,
    range.startOffset
  );
  const end = sourceBoundaryOffset(article, range.endContainer, range.endOffset);
  if (start === null || end === null) return null;
  const mapped = sourceTextSelection(responseText, start, end);
  return mapped && mapped.originalText.trim().length > 0 ? mapped : null;
}

function sourceBoundaryOffset(
  article: HTMLElement,
  boundaryNode: Node,
  boundaryOffset: number
) {
  const element =
    boundaryNode.nodeType === Node.TEXT_NODE
      ? boundaryNode.parentElement
      : boundaryNode instanceof Element
        ? boundaryNode
        : null;
  const sourceElement = element?.closest<HTMLElement>("[data-source-text]");
  if (!sourceElement || !article.contains(sourceElement)) return null;
  const sourceStart = Number(sourceElement.dataset.sourceStart);
  const sourceEnd = Number(sourceElement.dataset.sourceEnd);
  if (!Number.isInteger(sourceStart) || !Number.isInteger(sourceEnd)) return null;

  let localOffset = 0;
  const walker = document.createTreeWalker(sourceElement, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    if (current === boundaryNode) {
      localOffset += Math.min(
        Math.max(0, boundaryOffset),
        current.nodeValue?.length ?? 0
      );
      break;
    }
    localOffset += current.nodeValue?.length ?? 0;
    current = walker.nextNode();
  }
  if (boundaryNode === sourceElement) {
    localOffset = boundaryOffset <= 0 ? 0 : sourceEnd - sourceStart;
  }
  return Math.min(sourceEnd, sourceStart + localOffset);
}

function selectionRangeRect(selection: Selection | null) {
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const bounding = range.getBoundingClientRect();
  if (bounding.width > 0 || bounding.height > 0) return bounding;
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0
  );
  return rects.at(-1) ?? null;
}

function resolveSelectionActionPosition(anchor: DOMRect): InspectorPosition {
  return selectionActionPosition(
    anchor,
    window.innerWidth,
    window.innerHeight
  );
}

function resolveSelectionFormPosition(anchor: DOMRect): InspectorPosition {
  return selectionActionPosition(
    anchor,
    window.innerWidth,
    window.innerHeight,
    { width: 360, height: Math.min(560, window.innerHeight - 24) }
  );
}

function resolveInspectorPosition(anchor: DOMRect): InspectorPosition {
  const width = 340;
  const estimatedHeight = 430;
  const gap = 10;
  const left = Math.max(
    12,
    Math.min(anchor.left, window.innerWidth - width - 12)
  );
  const below = anchor.bottom + gap;
  const top =
    below + estimatedHeight <= window.innerHeight
      ? below
      : Math.max(12, anchor.top - estimatedHeight - gap);
  return { left, top };
}

export function scrollTargetWithinContainer(
  container: HTMLElement | null,
  target: HTMLElement | null,
  offset = 18
) {
  if (!container || !target) return;
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  container.scrollTo({
    top: calculateContainedScrollTop({
      containerScrollTop: container.scrollTop,
      containerTop: containerRect.top,
      targetTop: targetRect.top,
      offset
    }),
    behavior: "smooth"
  });
}

function cssEscape(value: string) {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}
