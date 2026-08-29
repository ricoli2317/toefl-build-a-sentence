"use client";

import { useState } from "react";
import { BookOpenCheck, Clock3, Target, Users } from "lucide-react";
import {
  TEACHER_READING_STATS_CACHE_KEY,
  useTeacherCachedData
} from "@/components/TeacherDataCache";
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
import type { TeacherReadingStatsPayload } from "@/lib/reading/teacherStats";
import type { ReadingModule } from "@/lib/reading/types";

type Tab = "students" | "items" | "questions";

const TASK_LABELS: Record<ReadingModule, string> = {
  ctw: "Complete the Words",
  rdl: "Read in Daily Life",
  rap: "Read an Academic Passage"
};

export function TeacherReadingStatistics() {
  const [tab, setTab] = useState<Tab>("students");
  const state = useTeacherCachedData<TeacherReadingStatsPayload>(
    TEACHER_READING_STATS_CACHE_KEY,
    loadTeacherReadingStatistics
  );
  const stats = state.data;

  return (
    <div className="grid gap-6">
      {state.loading ? <TeacherLoadingRegion label="正在加载阅读统计" /> : null}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <TeacherMetricCard icon={BookOpenCheck} label="已完成练习" value={metric(state, stats?.overview.completedAttempts)} />
        <TeacherMetricCard icon={Users} label="参与学生" value={metric(state, stats?.overview.studentCount)} />
        <TeacherMetricCard icon={Target} label="总体正确率" value={state.loading ? <TeacherSkeleton className="h-8 w-20" /> : state.error ? "—" : percent(stats?.overview.accuracy ?? 0)} />
        <TeacherMetricCard icon={Clock3} label="总练习时长" value={state.loading ? <TeacherSkeleton className="h-8 w-24" /> : state.error ? "—" : formatDuration(stats?.overview.totalPracticeSeconds ?? 0)} />
      </div>

      {state.error ? <TeacherDataError text="阅读统计加载失败，请稍后重试。" /> : null}

      <TeacherCard className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-student-border px-5 py-4 sm:px-6">
          <TeacherSectionTitle>阅读表现</TeacherSectionTitle>
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="阅读统计维度">
            <TabButton active={tab === "students"} label="学生" onClick={() => setTab("students")} />
            <TabButton active={tab === "items"} label="题目" onClick={() => setTab("items")} />
            <TabButton active={tab === "questions"} label="各题表现" onClick={() => setTab("questions")} />
          </div>
        </div>
        {state.loading ? <StatisticsSkeleton /> : !stats ? null : tab === "students"
          ? <StudentStatistics rows={stats.students} />
          : tab === "items"
            ? <ItemStatistics rows={stats.items} />
            : <QuestionStatistics rows={stats.questions} />}
      </TeacherCard>
    </div>
  );
}

function StudentStatistics({ rows }: { rows: TeacherReadingStatsPayload["students"] }) {
  if (!rows.length) return <div className="p-6"><TeacherEmptyState text="暂无可查看的学生阅读数据。" /></div>;
  return (
    <div className="overflow-x-auto p-5 sm:p-6">
      <table className="w-full min-w-[1080px] text-left text-sm">
        <thead><tr className="border-b border-student-border text-student-muted">
          <th className="px-3 py-3 font-medium">学生</th>
          <th className="px-3 py-3 font-medium">已完成</th>
          <th className="px-3 py-3 font-medium">正确率</th>
          <th className="px-3 py-3 font-medium">练习时长</th>
          <th className="px-3 py-3 font-medium">Complete the Words</th>
          <th className="px-3 py-3 font-medium">Read in Daily Life</th>
          <th className="px-3 py-3 font-medium">Read an Academic Passage</th>
        </tr></thead>
        <tbody className="divide-y divide-student-border">
          {rows.map((row) => <tr key={row.studentId}>
            <td className="px-3 py-4"><p className="font-semibold text-student-text">{row.displayName}</p><p className="mt-0.5 text-xs text-student-muted">{row.account}</p></td>
            <td className="px-3 py-4 font-semibold tabular-nums">{row.completedAttempts}</td>
            <td className="px-3 py-4"><TeacherAccuracyBar value={row.accuracy} /></td>
            <td className="px-3 py-4 tabular-nums">{formatDuration(row.totalPracticeSeconds)}</td>
            {(["ctw", "rdl", "rap"] as ReadingModule[]).map((taskType) => <td className="px-3 py-4 tabular-nums" key={taskType}>{taskSummary(row.byTask[taskType])}</td>)}
          </tr>)}
        </tbody>
      </table>
    </div>
  );
}

