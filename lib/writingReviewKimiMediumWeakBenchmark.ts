import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenRouterTokenUsage } from "./openrouterWritingReview.ts";
import {
  runWritingReviewKimiBenchmarkCases,
  type WritingReviewKimiCurrentDependencies,
  type WritingReviewKimiCurrentInput,
  type WritingReviewKimiCurrentResult
} from "./writingReviewKimiCurrentBenchmark.ts";
import { WRITING_REVIEW_KIMI_WEAK_RETEST_CASES } from "./writingReviewKimiWeakRetestBenchmark.ts";
import type {
  AIReviewRawResultV22,
  RawContentFeedbackV22
} from "./writingReviewSchemaV22.ts";

export const WRITING_REVIEW_KIMI_MEDIUM_WEAK_CASES =
  WRITING_REVIEW_KIMI_WEAK_RETEST_CASES;
export const WRITING_REVIEW_KIMI_MEDIUM_WEAK_MODEL =
  "moonshotai/kimi-k3" as const;
export const WRITING_REVIEW_KIMI_MEDIUM_WEAK_PROVIDER = "openrouter" as const;
export const WRITING_REVIEW_KIMI_MEDIUM_WEAK_EFFORT = "medium" as const;
export const WRITING_REVIEW_KIMI_MEDIUM_WEAK_OPERATION =
  "kimi_medium_weak_benchmark" as const;
export const WRITING_REVIEW_KIMI_MEDIUM_WEAK_TIMEOUT_MS = 240_000;
export const WRITING_REVIEW_KIMI_MEDIUM_WEAK_RETRY = 0 as const;
export const WRITING_REVIEW_KIMI_MEDIUM_WEAK_OUTPUT_DIR =
  "tmp/writing-review-kimi-medium-weak";
export const WRITING_REVIEW_KIMI_MEDIUM_WEAK_HIGH_DIR =
  "tmp/writing-review-kimi-weak-retest";

type WeakCase = (typeof WRITING_REVIEW_KIMI_MEDIUM_WEAK_CASES)[number];
type CaseLabel = WeakCase["case_label"];
type ScoreMap = Record<string, number>;
type CategoryCounts = Record<string, number>;
type ComparableEdit = Pick<
  AIReviewRawResultV22["language_edits"][number],
  "original_text" | "replacement_text"
>;

export type WritingReviewKimiMediumWeakInput = WritingReviewKimiCurrentInput & {
  caseLabel: CaseLabel;
};

export type WritingReviewKimiMediumWeakResult = Omit<
  WritingReviewKimiCurrentResult,
  "case_label" | "reasoning_effort" | "operation"
> & {
  case_label: CaseLabel;
  reasoning_effort: typeof WRITING_REVIEW_KIMI_MEDIUM_WEAK_EFFORT;
  operation: typeof WRITING_REVIEW_KIMI_MEDIUM_WEAK_OPERATION;
  localization_valid: boolean | null;
};

export type WritingReviewKimiMediumWeakHighResult = OpenRouterTokenUsage & {
  case_label: CaseLabel;
  attempt_id: string;
  task_type: WeakCase["task_type"];
  provider: typeof WRITING_REVIEW_KIMI_MEDIUM_WEAK_PROVIDER;
  model: typeof WRITING_REVIEW_KIMI_MEDIUM_WEAK_MODEL;
  reasoning_effort: "high";
  result: "success";
  elapsed_ms: number;
  schema_valid: true;
  localization_valid: true;
  official_score: number;
  dimension_scores: ScoreMap;
  language_edits: ComparableEdit[];
  content_feedback: RawContentFeedbackV22[];
  language_edit_count: number;
  content_feedback_count: number;
  content_feedback_categories: CategoryCounts;
  overall_feedback: string;
};

type ComparableResult = {
  result: string;
  elapsed_ms: number | null;
  reasoning_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cost: number | null;
  schema_valid: boolean;
  localization_valid: boolean | null;
  official_score: number | null;
  dimension_scores: ScoreMap | null;
  language_edit_count: number | null;
  content_feedback_count: number | null;
  content_feedback_categories: CategoryCounts;
  overall_feedback: string | null;
};

