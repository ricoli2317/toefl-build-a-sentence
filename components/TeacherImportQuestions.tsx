"use client";

import { ChangeEvent, DragEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ClipboardCheck, FileSearch, TableProperties, Upload } from "lucide-react";
import { parseCsv, type CsvRecord } from "@/lib/csv";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { broadcastQuestionBankUpdated } from "@/lib/questionBankCacheEvents";
import {
  TEACHER_ACCESS_CACHE_KEY,
  TEACHER_QUESTION_BANK_CACHE_PREFIX,
  TEACHER_STATS_CACHE_KEY,
  useTeacherDataCache
} from "@/components/TeacherDataCache";

const REQUIRED_FIELDS = [
  "question_id",
  "set_id",
  "set_title",
  "question_order",
  "prompt",
  "sentence_template",
  "blank_count",
  "options_text",
  "correct_order_text",
  "distractors_text",
  "final_sentence",
  "grammar_tags_text"
];

type ImportResult = {
  success?: boolean;
  successCount: number;
  insertedCount: number;
  updatedCount: number;
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

  const missingFields = REQUIRED_FIELDS.filter((field) =>
    rows.length === 0 ? false : !(field in rows[0])
  );
  const unexpectedFields =
    rows.length === 0
      ? []
      : Object.keys(rows[0]).filter((field) => !REQUIRED_FIELDS.includes(field));

  async function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) await readFile(file);
  }

  async function readFile(file: File) {
    setResult(null);
    setError("");
    setRows([]);

    if (!file.name.toLocaleLowerCase().endsWith(".csv")) {
      setFileName(file.name);
      setError("请选择 .csv 文件。");
      return;
    }

    setFileName(file.name);
    const text = await file.text();
    const parsedRows = parseCsv(text);
    setRows(parsedRows);

    if (parsedRows.length === 0) {
      setError("CSV has no data rows.");
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
      setError("Please choose a CSV file first.");
      setLoading(false);
      return;
    }

    if (missingFields.length > 0 || unexpectedFields.length > 0) {
      setError(
        `CSV headers do not match. Missing: ${missingFields.join(", ") || "none"}. Unexpected: ${
          unexpectedFields.join(", ") || "none"
        }.`
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
        body: JSON.stringify({ rows })
      });

      const responseText = await response.text();
      let payload: ImportResult | ImportErrorPayload;
      try {
        payload = responseText
          ? JSON.parse(responseText)
          : { error: "The import API returned an empty response." };
      } catch {
        payload = {
          error: "The import API returned invalid JSON.",
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
        error: error instanceof Error ? error.message : "Import failed before the server returned a response.",
        origin,
        requestMethod,
        requestUrl
      }));
    } finally {
      setLoading(false);
    }
  }

  if (checkingRole) {
    return <p className="teacher-loading">正在检查教师权限...</p>;
  }

  return (
    <div className="grid gap-5">
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
              onClick={() => fileInputRef.current?.click()}
              type="button"
            >
              选择文件
            </button>
            {fileName ? (
              <p className="mt-4 rounded-full bg-white px-4 py-1.5 text-sm font-semibold text-student-primary shadow-sm">
                {fileName}
              </p>
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
              disabled={loading || rows.length === 0 || missingFields.length > 0 || unexpectedFields.length > 0}
              onClick={importRows}
              type="button"
            >
              {loading ? "正在导入..." : "开始导入"}
            </button>
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
          {error ? <pre className="teacher-error mt-4 whitespace-pre-wrap">{error}</pre> : null}
        </div>
      </section>

      {result ? (
        <section className="teacher-card p-6">
          <h2 className="text-xl font-bold text-student-text">导入结果</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <ResultMetric label="成功" value={result.successCount} />
            <ResultMetric label="更新" value={result.updatedCount} />
            <ResultMetric label="失败" tone="error" value={result.failedCount} />
          </div>
          <p className="mt-3 text-sm text-student-muted">
            新增题目：{result.insertedCount}
          </p>
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
              <table className="w-full min-w-[620px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-student-border bg-student-primary-soft/45 text-student-muted">
                    <th className="px-4 py-3">CSV 行</th>
                    <th className="px-4 py-3">题目 ID</th>
                    <th className="px-4 py-3">操作</th>
                    <th className="px-4 py-3">原因</th>
                  </tr>
                </thead>
                <tbody>
                  {result.failedRows.map((row) => (
                    <tr className="border-b border-student-border last:border-0" key={`${row.rowNumber}-${row.questionId}`}>
                      <td className="px-4 py-3">{row.rowNumber}</td>
                      <td className="px-4 py-3">{row.questionId || "N/A"}</td>
                      <td className="px-4 py-3">{row.operation ?? "N/A"}</td>
                      <td className="px-4 py-3">
                        <div>{row.reason}</div>
                        {row.code ? <div className="text-student-muted">Code: {row.code}</div> : null}
                        {row.details ? <div className="text-student-muted">Details: {row.details}</div> : null}
                        {row.hint ? <div className="text-student-muted">Hint: {row.hint}</div> : null}
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
                  <th className="px-4 py-3">顺序</th>
                  <th className="px-4 py-3">套题</th>
                  <th className="px-4 py-3">题目</th>
                  <th className="px-4 py-3">选项</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 10).map((row, index) => (
                  <tr className="border-b border-student-border transition last:border-0 hover:bg-student-primary-soft/35" key={`${row.question_id}-${index}`}>
                    <td className="px-4 py-3">{row.question_order}</td>
                    <td className="px-4 py-3 font-semibold">{row.set_title}</td>
                    <td className="px-4 py-3">{row.prompt}</td>
                    <td className="px-4 py-3">{row.options_text}</td>
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

function formatImportError(payload: ImportErrorPayload) {
  return [
    `Message: ${payload.message ?? payload.error ?? "Import failed."}`,
    `Code: ${payload.code ?? "N/A"}`,
    `Details: ${payload.details ?? "N/A"}`,
    `Hint: ${payload.hint ?? "N/A"}`,
    payload.operation ? `Operation: ${payload.operation}` : null,
    payload.batch ? `Batch: ${payload.batch}` : null,
    payload.requestUrl ? `Request URL: ${payload.requestUrl}` : null,
    payload.requestMethod ? `Request method: ${payload.requestMethod}` : null,
    payload.origin ? `Current origin: ${payload.origin}` : null
  ]
    .filter(Boolean)
    .join("\n");
}

function formatImportWarning(warning: NonNullable<ImportResult["warnings"]>[number]) {
  return [
    `Warning: ${warning.message}`,
    `Code: ${warning.code ?? "N/A"}`,
    `Details: ${warning.details ?? "N/A"}`,
    `Hint: ${warning.hint ?? "N/A"}`,
    warning.operation ? `Operation: ${warning.operation}` : null
  ]
    .filter(Boolean)
    .join("\n");
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
