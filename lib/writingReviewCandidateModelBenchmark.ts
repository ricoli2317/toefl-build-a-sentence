import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EMPTY_OPENROUTER_USAGE,
  getOpenRouterErrorDiagnostic,
  OpenRouterWritingReviewError,
  requestOpenRouterWithTimeout,
  WRITING_REVIEW_FULL_REQUEST_TIMEOUT_MS,
  type OpenRouterTokenUsage,
  type OpenRouterWritingReviewInput,
  type OpenRouterWritingReviewResponse
} from "./openrouterWritingReview.ts";
import type {
  AIReviewRawResultV22,
  AIReviewResultV22
} from "./writingReviewSchemaV22.ts";

export const WRITING_REVIEW_CANDIDATE_ATTEMPT_ID =
  "a7ad7e9f-b4ef-4ee0-9b39-43f1d7020cdc";
export const WRITING_REVIEW_CANDIDATE_TASK_TYPE =
  "academic_discussion" as const;
export const WRITING_REVIEW_CANDIDATE_CONFIGS = [
  {
    label: "grok_medium",
    display_name: "Grok 4.6 Medium",
    model: "x-ai/grok-4.6",
    reasoning_effort: "medium"
  },
  {
    label: "grok_high",
    display_name: "Grok 4.6 High",
    model: "x-ai/grok-4.6",
    reasoning_effort: "high"
  },
  {
    label: "gemini_medium",
    display_name: "Gemini 3.7 Flash Medium",
    model: "google/gemini-3.7-flash",
    reasoning_effort: "medium"
  },
  {
    label: "gemini_high",
    display_name: "Gemini 3.7 Flash High",
    model: "google/gemini-3.7-flash",
    reasoning_effort: "high"
  }
] as const;
export const WRITING_REVIEW_CANDIDATE_PROVIDER = "openrouter" as const;
export const WRITING_REVIEW_CANDIDATE_OPERATION =
  "candidate_model_benchmark" as const;
export const WRITING_REVIEW_CANDIDATE_TIMEOUT_MS =
  WRITING_REVIEW_FULL_REQUEST_TIMEOUT_MS;
export const WRITING_REVIEW_CANDIDATE_OUTPUT_DIR =
  "tmp/writing-review-candidate-models";
export const WRITING_REVIEW_CANDIDATE_KIMI_BASELINE_PATH =
  "tmp/writing-review-reasoning-stability/ad_weak-high.json";

export type WritingReviewCandidateConfig =
  (typeof WRITING_REVIEW_CANDIDATE_CONFIGS)[number];
export type WritingReviewCandidateLabel = WritingReviewCandidateConfig["label"];
export type WritingReviewCandidateEffort =
  WritingReviewCandidateConfig["reasoning_effort"];
export type WritingReviewCandidateSelection = "all" | "gemini" | "grok";

type DimensionScores = Record<string, number>;
type FeedbackCategoryCounts = Record<string, number>;
type NormalizedEdit = Pick<
  AIReviewResultV22["language_edits"][number],
  "original_text" | "replacement_text"
>;

export type WritingReviewCandidateInput = OpenRouterWritingReviewInput & {
  attemptId: typeof WRITING_REVIEW_CANDIDATE_ATTEMPT_ID;
  taskType: typeof WRITING_REVIEW_CANDIDATE_TASK_TYPE;
};

export type WritingReviewCandidateResult = OpenRouterTokenUsage & {
  label: WritingReviewCandidateLabel;
  provider: typeof WRITING_REVIEW_CANDIDATE_PROVIDER;
  model: WritingReviewCandidateConfig["model"];
  reasoning_effort: WritingReviewCandidateEffort;
  operation: typeof WRITING_REVIEW_CANDIDATE_OPERATION;
  attempt_id: typeof WRITING_REVIEW_CANDIDATE_ATTEMPT_ID;
  task_type: typeof WRITING_REVIEW_CANDIDATE_TASK_TYPE;
  elapsed_ms: number;
  result:
    | "success"
    | "timeout"
    | "provider_error"
    | "invalid_json"
    | "validation_error"
    | "localization_error";
  error_code: string | null;
  error: string | null;
  http_status: number | null;
  provider_error_type: string | null;
  provider_error_code: string | number | null;
  provider_name: string | null;
  schema_valid: boolean;
  official_score: number | null;
  dimension_scores: DimensionScores | null;
  language_edit_count: number | null;
  content_feedback_count: number | null;
  content_feedback_categories: FeedbackCategoryCounts;
  overall_feedback: string | null;
  validated_result: AIReviewResultV22 | null;
};