export type WritingReviewKimiMediumWeakComparison = {
  case_label: CaseLabel;
  attempt_id: string;
  high: ComparableResult;
  medium: ComparableResult;
  elapsed_delta_medium_minus_high: number | null;
  reasoning_delta: number | null;
  total_tokens_delta: number | null;
  cost_delta: number | null;
  official_score_delta: number | null;
  dimension_score_deltas: Record<string, number | null>;
  language_edit_count_delta: number | null;
  content_feedback_count_delta: number | null;
  shared_language_edits: ComparableEdit[];
  high_only_language_edits: ComparableEdit[];
  medium_only_language_edits: ComparableEdit[];
};

export type WritingReviewKimiMediumWeakSummary = {
  provider: typeof WRITING_REVIEW_KIMI_MEDIUM_WEAK_PROVIDER;
  model: typeof WRITING_REVIEW_KIMI_MEDIUM_WEAK_MODEL;
  reasoning_effort: typeof WRITING_REVIEW_KIMI_MEDIUM_WEAK_EFFORT;
  timeout_ms: typeof WRITING_REVIEW_KIMI_MEDIUM_WEAK_TIMEOUT_MS;
  retry: typeof WRITING_REVIEW_KIMI_MEDIUM_WEAK_RETRY;
  high_source_directory: typeof WRITING_REVIEW_KIMI_MEDIUM_WEAK_HIGH_DIR;
  high_recalled: false;
  cases: WritingReviewKimiMediumWeakComparison[];
  medium_success_count: number;
  medium_timeout_count: number;
  avg_medium_elapsed_ms: number | null;
  avg_medium_reasoning_tokens: number | null;
  avg_medium_total_tokens: number | null;
  avg_medium_cost: number | null;
};

export async function benchmarkWritingReviewKimiMediumWeak(
  inputs: WritingReviewKimiMediumWeakInput[],
  dependencies: WritingReviewKimiCurrentDependencies
): Promise<WritingReviewKimiMediumWeakResult[]> {
  const results = await runWritingReviewKimiBenchmarkCases(
    inputs,
    WRITING_REVIEW_KIMI_MEDIUM_WEAK_CASES,
    {
      ...dependencies,
      timeoutMs: WRITING_REVIEW_KIMI_MEDIUM_WEAK_TIMEOUT_MS
    }
  );
  return results.map((result) => {
    const {
      reasoning_effort: _reasoningEffort,
      operation: _operation,
      ...fields
    } = result;
    return {
      ...fields,
      case_label: result.case_label as CaseLabel,
      reasoning_effort: WRITING_REVIEW_KIMI_MEDIUM_WEAK_EFFORT,
      operation: WRITING_REVIEW_KIMI_MEDIUM_WEAK_OPERATION,
      localization_valid:
        result.result === "success"
          ? true
          : result.result === "localization_error"
            ? false
            : null
    };
  });
}

