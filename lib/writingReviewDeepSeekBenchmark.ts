import { mkdirSync, writeFileSync } from "node:fs";
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
import {
  readWritingReviewCandidateKimiBaseline,
  type WritingReviewCandidateBaseline
} from "./writingReviewCandidateModelBenchmark.ts";
import type {
  AIReviewRawResultV22,
  AIReviewResultV22
} from "./writingReviewSchemaV22.ts";

export const WRITING_REVIEW_DEEPSEEK_ATTEMPT_ID =
  "a7ad7e9f-b4ef-4ee0-9b39-43f1d7020cdc";
export const WRITING_REVIEW_DEEPSEEK_TASK_TYPE =
  "academic_discussion" as const;
export const WRITING_REVIEW_DEEPSEEK_CONFIGS = [
  {
    label: "deepseek_flash_high",
    display_name: "DeepSeek V4 Flash High",
    model: "deepseek/deepseek-v4-flash",
    reasoning_effort: "high"
  },
  {
    label: "deepseek_pro_high",
    display_name: "DeepSeek V4 Pro High",
    model: "deepseek/deepseek-v4-pro",
    reasoning_effort: "high"
  }
] as const;
export const WRITING_REVIEW_DEEPSEEK_PROVIDER = "openrouter" as const;
export const WRITING_REVIEW_DEEPSEEK_OPERATION =
  "deepseek_model_benchmark" as const;
export const WRITING_REVIEW_DEEPSEEK_TIMEOUT_MS =
  WRITING_REVIEW_FULL_REQUEST_TIMEOUT_MS;
export const WRITING_REVIEW_DEEPSEEK_OUTPUT_DIR =
  "tmp/writing-review-deepseek-comparison";
export const WRITING_REVIEW_DEEPSEEK_KIMI_BASELINE_PATH =
  "tmp/writing-review-reasoning-stability/ad_weak-high.json";

export type WritingReviewDeepSeekConfig =
  (typeof WRITING_REVIEW_DEEPSEEK_CONFIGS)[number];
export type WritingReviewDeepSeekLabel = WritingReviewDeepSeekConfig["label"];
export type WritingReviewDeepSeekSelection = "all" | "flash" | "pro";
type ScoreMap = Record<string, number>;
type CategoryCounts = Record<string, number>;
type ValidationIssue = { path: string; message: string };
type EditPair = Pick<
  AIReviewRawResultV22["language_edits"][number],
  "original_text" | "replacement_text"
>;

export type WritingReviewDeepSeekInput = OpenRouterWritingReviewInput & {
  attemptId: typeof WRITING_REVIEW_DEEPSEEK_ATTEMPT_ID;
  taskType: typeof WRITING_REVIEW_DEEPSEEK_TASK_TYPE;
};

export type WritingReviewDeepSeekResult = OpenRouterTokenUsage & {
  label: WritingReviewDeepSeekLabel;
  provider: typeof WRITING_REVIEW_DEEPSEEK_PROVIDER;
  model: WritingReviewDeepSeekConfig["model"];
  reasoning_effort: "high";
  operation: typeof WRITING_REVIEW_DEEPSEEK_OPERATION;
  attempt_id: typeof WRITING_REVIEW_DEEPSEEK_ATTEMPT_ID;
  task_type: typeof WRITING_REVIEW_DEEPSEEK_TASK_TYPE;
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
  dimension_scores: ScoreMap | null;
  language_edit_count: number | null;
  content_feedback_count: number | null;
  content_feedback_categories: CategoryCounts;
  overall_feedback: string | null;
  raw_official_score: number | null;
  raw_dimension_scores: ScoreMap | null;
  raw_language_edit_count: number | null;
  raw_content_feedback_count: number | null;
  raw_content_feedback_categories: CategoryCounts;
  localization_issue_count: number;
  localization_issues: ValidationIssue[];
  validated_result: AIReviewResultV22 | null;
  validated_raw_result: AIReviewRawResultV22 | null;
};

export type WritingReviewDeepSeekEditComparison = {
  baseline_available: boolean;
  source: "final" | "raw" | null;
  shared_edits: EditPair[];
  kimi_only_edits: EditPair[];
  candidate_only_edits: EditPair[];
};