export type WritingReviewCandidateBaseline = OpenRouterTokenUsage & {
  label: "kimi_high_baseline";
  provider: string;
  model: string;
  reasoning_effort: "high";
  attempt_id: typeof WRITING_REVIEW_CANDIDATE_ATTEMPT_ID;
  task_type: typeof WRITING_REVIEW_CANDIDATE_TASK_TYPE;
  elapsed_ms: number | null;
  result: string;
  schema_valid: boolean;
  official_score: number | null;
  dimension_scores: DimensionScores | null;
  language_edit_count: number | null;
  content_feedback_count: number | null;
  content_feedback_categories: FeedbackCategoryCounts;
  overall_feedback: string | null;
  validated_result: AIReviewResultV22 | null;
};

export type WritingReviewCandidateComparison = {
  label: WritingReviewCandidateLabel;
  baseline_available: boolean;
  official_score_delta: number | null;
  dimension_score_deltas: Record<string, number | null>;
  shared_edits: NormalizedEdit[];
  kimi_only_edits: NormalizedEdit[];
  candidate_only_edits: NormalizedEdit[];
  feedback_category_delta: FeedbackCategoryCounts;
};

export type WritingReviewCandidateSummary = {
  attempt_id: typeof WRITING_REVIEW_CANDIDATE_ATTEMPT_ID;
  task_type: typeof WRITING_REVIEW_CANDIDATE_TASK_TYPE;
  provider: typeof WRITING_REVIEW_CANDIDATE_PROVIDER;
  baseline: Omit<WritingReviewCandidateBaseline, "validated_result"> | null;
  results: Array<Omit<WritingReviewCandidateResult, "validated_result">>;
  comparisons: WritingReviewCandidateComparison[];
};

export type WritingReviewCandidateDependencies = {
  now?: () => number;
  timeoutMs?: number;
  configs?: readonly WritingReviewCandidateConfig[];
  onConfigStart?(config: WritingReviewCandidateConfig): void;
  onConfigComplete?(result: WritingReviewCandidateResult): void;
  requestWithTimeout?<T>(
    request: (signal: AbortSignal) => Promise<T>,
    options: { timeoutMs: number; timeoutMessage: string }
  ): Promise<T>;
  requestAI(
    input: OpenRouterWritingReviewInput,
    config: WritingReviewCandidateConfig,
    signal: AbortSignal
  ): Promise<OpenRouterWritingReviewResponse>;
  parseRawReview(value: unknown): AIReviewRawResultV22;
  parseReview(value: unknown, responseText: string): AIReviewResultV22;
};