export function readWritingReviewKimiMediumWeakHighResult(
  benchmarkCase: WeakCase,
  filePath: string,
  readFile: typeof readFileSync = readFileSync
): WritingReviewKimiMediumWeakHighResult | null {
  try {
    const value = JSON.parse(readFile(filePath, "utf8")) as unknown;
    if (!isRecord(value)) return null;
    if (
      value.case_label !== benchmarkCase.case_label ||
      value.attempt_id !== benchmarkCase.attempt_id ||
      value.task_type !== benchmarkCase.task_type ||
      value.provider !== WRITING_REVIEW_KIMI_MEDIUM_WEAK_PROVIDER ||
      value.model !== WRITING_REVIEW_KIMI_MEDIUM_WEAK_MODEL ||
      value.reasoning_effort !== "high" ||
      value.result !== "success" ||
      value.schema_valid !== true
    ) {
      return null;
    }
    const elapsed = readNumber(value.elapsed_ms);
    const officialScore = readNumber(value.official_score);
    const dimensions = readNumberRecord(value.dimension_scores);
    const edits = readEdits(value.language_edits);
    const feedback = readFeedback(value.content_feedback);
    const editCount = readNumber(value.language_edit_count);
    const feedbackCount = readNumber(value.content_feedback_count);
    const categories = readNumberRecord(value.content_feedback_categories);
    const overallFeedback = readString(value.overall_feedback);
    if (
      elapsed === null ||
      officialScore === null ||
      dimensions === null ||
      edits === null ||
      feedback === null ||
      editCount !== edits.length ||
      feedbackCount !== feedback.length ||
      categories === null ||
      overallFeedback === null
    ) {
      return null;
    }
    return {
      case_label: benchmarkCase.case_label,
      attempt_id: benchmarkCase.attempt_id,
      task_type: benchmarkCase.task_type,
      provider: WRITING_REVIEW_KIMI_MEDIUM_WEAK_PROVIDER,
      model: WRITING_REVIEW_KIMI_MEDIUM_WEAK_MODEL,
      reasoning_effort: "high",
      result: "success",
      elapsed_ms: elapsed,
      ...readUsage(value),
      schema_valid: true,
      localization_valid: true,
      official_score: officialScore,
      dimension_scores: dimensions,
      language_edits: edits,
      content_feedback: feedback,
      language_edit_count: editCount,
      content_feedback_count: feedbackCount,
      content_feedback_categories: categories,
      overall_feedback: overallFeedback
    };
  } catch {
    return null;
  }
}

export function buildWritingReviewKimiMediumWeakSummary(
  mediumResults: WritingReviewKimiMediumWeakResult[],
  highResults: WritingReviewKimiMediumWeakHighResult[]
): WritingReviewKimiMediumWeakSummary {
  assertAligned(mediumResults, highResults);
  const successful = mediumResults.filter((result) => result.result === "success");
  return {
    provider: WRITING_REVIEW_KIMI_MEDIUM_WEAK_PROVIDER,
    model: WRITING_REVIEW_KIMI_MEDIUM_WEAK_MODEL,
    reasoning_effort: WRITING_REVIEW_KIMI_MEDIUM_WEAK_EFFORT,
    timeout_ms: WRITING_REVIEW_KIMI_MEDIUM_WEAK_TIMEOUT_MS,
    retry: WRITING_REVIEW_KIMI_MEDIUM_WEAK_RETRY,
    high_source_directory: WRITING_REVIEW_KIMI_MEDIUM_WEAK_HIGH_DIR,
    high_recalled: false,
    cases: mediumResults.map((medium, index) =>
      compareCase(medium, highResults[index])
    ),
    medium_success_count: successful.length,
    medium_timeout_count: mediumResults.filter(
      (result) => result.result === "timeout"
    ).length,
    avg_medium_elapsed_ms: average(successful.map((item) => item.elapsed_ms)),
    avg_medium_reasoning_tokens: averageNumbers(successful, "reasoning_tokens"),
    avg_medium_total_tokens: averageNumbers(successful, "total_tokens"),
    avg_medium_cost: averageNumbers(successful, "cost")
  };
}

