"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookMarked, CalendarDays, ChevronLeft, ChevronRight, UserRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { STUDENT_PRACTICE_ICONS } from "@/components/icons/StudentPracticeIcons";
import {
  TEACHER_STUDENT_PRACTICE_CACHE_PREFIX,
  TEACHER_STUDENT_PRACTICE_RANGE_CACHE_PREFIX,
  useTeacherCachedData,
  useTeacherDataCache
} from "@/components/TeacherDataCache";
import { ModalShell } from "@/components/shared/ConfirmDialog";
import { TeacherBreadcrumbs } from "@/components/teacher/TeacherAppShell";
import { useTeacherClassDisplayName } from "@/components/teacher/TeacherNavigationContext";
import { TeacherPopover } from "@/components/teacher/TeacherPopover";
import { SubjectBadgeStack } from "@/components/teacher/SubjectBadges";
import { TeacherSubjectFieldset } from "@/components/teacher/TeacherSubjectFieldset";
import { publishCacheInvalidation } from "@/lib/cacheInvalidation";
import {
  STUDENT_BINDING_DOMAINS,
  type StudentBindingDomain
} from "@/lib/studentBindings";
import {
  addStudentBindingDomains,
  removeStudentBindingDomain,
  studentBindingErrorMessage
} from "@/lib/teacherStudentBindingClient";
import {
  safeTeacherReturnTo,
  teacherClassIdFromReturnTo,
  teacherQueryUrl,
  teacherReturnToHref,
  teacherStudentDetailCrumbs,
  teacherStudentDetailHref,
  TEACHER_HOME_HREF
} from "@/lib/teacherNavigation";
import {
  TeacherAccuracyBar,
  TeacherCard,
  TeacherDataError,
  TeacherEmptyState,
  TeacherLoadingRegion,
  TeacherMetricCard,
  TeacherSectionTitle,
  TeacherSkeleton
} from "@/components/teacher/TeacherUI";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { formatAccountForDisplay } from "@/lib/accountIdentifier";
import {
  formatTeacherPracticeTaskSelection,
  parseTeacherPracticeTaskSelection,
  TEACHER_PRACTICE_TASK_LABELS,
  TEACHER_PRACTICE_TASK_SHORT_LABELS,
  TEACHER_PRACTICE_TASK_TYPES,
  type TeacherPracticeRecord,
  type TeacherPracticeTaskType,
  type TeacherStudentPracticePayload
} from "@/lib/teacherStudentPractice";
import {
  TEACHER_PRACTICE_RANGE_DAY_COUNT_KEYS,
  TEACHER_PRACTICE_RANGE_DAY_COUNT_LABELS,
  type TeacherPracticeRangeDay,
  type TeacherPracticeRangeDayCountKey,
  type TeacherStudentPracticeRangePayload
} from "@/lib/teacherStudentPracticeRange";

const READING_TASKS = ["ctw", "rdl", "rap"] as const;
const WRITING_TASKS = ["build_sentence", "email", "academic_discussion"] as const;

// The date list keeps its shared wrong-question counters for every teacher,
// while subject-specific columns follow the student's binding domains.
const RANGE_READING_DAY_KEYS = new Set<TeacherPracticeRangeDayCountKey>([
  "ctw",
  "rdl",
  "rap",
  "full_set"
]);
const RANGE_WRITING_DAY_KEYS = new Set<TeacherPracticeRangeDayCountKey>([
  "build_sentence",
  "email",
  "academic_discussion"
]);

type PracticeView =
  | { kind: "day" }
  | { kind: "range"; start: string; end: string }
  | { kind: "rangeDay"; start: string; end: string; date: string };

const ALL_TASKS_SELECTED: Record<TeacherPracticeTaskType, boolean> = {
  ctw: true,
  rdl: true,
  rap: true,
  full_set: true,
  build_sentence: true,
  email: true,
  academic_discussion: true
};

