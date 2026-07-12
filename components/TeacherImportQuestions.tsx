"use client";

import Link from "next/link";
import { ChangeEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { parseCsv, type CsvRecord } from "@/lib/csv";
import { createBrowserSupabase } from "@/lib/supabase/client";
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
    setResult(null);
    setError("");
    setRows([]);

    if (!file) return;

    setFileName(file.name);
    const text = await file.text();
    const parsedRows = parseCsv(text);
    setRows(parsedRows);

    if (parsedRows.length === 0) {
      setError("CSV has no data rows.");
    }
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
    return <p className="text-sm text-ink/70">Checking teacher access...</p>;
  }

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link className="text-sm font-semibold text-ocean hover:text-ink" href="/teacher/dashboard">
          Back to dashboard
        </Link>
      </div>

      <section className="rounded-lg border border-line bg-white p-5 shadow-sm">
        <label className="block text-sm font-semibold" htmlFor="csv-file">
          CSV file
        </label>
        <input
          accept=".csv,text/csv"
          className="mt-3 w-full rounded-md border border-line bg-white px-3 py-2"
          id="csv-file"
          onChange={onFileChange}
          type="file"
        />
        {fileName ? <p className="mt-3 text-sm text-ink/70">{fileName}</p> : null}

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            className="rounded-md bg-ink px-4 py-2 font-semibold text-white hover:bg-ocean disabled:cursor-not-allowed disabled:opacity-60"
            disabled={loading || rows.length === 0}
            onClick={importRows}
            type="button"
          >
            {loading ? "Importing..." : "Import questions"}
          </button>
          {rows.length > 0 ? (
            <span className="text-sm font-semibold text-ocean">{rows.length} rows detected</span>
          ) : null}
        </div>

        {missingFields.length > 0 ? (
          <p className="mt-4 text-sm font-semibold text-coral">
            Missing fields: {missingFields.join(", ")}
          </p>
        ) : null}
        {unexpectedFields.length > 0 ? (
          <p className="mt-4 text-sm font-semibold text-coral">
            Unexpected fields: {unexpectedFields.join(", ")}
          </p>
        ) : null}
        {error ? (
          <pre className="mt-4 whitespace-pre-wrap rounded-md border border-coral bg-coral/10 p-3 text-sm font-semibold text-coral">
            {error}
          </pre>
        ) : null}
      </section>

      {result ? (
        <section className="rounded-lg border border-line bg-white p-5 shadow-sm">
          <h2 className="text-xl font-bold">Import result</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <ResultMetric label="Success" value={result.successCount} />
            <ResultMetric label="Updated" value={result.updatedCount} />
            <ResultMetric label="Failed" value={result.failedCount} />
          </div>
          <p className="mt-3 text-sm text-ink/60">
            New questions: {result.insertedCount}
          </p>
          {result.warnings && result.warnings.length > 0 ? (
            <div className="mt-5 grid gap-3">
              {result.warnings.map((warning, index) => (
                <pre
                  className="whitespace-pre-wrap rounded-md border border-gold bg-gold/10 p-3 text-sm font-semibold text-ink"
                  key={`${warning.operation ?? "warning"}-${index}`}
                >
                  {formatImportWarning(warning)}
                </pre>
              ))}
            </div>
          ) : null}
          {result.failedRows.length > 0 ? (
            <div className="mt-5 overflow-x-auto">
              <table className="w-full min-w-[620px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-line text-ink/60">
                    <th className="py-2 pr-3">CSV row</th>
                    <th className="py-2 pr-3">Question ID</th>
                    <th className="py-2 pr-3">Operation</th>
                    <th className="py-2 pr-3">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {result.failedRows.map((row) => (
                    <tr className="border-b border-line last:border-0" key={`${row.rowNumber}-${row.questionId}`}>
                      <td className="py-3 pr-3">{row.rowNumber}</td>
                      <td className="py-3 pr-3">{row.questionId || "N/A"}</td>
                      <td className="py-3 pr-3">{row.operation ?? "N/A"}</td>
                      <td className="py-3 pr-3">
                        <div>{row.reason}</div>
                        {row.code ? <div className="text-ink/60">Code: {row.code}</div> : null}
                        {row.details ? <div className="text-ink/60">Details: {row.details}</div> : null}
                        {row.hint ? <div className="text-ink/60">Hint: {row.hint}</div> : null}
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
        <section className="rounded-lg border border-line bg-white p-5 shadow-sm">
          <h2 className="text-xl font-bold">Preview</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-line text-ink/60">
                  <th className="py-2 pr-3">Order</th>
                  <th className="py-2 pr-3">Set</th>
                  <th className="py-2 pr-3">Prompt</th>
                  <th className="py-2 pr-3">Options</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 10).map((row, index) => (
                  <tr className="border-b border-line last:border-0" key={`${row.question_id}-${index}`}>
                    <td className="py-3 pr-3">{row.question_order}</td>
                    <td className="py-3 pr-3 font-semibold">{row.set_title}</td>
                    <td className="py-3 pr-3">{row.prompt}</td>
                    <td className="py-3 pr-3">{row.options_text}</td>
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

function ResultMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-line bg-paper p-4">
      <p className="text-sm font-semibold text-ink/60">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}
