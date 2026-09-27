"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import clsx from "clsx";
import { ArrowLeft } from "lucide-react";
import { TeacherClassIcon } from "@/components/icons/TeacherClassIcon";
import {
  TEACHER_WRITING_CLASS_REVIEWS_CACHE_KEY,
  TEACHER_WRITING_CLASS_REVIEW_LIST_CACHE_PREFIX,
  TEACHER_WRITING_REVIEWS_CACHE_KEY,
  useTeacherCachedData
} from "@/components/TeacherDataCache";
import {
  TeacherCard,
  TeacherDataError,
  TeacherEmptyState,
  TeacherLoadingRegion,
  TeacherSkeleton
} from "@/components/teacher/TeacherUI";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { teacherWritingReviewWorkspaceHref } from "@/lib/teacherWritingReviewNavigation";
import { classSubjectsLabel, type TeacherClassReviewSummary } from "@/lib/teacherClasses";
import type { WritingTaskType } from "@/lib/writing";

type ReviewStatus = "pending" | "reviewing" | "published";
type StatusFilter = "all" | ReviewStatus;
type TaskFilter = "all" | WritingTaskType;

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
  reviewStatus: ReviewStatus;
};

type WritingReviewListPayload = { attempts: WritingReviewListItem[] };
type ErrorPayload = { code?: string; message?: string; error?: string };

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "pending", label: "待批改" },
  { value: "reviewing", label: "批改中" },
  { value: "published", label: "已发布" }
];

/**
 * 写作批改 list with the 学生 | 班级 tabs. The 学生 tab is the previous page
 * unchanged; the 班级 tab organizes the same submissions by class and always
 * opens the existing Writing Review workspace, one essay at a time.
 */
export function TeacherWritingReviewList({
  initialClassId,
  initialTab
}: {
  initialClassId?: string;
  initialTab?: "students" | "class";
} = {}) {
  const [tab, setTab] = useState<"students" | "class">(
    initialTab === "class" ? "class" : "students"
  );
  const [classId, setClassId] = useState(initialClassId?.trim() ?? "");

  return (
    <div className="grid gap-5">
      <nav aria-label="批改视图" className="flex gap-2 border-b border-student-border">
        <button
          className={`border-b-2 px-5 py-3 text-sm font-bold ${tab === "students" ? "border-student-primary text-student-primary" : "border-transparent text-student-muted hover:text-student-text"}`}
          onClick={() => setTab("students")}
          type="button"
        >
          学生
        </button>
        <button
          className={`border-b-2 px-5 py-3 text-sm font-bold ${tab === "class" ? "border-student-primary text-student-primary" : "border-transparent text-student-muted hover:text-student-text"}`}
          onClick={() => setTab("class")}
          type="button"
        >
          班级
        </button>
      </nav>
      {tab === "students" ? (
        <StudentReviewSection />
      ) : classId ? (
        <ClassReviewList classId={classId} onBack={() => setClassId("")} />
      ) : (
        <ClassReviewOverview onOpen={setClassId} />
      )}
    </div>
  );
}

function StudentReviewSection() {
  const { data, error, loading } = useTeacherCachedData<WritingReviewListPayload>(
    TEACHER_WRITING_REVIEWS_CACHE_KEY,
    () => loadWritingReviews()
  );
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("all");
  const attempts = useMemo(() => data?.attempts ?? [], [data]);
  const filtered = filterReviewAttempts(attempts, statusFilter, taskFilter);

  return (
    <div className="grid gap-5">
      {loading ? <TeacherLoadingRegion label="正在加载写作批改列表" /> : null}
      <ReviewFilters
        onStatusFilter={setStatusFilter}
        onTaskFilter={setTaskFilter}
        statusFilter={statusFilter}
        taskFilter={taskFilter}
      />
      <ReviewTable
        attempts={attempts}
        error={error}
        filtered={filtered}
        loading={loading}
        emptyTexts={{
          noAttempts: "暂无已提交的写作练习。",
          noMatch: "当前筛选条件下暂无提交。"
        }}
      />
    </div>
  );
}