export function TeacherStudentPracticeWorkspace({
  initialDate,
  initialTasks,
  returnTo,
  studentId
}: {
  /** Calendar date (YYYY-MM-DD) from the URL; missing means today. */
  initialDate?: string;
  /** Task filter (comma list / `none`) from the URL; missing means all. */
  initialTasks?: string;
  returnTo?: string;
  studentId: string;
}) {
  const router = useRouter();
  const cache = useTeacherDataCache();
  const [selectedDay, setSelectedDay] = useState(
    () => parseDateInputValue(initialDate ?? "") ?? startOfLocalDay()
  );
  // "day" is the untouched single-day detail. "range" swaps the practice area
  // for the range statistics. "rangeDay" reuses the single-day detail for one
  // date of the active range and can return to the cached range view.
  const [view, setView] = useState<PracticeView>({ kind: "day" });
  const [dateDraft, setDateDraft] = useState(() => ({
    start: formatDateInputValue(parseDateInputValue(initialDate ?? "") ?? startOfLocalDay()),
    end: formatDateInputValue(parseDateInputValue(initialDate ?? "") ?? startOfLocalDay())
  }));
  const [selectedTasks, setSelectedTasks] = useState(() =>
    initialTasks === undefined
      ? ALL_TASKS_SELECTED
      : parseTeacherPracticeTaskSelection(initialTasks));
  const [subjectsDraft, setSubjectsDraft] = useState<StudentBindingDomain[]>([]);
  const [subjectsDialogOpen, setSubjectsDialogOpen] = useState(false);
  const [subjectsBusy, setSubjectsBusy] = useState(false);
  const [subjectsError, setSubjectsError] = useState("");
  // Local override keeps the header badges instant after a save; the practice
  // payload itself refreshes from the server.
  const [domainsOverride, setDomainsOverride] = useState<StudentBindingDomain[] | null>(null);
  const range = useMemo(() => localDayRange(selectedDay), [selectedDay]);
  const parentReturnTo = safeTeacherReturnTo(returnTo, TEACHER_HOME_HREF);
  const className = useTeacherClassDisplayName(teacherClassIdFromReturnTo(parentReturnTo));
  // The drill-down returnTo carries the active date and task filter, so every
  // result page (and its read-only question pages) can come back to exactly
  // this view instead of the default today view.
  const selfQuery = new URLSearchParams({ date: formatDateInputValue(selectedDay) });
  const selfTasks = formatTeacherPracticeTaskSelection(selectedTasks);
  if (selfTasks) selfQuery.set("tasks", selfTasks);
  const selfHref = teacherReturnToHref(
    `${teacherStudentDetailHref(studentId)}?${selfQuery.toString()}`,
    parentReturnTo
  );

  // The URL props stay the source of truth, so browser Back/Forward restores
  // the date and the filter exactly like a fresh drill-down return does.
  useEffect(() => {
    setSelectedDay(parseDateInputValue(initialDate ?? "") ?? startOfLocalDay());
  }, [initialDate]);
  useEffect(() => {
    setSelectedTasks(parseTeacherPracticeTaskSelection(initialTasks));
  }, [initialTasks]);

  // Keep the address bar in sync so a refresh (or a copied URL) keeps the same
  // view. Missing `date` already means today, so the default state never
  // rewrites the URL.
  useEffect(() => {
    const desiredDate = formatDateInputValue(selectedDay);
    const desiredTasks = formatTeacherPracticeTaskSelection(selectedTasks);
    const params = new URLSearchParams(window.location.search);
    const currentDate = params.get("date") ?? "";
    const currentTasks = params.get("tasks") ?? "";
    const dateMatches = currentDate === desiredDate
      || (currentDate === "" && isToday(selectedDay));
    if (dateMatches && currentTasks === desiredTasks) return;
    router.replace(teacherQueryUrl({ date: desiredDate, tasks: desiredTasks || null }));
  }, [router, selectedDay, selectedTasks]);
  const practiceCacheKey =
    `${TEACHER_STUDENT_PRACTICE_CACHE_PREFIX}:${studentId}:${range.startAt}:${range.endAt}`;
  // A teacher with no binding for this student can no longer load their
  // practice; render the closed state instead of a request that would 403.
  const noDomains = domainsOverride !== null && domainsOverride.length === 0;
  const state = useTeacherCachedData<TeacherStudentPracticePayload>(
    practiceCacheKey,
    () => loadTeacherStudentPractice(studentId, range.startAt, range.endAt),
    { enabled: !noDomains }
  );
  const payload = state.data;
  const studentDomains =
    domainsOverride ?? payload?.student.domains ?? [];
  const readingRecords = filterRecords(payload?.reading?.records ?? [], selectedTasks);
  const writingRecords = filterRecords(payload?.writing?.records ?? [], selectedTasks);
  const rangeStartKey = view.kind === "range" || view.kind === "rangeDay" ? view.start : "";
  const rangeEndKey = view.kind === "range" || view.kind === "rangeDay" ? view.end : "";
  const rangeCacheKey = rangeStartKey && rangeEndKey
    ? `${TEACHER_STUDENT_PRACTICE_RANGE_CACHE_PREFIX}:${studentId}:${rangeStartKey}:${rangeEndKey}`
    : `${TEACHER_STUDENT_PRACTICE_RANGE_CACHE_PREFIX}:${studentId}:none`;
  // The range payload is cached per student and date pair, so stepping into one
  // date and back never refetches it.
  const rangeState = useTeacherCachedData<TeacherStudentPracticeRangePayload>(
    rangeCacheKey,
    () => loadTeacherStudentPracticeRange(studentId, rangeStartKey, rangeEndKey),
    { enabled: !noDomains && Boolean(rangeStartKey && rangeEndKey) }
  );

  // Keep the popover drafts aligned with the active selection whenever the
  // selection itself changes; typing inside the popover is never overwritten.
  useEffect(() => {
    if (view.kind === "range" || view.kind === "rangeDay") {
      setDateDraft({ start: view.start, end: view.end });
      return;
    }
    const day = formatDateInputValue(selectedDay);
    setDateDraft({ start: day, end: day });
  }, [view, selectedDay]);

  function applyDateDraft(close: () => void) {
    let start = dateDraft.start || formatDateInputValue(selectedDay);
    let end = dateDraft.end || start;
    if (end < start) [start, end] = [end, start];
    const startDay = parseDateInputValue(start) ?? selectedDay;
    close();
    setSelectedDay(startDay);
    setView(start === end
      ? { kind: "day" }
      : { kind: "range", start, end });
  }

  function openRangeDay(date: string) {
    if (view.kind !== "range" && view.kind !== "rangeDay") return;
    setSelectedDay(parseDateInputValue(date) ?? selectedDay);
    setView({ kind: "rangeDay", start: view.start, end: view.end, date });
  }

  function openSubjectsDialog() {
    setSubjectsDraft(studentDomains);
    setSubjectsError("");
    setSubjectsDialogOpen(true);
  }

  /**
   * 修改授课科目 edits exactly the current teacher's binding for this student:
   * a newly checked subject inserts the binding, an unchecked one deletes it.
   * Class subjects, memberships and other teachers are never touched.
   */
  async function saveSubjects() {
    const current = studentDomains;
    const next = STUDENT_BINDING_DOMAINS.filter((domain) => subjectsDraft.includes(domain));
    const toAdd = next.filter((domain) => !current.includes(domain));
    const toRemove = current.filter((domain) => !next.includes(domain));
    if (toAdd.length === 0 && toRemove.length === 0) {
      setSubjectsDialogOpen(false);
      return;
    }
    setSubjectsBusy(true);
    setSubjectsError("");
    try {
      if (toAdd.length > 0) await addStudentBindingDomains(studentId, toAdd);
      for (const domain of toRemove) await removeStudentBindingDomain(studentId, domain);

      setDomainsOverride(next);
      // The student id lets the shared cache drop this student's cached
      // sub-pages too, so losing the last binding never leaves a readable
      // cached detail view behind.
      publishCacheInvalidation({ type: "TEACHER_BINDING_UPDATED", studentId });
      // The invalidation above drops this page's practice entry; re-seed it
      // (badges and already loaded records) so the panel never flashes back to
      // a loading state. A removed subject's section is cleared immediately.
      if (payload && next.length > 0) {
        cache.set<TeacherStudentPracticePayload>(practiceCacheKey, {
          ...payload,
          student: { ...payload.student, domains: next },
          reading: next.includes("reading") ? payload.reading : null,
          writing: next.includes("writing") ? payload.writing : null
        });
      }
      if (next.length > 0) {
        // Refresh in the background so a newly added subject's section loads
        // without a manual reload.
        void cache.refresh<TeacherStudentPracticePayload>(practiceCacheKey, () =>
          loadTeacherStudentPractice(studentId, range.startAt, range.endAt)
        );
      }
      setSubjectsDialogOpen(false);
    } catch (mutation) {
      setSubjectsError(studentBindingErrorMessage(mutation, "授课科目保存失败，请稍后重试。"));
    } finally {
      setSubjectsBusy(false);
    }
  }

  if (noDomains) {
    return (
      <div className="grid gap-5">
        <TeacherBreadcrumbs
          crumbs={teacherStudentDetailCrumbs({
            className,
            returnTo: parentReturnTo,
            studentName: payload?.student.displayName ?? "学生详情"
          })}
        />
        <StudentAccessRemovedCard
          message="你已不再负责该学生的任何授课科目，无法查看其练习记录。如需恢复，请重新选择授课科目。"
          onEditSubjects={openSubjectsDialog}
          returnHref={parentReturnTo}
        />
        <StudentSubjectsDialog
          busy={subjectsBusy}
          error={subjectsError}
          onClose={() => (subjectsBusy ? undefined : setSubjectsDialogOpen(false))}
          onSave={() => void saveSubjects()}
          onChange={setSubjectsDraft}
          open={subjectsDialogOpen}
          value={subjectsDraft}
        />
      </div>
    );
  }

  return (
    <div className="grid gap-5">
      <TeacherBreadcrumbs
        crumbs={teacherStudentDetailCrumbs({
          className,
          returnTo: parentReturnTo,
          studentName: payload?.student.displayName ?? "学生详情"
        })}
      />
      {state.loading ? (
        <>
          <TeacherLoadingRegion label="正在加载学生练习记录" />
          <TeacherStudentPracticeSkeleton />
        </>
      ) : null}
      {state.error ? (
        practiceAccessLost(state.error) ? (
          <StudentAccessRemovedCard
            message="无法查看该学生的练习记录：该学生已不再由你负责，或已停用。如需恢复，请重新选择授课科目。"
            onEditSubjects={openSubjectsDialog}
            returnHref={parentReturnTo}
          />
        ) : (
          <TeacherDataError text={toPracticeErrorMessage(state.error)} />
        )
      ) : null}
      {!state.loading && !state.error && payload ? (
        <>
          <TeacherCard className="flex min-h-[96px] flex-wrap items-center justify-between gap-4 p-5">
            <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-3">
              <span className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-student-primary-soft text-student-primary">
                <UserRound aria-hidden="true" size={28} strokeWidth={1.9} />
              </span>
              <div className="min-w-0">
                <h2 className="truncate text-2xl font-bold text-student-text">
                  {payload.student.displayName}
                </h2>
                <p className="mt-1 truncate text-sm text-student-muted">
                  账号：{formatAccountForDisplay(payload.student.account) || "学生数据暂时无法显示"}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {studentDomains.length > 0 ? (
                  <SubjectBadgeStack direction="column" domains={studentDomains} />
                ) : null}
                <button
                  className="teacher-button-secondary shrink-0"
                  onClick={openSubjectsDialog}
                  type="button"
                >
                  修改授课科目
                </button>
              </div>
            </div>
            <Link className="teacher-button-primary ml-auto shrink-0 gap-2" href={teacherReturnToHref(`/teacher/students/${encodeURIComponent(studentId)}/wordbook`, selfHref)} prefetch={false}>
              <BookMarked aria-hidden="true" size={18} strokeWidth={1.9} />生词本
            </Link>
          </TeacherCard>

          <TeacherCard className="flex flex-wrap items-center justify-between gap-4 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <button
                aria-label="上一天"
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-student-border bg-white text-student-muted transition hover:border-student-primary-border hover:text-student-primary"
                onClick={() => {
                  setView({ kind: "day" });
                  setSelectedDay((day) => addDays(day, -1));
                }}
                type="button"
              >
                <ChevronLeft aria-hidden="true" size={18} />
              </button>
              <p className="min-w-[178px] text-center text-sm font-bold text-student-text">
                {view.kind === "range"
                  ? formatRangeLabel(view.start, view.end)
                  : formatDayLabel(selectedDay)}
              </p>
              <button
                aria-label="下一天"
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-student-border bg-white text-student-muted transition hover:border-student-primary-border hover:text-student-primary"
                onClick={() => {
                  setView({ kind: "day" });
                  setSelectedDay((day) => addDays(day, 1));
                }}
                type="button"
              >
                <ChevronRight aria-hidden="true" size={18} />
              </button>
              <button
                className="inline-flex h-9 items-center rounded-lg border border-student-primary-border bg-student-primary-soft/60 px-3 text-sm font-semibold text-student-primary transition disabled:opacity-45"
                disabled={view.kind === "day" && isToday(selectedDay)}
                onClick={() => {
                  setView({ kind: "day" });
                  setSelectedDay(startOfLocalDay());
                }}
                type="button"
              >
                今天
              </button>
              {/* Same icon control as before: single date and range share one
                  picker, so the date area keeps its exact size and position. */}
              <TeacherPopover
                buttonClassName="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-student-border bg-white text-student-muted transition hover:border-student-primary-border hover:text-student-primary"
                buttonContent={
                  <>
                    <span className="sr-only">选择日期</span>
                    <CalendarDays aria-hidden="true" size={18} />
                  </>
                }
                menuClassName="w-[304px] p-4"
                panelRole="dialog"
              >
                {(close) => (
                  <form
                    className="grid gap-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      applyDateDraft(close);
                    }}
                  >
                    <p className="text-sm font-bold text-student-text">日期选择</p>
                    <label className="grid gap-1.5 text-xs font-semibold text-student-muted">
                      开始日期
                      <input
                        aria-label="开始日期"
                        className="teacher-input w-full"
                        onChange={(event) =>
                          setDateDraft((draft) => ({ ...draft, start: event.target.value }))
                        }
                        type="date"
                        value={dateDraft.start}
                      />
                    </label>
                    <label className="grid gap-1.5 text-xs font-semibold text-student-muted">
                      结束日期（可不填）
                      <input
                        aria-label="结束日期"
                        className="teacher-input w-full"
                        onChange={(event) =>
                          setDateDraft((draft) => ({ ...draft, end: event.target.value }))
                        }
                        type="date"
                        value={dateDraft.end}
                      />
                    </label>
                    <p className="text-xs leading-5 text-student-muted">
                      同一天按单日详情查看；起止不同则显示范围统计。
                    </p>
                    <button
                      className="teacher-button-primary w-full"
                      disabled={!dateDraft.start}
                      type="submit"
                    >
                      {!dateDraft.end || dateDraft.end === dateDraft.start
                        ? "查看当天"
                        : "查看范围统计"}
                    </button>
                  </form>
                )}
              </TeacherPopover>
            </div>
            <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <legend className="sr-only">题型筛选</legend>
              {TEACHER_PRACTICE_TASK_TYPES.map((taskType) => (
                <label
                  className="inline-flex cursor-pointer items-center gap-1.5 text-sm font-semibold text-student-text"
                  key={taskType}
                >
                  <input
                    checked={selectedTasks[taskType]}
                    className="h-4 w-4 accent-student-primary"
                    onChange={(event) =>
                      setSelectedTasks((current) => ({
                        ...current,
                        [taskType]: event.target.checked
                      }))
                    }
                    type="checkbox"
                  />
                  {TEACHER_PRACTICE_TASK_SHORT_LABELS[taskType]}
                </label>
              ))}
            </fieldset>
          </TeacherCard>

          {view.kind === "range" ? (
            <TeacherStudentPracticeRangeView
              onOpenDay={openRangeDay}
              state={rangeState}
            />
          ) : null}

          {view.kind === "rangeDay" ? (
            <TeacherPracticeRangeReturnBar
              date={view.date}
              end={view.end}
              onBack={() => setView({ kind: "range", start: view.start, end: view.end })}
              start={view.start}
            />
          ) : null}

          {view.kind !== "range" && payload.reading ? (
            <section className="grid gap-4">
              <div className="flex flex-wrap items-center gap-3">
                <TeacherSectionTitle>Reading 练习</TeacherSectionTitle>
                <DomainChip domain="reading" />
              </div>
              {/* Desktop: CTW / RDL / RAP / Full Set in one equal-width row. */}
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {READING_TASKS.map((taskType) => {
                  const task = payload.reading!.tasks[taskType];
                  return (
                    <TeacherMetricCard
                      icon={STUDENT_PRACTICE_ICONS[taskType]}
                      key={taskType}
                      label={TEACHER_PRACTICE_TASK_LABELS[taskType]}
                      secondary={`平均正确率 ${task.totalPoints > 0 ? formatPercent(task.accuracy) : "—"}`}
                      tone="reading"
                      value={`${task.attempts} 次`}
                    />
                  );
                })}
                <TeacherMetricCard
                  icon={STUDENT_PRACTICE_ICONS.full_set}
                  label={TEACHER_PRACTICE_TASK_LABELS.full_set}
                  secondary={`平均正确率 ${
                    payload.reading!.fullSet.totalPoints > 0
                      ? formatPercent(payload.reading!.fullSet.accuracy)
                      : "—"
                  }`}
                  tone="reading"
                  value={`${payload.reading!.fullSet.attempts} 次`}
                />
              </div>
              <TeacherPracticeRecordList
                emptyText="该日期暂无 Reading 练习记录。"
                records={readingRecords}
                returnTo={selfHref}
              />
            </section>
          ) : null}

          {view.kind !== "range" && payload.writing ? (
            <section className="grid gap-4">
              <div className="flex flex-wrap items-center gap-3">
                <TeacherSectionTitle>Writing 练习</TeacherSectionTitle>
                <DomainChip domain="writing" />
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <TeacherMetricCard
                  icon={STUDENT_PRACTICE_ICONS.build_sentence}
                  label={TEACHER_PRACTICE_TASK_LABELS.build_sentence}
                  secondary={`平均正确率 ${
                    payload.writing.tasks.build_sentence.totalQuestions > 0
                      ? formatPercent(payload.writing.tasks.build_sentence.accuracy)
                      : "—"
                  }`}
                  value={`${payload.writing.tasks.build_sentence.attempts} 次`}
                />
                {([...WRITING_TASKS].filter((taskType) => taskType !== "build_sentence") as Array<
                  "email" | "academic_discussion"
                >).map((taskType) => {
                  const task = payload.writing!.tasks[taskType];
                  return (
                    <TeacherMetricCard
                      icon={STUDENT_PRACTICE_ICONS[taskType]}
                      key={taskType}
                      label={TEACHER_PRACTICE_TASK_LABELS[taskType]}
                      secondary={`平均分 ${
                        task.averageScore === null ? "暂无评分" : `${formatScore(task.averageScore)}/5`
                      }`}
                      value={`${task.attempts} 次`}
                    />
                  );
                })}
              </div>
              <TeacherPracticeRecordList
                emptyText="该日期暂无 Writing 练习记录。"
                records={writingRecords}
                returnTo={selfHref}
              />
            </section>
          ) : null}
        </>
      ) : null}

      <StudentSubjectsDialog
        busy={subjectsBusy}
        error={subjectsError}
        onChange={setSubjectsDraft}
        onClose={() => (subjectsBusy ? undefined : setSubjectsDialogOpen(false))}
        onSave={() => void saveSubjects()}
        open={subjectsDialogOpen}
        value={subjectsDraft}
      />
    </div>
  );
}

