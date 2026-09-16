"use client";

import clsx from "clsx";
import {
  CalendarDays,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Eye,
  FileCheck2,
  FilePenLine,
  Mail,
  MessageCircleMore,
  Play,
  RotateCcw
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import {
  studentWritingAssignmentBatchCacheKey,
  studentWritingAssignmentEntryCacheKey,
  studentWritingAssignmentsCalendarCacheKey,
  studentWritingAssignmentsDayCacheKey,
  useStudentCachedData,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import {
  StudentEmptyState,
  StudentErrorState,
  StudentLoadingState,
  StudentNavigation
} from "@/components/student/StudentUI";
import { WritingPractice } from "@/components/writing/WritingPractice";
import { STUDENT_ROUTES, writingReviewResultHref } from "@/lib/studentNavigation";
import { WRITING_TASK_CONFIG } from "@/lib/writing";
import type {
  StudentWritingAssignmentCalendarItem,
  StudentWritingAssignmentCalendarPayload,
  StudentWritingAssignmentSummary,
  StudentWritingAssignmentsPayload
} from "@/lib/writingAssignments";
import {
  assignmentDateKey,
  assignmentMonthKey,
  formatAssignmentDate,
  formatAssignmentMonth,
  getStudentWritingAssignmentDisplayStatus,
  isAssignmentMonthKey,
  studentWritingAssignmentTitle,
  studentWritingAssignmentDisplayStatusLabel
} from "@/lib/writingAssignments";

export function StudentWritingAssignmentCalendar({
  initialMonth
}: {
  initialMonth: string;
}) {
  const [month, setMonth] = useState(
    isAssignmentMonthKey(initialMonth) ? initialMonth : assignmentMonthKey()
  );
  const cacheKey = studentWritingAssignmentsCalendarCacheKey(month);
  const state = useStudentCachedData<StudentWritingAssignmentCalendarPayload>(
    cacheKey,
    (session) => loadStudentWritingAssignmentCalendar(month, session)
  );
  const cells = useMemo(() => calendarCells(month), [month]);
  const assignmentsByDate = useMemo(() => {
    const grouped = new Map<string, StudentWritingAssignmentCalendarItem[]>();
    for (const assignment of state.data?.assignments ?? []) {
      const existing = grouped.get(assignment.assignment_date) ?? [];
      existing.push(assignment);
      grouped.set(assignment.assignment_date, existing);
    }
    return grouped;
  }, [state.data]);
  const currentMonth = assignmentMonthKey();

  return (
    <div className="grid gap-5" aria-busy={state.refreshing}>
      <StudentNavigation
        backHref={STUDENT_ROUTES.home}
        crumbs={[
          { label: "学生首页", href: STUDENT_ROUTES.home },
          { label: "我的作业" }
        ]}
      />
      <section className="overflow-hidden rounded-2xl border border-student-border bg-white shadow-[0_1px_2px_rgba(23,32,51,0.035)]">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-student-border px-4 py-4 sm:px-5">
          <div className="flex items-center gap-3">
            <CalendarNavigationButton
              label="上一个月"
              onClick={() => setMonth(shiftMonth(month, -1))}
            >
              <ChevronLeft aria-hidden="true" size={20} />
            </CalendarNavigationButton>
            <h2 className="min-w-[8.5rem] text-center text-xl font-bold text-student-text sm:text-2xl">
              {formatAssignmentMonth(month)}
            </h2>
            <CalendarNavigationButton
              label="下一个月"
              onClick={() => setMonth(shiftMonth(month, 1))}
            >
              <ChevronRight aria-hidden="true" size={20} />
            </CalendarNavigationButton>
          </div>
          <button
            className="student-button-secondary min-h-9 px-3 py-1.5"
            onClick={() => setMonth(currentMonth)}
            type="button"
          >
            <CalendarDays aria-hidden="true" size={16} />
            今天
          </button>
        </header>
        {state.loading ? (
          <div className="p-5"><StudentLoadingState text="正在加载本月作业..." /></div>
        ) : state.error || !state.data ? (
          <div className="p-5"><StudentErrorState text="加载作业月历失败，请稍后重试。" /></div>
        ) : (
          <>
            <DesktopAssignmentCalendar
              assignmentsByDate={assignmentsByDate}
              cells={cells}
            />
            <MobileAssignmentCalendar
              assignmentsByDate={assignmentsByDate}
              month={month}
            />
          </>
        )}
      </section>
    </div>
  );
}

export function StudentWritingAssignmentDayDetail({ date }: { date: string }) {
  const cacheKey = studentWritingAssignmentsDayCacheKey(date);
  const state = useStudentCachedData<StudentWritingAssignmentsPayload>(
    cacheKey,
    (session) => loadStudentWritingAssignmentsDay(date, session),
    { refreshOnMount: true }
  );
  const calendarHref = `${STUDENT_ROUTES.assignments}?month=${encodeURIComponent(date.slice(0, 7))}`;

  return (
    <div className="grid gap-5" aria-busy={state.refreshing}>
      <StudentNavigation
        backHref={calendarHref}
        crumbs={[
          { label: "我的作业", href: calendarHref },
          { label: formatAssignmentDate(date) }
        ]}
      />
      {state.loading ? (
        <StudentLoadingState text="正在加载当日作业..." />
      ) : state.error || !state.data ? (
        <StudentErrorState text="加载当日作业失败，请稍后重试。" />
      ) : state.data.assignments.length === 0 ? (
        <StudentEmptyState text="这一天没有写作作业。" />
      ) : (
        <div className="grid gap-3">
          {state.data.assignments.map((assignment) => (
            <StudentWritingAssignmentCard
              assignment={assignment}
              key={assignment.assignment_id}
              returnTo={`${STUDENT_ROUTES.assignments}/day/${date}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function StudentWritingAssignmentCollectionDetail({
  collectionId
}: {
  collectionId: string;
}) {
  const cacheKey = studentWritingAssignmentBatchCacheKey(collectionId);
  const state = useStudentCachedData<StudentWritingAssignmentsPayload>(
    cacheKey,
    (session) => loadStudentWritingAssignmentBatch(collectionId, session),
    { refreshOnMount: true }
  );
  if (state.loading) return <StudentLoadingState text="正在加载作业内容..." />;
  const assignments = state.data?.assignments
    .sort((left, right) =>
      (left.group_position ?? Number.MAX_SAFE_INTEGER) -
      (right.group_position ?? Number.MAX_SAFE_INTEGER)
    ) ?? [];
  if (state.error || assignments.length < 2) {
    return <StudentErrorState text="未找到这项写作作业。" />;
  }
  const submittedCount = assignments.filter(
    (assignment) => assignment.latest_submitted_attempt_id
  ).length;
  const completedCount = assignments.filter(
    (assignment) => assignment.published_review_attempt_id
  ).length;

  return (
    <div className="grid gap-5" aria-busy={state.refreshing}>
      <StudentNavigation
        backHref={STUDENT_ROUTES.assignments}
        crumbs={[
          { label: "我的作业", href: STUDENT_ROUTES.assignments },
          { label: "作业详情" }
        ]}
      />
      <section className="student-card flex flex-wrap items-center justify-between gap-4 p-5">
        <div>
          <p className="text-xs font-bold text-student-primary">写作作业</p>
          <h1 className="mt-1 text-xl font-bold text-student-text">
            共 {assignments.length} 篇写作
          </h1>
          <p className="mt-2 text-sm text-student-muted">
            {submittedCount} / {assignments.length} 已提交
            {completedCount ? ` · ${completedCount} 篇已完成批改` : ""}
          </p>
        </div>
        <span className="rounded-full bg-student-primary-soft px-3 py-1.5 text-xs font-bold text-student-primary">
          每篇可独立完成
        </span>
      </section>
      <div className="grid gap-3">
        {assignments.map((assignment) => (
          <StudentWritingAssignmentCard
            assignment={assignment}
            key={assignment.assignment_id}
          />
        ))}
      </div>
    </div>
  );
}

export function StudentWritingAssignmentEntry({
  assignmentId,
  attemptId,
  forceNew
}: {
  assignmentId: string;
  attemptId?: string;
  forceNew?: boolean;
}) {
  const state = useStudentCachedData<StudentWritingAssignmentEntryPayload>(
    studentWritingAssignmentEntryCacheKey(assignmentId),
    (session) => loadStudentWritingAssignmentEntry(assignmentId, session)
  );
  if (state.loading) return <AssignmentEntryMessage text="正在准备写作作业..." />;
  const assignment = state.data?.assignment;
  if (state.error || !assignment) {
    return <AssignmentEntryMessage text="未找到这项写作作业。" />;
  }
  if (assignment.status === "withdrawn" && !attemptId) {
    return <AssignmentEntryMessage text="该作业已被教师撤回。" />;
  }
  return (
    <WritingPractice
      assignmentId={assignment.assignment_id}
      attemptId={attemptId}
      forceNew={forceNew}
      questionId={assignment.question_id}
      taskType={assignment.task_type}
    />
  );
}

function DesktopAssignmentCalendar({
  assignmentsByDate,
  cells
}: {
  assignmentsByDate: Map<string, StudentWritingAssignmentCalendarItem[]>;
  cells: CalendarCell[];
}) {
  return (
    <div className="hidden md:block">
      <div className="grid grid-cols-7 border-b border-student-border bg-student-bg/60 text-center text-xs font-bold text-student-muted">
        {WEEKDAY_LABELS.map((label) => <div className="py-3" key={label}>{label}</div>)}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((cell) => (
          <AssignmentCalendarCell
            assignments={assignmentsByDate.get(cell.dateKey) ?? []}
            cell={cell}
            key={cell.dateKey}
          />
        ))}
      </div>
    </div>
  );
}

function AssignmentCalendarCell({
  assignments,
  cell
}: {
  assignments: StudentWritingAssignmentCalendarItem[];
  cell: CalendarCell;
}) {
  const today = cell.dateKey === assignmentDateKey(new Date());
  const content = (
    <>
      <span className={clsx(
        "inline-flex h-7 min-w-7 items-center justify-center rounded-full text-sm font-bold",
        today && cell.inCurrentMonth
          ? "bg-student-primary text-white"
          : cell.inCurrentMonth ? "text-student-text" : "text-student-muted/55"
      )}>
        {cell.day}
      </span>
      {assignments.length > 0 ? (
        <div className="mt-2 grid gap-1.5">
          {assignments.map((assignment) => (
            <CalendarAssignmentTitle assignment={assignment} key={assignment.assignment_id} />
          ))}
        </div>
      ) : null}
    </>
  );
  const className = clsx(
    "min-h-[116px] border-b border-r border-student-border p-2.5 text-left transition xl:min-h-[132px] xl:p-3",
    cell.inCurrentMonth ? "bg-white" : "bg-student-bg/20",
    assignments.length > 0 && "cursor-pointer hover:bg-student-primary-soft/25 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-student-primary"
  );

  return assignments.length > 0 && cell.inCurrentMonth ? (
    <Link
      aria-label={`${formatAssignmentDate(cell.dateKey)}，${assignments.length}项作业`}
      className={className}
      href={`${STUDENT_ROUTES.assignments}/day/${cell.dateKey}`}
    >
      {content}
    </Link>
  ) : <div className={className}>{content}</div>;
}

function MobileAssignmentCalendar({
  assignmentsByDate,
  month
}: {
  assignmentsByDate: Map<string, StudentWritingAssignmentCalendarItem[]>;
  month: string;
}) {
  const days = daysInMonth(month);
  return (
    <div className="divide-y divide-student-border md:hidden">
      {days.map((cell) => {
        const assignments = assignmentsByDate.get(cell.dateKey) ?? [];
        const content = (
          <>
            <div className="w-12 shrink-0">
              <p className="text-base font-bold text-student-text">{cell.day}</p>
              <p className="mt-0.5 text-[11px] text-student-muted">{WEEKDAY_LABELS[cell.weekday]}</p>
            </div>
            <div className="min-w-0 flex-1">
              {assignments.length > 0 ? (
                <div className="grid gap-1.5">
                  {assignments.map((assignment) => (
                    <CalendarAssignmentTitle assignment={assignment} key={assignment.assignment_id} />
                  ))}
                </div>
              ) : null}
            </div>
            {assignments.length > 0 ? <ChevronRight aria-hidden="true" className="shrink-0 text-student-primary" size={18} /> : null}
          </>
        );
        const className = "flex min-h-[58px] items-center gap-3 px-4 py-2.5 text-left";
        return assignments.length > 0 ? (
          <Link
            aria-label={`${formatAssignmentDate(cell.dateKey)}，${assignments.length}项作业`}
            className={`${className} transition hover:bg-student-primary-soft/25`}
            href={`${STUDENT_ROUTES.assignments}/day/${cell.dateKey}`}
            key={cell.dateKey}
          >
            {content}
          </Link>
        ) : <div className={className} key={cell.dateKey}>{content}</div>;
      })}
    </div>
  );
}

function CalendarAssignmentTitle({
  assignment
}: {
  assignment: StudentWritingAssignmentCalendarItem;
}) {
  return (
    <span className="flex min-w-0 items-start gap-1.5 rounded-md bg-student-primary-soft px-2 py-1.5 text-[11px] font-semibold leading-4 text-student-text xl:text-xs">
      <span aria-hidden="true" className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-student-primary" />
      <span className="min-w-0 overflow-hidden [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
        {WRITING_TASK_CONFIG[assignment.task_type].label}: {assignment.title}
      </span>
    </span>
  );
}

function CalendarNavigationButton({
  children,
  label,
  onClick
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-student-primary-border bg-white text-student-primary transition hover:border-student-primary hover:bg-student-primary-soft"
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function StudentWritingAssignmentCard({
  assignment,
  returnTo = STUDENT_ROUTES.assignments
}: {
  assignment: StudentWritingAssignmentSummary;
  returnTo?: string;
}) {
  const config = WRITING_TASK_CONFIG[assignment.task_type];
  const TaskIcon = assignment.task_type === "email" ? Mail : MessageCircleMore;
  const entryHref = `${STUDENT_ROUTES.assignments}/${encodeURIComponent(
    assignment.assignment_id
  )}`;
  const submissionHref = assignment.latest_submitted_attempt_id
    ? `${config.submissionHref}/${encodeURIComponent(
        assignment.latest_submitted_attempt_id
      )}`
    : null;
  const reviewHref = assignment.published_review_attempt_id
    ? writingReviewResultHref(
        assignment.published_review_attempt_id,
        returnTo
      )
    : null;
  const withdrawnWithoutSubmission =
    assignment.status === "withdrawn" && !assignment.latest_submitted_attempt_id;

  return (
    <article className="student-card grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-5">
      <div className="flex min-w-0 items-start gap-3.5">
        <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-student-primary-soft text-student-primary">
          <TaskIcon aria-hidden="true" size={22} />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold text-student-primary">{config.label}</span>
            <AssignmentStatusChip assignment={assignment} />
            {assignment.status === "withdrawn" ? (
              <span className="rounded-full bg-student-bg px-2.5 py-1 text-[11px] font-bold text-student-muted">
                已撤回
              </span>
            ) : null}
          </div>
          <h2 className="mt-1.5 truncate text-lg font-bold text-student-text">
            {studentWritingAssignmentTitle(assignment)}
          </h2>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-student-muted">
            <span>布置于 {formatDateTime(assignment.assigned_at)}</span>
            <span className="inline-flex items-center gap-1.5">
              <CalendarClock aria-hidden="true" size={14} />
              {assignment.due_at
                ? `截止 ${formatDateTime(assignment.due_at)}`
                : "无截止时间"}
            </span>
            {assignment.draft_attempt_id ? (
              <span className="font-semibold text-student-primary">
                已保存{assignment.draft_writing_mode === "practice" ? "练习模式" : "模考模式"}草稿
              </span>
            ) : null}
          </div>
          {withdrawnWithoutSubmission ? (
            <p className="mt-2 text-sm font-semibold text-student-muted">
              该作业已被教师撤回。
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap justify-start gap-2 sm:max-w-[390px] sm:justify-end">
        {assignment.status === "active" && assignment.draft_attempt_id ? (
          <AssignmentAction
            href={`${entryHref}?attempt=${encodeURIComponent(assignment.draft_attempt_id)}`}
            icon={FilePenLine}
            label="继续作答"
            primary
          />
        ) : null}
        {submissionHref ? (
          <AssignmentAction href={submissionHref} icon={Eye} label="查看提交" />
        ) : null}
        {reviewHref ? (
          <AssignmentAction href={reviewHref} icon={FileCheck2} label="查看批改" primary />
        ) : null}
        {assignment.status === "active" && !assignment.draft_attempt_id ? (
          <AssignmentAction
            href={assignment.latest_submitted_attempt_id ? `${entryHref}?new=1` : entryHref}
            icon={assignment.latest_submitted_attempt_id ? RotateCcw : Play}
            label={assignment.latest_submitted_attempt_id ? "重新作答" : "开始作业"}
            primary={!reviewHref}
          />
        ) : null}
      </div>
    </article>
  );
}

function AssignmentStatusChip({
  assignment
}: {
  assignment: StudentWritingAssignmentSummary;
}) {
  const status = getStudentWritingAssignmentDisplayStatus(assignment);
  return (
    <span
      className={clsx(
        "rounded-full px-2.5 py-1 text-[11px] font-bold",
        status === "overdue"
          ? "bg-student-error-soft text-student-error"
          : status === "not_started" || status === "in_progress" || status === "submitted"
            ? "bg-amber-50 text-amber-700"
            : "bg-emerald-50 text-emerald-700"
      )}
    >
      {studentWritingAssignmentDisplayStatusLabel(status)}
    </span>
  );
}

function AssignmentAction({
  href,
  icon: Icon,
  label,
  primary = false
}: {
  href: string;
  icon: typeof Play;
  label: string;
  primary?: boolean;
}) {
  return (
    <Link
      className={primary ? "student-button-primary" : "student-button-secondary"}
      href={href}
    >
      <Icon aria-hidden="true" size={17} />
      {label}
    </Link>
  );
}

function AssignmentEntryMessage({ text }: { text: string }) {
  return (
    <div className="grid min-h-[100dvh] place-items-center bg-[#fbfbfe] px-5">
      <div className="student-card max-w-md text-center">
        <h1 className="text-xl font-bold text-student-text">我的作业</h1>
        <p className="mt-2 text-sm text-student-muted">{text}</p>
      </div>
    </div>
  );
}

type StudentWritingAssignmentEntryPayload = {
  assignment: {
    assignment_id: string;
    question_id: string;
    status: "active" | "withdrawn";
    task_type: "email" | "academic_discussion";
  };
  error?: string;
};

type CalendarCell = {
  dateKey: string;
  day: number;
  inCurrentMonth: boolean;
  weekday: number;
};

const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

async function loadStudentWritingAssignmentCalendar(
  month: string,
  session: StudentCacheSession
) {
  return loadAssignmentJson<StudentWritingAssignmentCalendarPayload>(
    `/api/writing/assignments/calendar?month=${encodeURIComponent(month)}`,
    session,
    "无法加载作业月历。"
  );
}

async function loadStudentWritingAssignmentsDay(
  date: string,
  session: StudentCacheSession
) {
  return loadAssignmentJson<StudentWritingAssignmentsPayload>(
    `/api/writing/assignments/day?date=${encodeURIComponent(date)}`,
    session,
    "无法加载当日作业。"
  );
}

async function loadStudentWritingAssignmentEntry(
  assignmentId: string,
  session: StudentCacheSession
) {
  return loadAssignmentJson<StudentWritingAssignmentEntryPayload>(
    `/api/writing/assignments/entry?assignmentId=${encodeURIComponent(assignmentId)}`,
    session,
    "无法加载这项作业。"
  );
}

async function loadStudentWritingAssignmentBatch(
  batchId: string,
  session: StudentCacheSession
) {
  return loadAssignmentJson<StudentWritingAssignmentsPayload>(
    `/api/writing/assignments/batch?batchId=${encodeURIComponent(batchId)}`,
    session,
    "无法加载这组作业。"
  );
}

async function loadAssignmentJson<T extends { error?: string }>(
  url: string,
  session: StudentCacheSession,
  fallback: string
) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${session.accessToken}` }
  });
  const payload = (await response.json()) as T;
  if (!response.ok || payload.error) {
    throw new Error(payload.error ?? fallback);
  }
  return payload;
}

function calendarCells(month: string): CalendarCell[] {
  const [year, monthNumber] = month.split("-").map(Number);
  const first = new Date(Date.UTC(year, monthNumber - 1, 1));
  const mondayOffset = (first.getUTCDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(Date.UTC(year, monthNumber - 1, 1 - mondayOffset + index));
    return {
      dateKey: utcDateKey(date),
      day: date.getUTCDate(),
      inCurrentMonth: date.getUTCMonth() === monthNumber - 1,
      weekday: index % 7
    };
  });
}

function daysInMonth(month: string): CalendarCell[] {
  const [year, monthNumber] = month.split("-").map(Number);
  const count = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(year, monthNumber - 1, index + 1));
    return {
      dateKey: utcDateKey(date),
      day: index + 1,
      inCurrentMonth: true,
      weekday: (date.getUTCDay() + 6) % 7
    };
  });
}

function shiftMonth(month: string, amount: number) {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + amount, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function utcDateKey(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}