export function writeWritingReviewKimiMediumWeakFiles(
  outputDir: string,
  mediumResults: WritingReviewKimiMediumWeakResult[],
  highResults: WritingReviewKimiMediumWeakHighResult[],
  fileSystem: {
    mkdirSync: typeof mkdirSync;
    writeFileSync: typeof writeFileSync;
  } = { mkdirSync, writeFileSync }
) {
  assertAligned(mediumResults, highResults);
  fileSystem.mkdirSync(outputDir, { recursive: true });
  mediumResults.forEach((result) => {
    fileSystem.writeFileSync(
      join(outputDir, `${result.case_label.replace("_", "-")}.json`),
      `${JSON.stringify(result, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  });
  const summary = buildWritingReviewKimiMediumWeakSummary(
    mediumResults,
    highResults
  );
  fileSystem.writeFileSync(
    join(outputDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  fileSystem.writeFileSync(
    join(outputDir, "comparison.md"),
    buildWritingReviewKimiMediumWeakMarkdown(mediumResults, highResults),
    { encoding: "utf8", mode: 0o600 }
  );
  return summary;
}

export function buildWritingReviewKimiMediumWeakMarkdown(
  mediumResults: WritingReviewKimiMediumWeakResult[],
  highResults: WritingReviewKimiMediumWeakHighResult[]
) {
  const summary = buildWritingReviewKimiMediumWeakSummary(
    mediumResults,
    highResults
  );
  const lines = [
    "# Kimi K3 Medium vs High — Weak Cases",
    "",
    "| Case | Effort | Result | Time | Reasoning | Total | Cost | Score | Edits | Feedback |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |"
  ];
  mediumResults.forEach((medium, index) => {
    lines.push(
      topRow(medium.case_label, "High", highResults[index]),
      topRow(medium.case_label, "Medium", medium)
    );
  });

  mediumResults.forEach((medium, index) => {
    const high = highResults[index];
    const comparison = summary.cases[index];
    const mediumReview = comparableMediumReview(medium);
    lines.push(
      "",
      `## ${medium.case_label}`,
      "",
      "### Result and performance",
      "",
      "| Metric | High | Medium | Delta (Medium - High) |",
      "| --- | ---: | ---: | ---: |",
      metricRow("result", high.result, medium.result, "—"),
      metricRow(
        "elapsed_ms",
        high.elapsed_ms,
        medium.elapsed_ms,
        comparison.elapsed_delta_medium_minus_high
      ),
      metricRow(
        "reasoning_tokens",
        high.reasoning_tokens,
        medium.reasoning_tokens,
        comparison.reasoning_delta
      ),
      metricRow(
        "total_tokens",
        high.total_tokens,
        medium.total_tokens,
        comparison.total_tokens_delta
      ),
      metricRow("cost", high.cost, medium.cost, comparison.cost_delta),
      "",
      "### Scores",
      "",
      "| Score | High | Medium | Delta (Medium - High) |",
      "| --- | ---: | ---: | ---: |",
      metricRow(
        "official",
        high.official_score,
        comparableMedium(medium).official_score,
        comparison.official_score_delta
      ),
      ...Object.keys(comparison.dimension_score_deltas).map((dimension) =>
        metricRow(
          dimension,
          high.dimension_scores[dimension] ?? null,
          comparableMedium(medium).dimension_scores?.[dimension] ?? null,
          comparison.dimension_score_deltas[dimension]
        )
      ),
      "",
      "### Language edits (exact original/replacement matching)",
      "",
      `- Shared (${comparison.shared_language_edits.length}): ${formatEditPairs(comparison.shared_language_edits)}`,
      `- High-only (${comparison.high_only_language_edits.length}): ${formatEditPairs(comparison.high_only_language_edits)}`,
      `- Medium-only (${comparison.medium_only_language_edits.length}): ${formatEditPairs(comparison.medium_only_language_edits)}`,
      "",
      "> Different spans may represent the same error; exact matching cannot automatically determine quality.",
      "",
      "#### High edits",
      "",
      ...formatEdits(high.language_edits),
      "",
      "#### Medium edits",
      "",
      ...formatEdits(mediumReview?.language_edits ?? []),
      "",
      "### Content feedback",
      "",
      `- Count delta: ${display(comparison.content_feedback_count_delta)}`,
      `- High categories: ${formatRecord(high.content_feedback_categories)}`,
      `- Medium categories: ${formatRecord(comparableMedium(medium).content_feedback_categories)}`,
      "",
      "#### High feedback",
      "",
      ...formatFeedback(high.content_feedback),
      "",
      "#### Medium feedback",
      "",
      ...formatFeedback(mediumReview?.content_feedback ?? []),
      "",
      "### Overall feedback",
      "",
      `- High: ${escapeInline(high.overall_feedback)}`,
      `- Medium: ${escapeInline(comparableMedium(medium).overall_feedback ?? "—")}`,
      "",
      "### Schema and localization",
      "",
      `- High: schema=${high.schema_valid}, localization=${high.localization_valid}`,
      `- Medium: schema=${medium.schema_valid}, localization=${displayBoolean(medium.localization_valid)}, localization issues=${medium.localization_issue_count}`,
      "",
      "### Manual QA",
      "",
      ...manualQa(medium.case_label)
    );
  });

  lines.push(
    "",
    "## Medium aggregate (successful results only)",
    "",
    `- medium_success_count: ${summary.medium_success_count}`,
    `- medium_timeout_count: ${summary.medium_timeout_count}`,
    `- avg_medium_elapsed_ms: ${display(summary.avg_medium_elapsed_ms)}`,
    `- avg_medium_reasoning_tokens: ${display(summary.avg_medium_reasoning_tokens)}`,
    `- avg_medium_total_tokens: ${display(summary.avg_medium_total_tokens)}`,
    `- avg_medium_cost: ${display(summary.avg_medium_cost)}`,
    "",
    "> No automatic winner is declared; use the per-case evidence and manual QA checklist.",
    ""
  );
  return `${lines.join("\n")}\n`;
}