/**
 * 修改授课科目 for one student. Reuses the class-detail modal shell, subject
 * checkbox fieldset and save/cancel buttons, but the checked boxes are the
 * current teacher's real reading/writing bindings for this student.
 */
function StudentSubjectsDialog({
  busy,
  error,
  onChange,
  onClose,
  onSave,
  open,
  value
}: {
  busy: boolean;
  error: string;
  onChange: (domains: StudentBindingDomain[]) => void;
  onClose: () => void;
  onSave: () => void;
  open: boolean;
  value: StudentBindingDomain[];
}) {
  return (
    <ModalShell open={open} onClose={onClose} size="wide">
      <p className="text-base font-bold text-student-text">修改授课科目</p>
      <div className="mt-4">
        <TeacherSubjectFieldset
          disabled={busy}
          helpText="勾选表示由你负责该学生的对应科目；只修改当前教师与这个学生的绑定，不影响班级授课科目和其他教师。"
          onChange={onChange}
          value={value}
        />
      </div>
      {error ? <p className="teacher-error mt-3">{error}</p> : null}
      <div className="mt-6 flex justify-end gap-3">
        <button className="teacher-button-secondary" disabled={busy} onClick={onClose} type="button">
          取消
        </button>
        <button className="teacher-button-primary" disabled={busy} onClick={onSave} type="button">
          {busy ? "保存中…" : "保存"}
        </button>
      </div>
    </ModalShell>
  );
}

