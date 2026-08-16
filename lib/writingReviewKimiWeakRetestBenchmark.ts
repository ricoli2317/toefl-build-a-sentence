import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenRouterTokenUsage } from "./openrouterWritingReview.ts";
import {
  runWritingReviewKimiBenchmarkCases,
  WRITING_REVIEW_KIMI_CURRENT_CASES,
  type WritingReviewKimiCurrentDependencies,
  type WritingReviewKimiCurrentInput,
  type WritingReviewKimiCurrentResult
} from "./writingReviewKimiCurrentBenchmark.ts";

export const WRITING_REVIEW_KIMI_WEAK_RETEST_CASES = [
  WRITING_REVIEW_KIMI_CURRENT_CASES[1],
  WRITING_REVIEW_KIMI_CURRENT_CASES[3]
] as const;
export const WRITING_REVIEW_KIMI_WEAK_RETEST_MODEL =
  "moonshotai/kimi-k3" as const;
export const WRITING_REVIEW_KIMI_WEAK_RETEST_PROVIDER = "openrouter" as const;
export const WRITING_REVIEW_KIMI_WEAK_RETEST_EFFORT = "high" as const;
export const WRITING_REVIEW_KIMI_WEAK_RETEST_OPERATION =
  "kimi_weak_retest_benchmark" as const;
export const WRITING_REVIEW_KIMI_WEAK_RETEST_TIMEOUT_MS = 240_000;
export const WRITING_REVIEW_KIMI_WEAK_RETEST_OUTPUT_DIR =
  "tmp/writing-review-kimi-weak-retest";
export const WRITING_REVIEW_KIMI_WEAK_RETEST_HISTORICAL_DIR =
  "tmp/writing-review-reasoning-stability";
export const WRITING_REVIEW_KIMI_WEAK_RETEST_ROUND1_DIR =
  "tmp/writing-review-kimi-current-prompt";

type WeakCase = (typeof WRITING_REVIEW_KIMI_WEAK_RETEST_CASES)[number];
export type WritingReviewKimiWeakRetestCaseLabel = WeakCase["case_label"];
export type WritingReviewKimiWeakRetestInput = WritingReviewKimiCurrentInput & {
  caseLabel: WritingReviewKimiWeakRetestCaseLabel;
};
export type WritingReviewKimiWeakRetestResult = Omit<
  WritingReviewKimiCurrentResult,
  "operation"
> & {
  operation: typeof WRITING_REVIEW_KIMI_WEAK_RETEST_OPERATION;
};

type StoredRun = OpenRouterTokenUsage & {
  case_label: WritingReviewKimiWeakRetestCaseLabel;
  attempt_id: string;
  task_type: WeakCase["task_type"];
  run: "historical" | "current_prompt_round1";
  result: string;
  schema_valid: boolean;
  elapsed_ms: number | null;
  official_score: number | null;
  dimension_scores: Record<string, number> | null;
  language_edit_count: number | null;
  content_feedback_count: number | null;
  content_feedback_categories: Record<string, number>;
  overall_feedback: string | null;
  raw_official_score: number | null;
  raw_dimension_scores: Record<string, number> | null;
  raw_language_edit_count: number | null;
  raw_content_feedback_count: number | null;
  raw_content_feedback_categories: Record<string, number>;
  localization_issue_count: number;
};

type ResultSummary = Pick<
  WritingReviewKimiWeakRetestResult,
  | "case_label"
  | "attempt_id"
  | "task_type"
  | "result"
  | "schema_valid"
  | "elapsed_ms"
  | "prompt_tokens"
  | "cached_tokens"
  | "completion_tokens"
  | "reasoning_tokens"
  | "total_tokens"
  | "cost"
  | "official_score"
  | "dimension_scores"
  | "language_edit_count"
  | "content_feedback_count"
  | "content_feedback_categories"
  | "overall_feedback"
  | "localization_issue_count"
> & {
  historical_result: string | null;
  current_prompt_round1_result: string | null;
  retest_result: WritingReviewKimiWeakRetestResult["result"];
};

export type WritingReviewKimiWeakRetestSummary = {
  provider: typeof WRITING_REVIEW_KIMI_WEAK_RETEST_PROVIDER;
  model: typeof WRITING_REVIEW_KIMI_WEAK_RETEST_MODEL;
  reasoning_effort: typeof WRITING_REVIEW_KIMI_WEAK_RETEST_EFFORT;
  timeout_ms: typeof WRITING_REVIEW_KIMI_WEAK_RETEST_TIMEOUT_MS;
  retry: 0;
  cases: ResultSummary[];
  email_weak_timeout_count: number;
  ad_weak_timeout_count: number;
  email_weak_timeout_reproduced_again: boolean;
  ad_weak_timeout_reproduced_again: boolean;
};

