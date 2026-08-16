import { resolve } from "node:path";

type SupabaseServerModule = typeof import("../lib/supabase/server");
type ReviewSourceModule = typeof import("../lib/writingReviewSource");
type OpenRouterModule = typeof import("../lib/openrouterWritingReview");
type ReviewSchemaModule = typeof import("../lib/writingReviewSchemaV22");
type BenchmarkModule = typeof import("../lib/writingReviewCandidateModelBenchmark");

void run().catch((error) => {
  console.error(
    `Candidate model benchmark stopped: ${
      error instanceof Error ? error.message : "Unknown error."
    }`
  );
  process.exitCode = 1;
});

async function run() {
  const benchmarkPath = "../lib/writingReviewCandidateModelBenchmark.ts";
  const benchmark = (await import(benchmarkPath)) as BenchmarkModule;
  const { selection, error } = benchmark.parseWritingReviewCandidateArguments(
    process.argv.slice(2)
  );
  if (error) {
    throw new Error(
      `${error}. Usage: pnpm benchmark:writing-candidate-models -- --only all|gemini|grok`
    );
  }
  requireEnvironment();
  const configs = benchmark.selectWritingReviewCandidateConfigs(selection);
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
    benchmark.WRITING_REVIEW_CANDIDATE_ATTEMPT_ID
  );
  if (attempt.task_type !== benchmark.WRITING_REVIEW_CANDIDATE_TASK_TYPE) {
    throw new Error("The fixed candidate benchmark attempt is not Academic Discussion.");
  }
  const input = {
    attemptId: benchmark.WRITING_REVIEW_CANDIDATE_ATTEMPT_ID,
    taskType: benchmark.WRITING_REVIEW_CANDIDATE_TASK_TYPE,
    question: question as unknown as Record<string, unknown>,
    responseText: attempt.response_text
  } as const;

  const results = await benchmark.benchmarkWritingReviewCandidateModels(input, {
    configs,
    onConfigStart: (config) =>
      console.log(`Starting candidate: ${config.label}`),
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

  const baselinePath = resolve(
    process.cwd(),
    benchmark.WRITING_REVIEW_CANDIDATE_KIMI_BASELINE_PATH
  );
  const baseline = benchmark.readWritingReviewCandidateKimiBaseline(baselinePath);
  const outputDir = resolve(
    process.cwd(),
    benchmark.WRITING_REVIEW_CANDIDATE_OUTPUT_DIR
  );
  benchmark.writeWritingReviewCandidateFiles(outputDir, results, baseline);
  printResultTable(results);
  console.log(
    `Kimi high baseline: ${baseline ? "loaded from existing file" : "not available"}`
  );
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
    model: string;
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
  console.log("\nCandidate Model Benchmark\n");
  console.log(
    "Model | Effort | Result | Time | Reasoning | Total | Cost | Score | L.Edits | Feedback"
  );
  for (const result of results) {
    console.log(
      [
        result.model,
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

function display(value: number | null) {
  return value === null ? "—" : String(value);
}
