"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase/client";
import {
  TeacherCard,
  TeacherDataError,
  TeacherEmptyState,
  TeacherLoadingRegion
} from "@/components/teacher/TeacherUI";

type AiLog = Record<string, unknown> & {
  id: string;
  created_at: string;
  attempt_id: string;
  student_name?: string | null;
  task_type: string | null;
  operation: string;
  model: string;
  prompt_version: string;
  schema_version: string;
  status: string;
  pipeline_stage: string;
  error_type?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  elapsed_ms: number;
  total_tokens?: number | null;
  cost?: number | string | null;
  normalization_applied?: boolean;
  validation_issues?: Array<{ path: string; message: string }>;
  diagnostics?: Record<string, unknown>;
};

type Payload = {
  logs: AiLog[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
};

const EMPTY_FILTERS = {
  attempt_id: "",
  status: "",
  pipeline_stage: "",
  error_type: "",
  error_code: "",
  operation: "",
  task_type: "",
  model: "",
  prompt_version: ""
};

export function TeacherWritingAiLogs({ initialAttemptId }: { initialAttemptId: string }) {
  const [filters, setFilters] = useState({ ...EMPTY_FILTERS, attempt_id: initialAttemptId });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<AiLog | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    const search = new URLSearchParams({ page: String(page), page_size: "25" });
    Object.entries(applied).forEach(([key, value]) => {
      if (value.trim()) search.set(key, value.trim());
    });
    void teacherFetch(`/api/teacher/writing/reviews/ai-logs?${search}`)
      .then(async (response) => {
        const result = (await response.json()) as Payload & { message?: string };
        if (!response.ok) throw new Error(result.message || "无法加载 AI 调用日志。");
        if (active) setPayload(result);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : "无法加载 AI 调用日志。");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [applied, page]);

  function apply(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setApplied(filters);
  }

  return (
    <div className="grid gap-5">
      <TeacherCard className="p-5 sm:p-6">
        <form className="grid gap-3 md:grid-cols-3 xl:grid-cols-5" onSubmit={apply}>
          <FilterInput label="Attempt ID" name="attempt_id" />
          <FilterSelect label="状态" name="status" options={["success", "recovered", "failed"]} />
          <FilterSelect label="阶段" name="pipeline_stage" options={[
            "provider_request", "provider_response", "response_parsing",
            "schema_validation", "localization", "normalization",
            "final_validation", "review_persistence", "unknown"
          ]} />
          <FilterInput label="错误类型" name="error_type" />
          <FilterInput label="错误代码" name="error_code" />
          <FilterSelect label="操作" name="operation" options={[
            "generate_ai", "full_regenerate", "feedback_regenerate"
          ]} />
          <FilterSelect label="题型" name="task_type" options={["email", "academic_discussion"]} />
          <FilterInput label="模型" name="model" />
          <FilterInput label="Prompt 版本" name="prompt_version" />
          <div className="flex items-end gap-2">
            <button className="teacher-button-primary" type="submit">筛选</button>
            <button
              className="teacher-button-secondary"
              onClick={() => {
                setFilters(EMPTY_FILTERS);
                setApplied(EMPTY_FILTERS);
                setPage(1);
              }}
              type="button"
            >
              清空
            </button>
          </div>
        </form>
      </TeacherCard>

      {loading ? <TeacherLoadingRegion label="正在加载 AI 调用日志" /> : null}
      {error ? <TeacherDataError text={error} /> : null}
      {!loading && !error && payload?.logs.length === 0 ? (
        <TeacherEmptyState text="当前筛选条件下暂无 AI 调用日志。" />
      ) : null}

      {!error && payload?.logs.length ? (
        <TeacherCard className="overflow-hidden p-0">
          <div className="overflow-x-auto p-5 sm:p-6">
            <table className="w-full min-w-[1280px] text-left text-sm">
              <thead className="border-b border-student-border text-student-muted">
                <tr>
                  {[
                    "时间", "Attempt / 学生", "题型", "操作", "模型", "Prompt",
                    "状态", "阶段", "错误类型", "耗时", "Token", "费用"
                  ].map((label) => <th className="px-3 py-3 font-semibold" key={label}>{label}</th>)}
                </tr>
              </thead>
              <tbody>
                {payload.logs.map((log) => (
                  <tr
                    className="cursor-pointer border-b border-student-border/70 hover:bg-student-primary-soft/35"
                    key={log.id}
                    onClick={() => void loadDetail(log)}
                  >
                    <td className="whitespace-nowrap px-3 py-3">{formatDate(log.created_at)}</td>
                    <td className="max-w-[190px] px-3 py-3">
                      <div className="font-semibold">{log.student_name || "未知学生"}</div>
                      <div className="truncate text-xs text-student-muted">{log.attempt_id}</div>
                    </td>
                    <td className="px-3 py-3">{taskLabel(log.task_type)}</td>
                    <td className="px-3 py-3">{operationLabel(log.operation)}</td>
                    <td className="max-w-[170px] truncate px-3 py-3">{log.model}</td>
                    <td className="max-w-[180px] truncate px-3 py-3">{log.prompt_version}</td>
                    <td className="px-3 py-3"><StatusBadge log={log} /></td>
                    <td className="px-3 py-3">{stageLabel(log.pipeline_stage)}</td>
                    <td className="px-3 py-3">{errorTypeLabel(log.error_type)}</td>
                    <td className="whitespace-nowrap px-3 py-3">{formatDuration(log.elapsed_ms)}</td>
                    <td className="px-3 py-3 tabular-nums">{log.total_tokens ?? "—"}</td>
                    <td className="px-3 py-3 tabular-nums">{formatCost(log.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-student-border px-6 py-4 text-sm">
            <span>共 {payload.pagination.total} 条</span>
            <div className="flex items-center gap-3">
              <button className="teacher-button-secondary" disabled={page <= 1} onClick={() => setPage((value) => value - 1)} type="button">上一页</button>
              <span>{page} / {Math.max(payload.pagination.total_pages, 1)}</span>
              <button className="teacher-button-secondary" disabled={page >= payload.pagination.total_pages} onClick={() => setPage((value) => value + 1)} type="button">下一页</button>
            </div>
          </div>
        </TeacherCard>
      ) : null}

      {selected ? <LogDetail log={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );

  function updateFilter(name: keyof typeof filters, value: string) {
    setFilters((current) => ({ ...current, [name]: value }));
  }

  function FilterInput({ label, name }: { label: string; name: keyof typeof filters }) {
    return (
      <label className="text-sm font-semibold text-student-text">
        {label}
        <input className="mt-2 h-10 w-full rounded-lg border border-student-border px-3 font-normal" value={filters[name]} onChange={(event) => updateFilter(name, event.target.value)} />
      </label>
    );
  }

  function FilterSelect({ label, name, options }: { label: string; name: keyof typeof filters; options: string[] }) {
    return (
      <label className="text-sm font-semibold text-student-text">
        {label}
        <select className="mt-2 h-10 w-full rounded-lg border border-student-border bg-white px-3 font-normal" value={filters[name]} onChange={(event) => updateFilter(name, event.target.value)}>
          <option value="">全部</option>
          {options.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
    );
  }

  async function loadDetail(fallback: AiLog) {
    setSelected(fallback);
    try {
      const response = await teacherFetch(`/api/teacher/writing/reviews/ai-logs/${encodeURIComponent(fallback.id)}`);
      const result = (await response.json()) as { log?: AiLog };
      if (response.ok && result.log) setSelected({ ...fallback, ...result.log });
    } catch {
      // The already-loaded safe list projection remains usable as detail fallback.
    }
  }
}

function LogDetail({ log, onClose }: { log: AiLog; onClose(): void }) {
  const overlap = asRecord(log.diagnostics?.language_edit_overlap);
  const groups = Array.isArray(overlap?.groups) ? overlap.groups : [];
  const knownKeys = new Set(["language_edit_overlap"]);
  const unknownDiagnostics = Object.fromEntries(
    Object.entries(log.diagnostics ?? {}).filter(([key]) => !knownKeys.has(key))
  );
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/35" onClick={onClose} role="presentation">
      <section aria-label="AI 日志详情" className="h-full w-full max-w-3xl overflow-y-auto bg-white p-6 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="mb-6 flex items-start justify-between gap-4">
          <div><h2 className="text-xl font-bold">AI 日志详情</h2><p className="mt-1 text-sm text-student-muted">{log.id}</p></div>
          <button className="teacher-button-secondary" onClick={onClose} type="button">关闭</button>
        </div>
        <DetailSection title="基本信息" values={{
          时间: formatDate(log.created_at), Attempt: log.attempt_id,
          学生: log.student_name || "—", 题型: taskLabel(log.task_type),
          操作: operationLabel(log.operation), Request_ID: String(log.request_id ?? "—")
        }} />
        <DetailSection title="版本与结果" values={{
          模型: log.model, Prompt版本: log.prompt_version, Schema版本: log.schema_version,
          状态: statusLabel(log), 阶段: log.pipeline_stage,
          错误类型: log.error_type ?? "—", 错误代码: log.error_code ?? "—",
          错误信息: log.error_message ?? "—"
        }} />
        <DetailSection title="性能、Token 与 Provider" values={{
          AI耗时: formatDuration(log.elapsed_ms), 端到端耗时: formatDuration(Number(log.end_to_end_elapsed_ms ?? 0)),
          Prompt_Token: log.prompt_tokens ?? "—", Cached_Token: log.cached_tokens ?? "—",
          Completion_Token: log.completion_tokens ?? "—", Reasoning_Token: log.reasoning_tokens ?? "—",
          Total_Token: log.total_tokens ?? "—", 费用: formatCost(log.cost),
          Provider: log.provider_name ?? "—", HTTP状态: log.http_status ?? "—",
          Provider错误: log.provider_error_type ?? "—", Generation_ID: log.generation_id ?? "—",
          Provider_Request_ID: log.provider_request_id ?? "—",
          Upstream总费用: formatCost(log.upstream_inference_cost),
          Upstream输入费用: formatCost(log.upstream_inference_prompt_cost),
          Upstream输出费用: formatCost(log.upstream_inference_completions_cost)
        }} />
        <DetailSection title="Hedge" values={{
          已触发: log.hedge_triggered === true ? "是" : log.hedge_triggered === false ? "否" : "—",
          请求数: log.requests_started ?? "—", Winner: log.winner ?? "—",
          Primary结果: log.primary_result ?? "—",
          Primary耗时: formatDuration(Number(log.primary_elapsed_ms ?? 0)),
          Primary费用: formatCost(log.primary_cost), Hedge结果: log.hedge_result ?? "—",
          Hedge耗时: formatDuration(Number(log.hedge_elapsed_ms ?? 0)),
          Hedge费用: formatCost(log.hedge_cost), Loser状态: log.loser_status ?? "—",
          Winner费用: formatCost(log.winner_cost),
          已完成请求总费用: formatCost(log.observed_completed_cost)
        }} />
        <section className="mb-6"><h3 className="mb-3 font-bold">Validation issues</h3>
          {log.validation_issues?.length ? <ul className="grid gap-2">{log.validation_issues.map((issue, index) => <li className="rounded-lg bg-rose-50 p-3 text-sm" key={`${issue.path}-${index}`}><code>{issue.path}</code><div>{issue.message}</div></li>)}</ul> : <p className="text-sm text-student-muted">无</p>}
        </section>
        {overlap ? <OverlapDiagnostic groups={groups} summary={overlap} /> : null}
        {Object.keys(unknownDiagnostics).length ? <details className="rounded-lg border border-student-border p-4"><summary className="cursor-pointer font-semibold">查看原始诊断 JSON</summary><pre className="mt-3 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(unknownDiagnostics, null, 2)}</pre></details> : null}
        <Link className="teacher-button-secondary mt-6 inline-flex" href={`/teacher/writing/reviews/${encodeURIComponent(log.attempt_id)}`}>打开当前批改</Link>
      </section>
    </div>
  );
}

function OverlapDiagnostic({ groups, summary }: { groups: unknown[]; summary: Record<string, unknown> }) {
  return <section className="mb-6"><h3 className="mb-3 font-bold">Language Edit overlap 诊断</h3><p className="mb-3 text-sm">输入 {String(summary.input_edit_count ?? "—")} 条，输出 {String(summary.output_edit_count ?? "—")} 条，共 {String(summary.group_count ?? groups.length)} 个冲突组。</p><div className="grid gap-4">{groups.map((value, groupIndex) => {
    const group = asRecord(value) ?? {};
    const edits = Array.isArray(group.edits) ? group.edits : [];
    const suppressed = Array.isArray(group.suppressed_edits) ? group.suppressed_edits : [];
    return <div className="rounded-xl border border-student-border p-4" key={groupIndex}><div className="mb-1 font-semibold">冲突组 {groupIndex + 1} · {String(group.relationship ?? "unknown")} · {actionLabel(group.action)}</div><div className="mb-3 font-mono text-xs text-student-muted">group range [{String(group.group_start ?? "?")}, {String(group.group_end ?? "?")})</div><div className="grid gap-3">{edits.map((edit, index) => <DiagnosticEdit edit={asRecord(edit) ?? {}} key={index} label={`Edit ${index + 1}`} />)}</div>{suppressed.length ? <div className="mt-4 rounded-lg bg-amber-50 p-3"><div className="mb-2 text-sm font-semibold">已抑制的冲突修改</div><div className="grid gap-2">{suppressed.map((edit, index) => <DiagnosticEdit edit={asRecord(edit) ?? {}} key={index} label={`Suppressed ${index + 1}`} />)}</div></div> : null}</div>;
  })}</div></section>;
}

function DiagnosticEdit({ edit, label }: { edit: Record<string, unknown>; label: string }) {
  return <div className="rounded-lg bg-slate-50 p-3 text-sm"><div className="font-semibold">{label} · {String(edit.category ?? "—")} / {String(edit.severity ?? "—")}</div><div className="mt-2"><span className="text-student-muted">原文：</span>{String(edit.original_text ?? "")}</div><div><span className="text-student-muted">修改后：</span>{String(edit.replacement_text ?? "")}</div><div className="mt-1 font-mono text-xs">range [{String(edit.start ?? "?")}, {String(edit.end ?? "?")}) · changed [{String(edit.actual_change_start ?? "?")}, {String(edit.actual_change_end ?? "?")})</div></div>;
}

function DetailSection({ title, values }: { title: string; values: Record<string, unknown> }) {
  return <section className="mb-6"><h3 className="mb-3 font-bold">{title}</h3><dl className="grid gap-3 rounded-xl border border-student-border p-4 sm:grid-cols-2">{Object.entries(values).map(([label, value]) => <div key={label}><dt className="text-xs text-student-muted">{label.replaceAll("_", " ")}</dt><dd className="mt-1 break-words text-sm font-medium">{String(value)}</dd></div>)}</dl></section>;
}

function StatusBadge({ log }: { log: AiLog }) { return <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${log.status === "failed" ? "bg-rose-50 text-rose-700" : log.status === "recovered" || log.normalization_applied ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"}`}>{statusLabel(log)}</span>; }
function statusLabel(log: AiLog) { return log.status === "failed" ? failedLabel(log.error_type) : log.status === "recovered" || log.normalization_applied ? "成功 · 已自动修复" : "成功"; }
function failedLabel(type: unknown) { return type === "provider_error" ? "Provider 失败" : type === "timeout" ? "超时" : type === "localization_error" ? "定位失败" : type === "response_parse_error" ? "解析失败" : type === "persistence_error" ? "保存失败" : "校验失败"; }
function actionLabel(value: unknown) { return ({ deduplicated: "已去重", kept_minimal_equivalent: "保留最小等价修改", merged_context_overlap: "已合并上下文冲突", merged_compatible: "已合并兼容修改", suppressed_conflict: "冲突项已抑制" } as Record<string, string>)[String(value)] ?? String(value ?? "未知处理"); }
function taskLabel(value: unknown) { return value === "email" ? "Write an Email" : value === "academic_discussion" ? "Academic Discussion" : value ? String(value) : "—"; }
function operationLabel(value: string) { return ({ generate_ai: "AI 初批", full_regenerate: "Full Regenerate", feedback_regenerate: "Feedback Regenerate" } as Record<string, string>)[value] ?? value; }
function stageLabel(value: string) { return ({ provider_request: "Provider 请求", response_parsing: "响应解析", schema_validation: "Schema 校验", localization: "原文定位", normalization: "自动修复", final_validation: "最终校验", review_persistence: "保存批改" } as Record<string, string>)[value] ?? value; }
function errorTypeLabel(value: unknown) { return value ? failedLabel(value) : "—"; }
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium" }).format(new Date(value)); }
function formatDuration(value: number) { return Number.isFinite(value) && value > 0 ? `${(value / 1000).toFixed(2)} s` : "—"; }
function formatCost(value: unknown) { if (value === null || value === undefined || value === "") return "—"; const number = Number(value); return Number.isFinite(number) ? `$${number.toFixed(6)}` : "—"; }
function asRecord(value: unknown): Record<string, unknown> | null { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }

async function teacherFetch(input: string) {
  const { data: { session } } = await createBrowserSupabase().auth.getSession();
  return fetch(input, { headers: { Authorization: `Bearer ${session?.access_token ?? ""}` } });
}
