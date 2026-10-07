"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent
} from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { ArrowLeft } from "lucide-react";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { TeacherClassIcon } from "@/components/icons/TeacherClassIcon";
import {
  TEACHER_WRITING_CLASS_REVIEWS_CACHE_KEY,
  TEACHER_WRITING_CLASS_REVIEW_LIST_CACHE_PREFIX,
  TEACHER_WRITING_REVIEWS_CACHE_KEY,
  useTeacherCachedData,
  useTeacherDataCache
} from "@/components/TeacherDataCache";
import {
  TeacherClassFilterPopover,
  TeacherReviewFilterBar,
  TeacherStudentFilterPopover
} from "@/components/teacher/TeacherListFilters";
import {
  TeacherCard,
  TeacherDataError,
  TeacherEmptyState,
  TeacherLoadingRegion,
  TeacherSkeleton
} from "@/components/teacher/TeacherUI";
import { createBrowserSupabase } from "@/lib/supabase/client";
import {
  TEACHER_WRITING_REVIEWS_HREF,
  teacherWritingReviewWorkspaceHref,
  teacherWritingReviewsListHref
} from "@/lib/teacherWritingReviewNavigation";
import {
  collectWritingReviewStudentOptions,
  filterWritingReviewListEntries,
  type WritingReviewListStatus,
  type WritingReviewStatusFilter,
  type WritingReviewTaskTypeFilter
} from "@/lib/teacherWritingReviewList";
import {
  applyWritingReviewModerationToEntries,
  parseWritingReviewModerationResponse,
  publishWritingReviewModerationInvalidation,
  writingReviewModerationNotice,
  type WritingReviewModerationAction
} from "@/lib/writingReviewModeration";
import { classSubjectsLabel, type TeacherClassReviewSummary } from "@/lib/teacherClasses";
import type { WritingAssignmentRecipient } from "@/lib/writingAssignments";
import type { WritingTaskType } from "@/lib/writing";

type WritingReviewListItem = {
  attemptId: string;
  assignmentId: string | null;
  studentId: string;
  studentName: string;
  taskType: WritingTaskType;
  questionId: string;
  setId: string;
  setTitle: string;
  displayName: string;
  reviewContext: "free_practice" | "assignment_question_bank" | "assignment_custom";
  logicalDisplay: {
    itemId: string | null;
    displayNumber: string | null;
    displayTitle: string | null;
    displayName: string;
  } | null;
  wordCount: number;
  submittedAt: string | null;
  reviewStatus: WritingReviewListStatus;
};

type WritingReviewListPayload = { attempts: WritingReviewListItem[] };
type ErrorPayload = { code?: string; message?: string; error?: string };

/** Desktop drag-select threshold: a plain click must never become a marquee. */
const MARQUEE_DRAG_THRESHOLD_PX = 6;
const ROW_ATTRIBUTE = "data-writing-review-row";

type ReviewListSelection = {
  selectedIds: ReadonlySet<string>;
  toggle: (attemptId: string) => void;
  addMany: (attemptIds: string[]) => void;
  clear: () => void;
};

type ReviewTableActions = {
  busy: boolean;
  onModerate: (
    action: WritingReviewModerationAction,
    attemptIds: string[]
  ) => void;
};

/**
 * 写作批改 list with the 学生 | 班级 tabs.
 *
 * Both tabs read the same URL state (tab / studentId / classId / status /
 * taskType), so a refresh, the workspace returnTo chain and the browser
 * Back/Forward always restore the exact list context. The server owns the
 * order (submitted_at DESC, attempt id tiebreaker); this component only
 * applies the shared 学生/班级 ∩ 状态 ∩ 题型 filter view. The 班级 tab keeps
 * its 班级列表 → 班级 submission 列表 drill-down: 全部班级 shows the class
 * cards, and selecting a class (card or class filter) opens that class's
 * submissions only.
 *
 * Each tab also owns one 退回/忽略 selection state: clicking a row (or
 * checkboxes, or a desktop drag rectangle) selects it, the filter bar's spare
 * area grows the batch buttons (退回 | 忽略 | 取消), and every row always
 * renders the same three compact 查看 | 退回 | 忽略 buttons so the action
 * column never moves. 取消 only clears the selection.
 */
