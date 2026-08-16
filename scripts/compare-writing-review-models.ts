import { writeFileSync } from "node:fs";

type SupabaseServerModule = typeof import("../lib/supabase/server");
type OpenRouterModule = typeof import("../lib/openrouterWritingReview");
type ComparisonModule = typeof import("../lib/writingReviewModelComparison");
type ReviewSchemaModule = typeof import("../lib/writingReviewSchemaV22");
type ReviewSourceModule = typeof import("../lib/writingReviewSource");

void run().catch((error) => {
  console.error(
    `Comparison stopped: ${error instanceof Error ? error.message : "Unknown error."}`
  );
  process.exitCode = 1;
});

async function run() {
  const comparisonPath = "../lib/writingReviewModelComparison.ts";
  const comparison = (await import(comparisonPath)) as ComparisonModule;
  const { attemptId, sourceOnly, model, unknownOption } =
    comparison.parseWritingReviewComparisonArguments(process.argv.slice(2));

  if (!attemptId || unknownOption) {
    if (unknownOption) console.error(`Unknown option: ${unknownOption}`);
    console.error(
      "Usage: pnpm compare:writing-models -- <writing_attempt_id> [--model deepseek|qwen|kimi|<model-id>] [--source-only]"
    );
    process.exitCode = 1;
    return;
  }

  const models = model
    ? [comparison.resolveWritingReviewComparisonModel(model)]
    : comparison.WRITING_REVIEW_COMPARISON_MODELS;
  await main(attemptId, sourceOnly, models, comparison);
}

async function main(
  targetAttemptId: string,
  shouldOnlyLoadSource: boolean,
  selectedModels: readonly string[],
  comparison: ComparisonModule
) {
  try {
    await runComparison(
      targetAttemptId,
      shouldOnlyLoadSource,
      selectedModels,
      comparison
    );
  } catch (error) {
    console.error(
      `Comparison stopped: ${error instanceof Error ? error.message : "Unknown error."}`
    );
    process.exitCode = 1;
  }
}

async function runComparison(
  targetAttemptId: string,
  shouldOnlyLoadSource: boolean,
  selectedModels: readonly string[],
  comparison: ComparisonModule
) {
  requireSupabaseEnvironment();

  const supabaseServerPath = "../lib/supabase/server.ts";
  const sourcePath = "../lib/writingReviewSource.ts";
  const [supabaseServer, source] = await Promise.all([
    import(supabaseServerPath) as Promise<SupabaseServerModule>,
    import(sourcePath) as Promise<ReviewSourceModule>
  ]);

  const supabase = supabaseServer.createServiceSupabase();
  const { attempt, question } = await source.loadWritingReviewComparisonSource(
    supabase,
    targetAttemptId
  );

  if (shouldOnlyLoadSource) {
    printSourceSummary(attempt);
    return;
  }

  requireOpenRouterEnvironment();
  const openRouterPath = "../lib/openrouterWritingReview.ts";
  const schemaPath = "../lib/writingReviewSchemaV22.ts";
  const [openRouter, schema] = await Promise.all([
    import(openRouterPath) as Promise<OpenRouterModule>,
    import(schemaPath) as Promise<ReviewSchemaModule>
  ]);

  const input = {
    taskType: attempt.task_type,
    question: question as unknown as Record<string, unknown>,
    responseText: attempt.response_text
  };

  console.log(`Attempt: ${attempt.attempt_id}`);
  console.log(`Task type: ${attempt.task_type}`);
  console.log(
    `Running ${selectedModels.length} model${
      selectedModels.length === 1 ? "" : "s"
    } sequentially...\n`
  );

  const modelResults = await comparison.compareWritingReviewModels(input, {
    models: selectedModels,
    onModelStart: (model) => console.log(`Starting model: ${model}`),
    onModelComplete: printModelSummary,
    requestAI: (requestInput, model, signal) =>
      openRouter.requestOpenRouterWritingReview(requestInput, {
        jsonSchema: schema.AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA as unknown as Record<
          string,
          unknown
        >,
        modelOverride: model,
        signal
      }),
    parseReview: schema.parseAIReviewRawResultV22ForResponse
  });

  const safeAttemptId = targetAttemptId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const outputPath = `/tmp/tps-writing-model-comparison-${safeAttemptId}.json`;
  writeFileSync(
    outputPath,
    `${JSON.stringify(
      {
        attempt: {
          attempt_id: attempt.attempt_id,
          task_type: attempt.task_type,
          question_id: attempt.question_id,
          set_id: attempt.set_id,
          word_count: attempt.word_count,
          response_text: attempt.response_text
        },
        models: modelResults
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", mode: 0o600 }
  );

  console.log(`Comparison JSON: ${outputPath}`);
}

function requireSupabaseEnvironment() {
  const missing = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY"
  ].filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

function requireOpenRouterEnvironment() {
  if (!process.env.OPENROUTER_API_KEY?.trim()) {
    throw new Error("Missing required environment variables: OPENROUTER_API_KEY");
  }
}

function printSourceSummary(attempt: {
  attempt_id: string;
  task_type: string;
  question_id: string;
  set_id: string;
  word_count: number;
}) {
  console.log(`attempt_id: ${attempt.attempt_id}`);
  console.log(`task_type: ${attempt.task_type}`);
  console.log(`question_id: ${attempt.question_id}`);
  console.log(`set_id: ${attempt.set_id}`);
  console.log(`word_count: ${attempt.word_count}`);
  console.log("source loaded: yes");
}

function printModelSummary(model: {
  model: string;
  success: boolean;
  latency_ms: number;
  result: {
    score?: { rubric_score: number };
    scores?: { official_score: { teacher_score: number } };
    language_edits: unknown[];
    content_feedback: unknown[];
  } | null;
  error: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
}) {
  console.log(`Model: ${model.model}`);
  console.log(`Status: ${model.success ? "success" : "failure"}`);
  console.log(`Latency: ${model.latency_ms} ms`);
  console.log(
    `Rubric score: ${
      model.result?.scores?.official_score.teacher_score ??
      model.result?.score?.rubric_score ??
      "—"
    }`
  );
  console.log(`Language edits: ${model.result?.language_edits.length ?? "—"}`);
  console.log(`Content feedback: ${model.result?.content_feedback.length ?? "—"}`);
  console.log(
    `Token usage: prompt=${model.prompt_tokens ?? "—"}, completion=${
      model.completion_tokens ?? "—"
    }, total=${model.total_tokens ?? "—"}`
  );
  if (model.error) console.log(`Error: ${model.error}`);
  console.log("");
}