function ClassReviewOverview({ onOpen }: { onOpen: (classId: string) => void }) {
  const { data, error, loading } = useTeacherCachedData<{ classes: TeacherClassReviewSummary[] }>(
    TEACHER_WRITING_CLASS_REVIEWS_CACHE_KEY,
    () => loadClassReviewSummaries()
  );
  const classes = data?.classes ?? [];

  if (loading) {
    return (
      <div className="grid gap-3" aria-busy="true">
        {[1, 2, 3].map((item) => <TeacherSkeleton className="h-28 w-full rounded-2xl" key={item} />)}
      </div>
    );
  }
  if (error) {
    return (
      <TeacherCard className="p-5">
        <TeacherDataError text={toChineseLoadError(error)} />
      </TeacherCard>
    );
  }
  if (classes.length === 0) {
    return (
      <TeacherCard className="p-5">
        <TeacherEmptyState text="还没有包含写作的班级。请先在首页“班级列表”中创建班级。" />
      </TeacherCard>
    );
  }

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

function ClassReviewList({ classId, onBack }: { classId: string; onBack: () => void }) {
  const summaries = useTeacherCachedData<{ classes: TeacherClassReviewSummary[] }>(
    TEACHER_WRITING_CLASS_REVIEWS_CACHE_KEY,
    () => loadClassReviewSummaries()
  );
  const { data, error, loading } = useTeacherCachedData<WritingReviewListPayload>(
    `${TEACHER_WRITING_CLASS_REVIEW_LIST_CACHE_PREFIX}:${classId}`,
    () => loadWritingReviews(`?classId=${encodeURIComponent(classId)}`)
  );
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("all");
  const attempts = useMemo(() => data?.attempts ?? [], [data]);
  const filtered = filterReviewAttempts(attempts, statusFilter, taskFilter);
  const className =
    summaries.data?.classes.find((entry) => entry.class_id === classId)?.name ?? "";

  return (
    <div className="grid gap-5">
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
      <ReviewFilters
        onStatusFilter={setStatusFilter}
        onTaskFilter={setTaskFilter}
        statusFilter={statusFilter}
        taskFilter={taskFilter}
      />
      <ReviewTable
        attempts={attempts}
        error={error}
        filtered={filtered}
        loading={loading}
        emptyTexts={{
          noAttempts: "该班级暂无已提交的写作练习。",
          noMatch: "当前筛选条件下暂无提交。"
        }}
      />
    </div>
  );
}

function filterReviewAttempts(
  attempts: WritingReviewListItem[],
  statusFilter: StatusFilter,
  taskFilter: TaskFilter
) {
  return attempts.filter(
    (attempt) =>
      (statusFilter === "all" || attempt.reviewStatus === statusFilter) &&
      (taskFilter === "all" || attempt.taskType === taskFilter)
  );
}

function ReviewFilters({
  onStatusFilter,
  onTaskFilter,
  statusFilter,
  taskFilter
}: {
  onStatusFilter: (value: StatusFilter) => void;
  onTaskFilter: (value: TaskFilter) => void;
  statusFilter: StatusFilter;
  taskFilter: TaskFilter;
}) {
  return (
    <TeacherCard className="p-5 sm:p-6">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <fieldset>
          <legend className="mb-2 text-sm font-semibold text-student-text">批改状态</legend>
          <div className="flex flex-wrap gap-2">
            {STATUS_FILTERS.map((filter) => (
              <button
                aria-pressed={statusFilter === filter.value}
                className={clsx(
                  "min-h-10 rounded-[10px] border px-4 text-sm font-semibold transition",
                  statusFilter === filter.value
                    ? "border-student-primary bg-student-primary text-white"
                    : "border-student-border bg-white text-student-text hover:border-student-primary-border hover:bg-student-primary-soft"
                )}
                key={filter.value}
                onClick={() => onStatusFilter(filter.value)}
                type="button"
              >
                {filter.label}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="block w-full max-w-[260px]">
          <span className="mb-2 block text-sm font-semibold text-student-text">题型</span>
          <select
            className="h-11 w-full rounded-[10px] border border-student-border bg-white px-3 text-sm font-medium text-student-text"
            onChange={(event) => onTaskFilter(event.target.value as TaskFilter)}
            value={taskFilter}
          >
            <option value="all">全部题型</option>
            <option value="email">Write an Email</option>
            <option value="academic_discussion">Academic Discussion</option>
          </select>
        </label>
      </div>
    </TeacherCard>
  );
}

function ReviewTable({
  attempts,
  emptyTexts,
  error,
  filtered,
  loading
}: {
  attempts: WritingReviewListItem[];
  emptyTexts: { noAttempts: string; noMatch: string };
  error: string;
  filtered: WritingReviewListItem[];
  loading: boolean;
}) {
  return (
    <TeacherCard className="overflow-hidden p-0">
      <div className="overflow-x-auto px-5 pb-5 pt-5 sm:px-6 sm:pb-6 sm:pt-6">
        <table className="w-full min-w-[1040px] border-separate border-spacing-0 overflow-hidden rounded-xl border border-student-border text-left text-sm">
          <thead className="bg-student-primary-soft/55">
            <tr className="text-student-text">
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
            <WritingReviewTableSkeleton />
          ) : filtered.length > 0 ? (
            <tbody>
              {filtered.map((attempt) => {
                return (
                  <tr
                    className="transition hover:bg-student-primary-soft/35"
                    key={attempt.attemptId}
                  >
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
                      <Link
                        className="teacher-button-secondary min-w-[104px]"
                        href={teacherWritingReviewWorkspaceHref(
                          attempt.attemptId,
                          "/teacher/writing/reviews"
                        )}
                      >
                        查看
                      </Link>
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
        {!loading && !error && filtered.length === 0 ? (
          <div className="mt-4">
            <TeacherEmptyState
              text={attempts.length === 0 ? emptyTexts.noAttempts : emptyTexts.noMatch}
            />
          </div>
        ) : null}
      </div>
    </TeacherCard>
  );
}

function WritingReviewTableSkeleton() {
  return (
    <tbody>
      {Array.from({ length: 5 }, (_, rowIndex) => (
        <tr key={rowIndex}>
          {Array.from({ length: 7 }, (_, cellIndex) => (
            <td className="border-t border-student-border px-4 py-4" key={cellIndex}>
              <TeacherSkeleton
                className={cellIndex === 2 ? "h-5 w-40" : cellIndex === 6 ? "h-10 w-24" : "h-5 w-24"}
              />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

function ReviewStatusBadge({ status }: { status: ReviewStatus }) {
  return (
    <span
      className={clsx(
        "mr-2 inline-flex h-7 w-16 items-center justify-center whitespace-nowrap rounded-full border px-1 text-xs font-semibold leading-none",
        status === "pending" && "border-amber-200 bg-amber-50 text-amber-700",
        status === "reviewing" &&
          "border-student-primary-border bg-student-primary-soft text-student-primary",
        status === "published" && "border-emerald-200 bg-emerald-50 text-emerald-700"
      )}
    >
      {status === "pending" ? "待批改" : status === "reviewing" ? "批改中" : "已发布"}
    </span>
  );
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
