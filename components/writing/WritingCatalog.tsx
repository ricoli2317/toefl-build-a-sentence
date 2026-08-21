"use client";

import Link from "next/link";
import { CalendarDays, Eye, FilePenLine, Play, RotateCcw } from "lucide-react";
import {
  studentWritingCatalogCacheKey,
  STUDENT_WRITING_OVERVIEW_CACHE_KEY,
  useStudentCachedData,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import {
  StudentEmptyState,
  StudentErrorState,
  StudentLoadingState,
  StudentMonthCard,
  StudentNavigation
} from "@/components/student/StudentUI";
import { PracticeSetAction, PracticeSetCatalogList } from "@/components/shared/PracticeCatalog";
import {
  STUDENT_ROUTES,
  writingReviewResultHref,
  writingSubmissionHistoryHref
} from "@/lib/studentNavigation";
import {
  WRITING_TASK_CONFIG,
  type WritingCatalogPayload,
  type WritingCatalogSet,
  type WritingOverviewPayload,
  type WritingTaskType
} from "@/lib/writing";
import { measureStudentRequest } from "@/lib/studentPerformance.client";

export function WritingMonthList({ taskType }: { taskType: WritingTaskType }) {
  const state = useWritingCatalog(taskType);
  const config = WRITING_TASK_CONFIG[taskType];

  if (state.loading) return <StudentLoadingState text="正在加载写作练习月份..." />;
  if (state.error) return <StudentErrorState text="加载写作练习月份失败，请稍后重试。" />;

  return (
    <div className="grid gap-5">
      <StudentNavigation
        backHref={STUDENT_ROUTES.home}
        crumbs={[
          { label: "学生首页", href: STUDENT_ROUTES.home },
          { label: config.label }
        ]}
      />
      {state.months.length === 0 ? (
        <StudentEmptyState text="暂无可练习月份。" />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {state.months.map((month) => (
            <StudentMonthCard
              href={`${config.listHref}/${month.month_key}`}
              key={month.month_key}
              month={month.month_label}
              questionCount={month.set_count}
              setCount={month.set_count}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function WritingSetList({
  monthKey,
  monthLabel,
  taskType
}: {
  monthKey: string;
  monthLabel: string;
  taskType: WritingTaskType;
}) {
  const state = useWritingCatalog(taskType);
  const config = WRITING_TASK_CONFIG[taskType];

  if (state.loading) return <StudentLoadingState text="正在加载写作套题..." />;
  if (state.error) return <StudentErrorState text="加载写作套题失败，请稍后重试。" />;

  const sets = state.sets.filter((set) => set.year_month === monthKey);
  return (
    <div className="grid gap-5">
      <StudentNavigation
        backHref={config.listHref}
        crumbs={[
          { label: "学生首页", href: STUDENT_ROUTES.home },
          { label: config.label, href: config.listHref },
          { label: monthLabel }
        ]}
      />
      <WritingSetCards sets={sets} taskType={taskType} />
    </div>
  );
}

function WritingSetCards({
  sets,
  taskType
}: {
  sets: WritingCatalogSet[];
  taskType: WritingTaskType;
}) {
  const config = WRITING_TASK_CONFIG[taskType];
  return (
    <PracticeSetCatalogList
      emptyState={<StudentEmptyState text="未找到写作套题。" />}
      renderActions={(item) => {
        const set = sets.find((candidate) => candidate.set_id === item.setId)!;
        const practiceHref = `${config.practiceHref}/${encodeURIComponent(set.question_id)}`;
        const returnHref = `${config.listHref}/${encodeURIComponent(set.year_month)}`;
        const historyHref = writingSubmissionHistoryHref(taskType, set.question_id);
        const submissionAction = set.submitted_attempt_id ? (
          <PracticeSetAction
            href={`${config.submissionHref}/${encodeURIComponent(set.submitted_attempt_id)}`}
            icon={Eye}
            label={set.status === "draft" ? "查看上次提交" : "查看提交"}
          />
        ) : null;
        const submittedHistoryAction = set.submitted_attempt_count > 1 ? (
          <PracticeSetAction
            href={historyHref}
            icon={Eye}
            label="查看提交记录"
          />
        ) : null;
        const reviewAction = set.published_review_attempt_id ? (
          <PracticeSetAction
            href={writingReviewResultHref(set.published_review_attempt_id, returnHref)}
            icon={Eye}
            label="查看批改"
          />
        ) : null;
        if (set.status === "draft") {
          return (
            <>
              <PracticeSetAction
                href={`${practiceHref}?attempt=${encodeURIComponent(set.draft_attempt_id ?? "")}`}
                icon={FilePenLine}
                label="继续练习"
              />
              {submittedHistoryAction ?? submissionAction}
              {set.submitted_attempt_count === 1 ? reviewAction : null}
            </>
          );
        }
        if (set.status === "submitted") {
          return (
            <>
              {submittedHistoryAction ?? submissionAction}
              {set.submitted_attempt_count === 1 ? reviewAction : null}
              <PracticeSetAction href={`${practiceHref}?new=1`} icon={RotateCcw} label="重新练习" />
            </>
          );
        }
        return <PracticeSetAction href={practiceHref} icon={Play} label="开始练习" />;
      }}
      renderStatus={(item) => {
        const set = sets.find((candidate) => candidate.set_id === item.setId)!;
        if (set.status === "draft") {
          return (
            <span className="inline-flex flex-col items-end text-xs font-semibold text-student-primary">
              <span>已保存</span>
              <span>{set.draft_word_count ?? 0} words</span>
            </span>
          );
        }
        if (set.status === "submitted") {
          return (
            <span className="student-chip">
              已提交{set.submitted_attempt_count > 1 ? ` · ${set.submitted_attempt_count}次` : ""}
            </span>
          );
        }
        return null;
      }}
      sets={sets.map((set) => ({
        questionCount: 1,
        setId: set.set_id,
        setTitle: set.display_name ?? set.set_title
      }))}
    />
  );
}

export function WritingDraftSummary({ taskType }: { taskType: WritingTaskType }) {
  const state = useWritingCatalog(taskType);
  return { error: state.error, latestDraft: state.latestDraft, loading: state.loading };
}

export function useWritingCatalog(taskType: WritingTaskType) {
  const { data, error, loading } = useStudentCachedData<WritingCatalogPayload>(
    studentWritingCatalogCacheKey(taskType),
    (session) => loadWritingCatalog(taskType, session),
    { refreshOnMount: true }
  );
  return {
    error,
    latestDraft: data?.latestDraft ?? null,
    loading,
    months: data?.months ?? [],
    sets: data?.sets ?? []
  };
}

export function useWritingOverview() {
  return useStudentCachedData<WritingOverviewPayload>(
    STUDENT_WRITING_OVERVIEW_CACHE_KEY,
    loadWritingOverview
  );
}

async function loadWritingCatalog(taskType: WritingTaskType, session: StudentCacheSession) {
  return loadWritingJson<WritingCatalogPayload>(
    `/api/writing/catalog?taskType=${encodeURIComponent(taskType)}`,
    session,
    "无法加载写作题库。"
  );
}

async function loadWritingOverview(session: StudentCacheSession) {
  return loadWritingJson<WritingOverviewPayload>(
    "/api/writing/overview",
    session,
    "无法加载写作练习概览。"
  );
}

async function loadWritingJson<T extends { error?: string }>(
  url: string,
  session: StudentCacheSession,
  fallback: string
) {
  return measureStudentRequest(`GET ${url}`, async (captureResponse) => {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${session.accessToken}` }
    });
    captureResponse(response);
    const text = await response.text();
    let payload: T;
    try {
      payload = text ? JSON.parse(text) : ({ error: "服务返回了空响应。" } as T);
    } catch {
      payload = { error: "服务返回的数据格式无效。" } as T;
    }
    if (!response.ok || payload.error) throw new Error(payload.error ?? fallback);
    return payload;
  });
}
