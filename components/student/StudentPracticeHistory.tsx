"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Eye, FileCheck2, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { STUDENT_PRACTICE_ICONS } from "@/components/icons/StudentPracticeIcons";
import { ReadingFullSetRetakeButton } from "@/components/reading/ReadingFullSetRetakeButton";
import { ReadingRetakeButton } from "@/components/reading/ReadingRetakeButton";
import {
  STUDENT_PRACTICE_HISTORY_CACHE_PREFIX,
  useStudentCachedData,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import { StudentNavigation } from "@/components/student/StudentUI";
import { StudentDateSelection, DATE_BUTTON_CLASS } from "@/components/student/StudentDateSelection";
import { startOfLocalDay, addDays, localDayRange, browserTimeZone, formatDateInputValue, parseDateInputValue, normalizeDateDraft } from "@/lib/studentDates";
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
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import {
  STUDENT_RANGE_DAY_COUNT_KEYS,
  formatStudentPracticeHistoryParams,
  parseStudentPracticeHistoryUrl,
  studentPracticeHistoryHref,
  studentPracticeHistoryQueryUrl,
  studentPracticeRecordResultTarget,
  studentPracticeRecordRetakeTarget,
  type StudentPracticeHistoryDayPayload,
  type StudentPracticeHistoryRangePayload,
  type StudentPracticeHistoryView
} from "@/lib/studentPracticeHistory";
import {
  TEACHER_PRACTICE_RANGE_DAY_COUNT_LABELS,
  type TeacherPracticeRangeDay
} from "@/lib/teacherStudentPracticeRange";
import {
  TEACHER_PRACTICE_TASK_LABELS,
  TEACHER_PRACTICE_TASK_SHORT_LABELS,
  TEACHER_PRACTICE_TASK_TYPES,
  type TeacherPracticeRecord,
  type TeacherPracticeTaskType,
  type TeacherStudentReadingPractice,
  type TeacherStudentWritingPractice
} from "@/lib/teacherStudentPractice";

const READING_TASKS = ["ctw", "rdl", "rap"] as const;

const READING_CHIP_CLASS =
  "shrink-0 rounded-full border border-[#cfe3f8] bg-[#eef6ff] px-2 py-0.5 text-xs font-semibold text-[#347fdc]";
const WRITING_CHIP_CLASS =
  "shrink-0 rounded-full border border-student-primary-border bg-student-primary-soft px-2 py-0.5 text-xs font-semibold text-student-primary";

// The student content area sits right of the fixed 248px Sidebar, so the four
// Reading cards keep one row only when the content column is actually wide
// enough; the sidebar width can never be counted as card space.
const READING_CARDS_GRID = "grid gap-4 sm:grid-cols-2 min-[1280px]:grid-cols-4";
const WRITING_CARDS_GRID = "grid gap-4 sm:grid-cols-2 lg:grid-cols-3";

export function StudentPracticeHistory({
  initialDate,
  initialEnd,
  initialStart,
  initialTasks,
  initialView
}: {
  initialDate?: string;
  initialEnd?: string;
  initialStart?: string;
  initialTasks?: string;
  initialView?: string;
}) {
  const router = useRouter();
  const todayKey = useMemo(() => formatDateInputValue(startOfLocalDay()), []);
  const initialState = useMemo(
    () => parseStudentPracticeHistoryUrl({
      date: initialDate,
      end: initialEnd,
      start: initialStart,
      tasks: initialTasks,
      today: todayKey,
      view: initialView
    }),
    [initialDate, initialEnd, initialStart, initialTasks, initialView, todayKey]
  );
  const [selectedDay, setSelectedDay] = useState(
    () => parseDateInputValue(initialState.selectedDay) ?? startOfLocalDay()
  );
  const [selectedTasks, setSelectedTasks] = useState(() => initialState.tasks);
  const [view, setView] = useState<StudentPracticeHistoryView>(() => initialState.view);
  const [dateDraft, setDateDraft] = useState(() => ({
    start: initialState.selectedDay,
    end: initialState.selectedDay
  }));

  // Browser Back/Forward (and any fresh drill-down return) realigns the state
  // from the URL, so the date, task filter and active range are never lost.
  useEffect(() => {
    const next = parseStudentPracticeHistoryUrl({
      date: initialDate,
      end: initialEnd,
      start: initialStart,
      tasks: initialTasks,
      today: todayKey,
      view: initialView
    });
    setSelectedDay(parseDateInputValue(next.selectedDay) ?? startOfLocalDay());
    setSelectedTasks(next.tasks);
    setView(next.view);
  }, [initialDate, initialEnd, initialStart, initialTasks, initialView, todayKey]);

  // Keep the date picker draft aligned with the active selection whenever the
  // selection itself changes; typing inside the popover is never overwritten.
  useEffect(() => {
    if (view.kind === "range" || view.kind === "rangeDay") {
      setDateDraft({ start: view.start, end: view.end });
      return;
    }
    const day = formatDateInputValue(selectedDay);
    setDateDraft({ start: day, end: day });
  }, [view, selectedDay]);

  function applyState(
    next: {
      selectedDay?: Date;
      tasks?: Record<TeacherPracticeTaskType, boolean>;
      view?: StudentPracticeHistoryView;
    }
  ) {
    const nextDay = next.selectedDay ?? selectedDay;
    const nextTasks = next.tasks ?? selectedTasks;
    const nextView = next.view ?? view;
    if (next.selectedDay) setSelectedDay(next.selectedDay);
    if (next.tasks) setSelectedTasks(next.tasks);
    if (next.view) setView(next.view);
    router.replace(studentPracticeHistoryQueryUrl(
      formatStudentPracticeHistoryParams({
        selectedDay: formatDateInputValue(nextDay),
        tasks: nextTasks,
        today: todayKey,
        view: nextView
      })
    ));
  }

  function applyDateDraft(close: () => void) {
    const { start, end } = normalizeDateDraft(dateDraft, formatDateInputValue(selectedDay));
    const startDay = parseDateInputValue(start) ?? selectedDay;
    close();
    applyState({
      selectedDay: startDay,
      view: start === end ? { kind: "day" } : { kind: "range", start, end }
    });
  }

  function openRangeDay(date: string) {
    if (view.kind !== "range" && view.kind !== "rangeDay") return;
    applyState({
      selectedDay: parseDateInputValue(date) ?? selectedDay,
      view: { kind: "rangeDay", date, end: view.end, start: view.start }
    });
  }

  function backToRange() {
    if (view.kind !== "rangeDay") return;
    applyState({ view: { kind: "range", end: view.end, start: view.start } });
  }

  const range = useMemo(() => localDayRange(selectedDay), [selectedDay]);
  const dayEnabled = view.kind !== "range";
  const dayCacheKey =
    `${STUDENT_PRACTICE_HISTORY_CACHE_PREFIX}:day:${range.startAt}:${range.endAt}`;
  // Only the requested day is loaded; stepping through days reuses each day's
  // own cached entry and never starts a full-history scan.
  const dayState = useStudentCachedData<StudentPracticeHistoryDayPayload>(
    dayCacheKey,
    (session) => loadStudentPracticeHistoryDay(session, range.startAt, range.endAt),
    { enabled: dayEnabled }
  );
  const dayPayload = dayState.data;

  const rangeStartKey = view.kind === "range" || view.kind === "rangeDay" ? view.start : "";
  const rangeEndKey = view.kind === "range" || view.kind === "rangeDay" ? view.end : "";
  const rangeCacheKey = rangeStartKey && rangeEndKey
    ? `${STUDENT_PRACTICE_HISTORY_CACHE_PREFIX}:range:${rangeStartKey}:${rangeEndKey}`
    : `${STUDENT_PRACTICE_HISTORY_CACHE_PREFIX}:range:none`;
  // The range statistics are only requested after the student selects a range,
  // and stay cached per student + date pair so one range visit never refetches.
  const rangeState = useStudentCachedData<StudentPracticeHistoryRangePayload>(
    rangeCacheKey,
    (session) => loadStudentPracticeHistoryRange(session, rangeStartKey, rangeEndKey),
    { enabled: Boolean(rangeStartKey && rangeEndKey) }
  );

  const returnToHref = useMemo(
    () => studentPracticeHistoryHref({
      selectedDay: formatDateInputValue(selectedDay),
      tasks: selectedTasks,
      today: todayKey,
      view
    }),
    [selectedDay, selectedTasks, todayKey, view]
  );
  const readingRecords = filterRecords(dayPayload?.reading?.records ?? [], selectedTasks);
  const writingRecords = filterRecords(dayPayload?.writing?.records ?? [], selectedTasks);

  return (
    <div className="grid gap-5">
      <StudentNavigation
        backHref={STUDENT_ROUTES.home}
        crumbs={[
          { href: STUDENT_ROUTES.home, label: "学生首页" },
          { label: "练习历史" }
        ]}
      />

      <TeacherCard className="flex flex-wrap items-center justify-between gap-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <button
            aria-label="上一天"
            className={DATE_BUTTON_CLASS}
            onClick={() => applyState({ selectedDay: addDays(selectedDay, -1), view: { kind: "day" } })}
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
            className={DATE_BUTTON_CLASS}
            onClick={() => applyState({ selectedDay: addDays(selectedDay, 1), view: { kind: "day" } })}
            type="button"
          >
            <ChevronRight aria-hidden="true" size={18} />
          </button>
          <button
            className="inline-flex h-9 items-center rounded-lg border border-student-primary-border bg-student-primary-soft/60 px-3 text-sm font-semibold text-student-primary transition disabled:opacity-45"
            disabled={view.kind === "day" && isToday(selectedDay)}
            onClick={() => applyState({ selectedDay: startOfLocalDay(), view: { kind: "day" } })}
            type="button"
          >
            今天
          </button>
          <StudentDateSelection draft={dateDraft} onDraftChange={setDateDraft} onApply={applyDateDraft} />
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
                  applyState({
                    tasks: { ...selectedTasks, [taskType]: event.target.checked }
                  })
                }
                type="checkbox"
              />
              {TEACHER_PRACTICE_TASK_SHORT_LABELS[taskType]}
            </label>
          ))}
        </fieldset>
      </TeacherCard>

      {view.kind === "range" ? (
        <StudentPracticeRangeView onOpenDay={openRangeDay} state={rangeState} />
      ) : (
        <>
          {view.kind === "rangeDay" ? (
            <StudentPracticeRangeReturnBar
              date={view.date}
              end={view.end}
              onBack={backToRange}
              start={view.start}
            />
          ) : null}
          {dayState.loading && !dayPayload ? (
            <>
              <TeacherLoadingRegion label="正在加载练习记录" />
              <StudentPracticeHistorySkeleton />
            </>
          ) : null}
          {dayState.error && !dayPayload ? (
            <TeacherDataError text="练习记录加载失败，请稍后重试。" />
          ) : null}
          {dayPayload ? (
            <>
              {dayPayload.reading ? (
                <ReadingPracticeSection
                  reading={dayPayload.reading}
                  records={readingRecords}
                  returnTo={returnToHref}
                />
              ) : null}
              {dayPayload.writing ? (
                <WritingPracticeSection
                  records={writingRecords}
                  returnTo={returnToHref}
                  writing={dayPayload.writing}
                />
              ) : null}
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

function ReadingPracticeSection({
  reading,
  records,
  returnTo
}: {
  reading: TeacherStudentReadingPractice;
  records: TeacherPracticeRecord[];
  returnTo: string;
}) {
  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <TeacherSectionTitle>Reading 练习</TeacherSectionTitle>
        <DomainChip domain="reading" />
      </div>
      {/* CTW / RDL / RAP / Full Set: one equal row when the content column can
          hold four readable cards, otherwise two — never crushed text. */}
      <div className={READING_CARDS_GRID}>
        {READING_TASKS.map((taskType) => {
          const task = reading.tasks[taskType];
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
            reading.fullSet.totalPoints > 0 ? formatPercent(reading.fullSet.accuracy) : "—"
          }`}
          tone="reading"
          value={`${reading.fullSet.attempts} 次`}
        />
      </div>
      <StudentPracticeRecordList
        emptyText="该日期暂无 Reading 练习记录。"
        records={records}
        returnTo={returnTo}
      />
    </section>
  );
}

function WritingPracticeSection({
  records,
  returnTo,
  writing
}: {
  records: TeacherPracticeRecord[];
  returnTo: string;
  writing: TeacherStudentWritingPractice;
}) {
  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <TeacherSectionTitle>Writing 练习</TeacherSectionTitle>
        <DomainChip domain="writing" />
      </div>
      <div className={WRITING_CARDS_GRID}>
        <TeacherMetricCard
          icon={STUDENT_PRACTICE_ICONS.build_sentence}
          label={TEACHER_PRACTICE_TASK_LABELS.build_sentence}
          secondary={`平均正确率 ${
            writing.tasks.build_sentence.totalQuestions > 0
              ? formatPercent(writing.tasks.build_sentence.accuracy)
              : "—"
          }`}
          value={`${writing.tasks.build_sentence.attempts} 次`}
        />
        {(["email", "academic_discussion"] as const).map((taskType) => {
          const task = writing.tasks[taskType];
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
      <StudentPracticeRecordList
        emptyText="该日期暂无 Writing 练习记录。"
        records={records}
        returnTo={returnTo}
      />
    </section>
  );
}

function StudentPracticeRecordList({
  emptyText,
  records,
  returnTo
}: {
  emptyText: string;
  records: TeacherPracticeRecord[];
  returnTo: string;
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
          <StudentPracticeRecordRow key={record.recordId} record={record} returnTo={returnTo} />
        ))}
      </div>
    </TeacherCard>
  );
}

function StudentPracticeRecordRow({
  record,
  returnTo
}: {
  record: TeacherPracticeRecord;
  returnTo: string;
}) {
  const result = studentPracticeRecordResultTarget(record, returnTo);
  const retake = studentPracticeRecordRetakeTarget(record);
  const title = result ? (
    <Link className="truncate font-semibold text-student-text hover:underline" href={result.href}>
      {record.title}
    </Link>
  ) : (
    <span className="truncate font-semibold text-student-text">{record.title}</span>
  );

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 py-3">
      <div className="min-w-0 flex-1 basis-[min(100%,280px)]">
        <p className="flex min-w-0 items-center gap-2 text-sm">
          <span className={record.domain === "reading" ? READING_CHIP_CLASS : WRITING_CHIP_CLASS}>
            {TEACHER_PRACTICE_TASK_SHORT_LABELS[record.taskType]}
          </span>
          {title}
        </p>
        <p className="mt-1 text-xs text-student-muted">
          {TEACHER_PRACTICE_TASK_LABELS[record.taskType]}
          {" · "}
          {formatRecordTime(record.submittedAt)}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-3">
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
      {result || retake ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {result ? (
            <Link className="student-button-secondary min-h-8 px-3 py-1 text-sm" href={result.href}>
              {result.label === "查看批改" ? (
                <FileCheck2 aria-hidden="true" size={16} />
              ) : (
                <Eye aria-hidden="true" size={16} />
              )}
              {result.label}
            </Link>
          ) : null}
          {retake ? <RetakeEntry retake={retake} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function RetakeEntry({
  retake
}: {
  retake: NonNullable<ReturnType<typeof studentPracticeRecordRetakeTarget>>;
}) {
  if (retake.kind === "reading") {
    return <ReadingRetakeButton attemptId={retake.attemptId} compact label="重新练习" />;
  }
  if (retake.kind === "full_set") {
    return <ReadingFullSetRetakeButton compact fullSetId={retake.fullSetId} />;
  }
  return (
    <Link className="student-button-primary min-h-8 px-3 py-1 text-sm" href={retake.href}>
      <RotateCcw aria-hidden="true" size={16} />
      {retake.label}
    </Link>
  );
}

function DomainChip({ domain }: { domain: "reading" | "writing" }) {
  return (
    <span className={domain === "reading" ? READING_CHIP_CLASS : WRITING_CHIP_CLASS}>
      {domain === "reading" ? "Reading" : "Writing"}
    </span>
  );
}

function StudentPracticeRangeView({
  onOpenDay,
  state
}: {
  onOpenDay: (date: string) => void;
  state: {
    data: StudentPracticeHistoryRangePayload | null;
    error: string;
    loading: boolean;
  };
}) {
  if (state.loading) {
    return (
      <>
        <TeacherLoadingRegion label="正在加载范围统计" />
        <StudentPracticeHistoryRangeSkeleton />
      </>
    );
  }
  if (state.error) {
    return <TeacherDataError text="范围统计加载失败，请稍后重试。" />;
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
          <div className={READING_CARDS_GRID}>
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
          <div className={WRITING_CARDS_GRID}>
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

      <StudentPracticeRangeDayList days={data.days} onOpenDay={onOpenDay} />
    </section>
  );
}

function StudentPracticeRangeDayList({
  days,
  onOpenDay
}: {
  days: TeacherPracticeRangeDay[];
  onOpenDay: (date: string) => void;
}) {
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
                {/* Seven public task types at most: four columns on phones,
                    seven (one per type) once the row has the width. */}
                <div className="grid grid-cols-4 gap-x-3 gap-y-1 sm:grid-cols-7">
                  {STUDENT_RANGE_DAY_COUNT_KEYS.map((key) => (
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

function StudentPracticeRangeReturnBar({
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

export function StudentPracticeHistorySkeleton() {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: 4 }, (_, index) => (
          <TeacherSkeleton className="h-[108px] w-full rounded-2xl" key={index} />
        ))}
      </div>
      <TeacherSkeleton className="h-40 w-full rounded-2xl" />
    </>
  );
}

export function StudentPracticeHistoryRangeSkeleton() {
  return (
    <>
      <div className={READING_CARDS_GRID}>
        {Array.from({ length: 4 }, (_, index) => (
          <TeacherSkeleton className="h-[108px] w-full rounded-2xl" key={index} />
        ))}
      </div>
      <div className={WRITING_CARDS_GRID}>
        {Array.from({ length: 3 }, (_, index) => (
          <TeacherSkeleton className="h-[108px] w-full rounded-2xl" key={index} />
        ))}
      </div>
      <TeacherSkeleton className="h-40 w-full rounded-2xl" />
    </>
  );
}

function filterRecords(
  records: TeacherPracticeRecord[],
  selectedTasks: Record<TeacherPracticeTaskType, boolean>
) {
  return records.filter((record) => selectedTasks[record.taskType]);
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

async function loadStudentPracticeHistoryDay(
  session: StudentCacheSession,
  startAt: string,
  endAt: string
): Promise<StudentPracticeHistoryDayPayload> {
  const params = new URLSearchParams({ endAt, startAt });
  const response = await fetch(`/api/student/practice-history?${params.toString()}`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${session.accessToken}` }
  });
  const payload = await response.json().catch(() => ({})) as
    | StudentPracticeHistoryDayPayload
    | { error?: string };
  if (!response.ok || "error" in payload) {
    const message = "error" in payload ? payload.error : null;
    throw new Error(message || "练习记录加载失败。");
  }
  return payload as StudentPracticeHistoryDayPayload;
}

async function loadStudentPracticeHistoryRange(
  session: StudentCacheSession,
  startKey: string,
  endKey: string
): Promise<StudentPracticeHistoryRangePayload> {
  const start = parseDateInputValue(startKey);
  const end = parseDateInputValue(endKey);
  if (!start || !end) throw new Error("无效的日期范围。");
  const { startAt } = localDayRange(start);
  const { endAt } = localDayRange(end);
  const params = new URLSearchParams({
    endAt,
    startAt,
    timeZone: browserTimeZone()
  });
  const response = await fetch(`/api/student/practice-history/range?${params.toString()}`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${session.accessToken}` }
  });
  const payload = await response.json().catch(() => ({})) as
    | StudentPracticeHistoryRangePayload
    | { error?: string };
  if (!response.ok || "error" in payload) {
    const message = "error" in payload ? payload.error : null;
    throw new Error(message || "范围统计加载失败，请稍后重试。");
  }
  return payload as StudentPracticeHistoryRangePayload;
}
