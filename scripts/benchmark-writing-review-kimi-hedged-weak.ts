import { resolve } from "node:path";
import type {
  WritingReviewKimiHedgedWeakInput,
  WritingReviewKimiSingleBaselineRun
} from "../lib/writingReviewKimiHedgedWeakBenchmark.ts";

type SupabaseServerModule = typeof import("../lib/supabase/server");
type ReviewSourceModule = typeof import("../lib/writingReviewSource");
type OpenRouterModule = typeof import("../lib/openrouterWritingReview");
type ReviewSchemaModule = typeof import("../lib/writingReviewSchemaV22");
type BenchmarkModule =
  typeof import("../lib/writingReviewKimiHedgedWeakBenchmark");

void run().catch((error) => {
  console.error(
    `Kimi hedged weak benchmark stopped: ${
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

  const benchmarkPath = "../lib/writingReviewKimiHedgedWeakBenchmark.ts";
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

  const baselines: WritingReviewKimiSingleBaselineRun[][] =
    benchmark.WRITING_REVIEW_KIMI_HEDGED_WEAK_CASES.map((benchmarkCase) =>
      benchmark.WRITING_REVIEW_KIMI_HEDGED_BASELINE_SOURCES.map((sourceInfo) =>
        benchmark.readWritingReviewKimiSingleBaseline(
          benchmarkCase,
          sourceInfo.run,
          resolve(
            process.cwd(),
            sourceInfo.directory,
            sourceInfo.fileName(benchmarkCase.case_label)
          )
        )
      ).filter(
        (run): run is WritingReviewKimiSingleBaselineRun => run !== null
      )
    );
  if (baselines.some((runs) => runs.length !== 3)) {
    throw new Error("One or more required single-request baseline files are missing or invalid.");
  }

  const supabase = supabaseServer.createServiceSupabase();
  const inputs: WritingReviewKimiHedgedWeakInput[] = [];
  for (const benchmarkCase of benchmark.WRITING_REVIEW_KIMI_HEDGED_WEAK_CASES) {
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

  const results = await benchmark.benchmarkWritingReviewKimiHedgedWeak(
    inputs,
    {
      onRequestStart: (input, request) =>
        console.log(`Starting ${input.caseLabel}: ${request}`),
      requestAI: (input, signal) =>
        openRouter.requestOpenRouterWritingReview(input, {
          jsonSchema:
            schema.AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA as unknown as Record<
              string,
              unknown
            >,
          modelOverride: benchmark.WRITING_REVIEW_KIMI_HEDGED_WEAK_MODEL,
          reasoningEffort: benchmark.WRITING_REVIEW_KIMI_HEDGED_WEAK_EFFORT,
          signal
        }),
      parseRawReview: schema.parseAIReviewRawResultV22,
      parseReview: schema.parseAIReviewRawResultV22ForResponse
    }
  );

  const outputDir = resolve(
    process.cwd(),
    benchmark.WRITING_REVIEW_KIMI_HEDGED_WEAK_OUTPUT_DIR
  );
  benchmark.writeWritingReviewKimiHedgedWeakFiles(
    outputDir,
    results,
    baselines
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
    hedge_triggered: boolean;
    requests_started: number;
    winner: string | null;
    end_to_end_elapsed_ms: number;
    winner_cost: number | null;
    observed_completed_cost: number | null;
  }>
) {
  console.log("\nKimi K3 High — 60s Hedged Weak Cases\n");
  console.log(
    "Case | Result | Hedged | Requests | Winner | Time | Winner Cost | Observed Cost"
  );
  results.forEach((result) => {
    console.log(
      [
        result.case_label,
        result.result,
        result.hedge_triggered,
        result.requests_started,
        result.winner ?? "—",
        result.end_to_end_elapsed_ms,
        display(result.winner_cost),
        display(result.observed_completed_cost)
      ].join(" | ")
    );
  });
  console.log("");
}

function display(value: number | null) {
  return value === null ? "—" : String(value);
}
