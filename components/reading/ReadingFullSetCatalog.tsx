"use client";

import Link from "next/link";
import { BookOpen, Clock3, Eye, Play } from "lucide-react";
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
import { formatReadingFullSetTime } from "@/lib/reading/fullSetPresentation";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
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
          { label: "套题练习" }
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
        <div className="grid gap-4 lg:grid-cols-2">
          {state.data.fullSets.map((fullSet) => (
            <ReadingFullSetCard fullSet={fullSet} key={fullSet.fullSetId} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ReadingFullSetCard({ fullSet }: { fullSet: ReadingFullSetCatalogItem }) {
  const detailHref = `${STUDENT_ROUTES.readingFullSets}/${encodeURIComponent(fullSet.fullSetId)}`;
  return (
    <article className="student-card flex min-h-[216px] flex-col p-4 sm:p-5" data-full-set-card>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-[#347fdc]">
            <BookOpen aria-hidden="true" size={22} strokeWidth={1.9} />
          </span>
          <h2 className="break-all text-lg font-bold text-student-text" data-full-set-title>
            {fullSet.title}
          </h2>
        </div>
        <span className="student-chip shrink-0">共 50 题</span>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <ModuleSummary
          label="Module 1"
          questionCount={35}
          timeLimitSeconds={fullSet.module1TimeLimitSeconds}
        />
        <ModuleSummary
          label="Module 2"
          questionCount={15}
          timeLimitSeconds={fullSet.module2TimeLimitSeconds}
        />
      </div>

      <div className="mt-auto flex justify-end pt-4">
        {fullSet.studentState.status === "in_progress" && fullSet.studentState.activeAttemptId ? (
          <Link
            className="student-button-primary min-h-9 px-3.5 py-1.5"
            href={`${detailHref}/attempt/${encodeURIComponent(fullSet.studentState.activeAttemptId)}`}
          >
            <Play aria-hidden="true" size={16} strokeWidth={1.9} />继续练习
          </Link>
        ) : fullSet.studentState.status === "completed" && fullSet.studentState.latestCompletedAttemptId ? (
          <div className="flex flex-wrap justify-end gap-2">
            <Link
              className="student-button-secondary min-h-9 px-3.5 py-1.5"
              href={`${detailHref}/result/${encodeURIComponent(fullSet.studentState.latestCompletedAttemptId)}`}
            >
              <Eye aria-hidden="true" size={16} strokeWidth={1.9} />查看结果
            </Link>
            <ReadingFullSetRetakeButton compact fullSetId={fullSet.fullSetId} />
          </div>
        ) : (
          <Link className="student-button-primary min-h-9 px-3.5 py-1.5" href={detailHref}>
            <Play aria-hidden="true" size={16} strokeWidth={1.9} />开始练习
          </Link>
        )}
      </div>
    </article>
  );
}

function ModuleSummary({
  label,
  questionCount,
  timeLimitSeconds
}: {
  label: string;
  questionCount: number;
  timeLimitSeconds: number;
}) {
  return (
    <div className="rounded-xl border border-student-border bg-student-bg px-3.5 py-3">
      <p className="font-semibold text-student-text">{label}</p>
      <p className="mt-1 flex items-center gap-1.5 text-sm text-student-muted">
        <span>{questionCount}题</span>
        <span aria-hidden="true">·</span>
        <Clock3 aria-hidden="true" size={15} strokeWidth={1.9} />
        <span>{formatReadingFullSetTime(timeLimitSeconds)}</span>
      </p>
    </div>
  );
}

function ReadingFullSetCatalogSkeleton() {
  return (
    <div aria-label="正在加载套题" className="grid gap-4 lg:grid-cols-2" role="status">
      {Array.from({ length: 6 }, (_, index) => (
        <div className="student-card min-h-[216px] animate-pulse p-5" key={index}>
          <div className="flex items-center gap-3">
            <span className="h-11 w-11 rounded-xl bg-slate-100" />
            <span className="h-5 w-32 rounded bg-slate-100" />
          </div>
          <div className="mt-5 grid gap-2 sm:grid-cols-2">
            <span className="h-[68px] rounded-xl bg-slate-100" />
            <span className="h-[68px] rounded-xl bg-slate-100" />
          </div>
          <span className="ml-auto mt-5 block h-9 w-24 rounded-lg bg-slate-100" />
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