export async function benchmarkWritingReviewCandidateModels(
  input: WritingReviewCandidateInput,
  dependencies: WritingReviewCandidateDependencies
) {
  assertFixedInput(input);
  const now = dependencies.now ?? (() => Date.now());
  const timeoutMs = dependencies.timeoutMs ?? WRITING_REVIEW_CANDIDATE_TIMEOUT_MS;
  const withTimeout = dependencies.requestWithTimeout ?? requestOpenRouterWithTimeout;
  const configs = dependencies.configs ?? WRITING_REVIEW_CANDIDATE_CONFIGS;
  assertSelectedConfigs(configs);
  const results: WritingReviewCandidateResult[] = [];

  for (const config of configs) {
    dependencies.onConfigStart?.(config);
    const startedAt = now();
    let usage: OpenRouterTokenUsage = { ...EMPTY_OPENROUTER_USAGE };
    let result: WritingReviewCandidateResult;
    try {
      const response = await withTimeout(
        (signal) => dependencies.requestAI(input, config, signal),
        {
          timeoutMs,
          timeoutMessage: `${config.label} timed out.`
        }
      );
      usage = response.usage;
      let rawValue: unknown;
      try {
        rawValue = JSON.parse(response.content) as unknown;
      } catch (error) {
        result = failureResult(input, config, now() - startedAt, usage, {
          result: "invalid_json",
          errorCode: "AI_RESPONSE_INVALID_JSON",
          error
        });
        results.push(result);
        dependencies.onConfigComplete?.(result);
        continue;
      }

      try {
        const raw = dependencies.parseRawReview(rawValue);
        if (
          raw.schema_version !== "2.2" ||
          raw.task_type !== WRITING_REVIEW_CANDIDATE_TASK_TYPE
        ) {
          throw new Error("Candidate response did not match the AD v2.2 schema.");
        }
      } catch (error) {
        result = failureResult(input, config, now() - startedAt, usage, {
          result: "validation_error",
          errorCode: "AI_RESPONSE_SCHEMA_INVALID",
          error
        });
        results.push(result);
        dependencies.onConfigComplete?.(result);
        continue;
      }

      let validated: AIReviewResultV22;
      try {
        validated = dependencies.parseReview(rawValue, input.responseText);
      } catch (error) {
        result = failureResult(input, config, now() - startedAt, usage, {
          result: "localization_error",
          errorCode: "AI_RESPONSE_LOCALIZATION_FAILED",
          error
        });
        results.push(result);
        dependencies.onConfigComplete?.(result);
        continue;
      }
      result = successResult(input, config, now() - startedAt, usage, validated);
    } catch (error) {
      const timedOut =
        error instanceof OpenRouterWritingReviewError &&
        error.code === "AI_REQUEST_TIMEOUT";
      result = failureResult(input, config, now() - startedAt, usage, {
        result: timedOut ? "timeout" : "provider_error",
        errorCode: timedOut ? "AI_REQUEST_TIMEOUT" : errorCode(error),
        error
      });
    }
    results.push(result);
    dependencies.onConfigComplete?.(result);
  }
  return results;
}

export function parseWritingReviewCandidateArguments(arguments_: string[]) {
  const argumentsWithoutSeparator = arguments_.filter((argument) => argument !== "--");
  let selection: WritingReviewCandidateSelection = "all";
  let error: string | null = null;
  for (let index = 0; index < argumentsWithoutSeparator.length; index += 1) {
    const argument = argumentsWithoutSeparator[index];
    if (argument !== "--only") {
      error ??= `Unknown option: ${argument}`;
      continue;
    }
    const value = argumentsWithoutSeparator[index + 1];
    if (!value || value.startsWith("--")) {
      error ??= "--only requires all, gemini, or grok";
      continue;
    }
    if (value !== "all" && value !== "gemini" && value !== "grok") {
      error ??= `Invalid --only value: ${value}`;
    } else {
      selection = value;
    }
    index += 1;
  }
  return { selection, error };
}

export function selectWritingReviewCandidateConfigs(
  selection: WritingReviewCandidateSelection
) {
  if (selection === "all") return WRITING_REVIEW_CANDIDATE_CONFIGS;
  return WRITING_REVIEW_CANDIDATE_CONFIGS.filter((config) =>
    selection === "gemini"
      ? config.model === "google/gemini-3.7-flash"
      : config.model === "x-ai/grok-4.6"
  );
}

function successResult(
  input: WritingReviewCandidateInput,
  config: WritingReviewCandidateConfig,
  elapsedMs: number,
  usage: OpenRouterTokenUsage,
  validated: AIReviewResultV22
): WritingReviewCandidateResult {
  return {
    label: config.label,
    provider: WRITING_REVIEW_CANDIDATE_PROVIDER,
    model: config.model,
    reasoning_effort: config.reasoning_effort,
    operation: WRITING_REVIEW_CANDIDATE_OPERATION,
    attempt_id: input.attemptId,
    task_type: input.taskType,
    elapsed_ms: Math.max(0, elapsedMs),
    ...usage,
    result: "success",
    error_code: null,
    error: null,
    http_status: null,
    provider_error_type: null,
    provider_error_code: null,
    provider_name: null,
    schema_valid: true,
    official_score: validated.scores.official_score.ai_score,
    dimension_scores: Object.fromEntries(
      Object.entries(validated.scores.dimension_scores).map(([key, value]) => [
        key,
        value.ai_score
      ])
    ),
    language_edit_count: validated.language_edits.length,
    content_feedback_count: validated.content_feedback.length,
    content_feedback_categories: countFeedbackCategories(validated),
    overall_feedback: validated.overall_feedback,
    validated_result: validated
  };
}

