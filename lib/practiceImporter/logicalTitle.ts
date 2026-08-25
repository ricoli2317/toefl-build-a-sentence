const TITLE_TIMEOUT_MS = 30_000;
const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

type GenerateTitleOptions = {
  env?: Pick<
    NodeJS.ProcessEnv,
    "OPENROUTER_API_KEY" | "OPENROUTER_WRITING_MODEL" | "PRACTICE_IMPORT_TITLE_MODEL"
  >;
  fetchImpl?: typeof fetch;
};

export type LogicalWritingTitleTask = "email" | "academic_discussion";

export function validateLogicalWritingTitle(value: unknown) {
  const title = String(value ?? "")
    .trim()
    .replace(/^["']+|["'.!?]+$/g, "")
    .replace(/\s+/g, " ");
  const words = title.split(" ").filter(Boolean);
  if (!title) throw new Error("Logical writing title generation returned an empty title");
  if (words.length > 5) throw new Error("Logical writing title must contain at most 5 words");
  if (!/[A-Za-z]/.test(title) || !/^[A-Za-z0-9&' -]+$/.test(title)) {
    throw new Error("Logical writing title must be English");
  }
  if (/\b(?:email|toefl|academic discussion)\b/i.test(title)) {
    throw new Error("Logical writing title must not include a task name");
  }
  if (/\b(?:19|20)\d{2}\b/.test(title) || /\bquestion\s*\d+\b/i.test(title)) {
    throw new Error("Logical writing title must not include a date or question number");
  }
  return title;
}

export async function generateLogicalWritingTitle(
  sourceText: string,
  taskType: LogicalWritingTitleTask,
  options: GenerateTitleOptions = {}
) {
  const env = options.env ?? process.env;
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  const model =
    env.PRACTICE_IMPORT_TITLE_MODEL?.trim() || env.OPENROUTER_WRITING_MODEL?.trim();
  if (!apiKey || !model) {
    throw new Error("Logical writing title provider is not configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl ?? fetch)(OPENROUTER_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 24,
        reasoning: { enabled: false },
        messages: [
          {
            role: "system",
            content:
              "Create one natural English topic title of 1 to 5 words that summarizes the core topic. Return only the title. Do not truncate mechanically. Do not include a number, date, task name, TOEFL, Email, or full question."
          },
          {
            role: "user",
            content: `${taskType === "email" ? "Email subject and topic" : "Discussion prompt"}: ${sourceText}`
          }
        ]
      }),
      cache: "no-store",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Logical writing title request failed (${response.status})`);
    const payload = (await response.json()) as {
      choices?: Array<{
        finish_reason?: unknown;
        message?: { content?: unknown };
      }>;
    };
    const choice = payload.choices?.[0];
    if (choice?.message?.content == null || choice.message.content === "") {
      const finishReason = String(choice?.finish_reason ?? "unknown");
      throw new Error(
        `Logical writing title response contained no title (finish_reason: ${finishReason})`
      );
    }
    return validateLogicalWritingTitle(choice.message.content);
  } finally {
    clearTimeout(timeout);
  }
}