function ItemStatistics({ rows }: { rows: TeacherReadingStatsPayload["items"] }) {
  if (!rows.length) return <div className="p-6"><TeacherEmptyState text="暂无阅读题目数据。" /></div>;
  return (
    <div className="overflow-x-auto p-5 sm:p-6">
      <table className="w-full min-w-[900px] text-left text-sm">
        <thead><tr className="border-b border-student-border text-student-muted">
          <th className="px-3 py-3 font-medium">练习</th><th className="px-3 py-3 font-medium">类型</th><th className="px-3 py-3 font-medium">作答次数</th><th className="px-3 py-3 font-medium">学生数</th><th className="px-3 py-3 font-medium">平均正确率</th><th className="px-3 py-3 font-medium">平均用时</th>
        </tr></thead>
        <tbody className="divide-y divide-student-border">
          {rows.map((row) => <tr key={row.itemId}>
            <td className="px-3 py-4 font-semibold text-student-text">{row.displayName}</td><td className="px-3 py-4 text-student-muted">{row.taskName}</td><td className="px-3 py-4 tabular-nums">{row.attemptCount}</td><td className="px-3 py-4 tabular-nums">{row.studentCount}</td><td className="px-3 py-4"><TeacherAccuracyBar value={row.averageAccuracy} /></td><td className="px-3 py-4 tabular-nums">{formatDuration(row.averageTimeSeconds)}</td>
          </tr>)}
        </tbody>
      </table>
    </div>
  );
}

function QuestionStatistics({ rows }: { rows: TeacherReadingStatsPayload["questions"] }) {
  if (!rows.length) return <div className="p-6"><TeacherEmptyState text="还没有可统计的阅读作答。" /></div>;
  return (
    <div className="overflow-x-auto p-5 sm:p-6">
      <table className="w-full min-w-[980px] text-left text-sm">
        <thead><tr className="border-b border-student-border text-student-muted">
          <th className="px-3 py-3 font-medium">练习</th><th className="px-3 py-3 font-medium">类型</th><th className="px-3 py-3 font-medium">位置</th><th className="px-3 py-3 font-medium">题型</th><th className="px-3 py-3 font-medium">作答次数</th><th className="px-3 py-3 font-medium">正确率</th>
        </tr></thead>
        <tbody className="divide-y divide-student-border">
          {rows.map((row) => <tr key={row.pointId}>
            <td className="px-3 py-4 font-semibold text-student-text">{row.itemDisplayName}</td><td className="px-3 py-4 text-student-muted">{row.taskName}</td><td className="px-3 py-4">{row.displayName}</td><td className="px-3 py-4">{row.typeName}</td><td className="px-3 py-4 tabular-nums">{row.attemptCount}</td><td className="px-3 py-4"><TeacherAccuracyBar value={row.accuracy} /></td>
          </tr>)}
        </tbody>
      </table>
    </div>
  );
}

function TabButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return <button aria-selected={active} className={active ? "teacher-button-primary min-h-9 px-4 py-1.5" : "teacher-button-secondary min-h-9 px-4 py-1.5"} onClick={onClick} role="tab" type="button">{label}</button>;
}

function StatisticsSkeleton() {
  return <div className="grid gap-3 p-6">{Array.from({ length: 5 }, (_, index) => <TeacherSkeleton className="h-12 w-full" key={index} />)}</div>;
}

function metric(state: { loading: boolean; error: string }, value: number | undefined) {
  return state.loading ? <TeacherSkeleton className="h-8 w-14" /> : state.error ? "—" : String(value ?? 0);
}

function taskSummary(value: TeacherReadingStatsPayload["students"][number]["byTask"][ReadingModule]) {
  return `${value.completedAttempts} 次 · ${percent(value.accuracy)}`;
}

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatDuration(value: number) {
  const seconds = Math.max(0, Math.round(value));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours}小时${minutes % 60 ? `${minutes % 60}分钟` : ""}`;
}

async function loadTeacherReadingStatistics() {
  const { data: { session } } = await createBrowserSupabase().auth.getSession();
  const response = await fetch("/api/teacher/reading/statistics", {
    cache: "no-store",
    headers: { Authorization: `Bearer ${session?.access_token ?? ""}` }
  });
  const payload = await response.json().catch(() => ({})) as TeacherReadingStatsPayload & { error?: string };
  if (!response.ok || payload.error) throw new Error(payload.error ?? "阅读统计加载失败。");
  return payload;
}
