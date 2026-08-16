import { resolve } from "node:path";
import type { WritingReviewKimiWeakRetestInput } from "../lib/writingReviewKimiWeakRetestBenchmark.ts";

type SupabaseServerModule = typeof import("../lib/supabase/server");
type ReviewSourceModule = typeof import("../lib/writingReviewSource");
type OpenRouterModule = typeof import("../lib/openrouterWritingReview");
type ReviewSchemaModule = typeof import("../lib/writingReviewSchemaV22");
type BenchmarkModule =
  typeof import("../lib/writingReviewKimiWeakRetestBenchmark");

void run().catch((error) => {
  console.error(
    `Kimi weak-case retest stopped: ${
      error instanceof Error ? error.message : "Unknown error."
    }`
  );
  process.exitCode = 1;
});

async function run() {
  if (process.argv.slice(2).some((argument) => argument !== "--")) {
    throw new Error("This benchmark does not accept arguments.");
  }
  requireEnvironment();

  const benchmarkPath = "../lib/writingReviewKimiWeakRetestBenchmark.ts";
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
  const inputs: WritingReviewKimiWeakRetestInput[] = [];
  for (const benchmarkCase of benchmark.WRITING_REVIEW_KIMI_WEAK_RETEST_CASES) {
    const { attempt, question } = await source.loadWritingReviewComparisonSource(
      supabase,
      benchmarkCase.attempt_id
    );
    if (attempt.task_type !== benchmarkCase.task_type) {
      throw new Error(`Task type mismatch for ${benchmarkCase.case_label}.`);
    }
    inputs.push({
      attemptId: attempt.attempt_id,
      caseLabel: benchmarkCase.case_label,
      qualityLabel: benchmarkCase.quality_label,
      taskType: attempt.task_type,
      question: question as unknown as Record<string, unknown>,
      responseText: attempt.response_text
    });
  }

  const results = await benchmark.benchmarkWritingReviewKimiWeakRetest(
    inputs,
    {
      onRequestStart: (input) =>
        console.log(`Starting case: ${input.caseLabel}`),
      requestAI: (input, signal) =>
        openRouter.requestOpenRouterWritingReview(input, {
          jsonSchema:
            schema.AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA as unknown as Record<
              string,
              unknown
            >,
          modelOverride: benchmark.WRITING_REVIEW_KIMI_WEAK_RETEST_MODEL,
          reasoningEffort: benchmark.WRITING_REVIEW_KIMI_WEAK_RETEST_EFFORT,
          signal
        }),
      parseRawReview: schema.parseAIReviewRawResultV22,
      parseReview: schema.parseAIReviewRawResultV22ForResponse
    }
  );

  const historical = benchmark.WRITING_REVIEW_KIMI_WEAK_RETEST_CASES.map(
    (benchmarkCase) =>
      benchmark.readWritingReviewKimiWeakStoredRun(
        benchmarkCase,
        "historical",
        resolve(
          process.cwd(),
          benchmark.WRITING_REVIEW_KIMI_WEAK_RETEST_HISTORICAL_DIR,
          `${benchmarkCase.case_label}-high.json`
        )
      )
  );
  const round1 = benchmark.WRITING_REVIEW_KIMI_WEAK_RETEST_CASES.map(
    (benchmarkCase) =>
      benchmark.readWritingReviewKimiWeakStoredRun(
        benchmarkCase,
        "current_prompt_round1",
        resolve(
          process.cwd(),
          benchmark.WRITING_REVIEW_KIMI_WEAK_RETEST_ROUND1_DIR,
          `${benchmarkCase.case_label.replace("_", "-")}.json`
        )
      )
  );
  const outputDir = resolve(
    process.cwd(),
    benchmark.WRITING_REVIEW_KIMI_WEAK_RETEST_OUTPUT_DIR
  );
  benchmark.writeWritingReviewKimiWeakRetestFiles(
    outputDir,
    results,
    historical,
    round1
  );
  printResultTable(results);
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
    result: string;
    elapsed_ms: number;
    reasoning_tokens: number | null;
    total_tokens: number | null;
    cost: number | null;
    official_score: number | null;
    raw_official_score: number | null;
    language_edit_count: number | null;
    raw_language_edit_count: number | null;
    content_feedback_count: number | null;
    raw_content_feedback_count: number | null;
  }>
) {
  console.log("\nKimi K3 High — Weak Case Retest\n");
  console.log(
    "Case | Result | Time | Reasoning | Total | Cost | Score | Edits | Feedback"
  );
  results.forEach((result) => {
    console.log(
      [
        result.case_label,
        result.result,
        result.elapsed_ms,
        display(result.reasoning_tokens),
        display(result.total_tokens),
        display(result.cost),
        display(result.official_score ?? result.raw_official_score),
        display(result.language_edit_count ?? result.raw_language_edit_count),
        display(
          result.content_feedback_count ?? result.raw_content_feedback_count
        )
      ].join(" | ")
    );
  });
  console.log("");
}

function display(value: number | null) {
  return value === null ? "—" : String(value);
}
