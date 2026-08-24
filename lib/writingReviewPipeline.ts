export type WritingReviewPipeline = "c3" | "legacy_v22";

export const WRITING_REVIEW_DEFAULT_PIPELINE: WritingReviewPipeline = "c3";
export const WRITING_REVIEW_C3_HEDGE_DELAY_MS = 90_000;
// The hedge starts after 90 seconds and must still receive the same 120-second
// request window as the primary. The 210-second deadline preserves that full
// window while avoiding duplicate requests for primary responses in 60–90s.
export const WRITING_REVIEW_C3_DEFAULT_DEADLINE_MS = 210_000;
export const WRITING_REVIEW_LEGACY_HEDGE_DELAY_MS = 60_000;
export const WRITING_REVIEW_LEGACY_DEADLINE_MS = 240_000;

export function getWritingReviewPipeline(env: Partial<NodeJS.ProcessEnv> = process.env): WritingReviewPipeline {
  const value = env.WRITING_REVIEW_PIPELINE?.trim().toLowerCase() || WRITING_REVIEW_DEFAULT_PIPELINE;
  if (value === "c3" || value === "legacy_v22") return value;
  throw Object.assign(new Error("WRITING_REVIEW_PIPELINE must be c3 or legacy_v22."), { code: "WRITING_REVIEW_PIPELINE_INVALID", status: 500 });
}

export function writingReviewPipelineTiming(pipeline: WritingReviewPipeline, env: Partial<NodeJS.ProcessEnv> = process.env) {
  if (pipeline === "legacy_v22") return { hedgeDelayMs: WRITING_REVIEW_LEGACY_HEDGE_DELAY_MS, deadlineMs: WRITING_REVIEW_LEGACY_DEADLINE_MS };
  const configured = Number(env.WRITING_REVIEW_C3_DEADLINE_MS);
  const deadlineMs =
    Number.isInteger(configured) &&
    configured >= WRITING_REVIEW_C3_DEFAULT_DEADLINE_MS
      ? configured
      : WRITING_REVIEW_C3_DEFAULT_DEADLINE_MS;
  return { hedgeDelayMs: WRITING_REVIEW_C3_HEDGE_DELAY_MS, deadlineMs };
}
