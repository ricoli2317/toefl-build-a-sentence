import {
  requestMoonshotStructuredOutput,
  requestMoonshotWritingReview,
  MoonshotWritingReviewError,
  type MoonshotReasoningEffort
} from "./moonshotWritingReview.ts";
import {
  requestOpenRouterStructuredOutput,
  requestOpenRouterWritingReview,
  OpenRouterWritingReviewError,
  type OpenRouterMessage,
  type OpenRouterReasoningEffort,
  type OpenRouterWritingReviewInput
} from "./openrouterWritingReview.ts";
import {
  requestDeepSeekStructuredOutput,
  requestDeepSeekWritingReview,
  DeepSeekWritingReviewError,
  type DeepSeekReasoningEffort
} from "./deepseekWritingReview.ts";
import { enrichWritingReviewUsage } from "./writingReviewCost.ts";

type JsonSchema = Record<string, unknown>;
type WritingReviewProviderEnv = Partial<Pick<
  NodeJS.ProcessEnv,
  | "OPENROUTER_API_KEY"
  | "OPENROUTER_WRITING_MODEL"
  | "MOONSHOT_API_KEY"
  | "MOONSHOT_API_BASE_URL"
  | "MOONSHOT_WRITING_MODEL"
  | "DEEPSEEK_API_KEY"
  | "DEEPSEEK_API_BASE_URL"
  | "DEEPSEEK_WRITING_MODEL"
>>;

export type WritingReviewProvider = "moonshot" | "openrouter" | "deepseek_flash";

export const WRITING_REVIEW_DEFAULT_PROVIDER: WritingReviewProvider = "moonshot";
export const WRITING_REVIEW_DEFAULT_MOONSHOT_MODEL = "kimi-k3";

export type WritingReviewProviderConfig = {
  provider: WritingReviewProvider;
  model: string;
  endpointHostname?: string | null;
};

export class WritingReviewProviderConfigurationError extends Error {
  code = "WRITING_REVIEW_PROVIDER_INVALID" as const;
  status = 500;

  constructor() {
    super("WRITING_REVIEW_PROVIDER must be moonshot, openrouter, or deepseek_flash.");
    this.name = "WritingReviewProviderConfigurationError";
  }
}

export function isWritingReviewProviderError(error: unknown) {
  return error instanceof MoonshotWritingReviewError ||
    error instanceof OpenRouterWritingReviewError ||
    error instanceof DeepSeekWritingReviewError ||
    error instanceof WritingReviewProviderConfigurationError;
}

export function getWritingReviewProviderConfig(
  env: Partial<NodeJS.ProcessEnv> = process.env
): WritingReviewProviderConfig {
  const value = env.WRITING_REVIEW_PROVIDER?.trim().toLowerCase() ||
    WRITING_REVIEW_DEFAULT_PROVIDER;
  if (value !== "moonshot" && value !== "openrouter" && value !== "deepseek_flash") {
    throw new WritingReviewProviderConfigurationError();
  }
  const base = value === "deepseek_flash"
    ? env.DEEPSEEK_API_BASE_URL?.trim() || "https://api.deepseek.com"
    : env.MOONSHOT_API_BASE_URL?.trim() || "https://api.moonshot.cn/v1";
  let endpointHostname: string | null = null;
  try { endpointHostname = new URL(base).hostname.toLowerCase() || null; } catch { endpointHostname = null; }
  return {
    provider: value,
    model: value === "moonshot"
      ? env.MOONSHOT_WRITING_MODEL?.trim() || WRITING_REVIEW_DEFAULT_MOONSHOT_MODEL
      : value === "deepseek_flash"
        ? env.DEEPSEEK_WRITING_MODEL?.trim() || "deepseek-v4-flash"
        : env.OPENROUTER_WRITING_MODEL?.trim() || "unknown",
    endpointHostname: value === "moonshot" || value === "deepseek_flash"
      ? endpointHostname
      : null
  };
}

export async function requestWritingReview(
  config: WritingReviewProviderConfig,
  input: OpenRouterWritingReviewInput,
  options: {
    env?: WritingReviewProviderEnv;
    fetchImpl?: typeof fetch;
    jsonSchema: JsonSchema;
    reasoningEffort: "high";
    signal?: AbortSignal;
  }
) {
  if (config.provider === "moonshot") {
    const response = await requestMoonshotWritingReview(input, {
      ...options,
      modelOverride: config.model,
      reasoningEffort: options.reasoningEffort as MoonshotReasoningEffort
    });
    const enriched = enrichWritingReviewUsage(config.provider, config.model, response.usage, config.endpointHostname); return { ...response, usage: enriched.usage, costObservability: enriched.cost };
  }
  if (config.provider === "deepseek_flash") {
    const response = await requestDeepSeekWritingReview(input, {
      ...options,
      modelOverride: config.model,
      reasoningEffort: options.reasoningEffort as DeepSeekReasoningEffort
    });
    const enriched = enrichWritingReviewUsage(config.provider, config.model, response.usage, config.endpointHostname);
    return { ...response, usage: enriched.usage, costObservability: enriched.cost };
  }
  const response = await requestOpenRouterWritingReview(input, {
    ...options,
    modelOverride: config.model === "unknown" ? undefined : config.model,
    reasoningEffort: options.reasoningEffort as OpenRouterReasoningEffort
  });
  { const enriched=enrichWritingReviewUsage(config.provider, config.model, response.usage, config.endpointHostname); return { ...response, usage: enriched.usage, costObservability: enriched.cost }; }
}

export async function requestWritingReviewStructuredOutput(
  config: WritingReviewProviderConfig,
  messages: OpenRouterMessage[],
  options: {
    env?: WritingReviewProviderEnv;
    fetchImpl?: typeof fetch;
    jsonSchema: JsonSchema;
    schemaName: string;
    reasoningEffort?: "high";
    signal?: AbortSignal;
    timeoutMs?: number;
    timeoutMessage?: string;
  }
) {
  if (config.provider === "moonshot") {
    const response = await requestMoonshotStructuredOutput(messages, {
      ...options,
      modelOverride: config.model,
      reasoningEffort: (options.reasoningEffort ?? "high") as MoonshotReasoningEffort
    }); { const enriched=enrichWritingReviewUsage(config.provider, config.model, response.usage, config.endpointHostname); return { ...response, usage: enriched.usage, costObservability: enriched.cost }; }
  }
  if (config.provider === "deepseek_flash") {
    const response = await requestDeepSeekStructuredOutput(messages, {
      ...options,
      modelOverride: config.model,
      reasoningEffort: (options.reasoningEffort ?? "high") as DeepSeekReasoningEffort
    });
    const enriched = enrichWritingReviewUsage(config.provider, config.model, response.usage, config.endpointHostname);
    return { ...response, usage: enriched.usage, costObservability: enriched.cost };
  }
  const response = await requestOpenRouterStructuredOutput(messages, {
    ...options,
    modelOverride: config.model === "unknown" ? undefined : config.model,
    reasoningEffort: options.reasoningEffort as OpenRouterReasoningEffort
  }); { const enriched=enrichWritingReviewUsage(config.provider, config.model, response.usage, config.endpointHostname); return { ...response, usage: enriched.usage, costObservability: enriched.cost }; }
}