function failureResult(
  input: WritingReviewCandidateInput,
  config: WritingReviewCandidateConfig,
  elapsedMs: number,
  usage: OpenRouterTokenUsage,
  failure: {
    result:
      | "timeout"
      | "provider_error"
      | "invalid_json"
      | "validation_error"
      | "localization_error";
    errorCode: string;
    error: unknown;
  }
): WritingReviewCandidateResult {
  const diagnostic = getOpenRouterErrorDiagnostic(failure.error);
  return {
    label: config.label,
    provider: WRITING_REVIEW_CANDIDATE_PROVIDER,
    model: config.model,
    reasoning_effort: config.reasoning_effort,
    operation: WRITING_REVIEW_CANDIDATE_OPERATION,
    attempt_id: input.attemptId,
    task_type: input.taskType,
    elapsed_ms: Math.max(0, elapsedMs),
    ...usage,
    result: failure.result,
    error_code: failure.errorCode,
    error: safeErrorMessage(failure.error),
    http_status: diagnostic.http_status,
    provider_error_type: diagnostic.error_type,
    provider_error_code: diagnostic.provider_code,
    provider_name: diagnostic.provider_name,
    schema_valid: failure.result === "localization_error",
    official_score: null,
    dimension_scores: null,
    language_edit_count: null,
    content_feedback_count: null,
    content_feedback_categories: {},
    overall_feedback: null,
    validated_result: null
  };
}

export function readWritingReviewCandidateKimiBaseline(
  filePath: string,
  readFile: typeof readFileSync = readFileSync
): WritingReviewCandidateBaseline | null {
  try {
    const value = JSON.parse(readFile(filePath, "utf8")) as unknown;
    if (!isRecord(value)) return null;
    if (
      value.attempt_id !== WRITING_REVIEW_CANDIDATE_ATTEMPT_ID ||
      value.task_type !== WRITING_REVIEW_CANDIDATE_TASK_TYPE ||
      value.reasoning_effort !== "high"
    ) {
      return null;
    }
    const validatedResult = isReviewResult(value.validated_result)
      ? (value.validated_result as AIReviewResultV22)
      : null;
    return {
      label: "kimi_high_baseline",
      provider: readString(value.provider) ?? "openrouter",
      model: readString(value.model) ?? "moonshotai/kimi-k3",
      reasoning_effort: "high",
      attempt_id: WRITING_REVIEW_CANDIDATE_ATTEMPT_ID,
      task_type: WRITING_REVIEW_CANDIDATE_TASK_TYPE,
      elapsed_ms: readNumber(value.elapsed_ms),
      ...readUsage(value),
      result: readString(value.result) ?? "unknown",
      schema_valid: value.schema_valid === true,
      official_score: readNumber(value.official_score),
      dimension_scores: readNumberRecord(value.dimension_scores),
      language_edit_count: readNumber(value.language_edit_count),
      content_feedback_count: readNumber(value.content_feedback_count),
      content_feedback_categories:
        readNumberRecord(value.content_feedback_categories) ?? {},
      overall_feedback: readString(value.overall_feedback),
      validated_result: validatedResult
    };
  } catch {
    return null;
  }
}

export function buildWritingReviewCandidateSummary(
  results: WritingReviewCandidateResult[],
  baseline: WritingReviewCandidateBaseline | null
): WritingReviewCandidateSummary {
  assertSelectedResults(results);
  return {
    attempt_id: WRITING_REVIEW_CANDIDATE_ATTEMPT_ID,
    task_type: WRITING_REVIEW_CANDIDATE_TASK_TYPE,
    provider: WRITING_REVIEW_CANDIDATE_PROVIDER,
    baseline: baseline
      ? (({ validated_result: _validatedResult, ...summary }) => summary)(baseline)
      : null,
    results: results.map(({ validated_result: _validatedResult, ...result }) => result),
    comparisons: results.map((result) => compareWithBaseline(result, baseline))
  };
}

