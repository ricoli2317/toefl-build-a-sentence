import { WRITING_REVIEW_PROMPT_VERSION } from "./openrouterWritingReview.ts";
import {
  type WritingReviewPipeline,
  writingReviewPipelineTiming
} from "./writingReviewPipeline.ts";
import { AI_REVIEW_SCHEMA_VERSION_V22 } from "./writingReviewSchemaV22.ts";
import { WRITING_REVIEW_C3_PROMPT_VERSION } from "./writingReviewSemanticPrompt.ts";
import { WRITING_REVIEW_C3_SCHEMA_VERSION } from "./writingReviewSemanticSchema.ts";

/** Version and timing facts persisted with every complete-review AI log. */
export function writingReviewLogMetadata(
  pipeline: WritingReviewPipeline,
  env: Partial<NodeJS.ProcessEnv> = process.env
) {
  const timing = writingReviewPipelineTiming(pipeline, env);
  return pipeline === "c3"
    ? {
        pipeline,
        promptVersion: WRITING_REVIEW_C3_PROMPT_VERSION,
        schemaVersion: WRITING_REVIEW_C3_SCHEMA_VERSION,
        ...timing
      }
    : {
        pipeline,
        promptVersion: WRITING_REVIEW_PROMPT_VERSION,
        schemaVersion: AI_REVIEW_SCHEMA_VERSION_V22,
        ...timing
      };
}