export function TeacherPracticeRecordList({
  emptyText,
  records,
  returnTo
}: {
  emptyText: string;
  records: TeacherPracticeRecord[];
  returnTo?: string;
}) {
  if (records.length === 0) {
    return (
      <TeacherCard className="p-5">
        <TeacherEmptyState text={emptyText} />
      </TeacherCard>
    );
  }
  return (
    <TeacherCard className="overflow-hidden p-0">
      <div className="divide-y divide-student-border px-5">
        {records.map((record) => (
          <TeacherPracticeRecordRow key={record.recordId} record={record} returnTo={returnTo} />
        ))}
      </div>
    </TeacherCard>
  );
}

function TeacherPracticeRecordRow({
  record,
  returnTo
}: {
  record: TeacherPracticeRecord;
  returnTo?: string;
}) {
  const href = record.href ? teacherReturnToHref(record.href, returnTo) : null;
  const title = href ? (
    <Link className="truncate font-semibold text-student-text hover:underline" href={href}>
      {record.title}
    </Link>
  ) : (
    <span className="truncate font-semibold text-student-text">{record.title}</span>
  );

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="flex min-w-0 items-center gap-2 text-sm">
          <span className={record.domain === "reading" ? READING_CHIP_CLASS : WRITING_CHIP_CLASS}>
            {TEACHER_PRACTICE_TASK_SHORT_LABELS[record.taskType]}
          </span>
          {record.kind === "wrongbook" ? (
            <span className="shrink-0 rounded-full border border-student-border bg-student-bg px-2 py-0.5 text-xs font-semibold text-student-muted">
              错题订正
            </span>
          ) : null}
          {title}
        </p>
        <p className="mt-1 text-xs text-student-muted">
          {TEACHER_PRACTICE_TASK_LABELS[record.taskType]}
          {record.scope ? ` · ${record.scope === "today" ? "今日错题" : "历史错题"}` : ""}
          {" · "}
          {formatRecordTime(record.submittedAt)}
        </p>
      </div>
      <div className="flex min-w-[190px] items-center justify-end gap-3">
        {record.metric.kind === "objective" ? (
          <>
            <span className="text-xs tabular-nums text-student-muted">
              {record.metric.correct}/{record.metric.total}
            </span>
            <TeacherAccuracyBar value={record.metric.accuracy} />
          </>
        ) : (
          <>
            <span className="text-sm font-semibold tabular-nums text-student-text">
              {record.metric.hasScore && record.metric.score !== null
                ? `${formatScore(record.metric.score)}/5`
                : "未评分"}
            </span>
            <span className="text-xs tabular-nums text-student-muted">
              {record.metric.wordCount} words
            </span>
          </>
        )}
        <span className="w-16 text-right text-xs tabular-nums text-student-muted">
          {formatDuration(record.durationSeconds)}
        </span>
      </div>
    </div>
  );
}

