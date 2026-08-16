import {
  buildWritingReviewMessages,
  readOpenAICompatibleUsage,
  type OpenRouterTokenUsage,
  type OpenRouterWritingReviewInput
} from "./openrouterWritingReview.ts";

type JsonSchema = Record<string, unknown>;

export const MOONSHOT_API_BASE_URL = "https://api.moonshot.cn/v1";
export const MOONSHOT_CHAT_COMPLETIONS_URL =
  `${MOONSHOT_API_BASE_URL}/chat/completions`;
export const MOONSHOT_WRITING_REVIEW_MODEL = "kimi-k3";

export type MoonshotReasoningEffort = "max" | "high";

export type MoonshotWritingReviewOptions = {
  env?: Pick<NodeJS.ProcessEnv, "MOONSHOT_API_KEY">;
  fetchImpl?: typeof fetch;
  jsonSchema: JsonSchema;
  reasoningEffort: MoonshotReasoningEffort;
  signal?: AbortSignal;
};

export type MoonshotWritingReviewResponse = {
  content: string;
  model: typeof MOONSHOT_WRITING_REVIEW_MODEL;
  usage: OpenRouterTokenUsage;
};

export type MoonshotWritingReviewErrorCode =
  | "MOONSHOT_API_KEY_MISSING"
  | "MOONSHOT_REQUEST_FAILED"
  | "MOONSHOT_RESPONSE_INVALID"
  | "AI_REQUEST_TIMEOUT";

export class MoonshotWritingReviewError extends Error {
  code: MoonshotWritingReviewErrorCode;
  status: number;

  constructor(code: MoonshotWritingReviewErrorCode, message: string, status = 500) {
    super(message);
    this.name = "MoonshotWritingReviewError";
    this.code = code;
    this.status = status;
  }
}

export async function requestMoonshotWritingReview(
  input: OpenRouterWritingReviewInput,
  options: MoonshotWritingReviewOptions
): Promise<MoonshotWritingReviewResponse> {
  const env = options.env ?? process.env;
  const apiKey = env.MOONSHOT_API_KEY?.trim();
  if (!apiKey) {
    throw new MoonshotWritingReviewError(
      "MOONSHOT_API_KEY_MISSING",
      "MOONSHOT_API_KEY is not configured in .env.local"
    );
  }

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(MOONSHOT_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      ...(options.signal ? { signal: options.signal } : {}),
      body: JSON.stringify({
        model: MOONSHOT_WRITING_REVIEW_MODEL,
        stream: false,
        messages: buildWritingReviewMessages(input),
        reasoning_effort: options.reasoningEffort,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "tps_writing_review",
            strict: true,
            schema: options.jsonSchema
          }
        }
      })
    });
  } catch {
    throw new MoonshotWritingReviewError(
      "MOONSHOT_REQUEST_FAILED",
      "Moonshot API could not be reached.",
      502
    );
  }

  if (!response.ok) {
    throw new MoonshotWritingReviewError(
      "MOONSHOT_REQUEST_FAILED",
      `Moonshot API returned HTTP ${response.status}.`,
      502
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new MoonshotWritingReviewError(
      "MOONSHOT_RESPONSE_INVALID",
      "Moonshot API returned an unreadable response.",
      502
    );
  }
  const content = readAssistantContent(payload);
  if (!content) {
    throw new MoonshotWritingReviewError(
      "MOONSHOT_RESPONSE_INVALID",
      "Moonshot API response did not contain final assistant content.",
      502
    );
  }
  return {
    content,
    model: MOONSHOT_WRITING_REVIEW_MODEL,
    usage: readOpenAICompatibleUsage(payload)
  };
}

export async function requestMoonshotWithTimeout<T>(
  request: (signal: AbortSignal) => Promise<T>,
  options: {
    timeoutMs: number;
    timeoutMessage: string;
    setTimeoutImpl?: typeof setTimeout;
    clearTimeoutImpl?: typeof clearTimeout;
  }
) {
  const controller = new AbortController();
  const schedule = options.setTimeoutImpl ?? setTimeout;
  const cancel = options.clearTimeoutImpl ?? clearTimeout;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = schedule(() => {
        timedOut = true;
        controller.abort();
        reject(
          new MoonshotWritingReviewError(
            "AI_REQUEST_TIMEOUT",
            options.timeoutMessage,
            504
          )
        );
      }, options.timeoutMs);
    });
    return await Promise.race([request(controller.signal), timeout]);
  } catch (error) {
    if (timedOut) {
      throw new MoonshotWritingReviewError(
        "AI_REQUEST_TIMEOUT",
        options.timeoutMessage,
        504
      );
    }
    throw error;
  } finally {
    if (timer !== null) cancel(timer);
  }
}

function readAssistantContent(payload: unknown) {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return null;
  const firstChoice = payload.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) return null;
  const content = firstChoice.message.content;
  return typeof content === "string" && content.trim() ? content : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