export async function benchmarkWritingReviewKimiWeakRetest(
  inputs: WritingReviewKimiWeakRetestInput[],
  dependencies: WritingReviewKimiCurrentDependencies
): Promise<WritingReviewKimiWeakRetestResult[]> {
  const results = await runWritingReviewKimiBenchmarkCases(
    inputs,
    WRITING_REVIEW_KIMI_WEAK_RETEST_CASES,
    {
      ...dependencies,
      timeoutMs: WRITING_REVIEW_KIMI_WEAK_RETEST_TIMEOUT_MS
    }
  );
  return results.map((result) => ({
    ...result,
    operation: WRITING_REVIEW_KIMI_WEAK_RETEST_OPERATION
  }));
}

export function readWritingReviewKimiWeakStoredRun(
  benchmarkCase: WeakCase,
  run: StoredRun["run"],
  filePath: string,
  readFile: typeof readFileSync = readFileSync
): StoredRun | null {
  try {
    const value = JSON.parse(readFile(filePath, "utf8")) as unknown;
    if (!isRecord(value)) return null;
    if (
      value.case_label !== benchmarkCase.case_label ||
      value.attempt_id !== benchmarkCase.attempt_id ||
      value.task_type !== benchmarkCase.task_type ||
      value.model !== WRITING_REVIEW_KIMI_WEAK_RETEST_MODEL ||
      value.reasoning_effort !== WRITING_REVIEW_KIMI_WEAK_RETEST_EFFORT
    ) {
      return null;
    }
    return {
      case_label: benchmarkCase.case_label,
      attempt_id: benchmarkCase.attempt_id,
      task_type: benchmarkCase.task_type,
      run,
      result: readString(value.result) ?? "unknown",
      schema_valid: value.schema_valid === true,
      elapsed_ms: readNumber(value.elapsed_ms),
      ...readUsage(value),
      official_score: readNumber(value.official_score),
      dimension_scores: readNumberRecord(value.dimension_scores),
      language_edit_count: readNumber(value.language_edit_count),
      content_feedback_count: readNumber(value.content_feedback_count),
      content_feedback_categories:
        readNumberRecord(value.content_feedback_categories) ?? {},
      overall_feedback: readString(value.overall_feedback),
      raw_official_score: readNumber(value.raw_official_score),
      raw_dimension_scores: readNumberRecord(value.raw_dimension_scores),
      raw_language_edit_count: readNumber(value.raw_language_edit_count),
      raw_content_feedback_count: readNumber(value.raw_content_feedback_count),
      raw_content_feedback_categories:
        readNumberRecord(value.raw_content_feedback_categories) ?? {},
      localization_issue_count:
        readNumber(value.localization_issue_count) ?? 0
    };
  } catch {
    return null;
  }
}

export function buildWritingReviewKimiWeakRetestSummary(
  results: WritingReviewKimiWeakRetestResult[],
  historical: Array<StoredRun | null>,
  round1: Array<StoredRun | null>
): WritingReviewKimiWeakRetestSummary {
  assertAligned(results, historical, round1);
  const statuses = (index: number) => [
    historical[index]?.result ?? null,
    round1[index]?.result ?? null,
    results[index].result
  ];
  return {
    provider: WRITING_REVIEW_KIMI_WEAK_RETEST_PROVIDER,
    model: WRITING_REVIEW_KIMI_WEAK_RETEST_MODEL,
    reasoning_effort: WRITING_REVIEW_KIMI_WEAK_RETEST_EFFORT,
    timeout_ms: WRITING_REVIEW_KIMI_WEAK_RETEST_TIMEOUT_MS,
    retry: 0,
    cases: results.map((result, index) => ({
      case_label: result.case_label,
      attempt_id: result.attempt_id,
      task_type: result.task_type,
      result: result.result,
      schema_valid: result.schema_valid,
      elapsed_ms: result.elapsed_ms,
      prompt_tokens: result.prompt_tokens,
      cached_tokens: result.cached_tokens,
      completion_tokens: result.completion_tokens,
      reasoning_tokens: result.reasoning_tokens,
      total_tokens: result.total_tokens,
      cost: result.cost,
      official_score: result.official_score ?? result.raw_official_score,
      dimension_scores:
        result.dimension_scores ?? result.raw_dimension_scores,
      language_edit_count:
        result.language_edit_count ?? result.raw_language_edit_count,
      content_feedback_count:
        result.content_feedback_count ?? result.raw_content_feedback_count,
      content_feedback_categories:
        result.result === "localization_error"
          ? result.raw_content_feedback_categories
          : result.content_feedback_categories,
      overall_feedback:
        result.overall_feedback ??
        result.validated_raw_result?.overall_feedback ??
        null,
      localization_issue_count: result.localization_issue_count,
      historical_result: historical[index]?.result ?? null,
      current_prompt_round1_result: round1[index]?.result ?? null,
      retest_result: result.result
    })),
    email_weak_timeout_count: countTimeouts(statuses(0)),
    ad_weak_timeout_count: countTimeouts(statuses(1)),
    email_weak_timeout_reproduced_again: results[0].result === "timeout",
    ad_weak_timeout_reproduced_again: results[1].result === "timeout"
  };
}