export function DomainChip({ domain }: { domain: "reading" | "writing" }) {
  if (domain === "reading") {
    return (
      <span className={READING_CHIP_CLASS}>
        Reading
      </span>
    );
  }
  return (
    <span className={WRITING_CHIP_CLASS}>
      Writing
    </span>
  );
}

const READING_CHIP_CLASS =
  "shrink-0 rounded-full border border-[#cfe3f8] bg-[#eef6ff] px-2 py-0.5 text-xs font-semibold text-[#347fdc]";
const WRITING_CHIP_CLASS =
  "shrink-0 rounded-full border border-student-primary-border bg-student-primary-soft px-2 py-0.5 text-xs font-semibold text-student-primary";

function filterRecords(
  records: TeacherPracticeRecord[],
  selectedTasks: Record<TeacherPracticeTaskType, boolean>
) {
  return records.filter((record) => selectedTasks[record.taskType]);
}

function toPracticeErrorMessage(message: string) {
  if (/无权|forbidden/i.test(message)) return "无权查看该学生的练习记录。";
  return /[\u3400-\u9fff]/.test(message) ? message : "练习记录加载失败，请稍后重试。";
}

/**
 * The student detail endpoint removes the student from the teacher's scope
 * once no binding is left (404 未找到该学生) or answers 403 for a bound domain
 * that no longer matches. That state must never fall back to cached practice
 * data: the page shows the explicit "no longer responsible" card instead.
 */