export function buildWritingReviewCandidateMarkdown(
  results: WritingReviewCandidateResult[],
  baseline: WritingReviewCandidateBaseline | null
) {
  const summary = buildWritingReviewCandidateSummary(results, baseline);
  const lines = [
    "# Candidate Model Benchmark",
    "",
    "## Performance Summary",
    "",
    "| Model | Effort | Result | Time | Reasoning | Completion | Total | Cost | Score | Edits | Feedback |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  ];
  if (baseline) lines.push(performanceRow(baseline));
  for (const result of results) lines.push(performanceRow(result));

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const config = WRITING_REVIEW_CANDIDATE_CONFIGS.find(
      (candidate) => candidate.label === result.label
    )!;
    const comparison = summary.comparisons[index];
    lines.push(
      "",
      `## ${config.display_name}`,
      "",
      "### Scores",
      "",
      "| Dimension | Score | Kimi high | Delta |",
      "| --- | ---: | ---: | ---: |",
      scoreRow("official", result.official_score, baseline?.official_score ?? null)
    );
    for (const dimension of scoreDimensions(result, baseline)) {
      lines.push(
        scoreRow(
          dimension,
          result.dimension_scores?.[dimension] ?? null,
          baseline?.dimension_scores?.[dimension] ?? null
        )
      );
    }
    lines.push(
      "",
      "### Language Edits",
      "",
      ...formatFullEdits(result.validated_result),
      "",
      `- Exact shared with Kimi high (${comparison.shared_edits.length}): ${formatEditPairs(comparison.shared_edits)}`,
      `- Kimi high only (${comparison.kimi_only_edits.length}): ${formatEditPairs(comparison.kimi_only_edits)}`,
      `- Candidate only (${comparison.candidate_only_edits.length}): ${formatEditPairs(comparison.candidate_only_edits)}`,
      "",
      "> Exact matching is only an aid. Different spans may describe the same underlying error and are not an automatic quality verdict.",
      "",
      "### Content Feedback",
      "",
      ...formatFeedback(result.validated_result),
      "",
      `Category delta vs Kimi high: ${formatCategoryDelta(comparison.feedback_category_delta)}`,
      "",
      "### Overall Feedback",
      "",
      result.overall_feedback ? escapeInline(result.overall_feedback) : "—",
      "",
      "### Performance",
      "",
      performanceDetails(result)
    );
  }
  lines.push(
    "",
    "## Manual QA Checklist",
    "",
    "- Relevance 是否合理",
    "- teenage years / age 10 是否进入 elaboration",
    "- claim-example mismatch 是否识别",
    "- necessary 的论证问题是否识别",
    "- growth environments 是否识别",
    "- kindful people 是否识别",
    "- grammar errors 是否明显漏检",
    "- Word Choice 是否错误进入 grammar edits",
    "- proposed revisions 是否自然",
    "- 是否出现过度润色",
    "- Schema 是否一次成功",
    ""
  );
  return `${lines.join("\n")}\n`;
}

