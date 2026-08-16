import { resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  WritingReviewCurrentAttemptRow,
  WritingReviewCurrentReviewRow
} from "../lib/writingReviewProductionExport.ts";

type SupabaseServerModule = typeof import("../lib/supabase/server");
type ExportModule = typeof import("../lib/writingReviewProductionExport");

const ATTEMPT_FIELDS = "attempt_id,task_type,response_text";
const REVIEW_FIELDS =
  "attempt_id,task_type,ai_model,ai_generated_at,ai_review_raw,scores,language_edits,content_feedback,teacher_comment";

void run().catch((error) => {
  console.error(
    `Current writing-review export stopped: ${
      error instanceof Error ? error.message : "Unknown error."
    }`
  );
  process.exitCode = 1;
});

async function run() {
  if (process.argv.slice(2).some((argument) => argument !== "--")) {
    throw new Error("This export does not accept arguments.");
  }
  requireEnvironment();
  const exportPath = "../lib/writingReviewProductionExport.ts";
  const supabasePath = "../lib/supabase/server.ts";
  const [exporter, supabaseServer] = await Promise.all([
    import(exportPath) as Promise<ExportModule>,
    import(supabasePath) as Promise<SupabaseServerModule>
  ]);
  const supabase = supabaseServer.createServiceSupabase();
  const currentReviews = [];

  for (const exportCase of exporter.WRITING_REVIEW_CURRENT_EXPORT_CASES) {
    const [attempt, review] = await Promise.all([
      readAttempt(supabase, exportCase.attempt_id, exportCase.case_label),
      readReview(supabase, exportCase.attempt_id, exportCase.case_label)
    ]);
    currentReviews.push(
      exporter.buildWritingReviewCurrentExport(exportCase, attempt, review)
    );
  }

  const outputDir = resolve(
    process.cwd(),
    exporter.WRITING_REVIEW_CURRENT_EXPORT_OUTPUT_DIR
  );
  exporter.writeWritingReviewCurrentExportFiles(outputDir, currentReviews);
  console.log(`Exported ${currentReviews.length} current writing reviews.`);
  console.log(`Output directory: ${outputDir}`);
}

async function readAttempt(
  supabase: SupabaseClient,
  attemptId: string,
  caseLabel: string
) {
  const { data, error } = await supabase
    .from("writing_attempts")
    .select(ATTEMPT_FIELDS)
    .eq("attempt_id", attemptId)
    .maybeSingle();
  if (error) throw new Error(`Could not read writing_attempts for ${caseLabel}.`);
  if (!data) throw new Error(`Writing attempt not found for ${caseLabel}.`);
  return data as WritingReviewCurrentAttemptRow;
}

async function readReview(
  supabase: SupabaseClient,
  attemptId: string,
  caseLabel: string
) {
  const { data, error } = await supabase
    .from("writing_reviews")
    .select(REVIEW_FIELDS)
    .eq("attempt_id", attemptId)
    .maybeSingle();
  if (error) throw new Error(`Could not read writing_reviews for ${caseLabel}.`);
  if (!data) throw new Error(`Writing review not found for ${caseLabel}.`);
  return data as WritingReviewCurrentReviewRow;
}

function requireEnvironment() {
  const required = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}