export type WritingReviewDeepSeekDirectComparison = {
  flash_source: "final" | "raw" | null;
  pro_source: "final" | "raw" | null;
  official_score_delta: number | null;
  dimension_score_deltas: Record<string, number | null>;
  flash_language_edit_count: number | null;
  pro_language_edit_count: number | null;
  flash_content_feedback_count: number | null;
  pro_content_feedback_count: number | null;
  flash_content_feedback_categories: CategoryCounts;
  pro_content_feedback_categories: CategoryCounts;
  shared_edits: EditPair[];
  flash_only_edits: EditPair[];
  pro_only_edits: EditPair[];
  elapsed_ms_delta: number;
  reasoning_tokens_delta: number | null;
  total_tokens_delta: number | null;
  cost_delta: number | null;
};

export type WritingReviewDeepSeekSummary = {
  attempt_id: typeof WRITING_REVIEW_DEEPSEEK_ATTEMPT_ID;
  task_type: typeof WRITING_REVIEW_DEEPSEEK_TASK_TYPE;
  provider: typeof WRITING_REVIEW_DEEPSEEK_PROVIDER;
  baseline: Omit<WritingReviewCandidateBaseline, "validated_result"> | null;
  results: Array<
    Omit<
      WritingReviewDeepSeekResult,
      "validated_result" | "validated_raw_result" | "localization_issues"
    >
  >;
  kimi_edit_comparisons: Partial<Record<
    WritingReviewDeepSeekLabel,
    WritingReviewDeepSeekEditComparison
  >>;
  flash_vs_pro: WritingReviewDeepSeekDirectComparison | null;
};

export type WritingReviewDeepSeekDependencies = {
  now?: () => number;
  timeoutMs?: number;
  configs?: readonly WritingReviewDeepSeekConfig[];
  onConfigStart?(config: WritingReviewDeepSeekConfig): void;
  onConfigComplete?(result: WritingReviewDeepSeekResult): void;
  requestWithTimeout?<T>(
    request: (signal: AbortSignal) => Promise<T>,
    options: { timeoutMs: number; timeoutMessage: string }
  ): Promise<T>;
  requestAI(
    input: OpenRouterWritingReviewInput,
    config: WritingReviewDeepSeekConfig,
    signal: AbortSignal
  ): Promise<OpenRouterWritingReviewResponse>;
  parseRawReview(value: unknown): AIReviewRawResultV22;
  parseReview(value: unknown, responseText: string): AIReviewResultV22;
};