export function writeWritingReviewKimiWeakRetestFiles(
  outputDir: string,
  results: WritingReviewKimiWeakRetestResult[],
  historical: Array<StoredRun | null>,
  round1: Array<StoredRun | null>,
  fileSystem: {
    mkdirSync: typeof mkdirSync;
    writeFileSync: typeof writeFileSync;
  } = { mkdirSync, writeFileSync }
) {
  assertAligned(results, historical, round1);
  fileSystem.mkdirSync(outputDir, { recursive: true });
  results.forEach((result) => {
    fileSystem.writeFileSync(
      join(outputDir, `${result.case_label.replace("_", "-")}.json`),
      `${JSON.stringify(result, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  });
  const summary = buildWritingReviewKimiWeakRetestSummary(
    results,
    historical,
    round1
  );
  fileSystem.writeFileSync(
    join(outputDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  fileSystem.writeFileSync(
    join(outputDir, "comparison.md"),
    buildWritingReviewKimiWeakRetestMarkdown(results, historical, round1),
    { encoding: "utf8", mode: 0o600 }
  );
  return summary;
}

export function buildWritingReviewKimiWeakRetestMarkdown(
  results: WritingReviewKimiWeakRetestResult[],
  historical: Array<StoredRun | null>,
  round1: Array<StoredRun | null>
) {
  const summary = buildWritingReviewKimiWeakRetestSummary(
    results,
    historical,
    round1
  );
  const lines = [
    "# Kimi K3 High — Weak Case Retest",
    "",
    "| Case | Run | Result | Time | Reasoning | Total | Cost | Score | Edits | Feedback |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  ];
  results.forEach((result, index) => {
    lines.push(
      tableRow(result.case_label, "Historical", historical[index]),
      tableRow(result.case_label, "Current Prompt Round 1", round1[index]),
      tableRow(result.case_label, "Current Prompt Retest", result)
    );
  });

  results.forEach((result, index) => {
    const old = historical[index];
    const first = round1[index];
    lines.push(
      "",
      `## ${result.case_label}`,
      "",
      `- Historical result: ${old?.result ?? "unavailable"}`,
      `- Current Prompt Round 1 result: ${first?.result ?? "unavailable"}`,
      `- Current Prompt Retest result: ${result.result}`,
      `- Timeout count across three runs: ${index === 0 ? summary.email_weak_timeout_count : summary.ad_weak_timeout_count}`
    );
    if (result.case_label === "email_weak") {
      lines.push(
        `- 第三次仍 timeout: ${result.result === "timeout"}`,
        `- Retest reasoning tokens: ${display(result.reasoning_tokens)}`,
        "- 是否出现异常长 reasoning：人工判断（仅展示事实，不解释 timeout 根因）"
      );
    } else {
      lines.push(
        `- Historical elapsed: ${display(old?.elapsed_ms ?? null)} ms`,
        `- Current Prompt Round 1 was timeout: ${first?.result === "timeout"}`,
        `- Retest success or timeout: ${result.result}`
      );
    }
    lines.push(
      "",
      "### Score / Edits / Feedback / Performance",
      "",
      "| Run | Score | Dimensions | Edits | Feedback | Categories | Reasoning | Cost |",
      "| --- | ---: | --- | ---: | ---: | --- | ---: | ---: |",
      detailRow("Historical", old),
      detailRow("Current Prompt Round 1", first),
      detailRow("Current Prompt Retest", result),
      "",
      "### Retest Feedback Content",
      "",
      ...formatRetestFeedback(result),
      "",
      `- Overall feedback: ${escapeInline(result.overall_feedback ?? result.validated_raw_result?.overall_feedback ?? "—")}`
    );
  });
  return `${lines.join("\n")}\n`;
}

