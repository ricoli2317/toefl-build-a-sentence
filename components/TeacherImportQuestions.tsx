"use client";

import { ChangeEvent, DragEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ClipboardCheck, FileSearch, TableProperties, Upload } from "lucide-react";
import { parseCsvDocument, type CsvRecord } from "@/lib/csv";
import {
  QUESTION_TYPE_LABELS,
  closestQuestionSchema,
  detectQuestionType,
  type QuestionType
} from "@/lib/questionCsvSchemas";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { broadcastQuestionBankUpdated } from "@/lib/questionBankCacheEvents";
import {
  TEACHER_ACCESS_CACHE_KEY,
  TEACHER_QUESTION_BANK_CACHE_PREFIX,
  TEACHER_STATS_CACHE_KEY,
  useTeacherDataCache
} from "@/components/TeacherDataCache";

type ImportResult = {
  success?: boolean;
  successCount: number;
  insertedCount: number;
  updatedCount: number;
  logicalNewItemCount: number;
  logicalAutoMergeCount: number;
  logicalNeedsReviewCount: number;
  occurrenceInsertedCount: number;
  failedCount: number;
  warnings?: Array<{
    message: string;
    code?: string | null;
    details?: string | null;
    hint?: string | null;
    operation?: string;
  }>;
  failedRows: Array<{
    rowNumber: number;
    questionId: string;
    setId?: string;
    reason: string;
    code?: string | null;
    details?: string | null;
    hint?: string | null;
    operation?: string;
  }>;
};

type ImportErrorPayload = {
  success?: boolean;
  error?: string;
  message?: string;
  code?: string | null;
  details?: string | null;
  hint?: string | null;
  operation?: string;
  batch?: string;
  requestUrl?: string;
  requestMethod?: string;
  origin?: string;
};

