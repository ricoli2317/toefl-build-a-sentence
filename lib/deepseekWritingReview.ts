import {
  buildWritingReviewMessages,
  readOpenAICompatibleUsage,
  type OpenRouterMessage,
  type OpenRouterTokenUsage,
  type OpenRouterWritingReviewInput
} from "./openrouterWritingReview.ts";

type JsonSchema = Record<string, unknown>;

export const DEEPSEEK_API_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_WRITING_REVIEW_MODEL = "deepseek-v4-flash";

export type DeepSeekReasoningEffort = "high";

export type DeepSeekWritingReviewOptions = {
  env?: Partial<Pick<
    NodeJS.ProcessEnv,
    "DEEPSEEK_API_KEY" | "DEEPSEEK_API_BASE_URL" | "DEEPSEEK_WRITING_MODEL"
  >>;
  fetchImpl?: typeof fetch;
  jsonSchema: JsonSchema;
  modelOverride?: string;
  reasoningEffort: DeepSeekReasoningEffort;
  signal?: AbortSignal;
};

export type DeepSeekStructuredOutputOptions = DeepSeekWritingReviewOptions & {
  schemaName: string;
  timeoutMs?: number;
  timeoutMessage?: string;
};

export type DeepSeekWritingReviewResponse = {
  content: string;
  model: string;
  usage: OpenRouterTokenUsage;
  generationId: string | null;
};

export type DeepSeekWritingReviewErrorCode =
  | "DEEPSEEK_API_KEY_MISSING"
  | "DEEPSEEK_REQUEST_FAILED"
  | "DEEPSEEK_RESPONSE_INVALID"
  | "AI_REQUEST_TIMEOUT";

export class DeepSeekWritingReviewError extends Error {
  code: DeepSeekWritingReviewErrorCode;
  status: number;
  httpStatus: number | null;

  constructor(
    code: DeepSeekWritingReviewErrorCode,
    message: string,
    status = 500,
    httpStatus: number | null = null
  ) {
    super(message);
    this.name = "DeepSeekWritingReviewError";
    this.code = code;
    this.status = status;
    this.httpStatus = httpStatus;
  }
}

export async function requestDeepSeekWritingReview(
  input: OpenRouterWritingReviewInput,
  options: DeepSeekWritingReviewOptions
): Promise<DeepSeekWritingReviewResponse> {
  return requestDeepSeekStructuredOutput(buildWritingReviewMessages(input), {
    ...options,
    schemaName: "tps_writing_review"
  });
}

export async function requestDeepSeekStructuredOutput(
  messages: OpenRouterMessage[],
  options: DeepSeekStructuredOutputOptions
): Promise<DeepSeekWritingReviewResponse> {
  if (options.timeoutMs !== undefined) {
    return requestDeepSeekWithTimeout(
      (signal) =>
        requestDeepSeekStructuredOutput(messages, {
          ...options,
          signal,
          timeoutMs: undefined,
          timeoutMessage: undefined
        }),
      {
        timeoutMs: options.timeoutMs,
        timeoutMessage: options.timeoutMessage ?? "AI 请求超时，请稍后重试。"
      }
    );
  }

  const env = options.env ?? process.env;
  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    throw new DeepSeekWritingReviewError(
      "DEEPSEEK_API_KEY_MISSING",
      "DEEPSEEK_API_KEY is not configured in .env.local"
    );
  }
  const baseUrl = env.DEEPSEEK_API_BASE_URL?.trim() || DEEPSEEK_API_BASE_URL;
  const model =
    options.modelOverride?.trim() ||
    env.DEEPSEEK_WRITING_MODEL?.trim() ||
    DEEPSEEK_WRITING_REVIEW_MODEL;
  const schemaInstruction: OpenRouterMessage = {
    role: "system",
    content:
      `The final answer must be one JSON object matching the ${options.schemaName} JSON Schema exactly: ` +
      JSON.stringify(options.jsonSchema)
  };

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(
      `${baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        ...(options.signal ? { signal: options.signal } : {}),
        body: JSON.stringify({
          model,
          stream: false,
          messages: [...messages, schemaInstruction],
          thinking: { type: "enabled" },
          reasoning_effort: options.reasoningEffort,
          response_format: { type: "json_object" }
        })
      }
    );
  } catch {
    throw new DeepSeekWritingReviewError(
      "DEEPSEEK_REQUEST_FAILED",
      "DeepSeek API could not be reached.",
      502
    );
  }

  if (!response.ok) {
    throw new DeepSeekWritingReviewError(
      "DEEPSEEK_REQUEST_FAILED",
      `DeepSeek API returned HTTP ${response.status}.`,
      502,
      response.status
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new DeepSeekWritingReviewError(
      "DEEPSEEK_RESPONSE_INVALID",
      "DeepSeek API returned an unreadable response.",
      502,
      response.status
    );
  }
  const content = readAssistantContent(payload);
  if (!content) {
    throw new DeepSeekWritingReviewError(
      "DEEPSEEK_RESPONSE_INVALID",
      "DeepSeek API response did not contain final assistant content.",
      502,
      response.status
    );
  }
  return {
    content,
    model:
      isRecord(payload) && typeof payload.model === "string" && payload.model.trim()
        ? payload.model.trim()
        : model,
    usage: readOpenAICompatibleUsage(payload),
    generationId:
      isRecord(payload) && typeof payload.id === "string" && payload.id.trim()
        ? payload.id.trim()
        : null
  };
}

export async function requestDeepSeekWithTimeout<T>(
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
          new DeepSeekWritingReviewError(
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
      throw new DeepSeekWritingReviewError(
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
