import { resolve } from "node:path";
import type { WritingReviewReasoningStabilityInput } from "../lib/writingReviewReasoningStabilityBenchmark.ts";

type SupabaseServerModule = typeof import("../lib/supabase/server");
type ReviewSourceModule = typeof import("../lib/writingReviewSource");
type OpenRouterModule = typeof import("../lib/openrouterWritingReview");
type ReviewSchemaModule = typeof import("../lib/writingReviewSchemaV22");
type BenchmarkModule =
  typeof import("../lib/writingReviewReasoningStabilityBenchmark");

void run().catch((error) => {
  console.error(
    `Reasoning stability benchmark stopped: ${
      error instanceof Error ? error.message : "Unknown error."
    }`
  );
  process.exitCode = 1;
});

async function run() {
  requireEnvironment();
  const benchmarkPath = "../lib/writingReviewReasoningStabilityBenchmark.ts";
  const sourcePath = "../lib/writingReviewSource.ts";
  const supabasePath = "../lib/supabase/server.ts";
  const openRouterPath = "../lib/openrouterWritingReview.ts";
  const schemaPath = "../lib/writingReviewSchemaV22.ts";
  const [benchmark, source, supabaseServer, openRouter, schema] =
    await Promise.all([
      import(benchmarkPath) as Promise<BenchmarkModule>,
      import(sourcePath) as Promise<ReviewSourceModule>,
      import(supabasePath) as Promise<SupabaseServerModule>,
      import(openRouterPath) as Promise<OpenRouterModule>,
      import(schemaPath) as Promise<ReviewSchemaModule>
    ]);

  const supabase = supabaseServer.createServiceSupabase();
  const inputs: WritingReviewReasoningStabilityInput[] = [];
  for (const benchmarkCase of benchmark.WRITING_REVIEW_REASONING_STABILITY_CASES) {
    const { attempt, question } = await source.loadWritingReviewComparisonSource(
      supabase,
      benchmarkCase.attempt_id
    );
    inputs.push({
      attemptId: attempt.attempt_id,
      caseLabel: benchmarkCase.case_label,
      qualityLabel: benchmarkCase.quality_label,
      taskType: attempt.task_type,
      question: question as unknown as Record<string, unknown>,
      responseText: attempt.response_text
    });
  }

  const results = await benchmark.benchmarkWritingReviewReasoningStability(
    inputs,
    {
      onRequestStart: (input, effort) =>
        console.log(`Starting case: ${input.caseLabel} (${effort})`),
      requestAI: (input, effort, signal) =>
        openRouter.requestOpenRouterWritingReview(input, {
          jsonSchema:
            schema.AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA as unknown as Record<
              string,
              unknown
            >,
          modelOverride: benchmark.WRITING_REVIEW_REASONING_STABILITY_MODEL,
          reasoningEffort: effort,
          signal
        }),
      parseReview: schema.parseAIReviewRawResultV22ForResponse
    }
  );

  const outputDir = resolve(
    process.cwd(),
    benchmark.WRITING_REVIEW_REASONING_STABILITY_OUTPUT_DIR
  );
  const summary = benchmark.writeWritingReviewReasoningStabilityFiles(
    outputDir,
    results
  );
  printResultTable(results);
  printAggregateTable(summary.aggregate);
  console.log(`Output directory: ${outputDir}`);
}

function requireEnvironment() {
  const required = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "OPENROUTER_API_KEY"
  ];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

function printResultTable(
  results: Array<{
    case_label: string;
    reasoning_effort: string;
    result: string;
    elapsed_ms: number;
    reasoning_tokens: number | null;
    total_tokens: number | null;
    cost: number | null;
    official_score: number | null;
    language_edit_count: number | null;
    content_feedback_count: number | null;
  }>
) {
  console.log("\nReasoning Stability Benchmark\n");
  console.log(
    "Case | Effort | Result | Time | Reasoning | Total | Cost | Score | L.Edits | Feedback"
  );
  for (const result of results) {
    console.log(
      [
        result.case_label,
        result.reasoning_effort,
        result.result,
        result.elapsed_ms,
        display(result.reasoning_tokens),
        display(result.total_tokens),
        display(result.cost),
        display(result.official_score),
        display(result.language_edit_count),
        display(result.content_feedback_count)
      ].join(" | ")
    );
  }
  console.log("");
}

function printAggregateTable(
  aggregate: Record<
    "max" | "high",
    {
      success_count: number;
      avg_elapsed_ms: number | null;
      median_elapsed_ms: number | null;
      avg_reasoning_tokens: number | null;
      avg_total_tokens: number | null;
      avg_cost: number | null;
    }
  >
) {
  console.log(
    "Effort | Success | Avg Time | Median Time | Avg Reasoning | Avg Total | Avg Cost"
  );
  for (const effort of ["max", "high"] as const) {
    const result = aggregate[effort];
    console.log(
      [
        effort,
        result.success_count,
        display(result.avg_elapsed_ms),
        display(result.median_elapsed_ms),
        display(result.avg_reasoning_tokens),
        display(result.avg_total_tokens),
        display(result.avg_cost)
      ].join(" | ")
    );
  }
  console.log("");
}

function display(value: number | null) {
  return value === null ? "—" : String(value);
}