function compareCase(
  medium: WritingReviewKimiMediumWeakResult,
  high: WritingReviewKimiMediumWeakHighResult
): WritingReviewKimiMediumWeakComparison {
  const mediumComparable = comparableMedium(medium);
  const mediumEdits = editMap(comparableMediumReview(medium)?.language_edits ?? []);
  const highEdits = editMap(high.language_edits);
  const dimensionKeys = new Set([
    ...Object.keys(high.dimension_scores),
    ...Object.keys(mediumComparable.dimension_scores ?? {})
  ]);
  return {
    case_label: medium.case_label,
    attempt_id: medium.attempt_id,
    high: comparableHigh(high),
    medium: mediumComparable,
    elapsed_delta_medium_minus_high: difference(
      medium.elapsed_ms,
      high.elapsed_ms
    ),
    reasoning_delta: difference(
      medium.reasoning_tokens,
      high.reasoning_tokens
    ),
    total_tokens_delta: difference(medium.total_tokens, high.total_tokens),
    cost_delta: difference(medium.cost, high.cost),
    official_score_delta: difference(
      mediumComparable.official_score,
      high.official_score
    ),
    dimension_score_deltas: Object.fromEntries(
      Array.from(dimensionKeys).map((dimension) => [
        dimension,
        difference(
          mediumComparable.dimension_scores?.[dimension] ?? null,
          high.dimension_scores[dimension] ?? null
        )
      ])
    ),
    language_edit_count_delta: difference(
      mediumComparable.language_edit_count,
      high.language_edit_count
    ),
    content_feedback_count_delta: difference(
      mediumComparable.content_feedback_count,
      high.content_feedback_count
    ),
    shared_language_edits: intersection(mediumEdits, highEdits),
    high_only_language_edits: mapDifference(highEdits, mediumEdits),
    medium_only_language_edits: mapDifference(mediumEdits, highEdits)
  };
}

function comparableHigh(
  value: WritingReviewKimiMediumWeakHighResult
): ComparableResult {
  return {
    result: value.result,
    elapsed_ms: value.elapsed_ms,
    reasoning_tokens: value.reasoning_tokens,
    completion_tokens: value.completion_tokens,
    total_tokens: value.total_tokens,
    cost: value.cost,
    schema_valid: value.schema_valid,
    localization_valid: value.localization_valid,
    official_score: value.official_score,
    dimension_scores: value.dimension_scores,
    language_edit_count: value.language_edit_count,
    content_feedback_count: value.content_feedback_count,
    content_feedback_categories: value.content_feedback_categories,
    overall_feedback: value.overall_feedback
  };
}