export function TeacherWritingReviewList({
  initialClassId,
  initialStudentId,
  initialStatus = "all",
  initialTab = "students",
  initialTaskType = "all"
}: {
  initialClassId?: string;
  initialStudentId?: string;
  initialStatus?: WritingReviewStatusFilter;
  initialTab?: "students" | "class";
  initialTaskType?: WritingReviewTaskTypeFilter;
} = {}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<"students" | "class">(
    initialTab === "class" ? "class" : "students"
  );
  const [studentId, setStudentId] = useState(initialStudentId?.trim() ?? "");
  const [classId, setClassId] = useState(initialClassId?.trim() ?? "");
  const [statusFilter, setStatusFilter] = useState<WritingReviewStatusFilter>(initialStatus);
  const [taskFilter, setTaskFilter] = useState<WritingReviewTaskTypeFilter>(initialTaskType);

  // The URL props stay the source of truth; these effects realign the local
  // state when the browser Back/Forward restores an older URL. Filter clicks
  // update the URL through router.push below, so the two never diverge.
  useEffect(() => {
    setTab(initialTab === "class" ? "class" : "students");
  }, [initialTab]);
  useEffect(() => {
    setStudentId(initialStudentId?.trim() ?? "");
  }, [initialStudentId]);
  useEffect(() => {
    setClassId(initialClassId?.trim() ?? "");
  }, [initialClassId]);
  useEffect(() => {
    setStatusFilter(initialStatus);
  }, [initialStatus]);
  useEffect(() => {
    setTaskFilter(initialTaskType);
  }, [initialTaskType]);

  // 学生 tab: one cached full-list request backs both the table and the
  // student filter options, so the picker costs no extra request.
  const reviewsState = useTeacherCachedData<WritingReviewListPayload>(
    TEACHER_WRITING_REVIEWS_CACHE_KEY,
    () => loadWritingReviews(),
    { enabled: tab === "students" }
  );
  const attempts = useMemo(() => reviewsState.data?.attempts ?? [], [reviewsState.data]);
  const studentOptions = useMemo(() => collectWritingReviewStudentOptions(attempts), [attempts]);

  // 班级 tab: the same cached class summaries that back the overview cards.
  // Only the teacher's own Writing / Reading+Writing classes can appear.
  const classReviewsState = useTeacherCachedData<{ classes: TeacherClassReviewSummary[] }>(
    TEACHER_WRITING_CLASS_REVIEWS_CACHE_KEY,
    () => loadClassReviewSummaries(),
    { enabled: tab === "class" }
  );
  const classOptions = useMemo(
    () => classReviewsState.data?.classes ?? [],
    [classReviewsState.data]
  );

  // A deep-linked student/class that is no longer visible falls back to
  // 全部学生 / 全部班级 without an error; the URL follows the fallback.
  const studentsReady = reviewsState.data !== null;
  const studentIdIsVisible = studentOptions.some((option) => option.student_id === studentId);
  const activeStudentId =
    studentsReady && studentId !== "" && !studentIdIsVisible ? "" : studentId;
  const classesReady = classReviewsState.data !== null;
  const classIdIsVisible = classOptions.some((entry) => entry.class_id === classId);
  const activeClassId = classesReady && classId !== "" && !classIdIsVisible ? "" : classId;

  useEffect(() => {
    if (!studentsReady || studentId === "" || studentIdIsVisible) return;
    setStudentId("");
    router.replace(
      teacherWritingReviewsListHref({
        tab: "students",
        classId,
        status: statusFilter,
        taskType: taskFilter
      }),
      { scroll: false }
    );
  }, [
    classId,
    router,
    statusFilter,
    studentId,
    studentIdIsVisible,
    studentsReady,
    taskFilter
  ]);

  useEffect(() => {
    if (!classesReady || classId === "" || classIdIsVisible) return;
    setClassId("");
    router.replace(
      teacherWritingReviewsListHref({
        tab: "class",
        status: statusFilter,
        taskType: taskFilter
      }),
      { scroll: false }
    );
  }, [classId, classIdIsVisible, classesReady, router, statusFilter, taskFilter]);

  // A hand-written or stale URL may carry unknown values (for example
  // ?status=banana) or the inactive tab's filter; normalize once on mount so
  // the URL always equals the visible list state. Later clicks keep the URL
  // in sync through the handlers below.
  useEffect(() => {
    if (pathname !== TEACHER_WRITING_REVIEWS_HREF) return;
    const canonical = teacherWritingReviewsListHref({
      tab: initialTab === "class" ? "class" : "students",
      studentId: initialStudentId,
      classId: initialClassId,
      status: initialStatus,
      taskType: initialTaskType
    });
    const current = `${pathname}${searchParams.toString() ? `?${searchParams.toString()}` : ""}`;
    if (current !== canonical) router.replace(canonical, { scroll: false });
    // Mount only: every later change goes through push/filter handlers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * All filters live in one URL state. Each handler changes only its own value
   * and passes the others through, so switching one filter never resets the
   * rest; router.push keeps Back/Forward able to restore every step.
   */
  function navigateListHref(next: {
    tab?: "students" | "class";
    studentId?: string;
    classId?: string;
    status?: WritingReviewStatusFilter;
    taskType?: WritingReviewTaskTypeFilter;
  }) {
    const href = teacherWritingReviewsListHref({
      tab: next.tab ?? tab,
      studentId: next.studentId ?? activeStudentId,
      classId: next.classId ?? activeClassId,
      status: next.status ?? statusFilter,
      taskType: next.taskType ?? taskFilter
    });
    const current = `${pathname}${searchParams.toString() ? `?${searchParams.toString()}` : ""}`;
    if (href !== current) router.push(href, { scroll: false });
  }

  function selectTab(nextTab: "students" | "class") {
    setTab(nextTab);
    navigateListHref({ tab: nextTab });
  }

  function selectStudentFilter(studentIdValue: string) {
    setStudentId(studentIdValue);
    navigateListHref({ studentId: studentIdValue });
  }

  function selectClassFilter(classIdValue: string) {
    setClassId(classIdValue);
    navigateListHref({ classId: classIdValue });
  }

  function selectStatusFilter(status: WritingReviewStatusFilter) {
    setStatusFilter(status);
    navigateListHref({ status });
  }

  function selectTaskFilter(taskType: WritingReviewTaskTypeFilter) {
    setTaskFilter(taskType);
    navigateListHref({ taskType });
  }

  const listHref = teacherWritingReviewsListHref({
    tab,
    studentId: activeStudentId,
    classId: activeClassId,
    status: statusFilter,
    taskType: taskFilter
  });
  const filtered = useMemo(
    () =>
      filterWritingReviewListEntries(attempts, {
        studentId: activeStudentId,
        status: statusFilter,
        taskType: taskFilter
      }),
    [activeStudentId, attempts, statusFilter, taskFilter]
  );
  const selectedClassName = classOptions.find((entry) => entry.class_id === activeClassId)?.name ?? "";

  return (
    <div className="grid gap-5">
      <nav aria-label="批改视图" className="flex gap-2 border-b border-student-border">
        <button
          className={`border-b-2 px-5 py-3 text-sm font-bold ${tab === "students" ? "border-student-primary text-student-primary" : "border-transparent text-student-muted hover:text-student-text"}`}
          onClick={() => selectTab("students")}
          type="button"
        >
          学生
        </button>
        <button
          className={`border-b-2 px-5 py-3 text-sm font-bold ${tab === "class" ? "border-student-primary text-student-primary" : "border-transparent text-student-muted hover:text-student-text"}`}
          onClick={() => selectTab("class")}
          type="button"
        >
          班级
        </button>
      </nav>
      {tab === "students" ? (
        <StudentReviewSection
          attempts={attempts}
          error={reviewsState.error}
          filtered={filtered}
          loading={reviewsState.loading}
          onStatusFilter={selectStatusFilter}
          onStudentFilter={selectStudentFilter}
          onTaskFilter={selectTaskFilter}
          returnTo={listHref}
          selectedStudentId={activeStudentId}
          statusFilter={statusFilter}
          studentOptions={studentOptions}
          taskFilter={taskFilter}
        />
      ) : (
        <ClassReviewSection
          classId={activeClassId}
          classOptions={classOptions}
          className={selectedClassName}
          classesError={classReviewsState.error}
          classesLoading={!classesReady && !classReviewsState.error}
          onBack={() => selectClassFilter("")}
          onOpenClass={selectClassFilter}
          onStatusFilter={selectStatusFilter}
          onTaskFilter={selectTaskFilter}
          returnTo={listHref}
          statusFilter={statusFilter}
          taskFilter={taskFilter}
        />
      )}
    </div>
  );
}

/**
 * The single selection model behind clicking, checkboxes and the drag
 * rectangle. A new filter context starts empty (never carry ids across
 * students / statuses / task types), and ids that leave the visible list are
 * dropped immediately so a stale attempt can never be batch-acted on.
 */
function useReviewListSelection(
  items: readonly { attemptId: string }[],
  resetKey: string
): ReviewListSelection {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const itemIds = useMemo(() => new Set(items.map((item) => item.attemptId)), [items]);

  useEffect(() => {
    setSelectedIds((current) => (current.size === 0 ? current : new Set()));
  }, [resetKey]);

  useEffect(() => {
    setSelectedIds((current) => {
      if (current.size === 0) return current;
      let changed = false;
      const next = new Set<string>();
      current.forEach((id) => {
        if (itemIds.has(id)) next.add(id);
        else changed = true;
      });
      return changed ? next : current;
    });
  }, [itemIds]);

  const toggle = useCallback((attemptId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(attemptId)) next.delete(attemptId);
      else next.add(attemptId);
      return next;
    });
  }, []);

  const addMany = useCallback((attemptIds: string[]) => {
    setSelectedIds((current) => {
      let changed = false;
      const next = new Set(current);
      for (const id of attemptIds) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, []);

  const clear = useCallback(() => {
    setSelectedIds((current) => (current.size === 0 ? current : new Set()));
  }, []);

  return { selectedIds, toggle, addMany, clear };
}

type WritingReviewModerationControls = {
  busy: boolean;
  confirmIds: string[] | null;
  error: string;
  notice: string;
  confirmReturn: () => void;
  cancelReturn: () => void;
  requestIgnore: (attemptIds: string[]) => void;
  requestReturn: (attemptIds: string[]) => void;
};

/**
 * One batch request (never N single requests) followed by the same cache
 * pipeline the rest of Writing Review uses: publish the invalidation events
 * first, then store the optimistic list payload for this tab. The server owns
 * the final word: skipped attempts stay in the list and are reported.
 */
function useWritingReviewModeration(options: {
  cacheKey: string;
  clearSelection: () => void;
  items: readonly WritingReviewListItem[];
}): WritingReviewModerationControls {
  const cache = useTeacherDataCache();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [confirmIds, setConfirmIds] = useState<string[] | null>(null);
  const itemsRef = useRef(options.items);
  itemsRef.current = options.items;
  const { cacheKey, clearSelection } = options;

  const run = useCallback(
    async (action: WritingReviewModerationAction, attemptIds: string[]) => {
      const ids = Array.from(new Set(attemptIds)).filter(Boolean);
      if (ids.length === 0 || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setNotice("");
      setError("");
      try {
        const response = await teacherFetch("/api/teacher/writing/reviews/moderate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, attemptIds: ids })
        });
        const payload = await readJson<unknown>(response);
        const parsed = response.ok ? parseWritingReviewModerationResponse(payload) : null;
        if (!parsed) {
          throw new Error(
            errorMessage(
              payload,
              action === "return" ? "退回失败，请稍后重试。" : "忽略失败，请稍后重试。"
            )
          );
        }
        // Capture this list's payload BEFORE the invalidation below clears it,
        // then store the merged result after: the acting tab updates
        // immediately (no loading skeleton) while every other cache consumer
        // still receives the invalidation event.
        const listPayload = readCachedReviewListPayload(cache.getEntry(cacheKey));
        publishWritingReviewModerationInvalidation(action, itemsRef.current, parsed.results);
        if (listPayload) {
          cache.set(cacheKey, {
            ...listPayload,
            attempts: applyWritingReviewModerationToEntries(
              listPayload.attempts,
              action,
              parsed.results
            )
          });
        } else {
          cache.invalidate(cacheKey);
        }
        clearSelection();
        setNotice(writingReviewModerationNotice(action, parsed.results));
      } catch (moderationError) {
        setError(
          moderationError instanceof Error
            ? moderationError.message
            : "操作失败，请稍后重试。"
        );
      } finally {
        busyRef.current = false;
        setBusy(false);
        setConfirmIds(null);
      }
    },
    [cache, cacheKey, clearSelection]
  );

  const requestReturn = useCallback((attemptIds: string[]) => {
    const ids = Array.from(new Set(attemptIds)).filter(Boolean);
    if (ids.length === 0) return;
    setConfirmIds(ids);
  }, []);

  const requestIgnore = useCallback(
    (attemptIds: string[]) => {
      void run("ignore", attemptIds);
    },
    [run]
  );

  const confirmReturn = useCallback(() => {
    if (!confirmIds) return;
    void run("return", confirmIds);
  }, [confirmIds, run]);

  const cancelReturn = useCallback(() => {
    if (busyRef.current) return;
    setConfirmIds(null);
  }, []);

  return {
    busy,
    confirmIds,
    error,
    notice,
    confirmReturn,
    cancelReturn,
    requestIgnore,
    requestReturn
  };
}

function WritingReviewBulkActions({
  busy,
  count,
  onCancel,
  onIgnore,
  onReturn
}: {
  busy: boolean;
  count: number;
  onCancel: () => void;
  onIgnore: () => void;
  onReturn: () => void;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <span className="pb-2 text-sm font-semibold text-student-muted">已选 {count} 条</span>
      <button
        className="teacher-button-secondary !min-h-10 !px-4 !py-1.5 text-sm"
        disabled={busy}
        onClick={onReturn}
        type="button"
      >
        退回
      </button>
      <button
        className="teacher-button-secondary !min-h-10 !px-4 !py-1.5 text-sm"
        disabled={busy}
        onClick={onIgnore}
        type="button"
      >
        忽略
      </button>
      {/* 取消 only drops the current selection: no API, no list refresh and no
          filter / page / search change. It is not a review action. */}
      <button
        className="teacher-button-secondary !min-h-10 !px-4 !py-1.5 text-sm"
        onClick={onCancel}
        type="button"
      >
        取消
      </button>
    </div>
  );
}

function WritingReviewReturnDialog({
  busy,
  ids,
  onCancel,
  onConfirm
}: {
  busy: boolean;
  ids: string[] | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const count = ids?.length ?? 0;
  return (
    <ConfirmDialog
      cancelText="取消"
      confirmText="退回"
      confirming={busy}
      message={
        count > 1
          ? `退回后这 ${count} 篇作文将恢复为学生草稿，学生可以继续修改并重新提交；教师端会从当前列表移除。`
          : "退回后这篇作文将恢复为学生草稿，学生可以继续修改并重新提交；教师端会从当前列表移除。"
      }
      onCancel={onCancel}
      onConfirm={onConfirm}
      open={ids !== null}
      title="退回草稿"
    />
  );
}

function StudentReviewSection({
  attempts,
  error,
  filtered,
  loading,
  onStatusFilter,
  onStudentFilter,
  onTaskFilter,
  returnTo,
  selectedStudentId,
  statusFilter,
  studentOptions,
  taskFilter
}: {
  attempts: WritingReviewListItem[];
  error: string;
  filtered: WritingReviewListItem[];
  loading: boolean;
  onStatusFilter: (value: WritingReviewStatusFilter) => void;
  onStudentFilter: (studentId: string) => void;
  onTaskFilter: (value: WritingReviewTaskTypeFilter) => void;
  returnTo: string;
  selectedStudentId: string;
  statusFilter: WritingReviewStatusFilter;
  studentOptions: WritingAssignmentRecipient[];
  taskFilter: WritingReviewTaskTypeFilter;
}) {
  const selection = useReviewListSelection(
    filtered,
    `${statusFilter}|${selectedStudentId}|${taskFilter}`
  );
  const moderation = useWritingReviewModeration({
    cacheKey: TEACHER_WRITING_REVIEWS_CACHE_KEY,
    clearSelection: selection.clear,
    items: filtered
  });
  const selectedStudent = selectedStudentId
    ? studentOptions.find((option) => option.student_id === selectedStudentId) ?? {
        student_id: selectedStudentId,
        student_name: ""
      }
    : null;
  const selectedCount = selection.selectedIds.size;

  return (
    <div className="grid gap-5">
      {loading ? <TeacherLoadingRegion label="正在加载写作批改列表" /> : null}
      <TeacherReviewFilterBar
        bulkActions={
          selectedCount > 0 ? (
            <WritingReviewBulkActions
              busy={moderation.busy}
              count={selectedCount}
              onCancel={() => selection.clear()}
              onIgnore={() => moderation.requestIgnore(Array.from(selection.selectedIds))}
              onReturn={() => moderation.requestReturn(Array.from(selection.selectedIds))}
            />
          ) : undefined
        }
        onStatusFilter={onStatusFilter}
        onTaskFilter={onTaskFilter}
        primary={
          <TeacherStudentFilterPopover
            onSelect={(recipient) => onStudentFilter(recipient?.student_id ?? "")}
            options={studentOptions}
            selected={selectedStudent}
          />
        }
        primaryLabel="学生"
        statusFilter={statusFilter}
        taskFilter={taskFilter}
      />
      <ReviewTable
        actions={{
          busy: moderation.busy,
          onModerate: (action, attemptIds) =>
            action === "return"
              ? moderation.requestReturn(attemptIds)
              : moderation.requestIgnore(attemptIds)
        }}
        attempts={attempts}
        error={error || moderation.error}
        filtered={filtered}
        loading={loading}
        notice={moderation.notice}
        returnTo={returnTo}
        emptyTexts={{
          noAttempts: "暂无已提交的写作练习。",
          noMatch: "当前筛选条件下暂无提交。"
        }}
        selection={selection}
      />
      <WritingReviewReturnDialog
        busy={moderation.busy}
        ids={moderation.confirmIds}
        onCancel={moderation.cancelReturn}
        onConfirm={moderation.confirmReturn}
      />
    </div>
  );
}

function ClassReviewSection({
  classId,
  classOptions,
  className,
  classesError,
  classesLoading,
  onBack,
  onOpenClass,
  onStatusFilter,
  onTaskFilter,
  returnTo,
  statusFilter,
  taskFilter
}: {
  classId: string;
  classOptions: TeacherClassReviewSummary[];
  className: string;
  classesError: string;
  classesLoading: boolean;
  onBack: () => void;
  onOpenClass: (classId: string) => void;
  onStatusFilter: (value: WritingReviewStatusFilter) => void;
  onTaskFilter: (value: WritingReviewTaskTypeFilter) => void;
  returnTo: string;
  statusFilter: WritingReviewStatusFilter;
  taskFilter: WritingReviewTaskTypeFilter;
}) {
  const classFilter = (
    <TeacherClassFilterPopover
      onSelect={(entry) => onOpenClass(entry?.class_id ?? "")}
      options={classOptions}
      selected={classId ? { class_id: classId, name: className } : null}
    />
  );
  const filterBar = (
    <TeacherReviewFilterBar
      onStatusFilter={onStatusFilter}
      onTaskFilter={onTaskFilter}
      primary={classFilter}
      primaryLabel="班级"
      statusFilter={statusFilter}
      taskFilter={taskFilter}
    />
  );

  if (classId) {
    // The class id is confirmed against the teacher's own Writing classes
    // before the per-class request is made, so a stale id never fires a
    // doomed request and the empty/loading handling stays identical.
    if (classesLoading) {
      return (
        <div className="grid gap-5">
          {filterBar}
          <div aria-busy="true" className="grid gap-3">
            <TeacherSkeleton className="h-16 w-full rounded-2xl" />
            <TeacherSkeleton className="h-72 w-full rounded-2xl" />
          </div>
        </div>
      );
    }
    return (
      <ClassReviewList
        classId={classId}
        classFilter={classFilter}
        className={className}
        onBack={onBack}
        onStatusFilter={onStatusFilter}
        onTaskFilter={onTaskFilter}
        statusFilter={statusFilter}
        taskFilter={taskFilter}
        returnTo={returnTo}
      />
    );
  }

  return (
    <div className="grid gap-5">
      {filterBar}
      {classesLoading ? (
        <div className="grid gap-3" aria-busy="true">
          {[1, 2, 3].map((item) => <TeacherSkeleton className="h-28 w-full rounded-2xl" key={item} />)}
        </div>
      ) : classesError ? (
        <TeacherCard className="p-5">
          <TeacherDataError text={toChineseLoadError(classesError)} />
        </TeacherCard>
      ) : classOptions.length === 0 ? (
        <TeacherCard className="p-5">
          <TeacherEmptyState text="还没有包含写作的班级。请先在首页“班级列表”中创建班级。" />
        </TeacherCard>
      ) : (
        <ClassReviewOverview classes={classOptions} onOpen={onOpenClass} />
      )}
    </div>
  );
}

function ClassReviewOverview({
  classes,
  onOpen
}: {
  classes: TeacherClassReviewSummary[];
  onOpen: (classId: string) => void;
}) {
  return (
    <div className="grid gap-3">
      {classes.map((entry) => (
        <TeacherCard className="flex flex-wrap items-center justify-between gap-4 p-5" key={entry.class_id}>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-student-primary-soft text-student-primary">
                <TeacherClassIcon aria-hidden="true" size={22} strokeWidth={1.9} />
              </span>
              <div className="min-w-0">
                <h2 className="truncate text-lg font-bold text-student-text">{entry.name}</h2>
                <p className="mt-1 text-sm text-student-muted">
                  {classSubjectsLabel(entry.subjects)} · {entry.member_count} 名学生
                </p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-student-text">
              <span className="inline-flex items-center gap-1">
                <ReviewStatusBadge status="pending" />
                <span className="tabular-nums font-semibold">{entry.pending_count}</span>
              </span>
              <span className="inline-flex items-center gap-1">
                <ReviewStatusBadge status="reviewing" />
                <span className="tabular-nums font-semibold">{entry.reviewing_count}</span>
              </span>
              <span className="inline-flex items-center gap-1">
                <ReviewStatusBadge status="published" />
                <span className="tabular-nums font-semibold">{entry.published_count}</span>
              </span>
            </div>
          </div>
          <button className="teacher-button-secondary" onClick={() => onOpen(entry.class_id)} type="button">
            查看批改
          </button>
        </TeacherCard>
      ))}
    </div>
  );
}

function ClassReviewList({
  classId,
  classFilter,
  className,
  onBack,
  onStatusFilter,
  onTaskFilter,
  returnTo,
  statusFilter,
  taskFilter
}: {
  classId: string;
  classFilter: React.ReactNode;
  className: string;
  onBack: () => void;
  onStatusFilter: (value: WritingReviewStatusFilter) => void;
  onTaskFilter: (value: WritingReviewTaskTypeFilter) => void;
  returnTo: string;
  statusFilter: WritingReviewStatusFilter;
  taskFilter: WritingReviewTaskTypeFilter;
}) {
  const cacheKey = `${TEACHER_WRITING_CLASS_REVIEW_LIST_CACHE_PREFIX}:${classId}`;
  const { data, error, loading } = useTeacherCachedData<WritingReviewListPayload>(
    cacheKey,
    () => loadWritingReviews(`?classId=${encodeURIComponent(classId)}`)
  );
  const attempts = useMemo(() => data?.attempts ?? [], [data]);
  const filtered = useMemo(
    () =>
      filterWritingReviewListEntries(attempts, {
        status: statusFilter,
        taskType: taskFilter
      }),
    [attempts, statusFilter, taskFilter]
  );
  const selection = useReviewListSelection(filtered, `${classId}|${statusFilter}|${taskFilter}`);
  const moderation = useWritingReviewModeration({
    cacheKey,
    clearSelection: selection.clear,
    items: filtered
  });
  const selectedCount = selection.selectedIds.size;

  return (
    <div className="grid gap-5">
      {loading ? <TeacherLoadingRegion label="正在加载班级写作提交" /> : null}
      <TeacherReviewFilterBar
        bulkActions={
          selectedCount > 0 ? (
            <WritingReviewBulkActions
              busy={moderation.busy}
              count={selectedCount}
              onCancel={() => selection.clear()}
              onIgnore={() => moderation.requestIgnore(Array.from(selection.selectedIds))}
              onReturn={() => moderation.requestReturn(Array.from(selection.selectedIds))}
            />
          ) : undefined
        }
        onStatusFilter={onStatusFilter}
        onTaskFilter={onTaskFilter}
        primary={classFilter}
        primaryLabel="班级"
        statusFilter={statusFilter}
        taskFilter={taskFilter}
      />
      <TeacherCard className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <button className="teacher-button-secondary" onClick={onBack} type="button">
            <ArrowLeft aria-hidden="true" size={16} strokeWidth={2} />
            返回班级列表
          </button>
          <p className="text-sm text-student-muted">
            当前仅显示「{className || "所选班级"}」的写作提交。
          </p>
        </div>
      </TeacherCard>
      <ReviewTable
        actions={{
          busy: moderation.busy,
          onModerate: (action, attemptIds) =>
            action === "return"
              ? moderation.requestReturn(attemptIds)
              : moderation.requestIgnore(attemptIds)
        }}
        attempts={attempts}
        error={error || moderation.error}
        filtered={filtered}
        loading={loading}
        notice={moderation.notice}
        returnTo={returnTo}
        emptyTexts={{
          noAttempts: "该班级暂无已提交的写作练习。",
          noMatch: "当前筛选条件下暂无提交。"
        }}
        selection={selection}
      />
      <WritingReviewReturnDialog
        busy={moderation.busy}
        ids={moderation.confirmIds}
        onCancel={moderation.cancelReturn}
        onConfirm={moderation.confirmReturn}
      />
    </div>
  );
}

function ReviewTable({
  actions,
  attempts,
  emptyTexts,
  error,
  filtered,
  loading,
  notice,
  returnTo,
  selection
}: {
  actions: ReviewTableActions;
  attempts: WritingReviewListItem[];
  emptyTexts: { noAttempts: string; noMatch: string };
  error: string;
  filtered: WritingReviewListItem[];
  loading: boolean;
  notice?: string;
  returnTo: string;
  selection: ReviewListSelection;
}) {
  const selectionActive = selection.selectedIds.size > 0;
  const { addMany } = selection;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [marqueeRect, setMarqueeRect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const marqueeStateRef = useRef<{
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  const suppressRowClickRef = useRef(false);

  // The rectangle is a window-level gesture: it may start on a row and end
  // outside the table, so move/up/blur all live on window. Rows are matched by
  // their current viewport rect, which also keeps the gesture correct while
  // the page itself scrolls.
  useEffect(() => {
    function finishMarquee() {
      const state = marqueeStateRef.current;
      if (!state) return;
      marqueeStateRef.current = null;
      if (state.active) {
        // The click that follows mouseup must not toggle the row under the
        // pointer; a plain click (no drag) never reaches this branch.
        suppressRowClickRef.current = true;
        window.setTimeout(() => {
          suppressRowClickRef.current = false;
        }, 0);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
      }
      setMarqueeRect(null);
    }

    function onMouseMove(event: MouseEvent) {
      const state = marqueeStateRef.current;
      if (!state) return;
      const dx = event.clientX - state.startX;
      const dy = event.clientY - state.startY;
      if (!state.active) {
        if (
          Math.abs(dx) < MARQUEE_DRAG_THRESHOLD_PX &&
          Math.abs(dy) < MARQUEE_DRAG_THRESHOLD_PX
        ) {
          return;
        }
        state.active = true;
        document.body.style.userSelect = "none";
        document.body.style.cursor = "crosshair";
      }
      const left = Math.min(state.startX, event.clientX);
      const top = Math.min(state.startY, event.clientY);
      const right = Math.max(state.startX, event.clientX);
      const bottom = Math.max(state.startY, event.clientY);
      setMarqueeRect({ left, top, width: right - left, height: bottom - top });
      const container = scrollRef.current;
      if (!container) return;
      const covered: string[] = [];
      container.querySelectorAll<HTMLElement>(`[${ROW_ATTRIBUTE}]`).forEach((row) => {
        const rect = row.getBoundingClientRect();
        if (
          !(rect.right < left || rect.left > right || rect.bottom < top || rect.top > bottom)
        ) {
          const attemptId = row.getAttribute(ROW_ATTRIBUTE);
          if (attemptId) covered.push(attemptId);
        }
      });
      addMany(covered);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", finishMarquee);
    window.addEventListener("blur", finishMarquee);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", finishMarquee);
      window.removeEventListener("blur", finishMarquee);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [addMany]);

  function startMarquee(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    // Buttons, links, checkboxes, selects and other controls keep their own
    // click behaviour: a mousedown on them never starts a drag rectangle.
    if (isInteractiveRowTarget(event.target)) return;
    marqueeStateRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      active: false
    };
    // Suppress the browser's native text selection for this gesture.
    event.preventDefault();
  }

  return (
    <TeacherCard className="overflow-hidden p-0">
      <div
        className="overflow-x-auto px-5 pb-5 pt-5 sm:px-6 sm:pb-6 sm:pt-6"
        onMouseDown={startMarquee}
        ref={scrollRef}
      >
        <table className="w-full min-w-[1040px] border-separate border-spacing-0 overflow-hidden rounded-xl border border-student-border text-left text-sm">
          <thead className="bg-student-primary-soft/55">
            <tr className="text-student-text">
              {selectionActive ? (
                <th className="w-11 px-3 py-4 font-semibold">
                  <span className="sr-only">选择</span>
                </th>
              ) : null}
              <th className="px-4 py-4 font-semibold">学生姓名</th>
              <th className="px-4 py-4 font-semibold">题型</th>
              <th className="px-4 py-4 font-semibold">题目名称</th>
              <th className="px-4 py-4 font-semibold">字数</th>
              <th className="px-4 py-4 font-semibold">提交时间</th>
              <th className="px-4 py-4 font-semibold">批改状态</th>
              <th className="px-4 py-4 font-semibold">操作</th>
            </tr>
          </thead>
          {loading ? (
            <WritingReviewTableSkeleton withSelection={selectionActive} />
          ) : filtered.length > 0 ? (
            <tbody>
              {filtered.map((attempt) => {
                const selected = selection.selectedIds.has(attempt.attemptId);
                const canModerate = attempt.reviewStatus === "pending";
                return (
                  <tr
                    className={clsx(
                      "transition",
                      selected
                        ? "bg-student-primary-soft/45 hover:bg-student-primary-soft/60"
                        : "hover:bg-student-primary-soft/35"
                    )}
                    data-writing-review-row={attempt.attemptId}
                    key={attempt.attemptId}
                    onClick={(event) => {
                      if (suppressRowClickRef.current) {
                        suppressRowClickRef.current = false;
                        return;
                      }
                      if (isInteractiveRowTarget(event.target)) return;
                      selection.toggle(attempt.attemptId);
                    }}
                  >
                    {selectionActive ? (
                      <td className="border-t border-student-border px-3 py-4">
                        <input
                          aria-label={`选择 ${attempt.studentName} 的作文`}
                          checked={selected}
                          className="h-4 w-4 accent-student-primary"
                          onChange={() => selection.toggle(attempt.attemptId)}
                          type="checkbox"
                        />
                      </td>
                    ) : null}
                    <td className="border-t border-student-border px-4 py-4 font-semibold text-student-text">
                      {attempt.studentName}
                    </td>
                    <td className="border-t border-student-border px-4 py-4 text-student-text">
                      {taskTypeLabel(attempt.taskType)}
                    </td>
                    <td className="border-t border-student-border px-4 py-4 text-student-text">
                      <p>{attempt.displayName}</p>
                      {attempt.reviewContext === "assignment_question_bank" &&
                      attempt.logicalDisplay &&
                      attempt.logicalDisplay.displayName !== attempt.displayName ? (
                        <p className="mt-1 text-xs text-student-muted">
                          {attempt.logicalDisplay.displayName}
                        </p>
                      ) : null}
                    </td>
                    <td className="border-t border-student-border px-4 py-4 tabular-nums text-student-text">
                      {attempt.wordCount}
                    </td>
                    <td className="border-t border-student-border px-4 py-4 whitespace-nowrap text-student-muted">
                      {formatSubmittedAt(attempt.submittedAt)}
                    </td>
                    <td className="border-t border-student-border px-4 py-4">
                      <ReviewStatusBadge status={attempt.reviewStatus} />
                    </td>
                    <td className="border-t border-student-border px-4 py-4">
                      <div className="flex items-center gap-1.5">
                        <Link
                          className="teacher-button-secondary !min-h-8 min-w-[52px] !px-2 !py-1 text-xs"
                          href={teacherWritingReviewWorkspaceHref(
                            attempt.attemptId,
                            returnTo || "/teacher/writing/reviews"
                          )}
                        >
                          查看
                        </Link>
                        <button
                          className={clsx(
                            "teacher-button-secondary !min-h-8 min-w-[52px] !px-2 !py-1 text-xs disabled:cursor-not-allowed disabled:pointer-events-auto",
                            !canModerate &&
                              "disabled:border-student-border disabled:text-student-muted"
                          )}
                          disabled={!canModerate || actions.busy}
                          onClick={() => actions.onModerate("return", [attempt.attemptId])}
                          type="button"
                        >
                          退回
                        </button>
                        <button
                          className={clsx(
                            "teacher-button-secondary !min-h-8 min-w-[52px] !px-2 !py-1 text-xs disabled:cursor-not-allowed disabled:pointer-events-auto",
                            !canModerate &&
                              "disabled:border-student-border disabled:text-student-muted"
                          )}
                          disabled={!canModerate || actions.busy}
                          onClick={() => actions.onModerate("ignore", [attempt.attemptId])}
                          type="button"
                        >
                          忽略
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          ) : null}
        </table>

        {error ? (
          <div className="mt-4">
            <TeacherDataError text={toChineseLoadError(error)} />
          </div>
        ) : null}
        {!error && notice ? (
          <div className="mt-4">
            <p className="teacher-loading">{notice}</p>
          </div>
        ) : null}
        {!loading && !error && filtered.length === 0 ? (
          <div className="mt-4">
            <TeacherEmptyState
              text={attempts.length === 0 ? emptyTexts.noAttempts : emptyTexts.noMatch}
            />
          </div>
        ) : null}
      </div>
      {marqueeRect && typeof document !== "undefined"
        ? createPortal(
            <div
              aria-hidden="true"
              className="pointer-events-none fixed z-[95] rounded-[3px] border border-student-primary bg-student-primary/10"
              style={{
                left: marqueeRect.left,
                top: marqueeRect.top,
                width: marqueeRect.width,
                height: marqueeRect.height
              }}
            />,
            document.body
          )
        : null}
    </TeacherCard>
  );
}

function WritingReviewTableSkeleton({ withSelection }: { withSelection: boolean }) {
  const columns = withSelection ? 8 : 7;
  const titleIndex = withSelection ? 3 : 2;
  return (
    <tbody>
      {Array.from({ length: 5 }, (_, rowIndex) => (
        <tr key={rowIndex}>
          {Array.from({ length: columns }, (_, cellIndex) => (
            <td className="border-t border-student-border px-4 py-4" key={cellIndex}>
              <TeacherSkeleton
                className={
                  cellIndex === titleIndex
                    ? "h-5 w-40"
                    : cellIndex === columns - 1
                      ? "h-10 w-24"
                      : "h-5 w-24"
                }
              />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

function ReviewStatusBadge({ status }: { status: WritingReviewListStatus }) {
  return (
    <span
      className={clsx(
        "mr-2 inline-flex h-7 w-16 items-center justify-center whitespace-nowrap rounded-full border px-1 text-xs font-semibold leading-none",
        status === "pending" && "border-amber-200 bg-amber-50 text-amber-700",
        status === "reviewing" &&
          "border-student-primary-border bg-student-primary-soft text-student-primary",
        status === "published" && "border-emerald-200 bg-emerald-50 text-emerald-700",
        status === "ignored" && "border-student-border bg-student-bg text-student-muted"
      )}
    >
      {status === "pending"
        ? "待批改"
        : status === "reviewing"
          ? "批改中"
          : status === "published"
            ? "已发布"
            : "已忽略"}
    </span>
  );
}

/** Row-level controls that keep their own click behaviour. */
function isInteractiveRowTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        "a,button,input,select,textarea,label,[role='menuitem'],[role='checkbox']"
      )
    )
  );
}

function readCachedReviewListPayload(
  entry: ReturnType<ReturnType<typeof useTeacherDataCache>["getEntry"]>
): WritingReviewListPayload | null {
  if (!entry || (entry.status !== "success" && entry.status !== "refreshing")) return null;
  const payload = entry.data as WritingReviewListPayload;
  return Array.isArray(payload?.attempts) ? payload : null;
}

async function loadWritingReviews(query = ""): Promise<WritingReviewListPayload> {
  const response = await teacherFetch(`/api/teacher/writing/reviews${query}`);
  const payload = await readJson<WritingReviewListPayload | ErrorPayload>(response);
  if (!response.ok || !("attempts" in payload)) {
    throw new Error(errorMessage(payload, "无法加载写作批改列表。"));
  }
  return payload;
}

async function loadClassReviewSummaries(): Promise<{ classes: TeacherClassReviewSummary[] }> {
  const response = await teacherFetch("/api/teacher/writing/review-classes");
  const payload = await readJson<{ classes: TeacherClassReviewSummary[] } | ErrorPayload>(response);
  if (!response.ok || !("classes" in payload)) {
    throw new Error(errorMessage(payload, "无法加载班级批改列表。"));
  }
  return payload;
}

async function teacherFetch(input: string, init?: RequestInit) {
  const supabase = createBrowserSupabase();
  const {
    data: { session }
  } = await supabase.auth.getSession();
  return fetch(input, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${session?.access_token ?? ""}`
    }
  });
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("服务器返回的数据格式无效，请稍后重试。");
  }
}

function errorMessage(payload: unknown, fallback: string) {
  if (typeof payload !== "object" || payload === null) return fallback;
  const errorPayload = payload as ErrorPayload;
  return errorPayload.message || errorPayload.error || fallback;
}

function taskTypeLabel(taskType: WritingTaskType) {
  return taskType === "email" ? "Write an Email" : "Academic Discussion";
}

function formatSubmittedAt(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function toChineseLoadError(message: string) {
  if (/unauthorized|access token|session/i.test(message)) return "登录状态已失效，请重新登录。";
  return /[\u3400-\u9fff]/.test(message) ? message : "无法加载写作批改列表，请稍后重试。";
}
