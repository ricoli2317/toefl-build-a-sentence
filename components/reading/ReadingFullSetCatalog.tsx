"use client";

import { Eye, FilePenLine, Play } from "lucide-react";
import {
  PracticeSetAction,
  PracticeSetCatalogList
} from "@/components/shared/PracticeCatalog";
import {
  useStudentCachedData,
  useStudentDataCache,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import {
  StudentEmptyState,
  StudentErrorState,
  StudentNavigation
} from "@/components/student/StudentUI";
import type { ReadingFullSetCatalogItem } from "@/lib/reading/fullSets";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import { ReadingCatalogStatusBadge } from "./ReadingCatalog";
import { ReadingFullSetRetakeButton } from "./ReadingFullSetRetakeButton";

const FULL_SET_CATALOG_CACHE_KEY = "reading:full-sets:catalog";

type ReadingFullSetCatalogPayload = {
  fullSets: ReadingFullSetCatalogItem[];
};

export function ReadingFullSetCatalog() {
  const cache = useStudentDataCache();
  const state = useStudentCachedData<ReadingFullSetCatalogPayload>(
    FULL_SET_CATALOG_CACHE_KEY,
    loadReadingFullSetCatalog,
    { refreshOnMount: true }
  );

  return (
    <div className="grid gap-5">
      <StudentNavigation
        backHref={STUDENT_ROUTES.home}
        crumbs={[
          { label: "学生首页", href: STUDENT_ROUTES.home },
          { label: "Full Set Practice" }
        ]}
      />
      {state.loading ? <ReadingFullSetCatalogSkeleton /> : null}
      {!state.loading && (state.error || !state.data) ? (
        <div className="grid gap-4">
          <StudentErrorState text="套题加载失败，请重试。" />
          <button
            className="student-button-secondary justify-self-start"
            onClick={() => cache.invalidate(FULL_SET_CATALOG_CACHE_KEY)}
            type="button"
          >
            重新加载
          </button>
        </div>
      ) : null}
      {!state.loading && state.data?.fullSets.length === 0 ? (
        <StudentEmptyState text="暂无可用套题" />
      ) : null}
      {!state.loading && state.data?.fullSets.length ? (
        <PracticeSetCatalogList
          renderActions={(set) => (
            <ReadingFullSetActions
              fullSet={state.data!.fullSets.find((item) => item.fullSetId === set.setId)!}
            />
          )}
          renderStatus={(set) => (
            <ReadingCatalogStatusBadge
              status={state.data!.fullSets.find((item) => item.fullSetId === set.setId)!.studentState.status}
            />
          )}
          sets={state.data.fullSets.map((fullSet) => ({
            setId: fullSet.fullSetId,
            setTitle: fullSet.title,
            questionCount: 50
          }))}
        />
      ) : null}
    </div>
  );
}

function ReadingFullSetActions({ fullSet }: { fullSet: ReadingFullSetCatalogItem }) {
  const detailHref = `${STUDENT_ROUTES.readingFullSets}/${encodeURIComponent(fullSet.fullSetId)}`;
  if (fullSet.studentState.status === "in_progress" && fullSet.studentState.activeAttemptId) {
    return (
      <PracticeSetAction
        href={`${detailHref}/attempt/${encodeURIComponent(fullSet.studentState.activeAttemptId)}`}
        icon={FilePenLine}
        label="继续练习"
        primary
      />
    );
  }
  if (fullSet.studentState.status === "completed" && fullSet.studentState.latestCompletedAttemptId) {
    return (
      <>
        <PracticeSetAction
          href={`${detailHref}/result/${encodeURIComponent(fullSet.studentState.latestCompletedAttemptId)}`}
          icon={Eye}
          label="查看结果"
        />
        <ReadingFullSetRetakeButton compact fullSetId={fullSet.fullSetId} label="再练一次" />
      </>
    );
  }
  return <PracticeSetAction href={detailHref} icon={Play} label="开始练习" primary />;
}

function ReadingFullSetCatalogSkeleton() {
  return (
    <div aria-label="正在加载套题" className="grid gap-1.5" role="status">
      {Array.from({ length: 6 }, (_, index) => (
        <div className="min-h-[64px] animate-pulse rounded-2xl border border-student-border bg-white px-5 py-2.5" key={index}>
          <div className="flex h-10 items-center gap-3.5">
            <span className="h-10 w-10 rounded-[10px] bg-slate-100" />
            <span className="h-5 w-32 rounded bg-slate-100" />
          </div>
        </div>
      ))}
      <span className="sr-only">正在加载套题...</span>
    </div>
  );
}

async function loadReadingFullSetCatalog(session: StudentCacheSession) {
  const response = await fetch("/api/reading/full-sets", {
    cache: "no-store",
    headers: { Authorization: `Bearer ${session.accessToken}` }
  });
  const payload = await response.json().catch(() => ({})) as ReadingFullSetCatalogPayload & {
    error?: string;
  };
  if (!response.ok || payload.error || !Array.isArray(payload.fullSets)) {
    throw new Error(payload.error ?? "套题加载失败，请重试。");
  }
  return payload;
}