function comparableMedium(
  value: WritingReviewKimiMediumWeakResult
): ComparableResult {
  return {
    result: value.result,
    elapsed_ms: value.elapsed_ms,
    reasoning_tokens: value.reasoning_tokens,
    completion_tokens: value.completion_tokens,
    total_tokens: value.total_tokens,
    cost: value.cost,
    schema_valid: value.schema_valid,
    localization_valid: value.localization_valid,
    official_score: value.official_score ?? value.raw_official_score,
    dimension_scores: value.dimension_scores ?? value.raw_dimension_scores,
    language_edit_count:
      value.language_edit_count ?? value.raw_language_edit_count,
    content_feedback_count:
      value.content_feedback_count ?? value.raw_content_feedback_count,
    content_feedback_categories:
      value.result === "localization_error"
        ? value.raw_content_feedback_categories
        : value.content_feedback_categories,
    overall_feedback:
      value.overall_feedback ?? value.validated_raw_result?.overall_feedback ?? null
  };
}

function comparableMediumReview(value: WritingReviewKimiMediumWeakResult) {
  return value.validated_result ?? value.validated_raw_result;
}

function assertAligned(
  mediumResults: WritingReviewKimiMediumWeakResult[],
  highResults: WritingReviewKimiMediumWeakHighResult[]
) {
  if (mediumResults.length !== 2 || highResults.length !== 2) {
    throw new Error("Kimi medium weak output requires two aligned result pairs.");
  }
  WRITING_REVIEW_KIMI_MEDIUM_WEAK_CASES.forEach((expected, index) => {
    if (
      mediumResults[index].case_label !== expected.case_label ||
      mediumResults[index].attempt_id !== expected.attempt_id ||
      highResults[index].case_label !== expected.case_label ||
      highResults[index].attempt_id !== expected.attempt_id
    ) {
      throw new Error(`Unexpected Kimi medium weak case at position ${index + 1}.`);
    }
  });
}

function editMap(edits: ComparableEdit[]) {
  return new Map(
    edits.map((edit) => [
      `${edit.original_text}\u0000${edit.replacement_text}`,
      {
        original_text: edit.original_text,
        replacement_text: edit.replacement_text
      }
    ])
  );
}

function intersection(
  first: Map<string, ComparableEdit>,
  second: Map<string, ComparableEdit>
) {
  return Array.from(first.entries())
    .filter(([key]) => second.has(key))
    .map(([, edit]) => edit);
}

function mapDifference(
  first: Map<string, ComparableEdit>,
  second: Map<string, ComparableEdit>
) {
  return Array.from(first.entries())
    .filter(([key]) => !second.has(key))
    .map(([, edit]) => edit);
}

function readEdits(value: unknown): ComparableEdit[] | null {
  if (!Array.isArray(value)) return null;
  const edits: ComparableEdit[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const originalText = readString(item.original_text);
    const replacementText = readString(item.replacement_text);
    if (originalText === null || replacementText === null) return null;
    edits.push({ original_text: originalText, replacement_text: replacementText });
  }
  return edits;
}

function readFeedback(value: unknown): RawContentFeedbackV22[] | null {
  if (!Array.isArray(value)) return null;
  const feedback: RawContentFeedbackV22[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const fields = {
      feedback_id: readString(item.feedback_id),
      category: readString(item.category),
      original_sentence: readString(item.original_sentence),
      issue: readString(item.issue),
      suggestion: readString(item.suggestion),
      proposed_revision: readString(item.proposed_revision)
    };
    if (Object.values(fields).some((field) => field === null)) return null;
    feedback.push(fields as RawContentFeedbackV22);
  }
  return feedback;
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
  return Object.fromEntries(entries) as ScoreMap;
}

function averageNumbers(
  results: WritingReviewKimiMediumWeakResult[],
  key: "reasoning_tokens" | "total_tokens" | "cost"
) {
  return average(
    results
      .map((result) => result[key])
      .filter((value): value is number => typeof value === "number")
  );
}