function assertAligned(
  results: WritingReviewKimiWeakRetestResult[],
  historical: Array<StoredRun | null>,
  round1: Array<StoredRun | null>
) {
  if (results.length !== 2 || historical.length !== 2 || round1.length !== 2) {
    throw new Error("Weak retest output requires two aligned case slots.");
  }
  WRITING_REVIEW_KIMI_WEAK_RETEST_CASES.forEach((expected, index) => {
    if (
      results[index].case_label !== expected.case_label ||
      results[index].attempt_id !== expected.attempt_id ||
      (historical[index] &&
        historical[index]?.case_label !== expected.case_label) ||
      (round1[index] && round1[index]?.case_label !== expected.case_label)
    ) {
      throw new Error(`Unexpected weak retest case at position ${index + 1}.`);
    }
  });
}

function countTimeouts(results: Array<string | null>) {
  return results.filter((result) => result === "timeout").length;
}

function tableRow(
  caseLabel: string,
  run: string,
  value: StoredRun | WritingReviewKimiWeakRetestResult | null
) {
  const comparable = comparableFields(value);
  return `| ${caseLabel} | ${run} | ${value?.result ?? "unavailable"} | ${display(value?.elapsed_ms ?? null)} | ${display(value?.reasoning_tokens ?? null)} | ${display(value?.total_tokens ?? null)} | ${display(value?.cost ?? null)} | ${display(comparable.score)} | ${display(comparable.edits)} | ${display(comparable.feedback)} |`;
}

function detailRow(
  run: string,
  value: StoredRun | WritingReviewKimiWeakRetestResult | null
) {
  const comparable = comparableFields(value);
  return `| ${run} | ${display(comparable.score)} | ${formatRecord(comparable.dimensions)} | ${display(comparable.edits)} | ${display(comparable.feedback)} | ${formatRecord(comparable.categories)} | ${display(value?.reasoning_tokens ?? null)} | ${display(value?.cost ?? null)} |`;
}

function comparableFields(
  value: StoredRun | WritingReviewKimiWeakRetestResult | null
) {
  if (!value) {
    return {
      score: null,
      dimensions: null,
      edits: null,
      feedback: null,
      categories: {}
    };
  }
  const raw = "raw_official_score" in value;
  return {
    score: value.official_score ?? (raw ? value.raw_official_score : null),
    dimensions:
      value.dimension_scores ?? (raw ? value.raw_dimension_scores : null),
    edits:
      value.language_edit_count ??
      (raw ? value.raw_language_edit_count : null),
    feedback:
      value.content_feedback_count ??
      (raw ? value.raw_content_feedback_count : null),
    categories:
      value.result === "localization_error" && raw
        ? value.raw_content_feedback_categories
        : value.content_feedback_categories
  };
}

function formatRetestFeedback(result: WritingReviewKimiWeakRetestResult) {
  const feedback =
    result.content_feedback ?? result.validated_raw_result?.content_feedback ?? [];
  return feedback.length === 0
    ? ["- —"]
    : feedback.map(
        (item) =>
          `- **${escapeInline(item.category)}** — ${escapeInline(item.issue)} — ${escapeInline(item.suggestion)} — Proposed: \`${escapeInline(item.proposed_revision)}\``
      );
}

function readUsage(value: Record<string, unknown>): OpenRouterTokenUsage {
  return {
    prompt_tokens: readNumber(value.prompt_tokens),
    cached_tokens: readNumber(value.cached_tokens),
    completion_tokens: readNumber(value.completion_tokens),
    reasoning_tokens: readNumber(value.reasoning_tokens),
    accepted_prediction_tokens: readNumber(value.accepted_prediction_tokens),
    rejected_prediction_tokens: readNumber(value.rejected_prediction_tokens),
    total_tokens: readNumber(value.total_tokens),
    cost: readNumber(value.cost),
    upstream_inference_cost: readNumber(value.upstream_inference_cost),
    upstream_inference_prompt_cost: readNumber(
      value.upstream_inference_prompt_cost
    ),
    upstream_inference_completions_cost: readNumber(
      value.upstream_inference_completions_cost
    )
  };
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function readNumberRecord(value: unknown) {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.some(([, item]) => readNumber(item) === null)) return null;
  return Object.fromEntries(entries) as Record<string, number>;
}

function formatRecord(value: Record<string, number> | null) {
  if (!value || Object.keys(value).length === 0) return "—";
  return Object.entries(value)
    .map(([key, number]) => `${escapeInline(key)}: ${number}`)
    .join(", ");
}

function display(value: number | null) {
  return value === null ? "—" : String(value);
}

function escapeInline(value: string) {
  return value.replace(/\s+/g, " ").replace(/`/g, "\\`").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