export async function benchmarkWritingReviewDeepSeekModels(
  input: WritingReviewDeepSeekInput,
  dependencies: WritingReviewDeepSeekDependencies
) {
  assertFixedInput(input);
  const now = dependencies.now ?? (() => Date.now());
  const timeoutMs = dependencies.timeoutMs ?? WRITING_REVIEW_DEEPSEEK_TIMEOUT_MS;
  const withTimeout = dependencies.requestWithTimeout ?? requestOpenRouterWithTimeout;
  const configs = dependencies.configs ?? WRITING_REVIEW_DEEPSEEK_CONFIGS;
  assertSelectedConfigs(configs);
  const results: WritingReviewDeepSeekResult[] = [];

  // Deliberately sequential: each supported configuration is requested once.
  for (const config of configs) {
    dependencies.onConfigStart?.(config);
    const startedAt = now();
    let usage: OpenRouterTokenUsage = { ...EMPTY_OPENROUTER_USAGE };
    let result: WritingReviewDeepSeekResult;
    try {
      const response = await withTimeout(
        (signal) => dependencies.requestAI(input, config, signal),
        { timeoutMs, timeoutMessage: `${config.label} timed out.` }
      );
      usage = response.usage;
      let value: unknown;
      try {
        value = JSON.parse(response.content) as unknown;
      } catch {
        result = failureResult(input, config, now() - startedAt, usage, {
          result: "invalid_json",
          errorCode: "AI_RESPONSE_INVALID_JSON",
          error: new Error("OpenRouter returned invalid JSON.")
        });
        results.push(result);
        dependencies.onConfigComplete?.(result);
        continue;
      }

      let raw: AIReviewRawResultV22;
      try {
        raw = dependencies.parseRawReview(value);
        if (
          raw.schema_version !== "2.2" ||
          raw.task_type !== WRITING_REVIEW_DEEPSEEK_TASK_TYPE
        ) {
          throw new Error("DeepSeek response did not match the AD v2.2 schema.");
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

      try {
        const validated = dependencies.parseReview(value, input.responseText);
        result = successResult(
          input,
          config,
          now() - startedAt,
          usage,
          validated
        );
      } catch (error) {
        result = localizationFailureResult(
          input,
          config,
          now() - startedAt,
          usage,
          raw,
          error
        );
      }
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

export function parseWritingReviewDeepSeekArguments(arguments_: string[]) {
  const argumentsWithoutSeparator = arguments_.filter((argument) => argument !== "--");
  let selection: WritingReviewDeepSeekSelection = "all";
  let error: string | null = null;
  for (let index = 0; index < argumentsWithoutSeparator.length; index += 1) {
    const argument = argumentsWithoutSeparator[index];
    if (argument !== "--only") {
      error ??= `Unknown option: ${argument}`;
      continue;
    }
    const value = argumentsWithoutSeparator[index + 1];
    if (!value || value.startsWith("--")) {
      error ??= "--only requires all, flash, or pro";
      continue;
    }
    if (value !== "all" && value !== "flash" && value !== "pro") {
      error ??= `Invalid --only value: ${value}`;
    } else {
      selection = value;
    }
    index += 1;
  }
  return { selection, error };
}

export function selectWritingReviewDeepSeekConfigs(
  selection: WritingReviewDeepSeekSelection
) {
  if (selection === "all") return WRITING_REVIEW_DEEPSEEK_CONFIGS;
  return WRITING_REVIEW_DEEPSEEK_CONFIGS.filter((config) =>
    selection === "flash"
      ? config.label === "deepseek_flash_high"
      : config.label === "deepseek_pro_high"
  );
}

function baseResult(
  input: WritingReviewDeepSeekInput,
  config: WritingReviewDeepSeekConfig,
  elapsedMs: number,
  usage: OpenRouterTokenUsage
) {
  return {
    label: config.label,
    provider: WRITING_REVIEW_DEEPSEEK_PROVIDER,
    model: config.model,
    reasoning_effort: config.reasoning_effort,
    operation: WRITING_REVIEW_DEEPSEEK_OPERATION,
    attempt_id: input.attemptId,
    task_type: input.taskType,
    elapsed_ms: Math.max(0, elapsedMs),
    ...usage
  } as const;
}

function successResult(
  input: WritingReviewDeepSeekInput,
  config: WritingReviewDeepSeekConfig,
  elapsedMs: number,
  usage: OpenRouterTokenUsage,
  validated: AIReviewResultV22
): WritingReviewDeepSeekResult {
  return {
    ...baseResult(input, config, elapsedMs, usage),
    result: "success",
    error_code: null,
    error: null,
    http_status: null,
    provider_error_type: null,
    provider_error_code: null,
    provider_name: null,
    schema_valid: true,
    official_score: validated.scores.official_score.ai_score,
    dimension_scores: scoreDimensions(validated),
    language_edit_count: validated.language_edits.length,
    content_feedback_count: validated.content_feedback.length,
    content_feedback_categories: countFeedbackCategories(validated),
    overall_feedback: validated.overall_feedback,
    raw_official_score: null,
    raw_dimension_scores: null,
    raw_language_edit_count: null,
    raw_content_feedback_count: null,
    raw_content_feedback_categories: {},
    localization_issue_count: 0,
    localization_issues: [],
    validated_result: validated,
    validated_raw_result: null
  };
}

function localizationFailureResult(
  input: WritingReviewDeepSeekInput,
  config: WritingReviewDeepSeekConfig,
  elapsedMs: number,
  usage: OpenRouterTokenUsage,
  raw: AIReviewRawResultV22,
  error: unknown
): WritingReviewDeepSeekResult {
  const issues = safeValidationIssues(error);
  return {
    ...baseResult(input, config, elapsedMs, usage),
    result: "localization_error",
    error_code: "AI_RESPONSE_LOCALIZATION_FAILED",
    error: safeErrorMessage(error),
    http_status: null,
    provider_error_type: null,
    provider_error_code: null,
    provider_name: null,
    schema_valid: true,
    official_score: null,
    dimension_scores: null,
    language_edit_count: null,
    content_feedback_count: null,
    content_feedback_categories: {},
    overall_feedback: null,
    raw_official_score: raw.scores.official_score.ai_score,
    raw_dimension_scores: scoreDimensions(raw),
    raw_language_edit_count: raw.language_edits.length,
    raw_content_feedback_count: raw.content_feedback.length,
    raw_content_feedback_categories: countFeedbackCategories(raw),
    localization_issue_count: issues.length,
    localization_issues: issues,
    validated_result: null,
    validated_raw_result: raw
  };
}

function failureResult(
  input: WritingReviewDeepSeekInput,
  config: WritingReviewDeepSeekConfig,
  elapsedMs: number,
  usage: OpenRouterTokenUsage,
  failure: {
    result: "timeout" | "provider_error" | "invalid_json" | "validation_error";
    errorCode: string;
    error: unknown;
  }
): WritingReviewDeepSeekResult {
  const diagnostic = getOpenRouterErrorDiagnostic(failure.error);
  return {
    ...baseResult(input, config, elapsedMs, usage),
    result: failure.result,
    error_code: failure.errorCode,
    error: safeErrorMessage(failure.error),
    http_status: diagnostic.http_status,
    provider_error_type: diagnostic.error_type,
    provider_error_code: diagnostic.provider_code,
    provider_name: diagnostic.provider_name,
    schema_valid: false,
    official_score: null,
    dimension_scores: null,
    language_edit_count: null,
    content_feedback_count: null,
    content_feedback_categories: {},
    overall_feedback: null,
    raw_official_score: null,
    raw_dimension_scores: null,
    raw_language_edit_count: null,
    raw_content_feedback_count: null,
    raw_content_feedback_categories: {},
    localization_issue_count: 0,
    localization_issues: [],
    validated_result: null,
    validated_raw_result: null
  };
}

export function readWritingReviewDeepSeekKimiBaseline(
  filePath: string,
  readFile?: Parameters<typeof readWritingReviewCandidateKimiBaseline>[1]
) {
  return readWritingReviewCandidateKimiBaseline(filePath, readFile);
}

export function buildWritingReviewDeepSeekSummary(
  results: WritingReviewDeepSeekResult[],
  baseline: WritingReviewCandidateBaseline | null
): WritingReviewDeepSeekSummary {
  assertResults(results);
  return {
    attempt_id: WRITING_REVIEW_DEEPSEEK_ATTEMPT_ID,
    task_type: WRITING_REVIEW_DEEPSEEK_TASK_TYPE,
    provider: WRITING_REVIEW_DEEPSEEK_PROVIDER,
    baseline: baseline
      ? (({ validated_result: _validatedResult, ...summary }) => summary)(baseline)
      : null,
    results: results.map(
      ({
        validated_result: _validatedResult,
        validated_raw_result: _validatedRawResult,
        localization_issues: _localizationIssues,
        ...result
      }) => result
    ),
    kimi_edit_comparisons: Object.fromEntries(
      results.map((result) => [result.label, compareWithKimi(result, baseline)])
    ) as WritingReviewDeepSeekSummary["kimi_edit_comparisons"],
    flash_vs_pro:
      results.length === 2 ? compareFlashAndPro(results[0], results[1]) : null
  };
}

export function writeWritingReviewDeepSeekFiles(
  outputDir: string,
  results: WritingReviewDeepSeekResult[],
  baseline: WritingReviewCandidateBaseline | null,
  fileSystem: {
    mkdirSync: typeof mkdirSync;
    writeFileSync: typeof writeFileSync;
  } = { mkdirSync, writeFileSync }
) {
  assertResults(results);
  fileSystem.mkdirSync(outputDir, { recursive: true });
  const detailNames: Record<WritingReviewDeepSeekLabel, string> = {
    deepseek_flash_high: "deepseek-flash-high.json",
    deepseek_pro_high: "deepseek-pro-high.json"
  };
  for (const result of results) {
    fileSystem.writeFileSync(
      join(outputDir, detailNames[result.label]),
      `${JSON.stringify(result, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  }
  const summary = buildWritingReviewDeepSeekSummary(results, baseline);
  fileSystem.writeFileSync(
    join(outputDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  fileSystem.writeFileSync(
    join(outputDir, "comparison.md"),
    buildWritingReviewDeepSeekMarkdown(results, baseline),
    { encoding: "utf8", mode: 0o600 }
  );
  return summary;
}

export function buildWritingReviewDeepSeekMarkdown(
  results: WritingReviewDeepSeekResult[],
  baseline: WritingReviewCandidateBaseline | null
) {
  const summary = buildWritingReviewDeepSeekSummary(results, baseline);
  const lines = [
    results.length === 2
      ? "# DeepSeek V4 Flash vs V4 Pro"
      : `# ${displayName(results[0].label)} Retest`,
    "",
    "| Model | Result | Time | Reasoning | Completion | Total | Cost | Score | Edits | Feedback |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    baseline
      ? performanceRow("Kimi K3 high baseline", baseline)
      : "| Kimi K3 high baseline | unavailable | — | — | — | — | — | — | — | — |",
    ...results.map((result) => performanceRow(displayName(result.label), result))
  ];

  for (const result of results) {
    const review = comparableReview(result);
    const score = comparableScores(result);
    const kimiComparison = summary.kimi_edit_comparisons[result.label]!;
    lines.push(
      "",
      `## ${displayName(result.label)}`,
      "",
      "### Status",
      "",
      `- Result: ${result.result}`,
      `- Schema valid: ${result.schema_valid}`,
      `- Error: ${result.error ? escapeInline(result.error) : "—"}`,
      "",
      "### Scores",
      "",
      `- Official score: ${display(score.official)}`,
      `- Dimensions: ${formatRecord(score.dimensions)}`,
      "",
      result.result === "localization_error"
        ? "### Raw Language Edits Before Localization"
        : "### Language Edits",
      "",
      ...(result.result === "localization_error" ? ["**Localization failed.**", ""] : []),
      ...formatEdits(review),
      "",
      `- Exact shared with Kimi high (${kimiComparison.shared_edits.length}): ${formatEditPairs(kimiComparison.shared_edits)}`,
      `- Kimi high only (${kimiComparison.kimi_only_edits.length}): ${formatEditPairs(kimiComparison.kimi_only_edits)}`,
      `- DeepSeek only (${kimiComparison.candidate_only_edits.length}): ${formatEditPairs(kimiComparison.candidate_only_edits)}`,
      "",
      "> Exact matching is only an aid. Different spans can represent the same issue and are not an automatic quality verdict.",
      "",
      "### Content Feedback",
      "",
      ...formatFeedback(review),
      "",
      `- Categories: ${formatRecord(comparableCategories(result))}`,
      "",
      "### Localization Issues",
      "",
      ...formatLocalizationIssues(result),
      "",
      "### Performance",
      "",
      ...performanceDetails(result)
    );
  }

  const direct = summary.flash_vs_pro;
  if (direct) {
    lines.push(
      "",
      "## Flash vs Pro",
      "",
      "### Scores",
      "",
      `- Official score delta (Pro - Flash): ${display(direct.official_score_delta)}`,
      `- Dimension deltas (Pro - Flash): ${formatNullableRecord(direct.dimension_score_deltas)}`,
      "",
      "### Language Edits",
      "",
      `- Flash source: ${direct.flash_source ?? "—"}; Pro source: ${direct.pro_source ?? "—"}`,
      `- Shared (${direct.shared_edits.length}): ${formatEditPairs(direct.shared_edits)}`,
      `- Flash only (${direct.flash_only_edits.length}): ${formatEditPairs(direct.flash_only_edits)}`,
      `- Pro only (${direct.pro_only_edits.length}): ${formatEditPairs(direct.pro_only_edits)}`,
      "",
      "### Content Feedback Categories",
      "",
      `- Flash (${display(direct.flash_content_feedback_count)}): ${formatRecord(direct.flash_content_feedback_categories)}`,
      `- Pro (${display(direct.pro_content_feedback_count)}): ${formatRecord(direct.pro_content_feedback_categories)}`,
      "",
      "### Performance",
      "",
      `- Elapsed delta (Pro - Flash): ${direct.elapsed_ms_delta} ms`,
      `- Reasoning token delta (Pro - Flash): ${display(direct.reasoning_tokens_delta)}`,
      `- Total token delta (Pro - Flash): ${display(direct.total_tokens_delta)}`,
      `- Cost delta (Pro - Flash): ${display(direct.cost_delta)}`
    );
  }
  lines.push(
    "",
    "## Manual QA Checklist",
    "",
    "- Official score 是否合理",
    "- 四项 dimension 是否合理",
    "- Relevance 是否只判断回应题目",
    "- teenage years vs age 10 是否进入 Elaboration",
    "- necessary 的论证问题是否识别",
    "- growth environments 是否识别",
    "- kindful people 是否识别",
    "- grammar errors 是否明显漏检",
    "- Word Choice 是否误入 Language Edits",
    "- proposed revisions 是否自然",
    "- Language Edit span 是否严格忠于原文",
    "- 是否仍有 non-unique original_text",
    "- 是否出现不存在于原文的 original_text",
    "- 是否出现 overlap",
    "- 是否出现原文空格或拼写被模型自行改写",
    "- 是否遵守最短唯一 span",
    "- 是否存在过度扩大 span",
    "- 多个 edits 同时应用后是否仍正确",
    "- 是否过度润色",
    "- Schema 是否一次成功",
    "- Localization 是否一次成功",
    ""
  );
  return `${lines.join("\n")}\n`;
}

function compareWithKimi(
  result: WritingReviewDeepSeekResult,
  baseline: WritingReviewCandidateBaseline | null
): WritingReviewDeepSeekEditComparison {
  const comparable = comparableReview(result);
  if (!baseline?.validated_result || !comparable) {
    return {
      baseline_available: baseline !== null,
      source: comparisonSource(result),
      shared_edits: [],
      kimi_only_edits: [],
      candidate_only_edits: []
    };
  }
  const candidate = editMap(comparable);
  const kimi = editMap(baseline.validated_result);
  return {
    baseline_available: true,
    source: comparisonSource(result),
    shared_edits: mapIntersection(candidate, kimi),
    kimi_only_edits: mapDifference(kimi, candidate),
    candidate_only_edits: mapDifference(candidate, kimi)
  };
}

function compareFlashAndPro(
  flash: WritingReviewDeepSeekResult,
  pro: WritingReviewDeepSeekResult
): WritingReviewDeepSeekDirectComparison {
  const flashReview = comparableReview(flash);
  const proReview = comparableReview(pro);
  const flashScores = comparableScores(flash);
  const proScores = comparableScores(pro);
  const flashEdits = editMap(flashReview);
  const proEdits = editMap(proReview);
  const dimensions = new Set([
    ...Object.keys(flashScores.dimensions ?? {}),
    ...Object.keys(proScores.dimensions ?? {})
  ]);
  return {
    flash_source: comparisonSource(flash),
    pro_source: comparisonSource(pro),
    official_score_delta: difference(proScores.official, flashScores.official),
    dimension_score_deltas: Object.fromEntries(
      Array.from(dimensions).map((key) => [
        key,
        difference(
          proScores.dimensions?.[key] ?? null,
          flashScores.dimensions?.[key] ?? null
        )
      ])
    ),
    flash_language_edit_count: comparableEditCount(flash),
    pro_language_edit_count: comparableEditCount(pro),
    flash_content_feedback_count: comparableFeedbackCount(flash),
    pro_content_feedback_count: comparableFeedbackCount(pro),
    flash_content_feedback_categories: comparableCategories(flash),
    pro_content_feedback_categories: comparableCategories(pro),
    shared_edits: mapIntersection(flashEdits, proEdits),
    flash_only_edits: mapDifference(flashEdits, proEdits),
    pro_only_edits: mapDifference(proEdits, flashEdits),
    elapsed_ms_delta: pro.elapsed_ms - flash.elapsed_ms,
    reasoning_tokens_delta: difference(pro.reasoning_tokens, flash.reasoning_tokens),
    total_tokens_delta: difference(pro.total_tokens, flash.total_tokens),
    cost_delta: difference(pro.cost, flash.cost)
  };
}

function comparableReview(result: WritingReviewDeepSeekResult) {
  return result.validated_result ?? result.validated_raw_result;
}

function comparisonSource(result: WritingReviewDeepSeekResult) {
  if (result.validated_result) return "final" as const;
  if (result.validated_raw_result) return "raw" as const;
  return null;
}

function comparableScores(result: WritingReviewDeepSeekResult) {
  return {
    official: result.official_score ?? result.raw_official_score,
    dimensions: result.dimension_scores ?? result.raw_dimension_scores
  };
}

function comparableEditCount(result: WritingReviewDeepSeekResult) {
  return result.language_edit_count ?? result.raw_language_edit_count;
}

function comparableFeedbackCount(result: WritingReviewDeepSeekResult) {
  return result.content_feedback_count ?? result.raw_content_feedback_count;
}

function comparableCategories(result: WritingReviewDeepSeekResult) {
  return result.result === "localization_error"
    ? result.raw_content_feedback_categories
    : result.content_feedback_categories;
}

function scoreDimensions(review: AIReviewRawResultV22 | AIReviewResultV22) {
  return Object.fromEntries(
    Object.entries(review.scores.dimension_scores).map(([key, score]) => [
      key,
      score.ai_score
    ])
  );
}

function countFeedbackCategories(
  review: AIReviewRawResultV22 | AIReviewResultV22
) {
  return review.content_feedback.reduce<CategoryCounts>((counts, feedback) => {
    counts[feedback.category] = (counts[feedback.category] ?? 0) + 1;
    return counts;
  }, {});
}

function editMap(review: AIReviewRawResultV22 | AIReviewResultV22 | null) {
  return new Map(
    (review?.language_edits ?? []).map((edit) => {
      const pair = {
        original_text: edit.original_text,
        replacement_text: edit.replacement_text
      };
      return [`${pair.original_text}\u0000${pair.replacement_text}`, pair] as const;
    })
  );
}

function mapIntersection(first: Map<string, EditPair>, second: Map<string, EditPair>) {
  return Array.from(first.entries())
    .filter(([key]) => second.has(key))
    .map(([, value]) => value);
}

function mapDifference(first: Map<string, EditPair>, second: Map<string, EditPair>) {
  return Array.from(first.entries())
    .filter(([key]) => !second.has(key))
    .map(([, value]) => value);
}

function safeValidationIssues(error: unknown): ValidationIssue[] {
  if (!isRecord(error) || !Array.isArray(error.issues)) return [];
  return error.issues.flatMap((issue) =>
    isRecord(issue) &&
    typeof issue.path === "string" &&
    typeof issue.message === "string"
      ? [{ path: issue.path, message: issue.message }]
      : []
  );
}

function safeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown benchmark error.";
}

function errorCode(error: unknown) {
  return isRecord(error) && typeof error.code === "string"
    ? error.code
    : "OPENROUTER_REQUEST_FAILED";
}

function assertFixedInput(input: WritingReviewDeepSeekInput) {
  if (
    input.attemptId !== WRITING_REVIEW_DEEPSEEK_ATTEMPT_ID ||
    input.taskType !== WRITING_REVIEW_DEEPSEEK_TASK_TYPE
  ) {
    throw new Error("DeepSeek benchmark requires the fixed weak AD attempt.");
  }
}

function assertResults(results: WritingReviewDeepSeekResult[]) {
  if (results.length === 0 || results.length > WRITING_REVIEW_DEEPSEEK_CONFIGS.length) {
    throw new Error("DeepSeek benchmark requires a supported result selection.");
  }
  let previousIndex = -1;
  for (const result of results) {
    const index = WRITING_REVIEW_DEEPSEEK_CONFIGS.findIndex(
      (config) => config.label === result.label
    );
    if (index <= previousIndex) {
      throw new Error("DeepSeek benchmark results are not in supported order.");
    }
    previousIndex = index;
  }
}

function assertSelectedConfigs(configs: readonly WritingReviewDeepSeekConfig[]) {
  if (configs.length === 0 || configs.length > WRITING_REVIEW_DEEPSEEK_CONFIGS.length) {
    throw new Error("DeepSeek benchmark requires a supported config selection.");
  }
  let previousIndex = -1;
  for (const config of configs) {
    const index = WRITING_REVIEW_DEEPSEEK_CONFIGS.findIndex(
      (candidate) => candidate.label === config.label
    );
    if (
      index <= previousIndex ||
      index < 0 ||
      WRITING_REVIEW_DEEPSEEK_CONFIGS[index] !== config
    ) {
      throw new Error("DeepSeek benchmark configs are not a supported ordered subset.");
    }
    previousIndex = index;
  }
}

function performanceRow(
  label: string,
  result: WritingReviewDeepSeekResult | WritingReviewCandidateBaseline
) {
  const score =
    "raw_official_score" in result
      ? result.official_score ?? result.raw_official_score
      : result.official_score;
  const edits =
    "raw_language_edit_count" in result
      ? result.language_edit_count ?? result.raw_language_edit_count
      : result.language_edit_count;
  const feedback =
    "raw_content_feedback_count" in result
      ? result.content_feedback_count ?? result.raw_content_feedback_count
      : result.content_feedback_count;
  return `| ${escapeTable(label)} | ${result.result} | ${display(result.elapsed_ms)} | ${display(result.reasoning_tokens)} | ${display(result.completion_tokens)} | ${display(result.total_tokens)} | ${display(result.cost)} | ${display(score)} | ${display(edits)} | ${display(feedback)} |`;
}

function performanceDetails(result: WritingReviewDeepSeekResult) {
  return [
    `- Label: ${result.label}`,
    `- Provider/model/effort: ${result.provider} / ${result.model} / ${result.reasoning_effort}`,
    `- Elapsed: ${result.elapsed_ms} ms`,
    `- Prompt/cached tokens: ${display(result.prompt_tokens)} / ${display(result.cached_tokens)}`,
    `- Completion/reasoning tokens: ${display(result.completion_tokens)} / ${display(result.reasoning_tokens)}`,
    `- Accepted/rejected prediction tokens: ${display(result.accepted_prediction_tokens)} / ${display(result.rejected_prediction_tokens)}`,
    `- Total tokens: ${display(result.total_tokens)}`,
    `- Cost: ${display(result.cost)}`,
    `- Upstream inference/prompt/completions cost: ${display(result.upstream_inference_cost)} / ${display(result.upstream_inference_prompt_cost)} / ${display(result.upstream_inference_completions_cost)}`,
    `- Provider diagnostic: HTTP ${display(result.http_status)}; type ${result.provider_error_type ?? "—"}; code ${result.provider_error_code ?? "—"}; provider ${result.provider_name ?? "—"}`
  ];
}

function formatEdits(review: AIReviewRawResultV22 | AIReviewResultV22 | null) {
  if (!review || review.language_edits.length === 0) return ["- —"];
  return review.language_edits.map(
    (edit) =>
      `- \`${escapeInline(edit.original_text)}\` → \`${escapeInline(edit.replacement_text)}\` — ${escapeInline(edit.category)}, ${escapeInline(edit.severity)}: ${escapeInline(edit.explanation)}`
  );
}

function formatEditPairs(edits: EditPair[]) {
  return edits.length === 0
    ? "—"
    : edits
        .map(
          (edit) =>
            `\`${escapeInline(edit.original_text)}\` → \`${escapeInline(edit.replacement_text)}\``
        )
        .join("; ");
}

function formatFeedback(review: AIReviewRawResultV22 | AIReviewResultV22 | null) {
  if (!review || review.content_feedback.length === 0) return ["- —"];
  return review.content_feedback.map(
    (feedback) =>
      `- **${escapeInline(feedback.category)}** — \`${escapeInline(feedback.original_sentence)}\` — ${escapeInline(feedback.issue)} — Proposed: \`${escapeInline(feedback.proposed_revision)}\``
  );
}

function formatLocalizationIssues(result: WritingReviewDeepSeekResult) {
  if (result.localization_issues.length === 0) return ["- —"];
  return result.localization_issues.map(
    (issue) => `- \`${escapeInline(issue.path)}\`: ${escapeInline(issue.message)}`
  );
}

function displayName(label: WritingReviewDeepSeekLabel) {
  return WRITING_REVIEW_DEEPSEEK_CONFIGS.find((config) => config.label === label)!
    .display_name;
}

function difference(left: number | null, right: number | null) {
  return left === null || right === null ? null : left - right;
}

function formatRecord(record: Record<string, number> | null) {
  if (!record || Object.keys(record).length === 0) return "—";
  return Object.entries(record)
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ");
}

function formatNullableRecord(record: Record<string, number | null>) {
  if (Object.keys(record).length === 0) return "—";
  return Object.entries(record)
    .map(([key, value]) => `${key}: ${display(value)}`)
    .join(", ");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