function average(values: number[]) {
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function difference(left: number | null, right: number | null) {
  return left === null || right === null ? null : left - right;
}

function topRow(
  caseLabel: string,
  effort: "High" | "Medium",
  value:
    | WritingReviewKimiMediumWeakHighResult
    | WritingReviewKimiMediumWeakResult
) {
  const comparable =
    effort === "High"
      ? comparableHigh(value as WritingReviewKimiMediumWeakHighResult)
      : comparableMedium(value as WritingReviewKimiMediumWeakResult);
  return `| ${caseLabel} | ${effort} | ${value.result} | ${value.elapsed_ms} | ${display(value.reasoning_tokens)} | ${display(value.total_tokens)} | ${display(value.cost)} | ${display(comparable.official_score)} | ${display(comparable.language_edit_count)} | ${display(comparable.content_feedback_count)} (${formatRecord(comparable.content_feedback_categories)}) |`;
}

function metricRow(
  metric: string,
  high: string | number | null,
  medium: string | number | null,
  delta: string | number | null
) {
  return `| ${escapeTable(metric)} | ${displayValue(high)} | ${displayValue(medium)} | ${displayValue(delta)} |`;
}

function formatEditPairs(edits: ComparableEdit[]) {
  return edits.length === 0
    ? "—"
    : edits
        .map(
          (edit) =>
            `\`${escapeInline(edit.original_text)}\` → \`${escapeInline(edit.replacement_text)}\``
        )
        .join("; ");
}

function formatEdits(edits: ComparableEdit[]) {
  return edits.length === 0
    ? ["- —"]
    : edits.map(
        (edit) =>
          `- \`${escapeInline(edit.original_text)}\` → \`${escapeInline(edit.replacement_text)}\``
      );
}

function formatFeedback(feedback: RawContentFeedbackV22[]) {
  return feedback.length === 0
    ? ["- —"]
    : feedback.map(
        (item) =>
          `- **${escapeInline(item.category)}** — \`${escapeInline(item.original_sentence)}\` — ${escapeInline(item.issue)} — ${escapeInline(item.suggestion)} — Proposed: \`${escapeInline(item.proposed_revision)}\``
      );
}

function manualQa(caseLabel: CaseLabel) {
  const checks: Record<CaseLabel, string[]> = {
    email_weak: [
      "Official 是否仍为 3",
      "communicative purpose / elaboration 是否合理",
      "grammar 是否明显漏检",
      "是否覆盖 `make a directional goal`",
      "是否覆盖 `apply my dream career`",
      "是否覆盖 `introduction papers`",
      "是否覆盖 `next events`",
      "Word Choice 是否仍完整",
      "是否明显减少反馈质量"
    ],
    ad_weak: [
      "Official 是否仍为 3",
      "relevance / elaboration / syntax / lexical 分数是否接近 high",
      "是否识别 teenage years / nurture 逻辑问题",
      "是否识别 `nurture is necessary` 的比较表达",
      "是否覆盖 `growth environments`",
      "是否覆盖 `kindful people`",
      "grammar coverage 是否完整",
      "Word Choice / Content Feedback 是否明显减少"
    ]
  };
  return checks[caseLabel].map((item) => `- [ ] ${item}`);
}

function formatRecord(value: CategoryCounts) {
  const entries = Object.entries(value);
  return entries.length === 0
    ? "—"
    : entries.map(([key, count]) => `${escapeInline(key)}: ${count}`).join(", ");
}

function display(value: number | null) {
  return value === null ? "—" : String(value);
}

function displayBoolean(value: boolean | null) {
  return value === null ? "not_run" : String(value);
}

function displayValue(value: string | number | null) {
  return value === null ? "—" : escapeTable(String(value));
}

function escapeInline(value: string) {
  return value.replace(/\s+/g, " ").replace(/`/g, "\\`").trim();
}

function escapeTable(value: string) {
  return escapeInline(value).replace(/\|/g, "\\|");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
