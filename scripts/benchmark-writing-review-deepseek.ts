import { resolve } from "node:path";

type SupabaseServerModule = typeof import("../lib/supabase/server");
type ReviewSourceModule = typeof import("../lib/writingReviewSource");
type OpenRouterModule = typeof import("../lib/openrouterWritingReview");
type ReviewSchemaModule = typeof import("../lib/writingReviewSchemaV22");
type BenchmarkModule = typeof import("../lib/writingReviewDeepSeekBenchmark");

void run().catch((error) => {
  console.error(
    `DeepSeek writing benchmark stopped: ${
      error instanceof Error ? error.message : "Unknown error."
    }`
  );
  process.exitCode = 1;
});

async function run() {
  const benchmarkPath = "../lib/writingReviewDeepSeekBenchmark.ts";
  const benchmark = (await import(benchmarkPath)) as BenchmarkModule;
  const { selection, error } = benchmark.parseWritingReviewDeepSeekArguments(
    process.argv.slice(2)
  );
  if (error) {
    throw new Error(
      `${error}. Usage: pnpm benchmark:writing-deepseek -- --only all|flash|pro`
    );
  }
  requireEnvironment();
  const configs = benchmark.selectWritingReviewDeepSeekConfigs(selection);
  const sourcePath = "../lib/writingReviewSource.ts";
  const supabasePath = "../lib/supabase/server.ts";
  const openRouterPath = "../lib/openrouterWritingReview.ts";
  const schemaPath = "../lib/writingReviewSchemaV22.ts";
  const [source, supabaseServer, openRouter, schema] =
    await Promise.all([
      import(sourcePath) as Promise<ReviewSourceModule>,
      import(supabasePath) as Promise<SupabaseServerModule>,
      import(openRouterPath) as Promise<OpenRouterModule>,
      import(schemaPath) as Promise<ReviewSchemaModule>
    ]);

  const supabase = supabaseServer.createServiceSupabase();
  const { attempt, question } = await source.loadWritingReviewComparisonSource(
    supabase,
    benchmark.WRITING_REVIEW_DEEPSEEK_ATTEMPT_ID
  );
  if (attempt.task_type !== benchmark.WRITING_REVIEW_DEEPSEEK_TASK_TYPE) {
    throw new Error("The fixed DeepSeek benchmark attempt is not Academic Discussion.");
  }
  const input = {
    attemptId: benchmark.WRITING_REVIEW_DEEPSEEK_ATTEMPT_ID,
    taskType: benchmark.WRITING_REVIEW_DEEPSEEK_TASK_TYPE,
    question: question as unknown as Record<string, unknown>,
    responseText: attempt.response_text
  } as const;

  const results = await benchmark.benchmarkWritingReviewDeepSeekModels(input, {
    configs,
    onConfigStart: (config) => console.log(`Starting model: ${config.model}`),
    requestAI: (requestInput, config, signal) =>
      openRouter.requestOpenRouterWritingReview(requestInput, {
        jsonSchema:
          schema.AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA as unknown as Record<
            string,
            unknown
          >,
        modelOverride: config.model,
        reasoningEffort: config.reasoning_effort,
        signal
      }),
    parseRawReview: schema.parseAIReviewRawResultV22,
    parseReview: schema.parseAIReviewRawResultV22ForResponse
  });

  const baseline = benchmark.readWritingReviewDeepSeekKimiBaseline(
    resolve(
      process.cwd(),
      benchmark.WRITING_REVIEW_DEEPSEEK_KIMI_BASELINE_PATH
    )
  );
  const outputDir = resolve(
    process.cwd(),
    benchmark.WRITING_REVIEW_DEEPSEEK_OUTPUT_DIR
  );
  benchmark.writeWritingReviewDeepSeekFiles(outputDir, results, baseline);
  printResultTable(baseline, results);
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
  baseline: {
    result: string;
    elapsed_ms: number | null;
    reasoning_tokens: number | null;
    total_tokens: number | null;
    cost: number | null;
    official_score: number | null;
    language_edit_count: number | null;
    content_feedback_count: number | null;
  } | null,
  results: Array<{
    model: string;
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
  console.log("\nDeepSeek Writing Benchmark\n");
  console.log(
    "Model | Result | Time | Reasoning | Total | Cost | Score | L.Edits | Feedback"
  );
  console.log(
    baseline
      ? [
          "Kimi high baseline",
          baseline.result,
          display(baseline.elapsed_ms),
          display(baseline.reasoning_tokens),
          display(baseline.total_tokens),
          display(baseline.cost),
          display(baseline.official_score),
          display(baseline.language_edit_count),
          display(baseline.content_feedback_count)
        ].join(" | ")
      : "Kimi high baseline | unavailable | — | — | — | — | — | — | —"
  );
  for (const result of results) {
    console.log(
      [
        result.model,
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
  }
  console.log("");
}

function display(value: number | null) {
  return value === null ? "—" : String(value);
}
