"use client";

import { useStudentCachedData, STUDENT_WRITING_CORRECTION_CACHE_PREFIX } from "@/components/StudentDataCache";
import { writingCorrectionClient } from "@/lib/writingCorrectionClient";
import type { WritingCorrectionHistoryItem } from "@/lib/writingCorrectionUi";
import { ArrowRight } from "lucide-react";

export function WritingCorrectionHistory({ originalAttemptId }: { originalAttemptId: string }) {
  const state = useStudentCachedData(
    `${STUDENT_WRITING_CORRECTION_CACHE_PREFIX}:history:${originalAttemptId}`,
    () => writingCorrectionClient.history(originalAttemptId), { refreshOnMount: true }
  );
  return <section className="mt-4 border-t border-student-border pt-3">
    <h2 className="text-sm font-bold">订正历史</h2>
    {state.loading ? <p className="text-sm text-student-muted">正在加载订正历史…</p> : null}
    {state.error ? <p role="alert" className="text-sm text-student-error">{state.error}</p> : null}
    {state.data ? <WritingCorrectionHistoryItems items={state.data} /> : null}
  </section>;
}

export function WritingCorrectionHistoryItems({ items, onOpen }: {
  items: WritingCorrectionHistoryItem[]; onOpen?: (id: string) => void;
}) {
   if (!items.length) return <p className="mt-2 text-xs text-student-muted">暂无订正记录。</p>;
   return <ol className="mt-2 max-h-48 divide-y divide-student-border overflow-y-auto text-xs">
    {items.map((item) => <li className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0" key={item.attempt_id}>
      <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2"><p className="font-bold">{item.submitted_at ? new Date(item.submitted_at).toLocaleString("zh-CN") : item.saved_at ? `保存于 ${new Date(item.saved_at).toLocaleString("zh-CN")}` : "尚未提交"}</p><span className="student-chip !py-0.5 text-[11px]">{item.status === "draft" ? "草稿" : "已提交"}</span></div>
      {item.status === "submitted" ? <p className="mt-1 text-student-muted">{item.reviewStatus === "published" ? "批改已发布" : "等待批改中"}</p> : null}
      </div>
      <a className="inline-flex shrink-0 items-center gap-1 font-bold text-student-primary hover:underline" href={`/student/writing-corrections/${encodeURIComponent(item.attempt_id)}${item.reviewStatus === "published" ? "/review" : ""}`}
        onClick={onOpen ? (event) => { event.preventDefault(); onOpen(item.attempt_id); } : (event) => {
          event.currentTarget.href += `?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`;
        }}>{item.status === "draft" ? "继续订正" : item.reviewStatus === "published" ? "查看批改" : "查看"}<ArrowRight aria-hidden="true" size={14} /></a>
    </li>)}
  </ol>;
}
