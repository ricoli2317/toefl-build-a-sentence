import { resolve } from "node:path";

type SupabaseServerModule = typeof import("../lib/supabase/server");
type ReviewSourceModule = typeof import("../lib/writingReviewSource");
type MoonshotModule = typeof import("../lib/moonshotWritingReview");
type ReviewSchemaModule = typeof import("../lib/writingReviewSchemaV22");
type BenchmarkModule = typeof import("../lib/writingReviewMoonshotBenchmark");

void run().catch((error) => {
  console.error(
    `Moonshot benchmark stopped: ${
      error instanceof Error ? error.message : "Unknown error."
    }`
  );
  process.exitCode = 1;
});

async function run() {
  requireEnvironment();
  const benchmarkPath = "../lib/writingReviewMoonshotBenchmark.ts";
  const sourcePath = "../lib/writingReviewSource.ts";
  const supabasePath = "../lib/supabase/server.ts";
  const moonshotPath = "../lib/moonshotWritingReview.ts";
  const schemaPath = "../lib/writingReviewSchemaV22.ts";
  const [benchmark, source, supabaseServer, moonshot, schema] =
    await Promise.all([
      import(benchmarkPath) as Promise<BenchmarkModule>,
      import(sourcePath) as Promise<ReviewSourceModule>,
      import(supabasePath) as Promise<SupabaseServerModule>,
      import(moonshotPath) as Promise<MoonshotModule>,
      import(schemaPath) as Promise<ReviewSchemaModule>
    ]);

  const attemptId =
    process.argv.slice(2).find((argument) => argument !== "--")?.trim() ||
    benchmark.DEFAULT_WRITING_REVIEW_MOONSHOT_BENCHMARK_ATTEMPT_ID;
  const supabase = supabaseServer.createServiceSupabase();
  const { attempt, question } = await source.loadWritingReviewComparisonSource(
    supabase,
    attemptId
  );
  const input = {
    attemptId: attempt.attempt_id,
    taskType: attempt.task_type,
    question: question as unknown as Record<string, unknown>,
    responseText: attempt.response_text
  };

  const results = await benchmark.benchmarkWritingReviewMoonshot(input, {
    onEffortStart: (effort) =>
      console.log(`Starting Moonshot reasoning effort: ${effort}`),
    requestAI: (requestInput, effort, signal) =>
      moonshot.requestMoonshotWritingReview(requestInput, {
        jsonSchema:
          schema.AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA as unknown as Record<
            string,
            unknown
          >,
        reasoningEffort: effort,
        signal
      }),
    parseReview: schema.parseAIReviewRawResultV22ForResponse
  });

  const outputDir = resolve(
    process.cwd(),
    benchmark.WRITING_REVIEW_MOONSHOT_BENCHMARK_OUTPUT_DIR
  );
  benchmark.writeWritingReviewMoonshotBenchmarkFiles(outputDir, results);
  printComparisonTable(results);
  console.log(`Output directory: ${outputDir}`);
}

function requireEnvironment() {
  if (!process.env.MOONSHOT_API_KEY?.trim()) {
    throw new Error("MOONSHOT_API_KEY is not configured in .env.local");
  }
  const required = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

function printComparisonTable(
  results: Array<{
    reasoning_effort: string;
    elapsed_ms: number;
    reasoning_tokens: number | null;
    completion_tokens: number | null;
    total_tokens: number | null;
    cost: number | null;
    result: string;
    official_score: number | null;
    language_edit_count: number | null;
    content_feedback_count: number | null;
  }>
) {
  console.log("\nMoonshot Direct Benchmark\n");
  console.log(
    "Effort | Result | Time(ms) | Reasoning | Completion | Total | Cost | Score | L.Edits | Feedback"
  );
  for (const result of results) {
    console.log(
      [
        result.reasoning_effort,
        result.result,
        result.elapsed_ms,
        display(result.reasoning_tokens),
        display(result.completion_tokens),
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