export function TeacherImportQuestions() {
  const router = useRouter();
  const { invalidate, load } = useTeacherDataCache();
  const [rows, setRows] = useState<CsvRecord[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [questionType, setQuestionType] = useState<QuestionType>("unknown");
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [checkingRole, setCheckingRole] = useState(true);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let ignore = false;

    async function guardTeacher() {
      const authorized = await load(TEACHER_ACCESS_CACHE_KEY, async () => {
        const supabase = createBrowserSupabase();
        const {
          data: { user }
        } = await supabase.auth.getUser();

        if (!user) return false;

        const { data } = await supabase
          .from("profiles")
          .select("role")
          .eq("id", user.id)
          .single();
        return data?.role === "teacher";
      });

      if (ignore) return;
      if (!authorized) {
        router.replace("/");
        return;
      }

      setCheckingRole(false);
    }

    guardTeacher();
    return () => {
      ignore = true;
    };
  }, [load, router]);

  const closestSchema = headers.length > 0 ? closestQuestionSchema(headers) : null;
  const missingFields =
    questionType === "unknown" ? closestSchema?.difference.missingFields ?? [] : [];
  const unexpectedFields =
    questionType === "unknown" ? closestSchema?.difference.unexpectedFields ?? [] : [];

  async function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) await readFile(file);
  }

  async function readFile(file: File) {
    setResult(null);
    setError("");
    setRows([]);
    setHeaders([]);
    setQuestionType("unknown");

    if (!file.name.toLocaleLowerCase().endsWith(".csv")) {
      setFileName(file.name);
      setError("请选择 .csv 文件。");
      return;
    }

    setFileName(file.name);
    const text = await file.text();
    const parsed = parseCsvDocument(text, { trimValues: false });
    const detectedQuestionType = detectQuestionType(parsed.headers);
    const parsedRows = parsed.rows;
    setHeaders(parsed.headers);
    setQuestionType(detectedQuestionType);
    setRows(parsedRows);

    if (detectedQuestionType === "unknown") {
      setError("无法识别题型：CSV 表头与现有题型格式不匹配");
    } else if (parsedRows.length === 0) {
      setError("CSV 中没有数据行。");
    }
  }

  async function onFileDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) await readFile(file);
  }

  async function importRows() {
    setLoading(true);
    setError("");
    setResult(null);

    if (rows.length === 0) {
      setError("请先选择 CSV 文件。");
      setLoading(false);
      return;
    }

    if (questionType === "unknown") {
      setError(
        `无法识别题型：CSV 表头与现有题型格式不匹配。缺少字段：${
          missingFields.join(", ") || "无"
        }。非预期字段：${unexpectedFields.join(", ") || "无"}。`
      );
      setLoading(false);
      return;
    }

    try {
      const supabase = createBrowserSupabase();
      const {
        data: { session }
      } = await supabase.auth.getSession();
      const requestUrl = "/api/teacher/import-questions";
      const requestMethod = "POST";
      const origin = window.location.origin;

      const response = await fetch(requestUrl, {
        method: requestMethod,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token ?? ""}`
        },
        body: JSON.stringify({ headers, rows })
      });

      const responseText = await response.text();
      let payload: ImportResult | ImportErrorPayload;
      try {
        payload = responseText
          ? JSON.parse(responseText)
          : { error: "导入服务返回了空响应。" };
      } catch {
        payload = {
          error: "导入服务返回的数据格式无效。",
          details: responseText
        };
      }

      if (!response.ok) {
        console.error("Import questions failed", payload);
        setError(formatImportError({
          ...(payload as ImportErrorPayload),
          origin,
          requestMethod,
          requestUrl
        }));
      } else {
        const resultPayload = payload as ImportResult;
        if (resultPayload.failedRows?.length > 0) {
          console.error("Import questions completed with failed rows", resultPayload);
        }
        invalidate(TEACHER_STATS_CACHE_KEY);
        invalidate(TEACHER_QUESTION_BANK_CACHE_PREFIX);
        if (resultPayload.successCount > 0) {
          broadcastQuestionBankUpdated();
        }
        setResult(resultPayload);
      }
    } catch (error) {
      const requestUrl = "/api/teacher/import-questions";
      const requestMethod = "POST";
      const origin = window.location.origin;
      console.error("Import questions failed before the server returned a response", {
        error,
        origin,
        requestMethod,
        requestUrl
      });
      setError(formatImportError({
        error: error instanceof Error ? error.message : "服务器返回响应前导入失败。",
        origin,
        requestMethod,
        requestUrl
      }));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid gap-5">
      {checkingRole ? <span className="sr-only" role="status">正在检查教师权限</span> : null}
      <section className="teacher-card overflow-hidden">
        <div className="p-6 sm:p-8">
          <h2 className="text-xl font-bold text-student-text">上传文件</h2>
          <div
            className={`mt-5 flex min-h-[270px] flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-10 text-center transition ${
              dragging
                ? "border-student-primary bg-student-primary-soft"
                : "border-[#b9a8ff] bg-gradient-to-br from-white to-student-primary-soft/55"
            }`}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(event) => {
              if (event.currentTarget === event.target) setDragging(false);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={onFileDrop}
          >
            <Upload aria-hidden="true" className="text-student-primary" size={46} strokeWidth={1.8} />
            <p className="mt-5 text-lg font-bold text-student-text">拖拽 CSV 文件到此处，或点击选择文件</p>
            <p className="mt-2 text-sm text-student-muted">仅支持 .csv 文件</p>
            <button
              className="teacher-button-secondary mt-5 min-w-32"
              disabled={checkingRole}
              onClick={() => fileInputRef.current?.click()}
              type="button"
            >
              选择文件
            </button>
            {fileName ? (
              <div className="mt-4 grid gap-2 text-sm font-semibold">
                <p className="rounded-full bg-white px-4 py-1.5 text-student-primary shadow-sm">
                  文件：{fileName}
                </p>
                {questionType !== "unknown" ? (
                  <p className="text-student-primary">
                    已识别题型：{QUESTION_TYPE_LABELS[questionType]}
                  </p>
                ) : (
                  <p className="text-student-error">
                    无法识别题型：CSV 表头与现有题型格式不匹配
                  </p>
                )}
              </div>
            ) : null}
          </div>
        </div>
        <input
          accept=".csv,text/csv"
          className="sr-only"
          id="csv-file"
          onChange={onFileChange}
          ref={fileInputRef}
          type="file"
        />

        <div className="mx-6 grid gap-4 rounded-2xl border border-student-primary-border bg-student-primary-soft/45 p-5 sm:mx-8 md:grid-cols-3">
          <ImportStep icon={TableProperties} description="校验文件表头是否符合要求" title="CSV 表头校验" />
          <ImportStep icon={FileSearch} description="预览前几行数据，确认内容无误" title="题目预览" />
          <ImportStep icon={ClipboardCheck} description="查看导入统计与详细结果" title="导入结果" />
        </div>

        <div className="mt-6 border-t border-student-border px-6 py-5 sm:px-8">
          <div className="flex flex-wrap items-center justify-center gap-4">
            <button
              className="teacher-button-primary min-w-52"
              disabled={checkingRole || loading || rows.length === 0 || questionType === "unknown"}
              onClick={importRows}
              type="button"
            >
              {loading ? "正在导入..." : "开始导入"}
            </button>
            {checkingRole ? <span className="text-sm font-semibold text-student-muted">正在检查教师权限...</span> : null}
            {rows.length > 0 ? (
              <span className="text-sm font-semibold text-student-primary">检测到 {rows.length} 行数据</span>
            ) : null}
          </div>
          {missingFields.length > 0 ? (
            <p className="teacher-error mt-4">缺少字段：{missingFields.join(", ")}</p>
          ) : null}
          {unexpectedFields.length > 0 ? (
            <p className="teacher-error mt-4">存在非预期字段：{unexpectedFields.join(", ")}</p>
          ) : null}
          {questionType === "unknown" && closestSchema ? (
            <p className="teacher-error mt-4 break-words">
              最接近的格式：{QUESTION_TYPE_LABELS[closestSchema.questionType]}；所需表头：
              {closestSchema.schema.join(",")}
            </p>
          ) : null}
          {error ? <pre className="teacher-error mt-4 whitespace-pre-wrap">{error}</pre> : null}
        </div>
      </section>

      {result ? (
        <section className="teacher-card p-6">
          <h2 className="text-xl font-bold text-student-text">导入结果</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <ResultMetric label="原始记录成功" value={result.successCount} />
            <ResultMetric label="原始记录新增" value={result.insertedCount} />
            <ResultMetric label="原始记录更新" value={result.updatedCount} />
            <ResultMetric label="失败" tone="error" value={result.failedCount} />
            <ResultMetric label="新逻辑题" value={result.logicalNewItemCount ?? 0} />
            <ResultMetric label="重复归组" value={result.logicalAutoMergeCount ?? 0} />
            <ResultMetric label="待确认" tone={result.logicalNeedsReviewCount > 0 ? "error" : undefined} value={result.logicalNeedsReviewCount ?? 0} />
            <ResultMetric label="新增日期记录" value={result.occurrenceInsertedCount ?? 0} />
          </div>
          {result.logicalNeedsReviewCount > 0 ? (
            <p className="mt-5 rounded-xl border border-student-error-border bg-student-error-soft p-4 text-sm font-semibold text-student-text">
              待确认题目已导入原始题库，但暂未进入学生练习列表，等待重复题确认。
            </p>
          ) : null}
          {result.warnings && result.warnings.length > 0 ? (
            <div className="mt-5 grid gap-3">
              {result.warnings.map((warning, index) => (
                <pre
                  className="whitespace-pre-wrap rounded-xl border border-student-error-border bg-student-error-soft p-4 text-sm font-semibold text-student-text"
                  key={`${warning.operation ?? "warning"}-${index}`}
                >
                  {formatImportWarning(warning)}
                </pre>
              ))}
            </div>
          ) : null}
          {result.failedRows.length > 0 ? (
            <div className="mt-5 overflow-x-auto rounded-xl border border-student-border">
              <table className="w-full min-w-[720px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-student-border bg-student-primary-soft/45 text-student-muted">
                    <th className="px-4 py-3">CSV 行</th>
                    <th className="px-4 py-3">题目 ID</th>
                    <th className="px-4 py-3">套题 ID</th>
                    <th className="px-4 py-3">操作</th>
                    <th className="px-4 py-3">原因</th>
                  </tr>
                </thead>
                <tbody>
                  {result.failedRows.map((row) => (
                    <tr className="border-b border-student-border last:border-0" key={`${row.rowNumber}-${row.questionId}`}>
                      <td className="px-4 py-3">{row.rowNumber}</td>
                      <td className="px-4 py-3">{row.questionId || "无"}</td>
                      <td className="px-4 py-3">{row.setId || "无"}</td>
                      <td className="px-4 py-3">{localizeImportOperation(row.operation) ?? "无"}</td>
                      <td className="px-4 py-3">
                        <div>{localizeImportMessage(row.reason)}</div>
                        {row.code ? <div className="text-student-muted">错误代码：{row.code}</div> : null}
                        {row.details ? <div className="text-student-muted">详细信息：{localizeImportDetails(row.details)}</div> : null}
                        {row.hint ? <div className="text-student-muted">建议：{localizeImportHint(row.hint)}</div> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}

      {rows.length > 0 ? (
        <section className="teacher-card p-6">
          <h2 className="text-xl font-bold text-student-text">题目预览</h2>
          <div className="mt-4 overflow-x-auto rounded-xl border border-student-border">
            <table className="w-full min-w-[760px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-student-border bg-student-primary-soft/45 text-student-muted">
                  {getPreviewColumns(questionType).map((column) => (
                    <th className="px-4 py-3" key={column.field}>{column.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 10).map((row, index) => (
                  <tr className="border-b border-student-border transition last:border-0 hover:bg-student-primary-soft/35" key={`${row.question_id}-${index}`}>
                    {getPreviewColumns(questionType).map((column) => (
                      <td className="max-w-md px-4 py-3" key={column.field}>
                        {row[column.field]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function getPreviewColumns(questionType: QuestionType) {
  if (questionType === "email") {
    return [
      { field: "question_id", label: "题目 ID" },
      { field: "set_title", label: "套题" },
      { field: "scenario", label: "情境" },
      { field: "subject", label: "主题" }
    ];
  }

  if (questionType === "academic_discussion") {
    return [
      { field: "question_id", label: "题目 ID" },
      { field: "set_title", label: "套题" },
      { field: "professor_name", label: "教授" },
      { field: "professor_prompt", label: "讨论题目" }
    ];
  }

  return [
    { field: "question_order", label: "顺序" },
    { field: "set_title", label: "套题" },
    { field: "prompt", label: "题目" },
    { field: "options_text", label: "选项" }
  ];
}

function formatImportError(payload: ImportErrorPayload) {
  return [
    `错误信息：${localizeImportMessage(payload.message ?? payload.error ?? "导入失败。")}`,
    `错误代码：${payload.code ?? "无"}`,
    `详细信息：${payload.details ? localizeImportDetails(payload.details) : "无"}`,
    `建议：${payload.hint ? localizeImportHint(payload.hint) : "无"}`,
    payload.operation ? `操作：${localizeImportOperation(payload.operation)}` : null,
    payload.batch ? `批次：${localizeImportBatch(payload.batch)}` : null,
    payload.requestUrl ? `请求地址：${payload.requestUrl}` : null,
    payload.requestMethod ? `请求方式：${payload.requestMethod}` : null,
    payload.origin ? `当前来源：${payload.origin}` : null
  ]
    .filter(Boolean)
    .join("\n");
}

function formatImportWarning(warning: NonNullable<ImportResult["warnings"]>[number]) {
  return [
    `警告：${localizeImportMessage(warning.message)}`,
    `错误代码：${warning.code ?? "无"}`,
    `详细信息：${warning.details ? localizeImportDetails(warning.details) : "无"}`,
    `建议：${warning.hint ? localizeImportHint(warning.hint) : "无"}`,
    warning.operation ? `操作：${localizeImportOperation(warning.operation)}` : null
  ]
    .filter(Boolean)
    .join("\n");
}

function localizeImportMessage(message: string) {
  if (/unauthorized|not authenticated/i.test(message)) return "登录状态已失效，请重新登录。";
  if (/invalid import payload/i.test(message)) return "导入请求内容无效。";
  if (/csv headers do not match/i.test(message)) return "CSV 表头与所需模板不匹配。";
  const missingField = message.match(/^Missing (.+)$/i);
  if (missingField) return `缺少字段：${missingField[1]}`;
  if (/question_order must be an integer from 1 to 10/i.test(message)) return "question_order 必须是 1 到 10 之间的整数。";
  if (/blank_count must be a positive integer/i.test(message)) return "blank_count 必须是正整数。";
  if (/question_sets\.set_id appears to be uuid/i.test(message)) return "question_sets.set_id 当前似乎是 uuid 类型，因此无法写入 CSV 中的文本 set_id；题目仍会按文本形式写入 questions.set_id。";
  if (/[\u3400-\u9fff]/.test(message)) return message;
  return "导入过程中发生错误，请根据错误代码排查。";
}

function localizeImportOperation(operation?: string) {
  if (!operation) return undefined;
  const labels: Record<string, string> = {
    "authorize teacher import": "验证教师导入权限",
    "parse import request": "解析导入请求",
    "detect question type": "识别 CSV 题型",
    "validate CSV headers": "校验 CSV 表头",
    "validate row": "校验数据行",
    "validate set_id uniqueness": "校验 set_id 唯一性",
    "read existing question IDs": "读取现有题目 ID",
    "read existing writing question IDs": "读取现有写作题目 ID",
    "read existing writing set IDs": "读取现有写作套题 ID",
    "upsert question_sets": "写入套题数据",
    "upsert questions": "写入题目数据",
    "upsert email questions": "写入 Write an Email 题目",
    "upsert academic discussion questions": "写入 Academic Discussion 题目",
    "import CSV questions": "导入 CSV 题目"
  };
  return labels[operation] ?? (/[\u3400-\u9fff]/.test(operation) ? operation : "执行导入操作");
}

function localizeImportDetails(details: string) {
  if (/Missing fields:/i.test(details)) {
    return details
      .replace(/Missing fields:/i, "缺少字段：")
      .replace(/Unexpected fields:/i, "非预期字段：")
      .replace(/Required header:/i, "所需表头：")
      .replace(/Received header:/i, "收到的表头：")
      .replace(/Closest required header:/i, "最接近的所需表头：")
      .replace(/\bnone\b/gi, "无");
  }
  return /[\u3400-\u9fff]/.test(details) ? details : "请根据错误代码检查数据库配置或数据内容。";
}

function localizeImportHint(hint: string) {
  if (/Use the exact required header names/i.test(hint)) return "请在 CSV 第一行使用完全一致的必填字段名。";
  if (/Use one of the exact supported CSV headers/i.test(hint)) return "请使用任一受支持题型的完整固定表头，并保持规定的列顺序。";
  if (/Run this Supabase SQL/i.test(hint)) return hint.replace(/Run this Supabase SQL[^:]*:/i, "如需调整字段类型，请执行以下 Supabase SQL：");
  if (/If questions\.set_id is also uuid/i.test(hint)) return "如果 questions.set_id 也是 uuid 类型，请将其改为 text；CSV 中的 set_id 应为文本格式。";
  return /[\u3400-\u9fff]/.test(hint) ? hint : "请根据错误代码检查数据库配置或数据内容。";
}

function localizeImportBatch(batch: string) {
  return batch
    .replace(/preflight question_id lookup for (\d+) rows/i, "预检查 $1 行 question_id")
    .replace(/question_sets batch for (\d+) sets/i, "question_sets 批次（$1 套）")
    .replace(/questions batch (\d+)\/(\d+), CSV rows (.+)/i, "题目批次 $1/$2，CSV 行 $3");
}

function ImportStep({
  description,
  icon: Icon,
  title
}: {
  description: string;
  icon: typeof TableProperties;
  title: string;
}) {
  return (
    <div className="flex items-center gap-4 md:border-r md:border-student-primary-border md:last:border-r-0">
      <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white text-student-primary">
        <Icon aria-hidden="true" size={23} strokeWidth={1.9} />
      </span>
      <div>
        <p className="font-bold text-student-text">{title}</p>
        <p className="mt-1 text-xs leading-5 text-student-muted">{description}</p>
      </div>
    </div>
  );
}

function ResultMetric({ label, tone, value }: { label: string; tone?: "error"; value: number }) {
  return (
    <div className={tone === "error" ? "rounded-xl border border-student-error-border bg-student-error-soft p-4" : "rounded-xl border border-student-primary-border bg-student-primary-soft p-4"}>
      <p className={tone === "error" ? "text-sm font-semibold text-student-error" : "text-sm font-semibold text-student-primary"}>{label}</p>
      <p className={tone === "error" ? "mt-1 text-2xl font-bold text-student-error" : "mt-1 text-2xl font-bold text-student-text"}>{value}</p>
    </div>
  );
}