export function writeWritingReviewCandidateFiles(
  outputDir: string,
  results: WritingReviewCandidateResult[],
  baseline: WritingReviewCandidateBaseline | null,
  fileSystem: {
    mkdirSync: typeof mkdirSync;
    writeFileSync: typeof writeFileSync;
  } = { mkdirSync, writeFileSync }
) {
  assertSelectedResults(results);
  fileSystem.mkdirSync(outputDir, { recursive: true });
  for (const result of results) {
    fileSystem.writeFileSync(
      join(outputDir, `${result.label.replace("_", "-")}.json`),
      `${JSON.stringify(result, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  }
  const summary = buildWritingReviewCandidateSummary(results, baseline);
  fileSystem.writeFileSync(
    join(outputDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  fileSystem.writeFileSync(
    join(outputDir, "comparison.md"),
    buildWritingReviewCandidateMarkdown(results, baseline),
    { encoding: "utf8", mode: 0o600 }
  );
  return summary;
}

function compareWithBaseline(
  result: WritingReviewCandidateResult,
  baseline: WritingReviewCandidateBaseline | null
): WritingReviewCandidateComparison {
  if (!baseline) {
    return {
      label: result.label,
      baseline_available: false,
      official_score_delta: null,
      dimension_score_deltas: {},
      shared_edits: [],
      kimi_only_edits: [],
      candidate_only_edits: [],
      feedback_category_delta: {}
    };
  }
  const candidateEdits = normalizedEditMap(result.validated_result);
  const kimiEdits = normalizedEditMap(baseline.validated_result);
  const sharedKeys = Array.from(candidateEdits.keys()).filter((key) =>
    kimiEdits.has(key)
  );
  const kimiOnlyKeys = Array.from(kimiEdits.keys()).filter(
    (key) => !candidateEdits.has(key)
  );
  const candidateOnlyKeys = Array.from(candidateEdits.keys()).filter(
    (key) => !kimiEdits.has(key)
  );
  const dimensionKeys = new Set([
    ...Object.keys(result.dimension_scores ?? {}),
    ...Object.keys(baseline.dimension_scores ?? {})
  ]);
  const categoryKeys = new Set([
    ...Object.keys(result.content_feedback_categories),
    ...Object.keys(baseline.content_feedback_categories)
  ]);
  return {
    label: result.label,
    baseline_available: true,
    official_score_delta: difference(result.official_score, baseline.official_score),
    dimension_score_deltas: Object.fromEntries(
      Array.from(dimensionKeys).map((key) => [
        key,
        difference(
          result.dimension_scores?.[key] ?? null,
          baseline.dimension_scores?.[key] ?? null
        )
      ])
    ),
    shared_edits: sharedKeys.map((key) => candidateEdits.get(key)!),
    kimi_only_edits: kimiOnlyKeys.map((key) => kimiEdits.get(key)!),
    candidate_only_edits: candidateOnlyKeys.map((key) => candidateEdits.get(key)!),
    feedback_category_delta: Object.fromEntries(
      Array.from(categoryKeys).map((key) => [
        key,
        (result.content_feedback_categories[key] ?? 0) -
          (baseline.content_feedback_categories[key] ?? 0)
      ])
    )
  };
}

function normalizedEditMap(result: AIReviewResultV22 | null) {
  return new Map(
    (result?.language_edits ?? []).map((edit) => {
      const normalized = {
        original_text: edit.original_text,
        replacement_text: edit.replacement_text
      };
      return [`${normalized.original_text}\u0000${normalized.replacement_text}`, normalized];
    })
  );
}

function countFeedbackCategories(result: AIReviewResultV22) {
  return result.content_feedback.reduce<FeedbackCategoryCounts>((counts, feedback) => {
    counts[feedback.category] = (counts[feedback.category] ?? 0) + 1;
    return counts;
  }, {});
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

function isReviewResult(value: unknown) {
  return (
    isRecord(value) &&
    value.schema_version === "2.2" &&
    value.task_type === WRITING_REVIEW_CANDIDATE_TASK_TYPE &&
    Array.isArray(value.language_edits) &&
    Array.isArray(value.content_feedback) &&
    isRecord(value.scores)
  );
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function readNumberRecord(value: unknown) {
  if (!isRecord(value)) return null;
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isFinite(entry[1])
    )
  );
}

function formatFullEdits(result: AIReviewResultV22 | null) {
  if (!result || result.language_edits.length === 0) return ["- —"];
  return result.language_edits.map(
    (edit) =>
      `- \`${escapeInline(edit.original_text)}\` → \`${escapeInline(edit.replacement_text)}\` — ${escapeInline(edit.category)}, ${escapeInline(edit.severity)}: ${escapeInline(edit.explanation)}`
  );
}

function formatEditPairs(edits: NormalizedEdit[]) {
  return edits.length === 0
    ? "—"
    : edits
        .map(
          (edit) =>
            `\`${escapeInline(edit.original_text)}\` → \`${escapeInline(edit.replacement_text)}\``
        )
        .join("; ");
}

function formatFeedback(result: AIReviewResultV22 | null) {
  if (!result || result.content_feedback.length === 0) return ["- —"];
  return result.content_feedback.map(
    (feedback) =>
      `- **${escapeInline(feedback.category)}** — \`${escapeInline(feedback.original_sentence)}\` — ${escapeInline(feedback.issue)} — Proposed: \`${escapeInline(feedback.proposed_revision)}\``
  );
}

function formatCategoryDelta(delta: FeedbackCategoryCounts) {
  const entries = Object.entries(delta);
  return entries.length === 0
    ? "—"
    : entries.map(([category, value]) => `${category}: ${value}`).join(", ");
}

function performanceRow(
  result: WritingReviewCandidateResult | WritingReviewCandidateBaseline
) {
  return `| ${escapeTable(result.model)} | ${result.reasoning_effort} | ${result.result} | ${display(result.elapsed_ms)} | ${display(result.reasoning_tokens)} | ${display(result.completion_tokens)} | ${display(result.total_tokens)} | ${display(result.cost)} | ${display(result.official_score)} | ${display(result.language_edit_count)} | ${display(result.content_feedback_count)} |`;
}

function scoreRow(label: string, score: number | null, baselineScore: number | null) {
  return `| ${escapeTable(label)} | ${display(score)} | ${display(baselineScore)} | ${display(difference(score, baselineScore))} |`;
}

function scoreDimensions(
  result: WritingReviewCandidateResult,
  baseline: WritingReviewCandidateBaseline | null
) {
  return Array.from(
    new Set([
      ...Object.keys(result.dimension_scores ?? {}),
      ...Object.keys(baseline?.dimension_scores ?? {})
    ])
  );
}

function performanceDetails(result: WritingReviewCandidateResult) {
  return [
    `Result: ${result.result}`,
    `HTTP status: ${display(result.http_status)}`,
    `Error type: ${result.provider_error_type ?? "—"}`,
    `Provider code: ${result.provider_error_code ?? "—"}`,
    `Provider: ${result.provider_name ?? "—"}`,
    `Message: ${result.error ? escapeInline(result.error) : "—"}`,
    `Time: ${result.elapsed_ms} ms`,
    `Reasoning: ${display(result.reasoning_tokens)}`,
    `Completion: ${display(result.completion_tokens)}`,
    `Total: ${display(result.total_tokens)}`,
    `Cost: ${display(result.cost)}`
  ].join("; ") + ".";
}

function difference(candidate: number | null, baseline: number | null) {
  return candidate === null || baseline === null ? null : candidate - baseline;
}

function display(value: number | null) {
  return value === null ? "—" : String(value);
}

function escapeInline(value: string) {
  return value.replace(/\s+/g, " ").replace(/`/g, "\\`").trim();
}

function escapeTable(value: string) {
  return escapeInline(value).replace(/\|/g, "\\|");
}

function assertFixedInput(input: WritingReviewCandidateInput) {
  if (
    input.attemptId !== WRITING_REVIEW_CANDIDATE_ATTEMPT_ID ||
    input.taskType !== WRITING_REVIEW_CANDIDATE_TASK_TYPE
  ) {
    throw new Error("Candidate benchmark requires the fixed weak AD attempt.");
  }
}

function assertSelectedConfigs(configs: readonly WritingReviewCandidateConfig[]) {
  if (configs.length === 0 || configs.length > WRITING_REVIEW_CANDIDATE_CONFIGS.length) {
    throw new Error("Candidate benchmark requires one of the supported config groups.");
  }
  let previousIndex = -1;
  for (const config of configs) {
    const index = WRITING_REVIEW_CANDIDATE_CONFIGS.findIndex(
      (candidate) => candidate.label === config.label
    );
    if (index <= previousIndex || WRITING_REVIEW_CANDIDATE_CONFIGS[index] !== config) {
      throw new Error("Candidate benchmark configs must be a supported ordered subset.");
    }
    previousIndex = index;
  }
}

function assertSelectedResults(results: WritingReviewCandidateResult[]) {
  if (results.length === 0 || results.length > WRITING_REVIEW_CANDIDATE_CONFIGS.length) {
    throw new Error("Candidate benchmark requires supported ordered results.");
  }
  let previousIndex = -1;
  for (const result of results) {
    const index = WRITING_REVIEW_CANDIDATE_CONFIGS.findIndex(
      (config) => config.label === result.label
    );
    if (index <= previousIndex) {
      throw new Error("Candidate benchmark results are not in supported order.");
    }
    previousIndex = index;
  }
}

function errorCode(error: unknown) {
  return isRecord(error) && typeof error.code === "string"
    ? error.code
    : "OPENROUTER_REQUEST_FAILED";
}

function safeErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return "Unknown candidate benchmark error.";
  const issues = "issues" in error ? (error as { issues?: unknown }).issues : undefined;
  return Array.isArray(issues)
    ? `${error.message} Issues: ${JSON.stringify(issues)}`
    : error.message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