function practiceAccessLost(message: string) {
  return /未找到该学生|无权查看|forbidden/i.test(message);
}

function StudentAccessRemovedCard({
  message,
  onEditSubjects,
  returnHref
}: {
  message: string;
  onEditSubjects: () => void;
  returnHref: string;
}) {
  return (
    <TeacherCard className="grid gap-4 p-6">
      <p className="text-sm text-student-muted">{message}</p>
      <div className="flex flex-wrap gap-3">
        <button className="teacher-button-secondary" onClick={onEditSubjects} type="button">
          修改授课科目
        </button>
        <Link className="teacher-button-secondary" href={returnHref}>
          返回学生列表
        </Link>
      </div>
    </TeacherCard>
  );
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatScore(value: number) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatDuration(value: number) {
  const seconds = Math.max(0, Math.round(value));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours}小时${minutes % 60 ? `${minutes % 60}分钟` : ""}`;
}

function formatRecordTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit"
  });
}

function startOfLocalDay(date = new Date()) {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day;
}

function addDays(day: Date, amount: number) {
  const next = startOfLocalDay(day);
  next.setDate(next.getDate() + amount);
  return next;
}

function localDayRange(day: Date) {
  const start = startOfLocalDay(day);
  const end = addDays(start, 1);
  return { startAt: start.toISOString(), endAt: end.toISOString() };
}

function isToday(day: Date) {
  return startOfLocalDay(day).getTime() === startOfLocalDay().getTime();
}

function formatDayLabel(day: Date) {
  const label = `${day.getFullYear()}年${day.getMonth() + 1}月${day.getDate()}日`;
  return isToday(day) ? `${label} · 今天` : label;
}

function formatRangeLabel(startKey: string, endKey: string) {
  const start = parseDateInputValue(startKey);
  const end = parseDateInputValue(endKey);
  if (!start || !end) return "";
  const startLabel = `${start.getFullYear()}年${start.getMonth() + 1}月${start.getDate()}日`;
  if (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()) {
    return `${startLabel}–${end.getDate()}日`;
  }
  const endLabel = start.getFullYear() === end.getFullYear()
    ? `${end.getMonth() + 1}月${end.getDate()}日`
    : `${end.getFullYear()}年${end.getMonth() + 1}月${end.getDate()}日`;
  return `${startLabel}–${endLabel}`;
}

function formatRangeDayLabel(dateKey: string) {
  const day = parseDateInputValue(dateKey);
  if (!day) return dateKey;
  const weekday = day.toLocaleDateString("zh-CN", { weekday: "short" });
  return `${day.getFullYear()}年${day.getMonth() + 1}月${day.getDate()}日 · ${weekday}`;
}

function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
  } catch {
    return "Asia/Shanghai";
  }
}

function formatDateInputValue(day: Date) {
  const month = String(day.getMonth() + 1).padStart(2, "0");
  const date = String(day.getDate()).padStart(2, "0");
  return `${day.getFullYear()}-${month}-${date}`;
}

function parseDateInputValue(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(day.getTime()) ? null : day;
}

export function TeacherStudentPracticeSkeleton() {
  return (
    <>
      <TeacherCard className="grid gap-3 p-5">
        <TeacherSkeleton className="h-7 w-40" />
        <TeacherSkeleton className="h-4 w-56" />
      </TeacherCard>
      <TeacherCard className="grid gap-3 p-4">
        <TeacherSkeleton className="h-9 w-full" />
      </TeacherCard>
      <div className="grid gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <TeacherSkeleton className="h-[108px] w-full rounded-2xl" key={index} />
        ))}
      </div>
      <TeacherSkeleton className="h-40 w-full rounded-2xl" />
    </>
  );
}

/**
 * Range statistics view. It reuses the single-day metric cards: four reading
 * cards in one equal-width row, then the three writing cards on the same
 * four-column grid so they stay aligned with CTW / RDL / RAP and the Full Set
 * column under the Full Set card stays empty. Practice records are never
 * listed here; the date list carries the per-day counts only.
 */
function TeacherStudentPracticeRangeView({
  onOpenDay,
  state
}: {
  onOpenDay: (date: string) => void;
  state: {
    data: TeacherStudentPracticeRangePayload | null;
    error: string;
    loading: boolean;
  };
}) {
  if (state.loading) {
    return (
      <>
        <TeacherLoadingRegion label="正在加载范围统计" />
        <TeacherStudentPracticeRangeSkeleton />
      </>
    );
  }
  if (state.error) {
    return <TeacherDataError text={toPracticeErrorMessage(state.error)} />;
  }
  const data = state.data;
  if (!data) return null;

  return (
    <section className="grid gap-4">
      {data.reading ? (
        <section className="grid gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <TeacherSectionTitle>Reading 练习</TeacherSectionTitle>
            <DomainChip domain="reading" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {READING_TASKS.map((taskType) => {
              const task = data.reading!.tasks[taskType];
              return (
                <TeacherMetricCard
                  icon={STUDENT_PRACTICE_ICONS[taskType]}
                  key={taskType}
                  label={TEACHER_PRACTICE_TASK_LABELS[taskType]}
                  secondary={`平均正确率 ${task.totalPoints > 0 ? formatPercent(task.accuracy) : "—"}`}
                  tone="reading"
                  value={`${task.attempts} 次`}
                />
              );
            })}
            <TeacherMetricCard
              icon={STUDENT_PRACTICE_ICONS.full_set}
              label={TEACHER_PRACTICE_TASK_LABELS.full_set}
              secondary={`平均正确率 ${
                data.reading!.fullSet.totalPoints > 0
                  ? formatPercent(data.reading!.fullSet.accuracy)
                  : "—"
              }`}
              tone="reading"
              value={`${data.reading!.fullSet.attempts} 次`}
            />
          </div>
        </section>
      ) : null}

      {data.writing ? (
        <section className="grid gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <TeacherSectionTitle>Writing 练习</TeacherSectionTitle>
            <DomainChip domain="writing" />
          </div>
          {/* Same four-column grid as the reading row: BAS / WE / AD line up
              with CTW / RDL / RAP and the Full Set column stays empty. */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <TeacherMetricCard
              icon={STUDENT_PRACTICE_ICONS.build_sentence}
              label={TEACHER_PRACTICE_TASK_LABELS.build_sentence}
              secondary={`平均正确率 ${
                data.writing.tasks.build_sentence.totalQuestions > 0
                  ? formatPercent(data.writing.tasks.build_sentence.accuracy)
                  : "—"
              }`}
              value={`${data.writing.tasks.build_sentence.attempts} 次`}
            />
            {(["email", "academic_discussion"] as const).map((taskType) => {
              const task = data.writing!.tasks[taskType];
              return (
                <TeacherMetricCard
                  icon={STUDENT_PRACTICE_ICONS[taskType]}
                  key={taskType}
                  label={TEACHER_PRACTICE_TASK_LABELS[taskType]}
                  secondary={`平均分 ${
                    task.averageScore === null ? "暂无评分" : `${formatScore(task.averageScore)}/5`
                  }`}
                  value={`${task.attempts} 次`}
                />
              );
            })}
          </div>
        </section>
      ) : null}

      <TeacherPracticeRangeDayList
        days={data.days}
        onOpenDay={onOpenDay}
        visibleKeys={rangeDayVisibleKeys(data)}
      />
    </section>
  );
}

/**
 * The date list keeps every shared wrong-question counter and only shows the
 * subject-specific columns the teacher is bound to for this student.
 */
function rangeDayVisibleKeys(data: TeacherStudentPracticeRangePayload) {
  return TEACHER_PRACTICE_RANGE_DAY_COUNT_KEYS.filter((key) =>
    RANGE_READING_DAY_KEYS.has(key)
      ? Boolean(data.reading)
      : RANGE_WRITING_DAY_KEYS.has(key)
        ? Boolean(data.writing)
        : true
  );
}

/**
 * The per-day counters. Entry corrections are independent attempts; today /
 * history wrong questions count finished sessions (one per session), never the
 * attempts inside them. Shared counters stay visible for every teacher.
 */
function TeacherPracticeRangeDayList({
  days,
  onOpenDay,
  visibleKeys
}: {
  days: TeacherPracticeRangeDay[];
  onOpenDay: (date: string) => void;
  visibleKeys: TeacherPracticeRangeDayCountKey[];
}) {
  // 10 (both subjects) / 7 (reading only) / 6 (writing only) columns.
  const columnsClass = visibleKeys.length > 7
    ? "grid-cols-5 sm:grid-cols-10"
    : visibleKeys.length > 6
      ? "grid-cols-4 sm:grid-cols-7"
      : "grid-cols-3 sm:grid-cols-6";
  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <TeacherSectionTitle>按日期统计</TeacherSectionTitle>
        <span className="text-sm text-student-muted">点击日期查看当天练习记录</span>
      </div>
      {days.length === 0 ? (
        <TeacherCard className="p-5">
          <TeacherEmptyState text="该日期范围暂无练习记录。" />
        </TeacherCard>
      ) : (
        <TeacherCard className="overflow-hidden p-0">
          <div className="divide-y divide-student-border px-5">
            {days.map((day) => (
              <div
                className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3"
                key={day.date}
              >
                <button
                  className="text-sm font-semibold text-student-primary hover:underline"
                  onClick={() => onOpenDay(day.date)}
                  type="button"
                >
                  {formatRangeDayLabel(day.date)}
                </button>
                <div className={`grid gap-x-3 gap-y-1 ${columnsClass}`}>
                  {visibleKeys.map((key) => (
                    <div className="min-w-[64px] text-center" key={key}>
                      <p className="text-[11px] font-medium text-student-muted">
                        {TEACHER_PRACTICE_RANGE_DAY_COUNT_LABELS[key]}
                      </p>
                      <p
                        className={
                          day.counts[key] > 0
                            ? "text-sm font-bold tabular-nums text-student-text"
                            : "text-sm font-semibold tabular-nums text-student-muted/70"
                        }
                      >
                        {day.counts[key]}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </TeacherCard>
      )}
    </section>
  );
}

/** Return path from one range day back to the still-cached range statistics. */
function TeacherPracticeRangeReturnBar({
  date,
  end,
  onBack,
  start
}: {
  date: string;
  end: string;
  onBack: () => void;
  start: string;
}) {
  return (
    <TeacherCard className="flex flex-wrap items-center justify-between gap-3 p-4">
      <p className="text-sm text-student-muted">
        正在查看 {formatRangeDayLabel(date)} 的单日详情 · 范围 {formatRangeLabel(start, end)}
      </p>
      <button className="teacher-button-secondary" onClick={onBack} type="button">
        返回范围统计
      </button>
    </TeacherCard>
  );
}

export function TeacherStudentPracticeRangeSkeleton() {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <TeacherSkeleton className="h-[108px] w-full rounded-2xl" key={index} />
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 3 }, (_, index) => (
          <TeacherSkeleton className="h-[108px] w-full rounded-2xl" key={index} />
        ))}
      </div>
      <TeacherSkeleton className="h-40 w-full rounded-2xl" />
    </>
  );
}

async function loadTeacherStudentPractice(
  studentId: string,
  startAt: string,
  endAt: string
): Promise<TeacherStudentPracticePayload> {
  const {
    data: { session }
  } = await createBrowserSupabase().auth.getSession();
  const params = new URLSearchParams({ startAt, endAt });
  const response = await fetch(
    `/api/teacher/students/${encodeURIComponent(studentId)}/practice?${params.toString()}`,
    {
      cache: "no-store",
      headers: { Authorization: `Bearer ${session?.access_token ?? ""}` }
    }
  );
  const payload = (await response.json().catch(() => ({}))) as
    | TeacherStudentPracticePayload
    | { error?: string };
  if (!response.ok || "error" in payload) {
    const message = "error" in payload ? payload.error : null;
    throw new Error(message || "学生练习记录加载失败。");
  }
  return payload as TeacherStudentPracticePayload;
}

async function loadTeacherStudentPracticeRange(
  studentId: string,
  startKey: string,
  endKey: string
): Promise<TeacherStudentPracticeRangePayload> {
  const start = parseDateInputValue(startKey);
  const end = parseDateInputValue(endKey);
  if (!start || !end) throw new Error("无效的日期范围。");
  const { startAt } = localDayRange(start);
  const { endAt } = localDayRange(end);
  const {
    data: { session }
  } = await createBrowserSupabase().auth.getSession();
  const params = new URLSearchParams({
    startAt,
    endAt,
    timeZone: browserTimeZone()
  });
  const response = await fetch(
    `/api/teacher/students/${encodeURIComponent(studentId)}/practice-range?${params.toString()}`,
    {
      cache: "no-store",
      headers: { Authorization: `Bearer ${session?.access_token ?? ""}` }
    }
  );
  const payload = (await response.json().catch(() => ({}))) as
    | TeacherStudentPracticeRangePayload
    | { error?: string };
  if (!response.ok || "error" in payload) {
    const message = "error" in payload ? payload.error : null;
    throw new Error(message || "范围统计加载失败，请稍后重试。");
  }
  return payload as TeacherStudentPracticeRangePayload;
}
