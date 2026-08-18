const TITLE_TIMEOUT_MS = 30_000;
const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

type GenerateTitleOptions = {
  env?: Pick<
    NodeJS.ProcessEnv,
    "OPENROUTER_API_KEY" | "OPENROUTER_WRITING_MODEL" | "PRACTICE_IMPORT_TITLE_MODEL"
  >;
  fetchImpl?: typeof fetch;
};

export function validateAcademicDiscussionTitle(value: unknown) {
  const title = String(value ?? "")
    .trim()
    .replace(/^["']+|["'.!?]+$/g, "")
    .replace(/\s+/g, " ");
  const words = title.split(" ").filter(Boolean);
  if (!title) throw new Error("Academic Discussion title generation returned an empty title");
  if (words.length > 5) throw new Error("Academic Discussion title must contain at most 5 words");
  if (!/[A-Za-z]/.test(title) || !/^[A-Za-z0-9&' -]+$/.test(title)) {
    throw new Error("Academic Discussion title must be English");
  }
  if (/academic discussion/i.test(title)) {
    throw new Error("Academic Discussion title must not include the task name");
  }
  return title;
}

export async function generateAcademicDiscussionTitle(
  professorPrompt: string,
  options: GenerateTitleOptions = {}
) {
  const env = options.env ?? process.env;
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  const model =
    env.PRACTICE_IMPORT_TITLE_MODEL?.trim() || env.OPENROUTER_WRITING_MODEL?.trim();
  if (!apiKey || !model) {
    throw new Error("Academic Discussion title provider is not configured");
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
        messages: [
          {
            role: "system",
            content:
              "Create one concise English topic title of at most 5 words. Return only the title. Do not include a number, date, task name, or full question."
          },
          { role: "user", content: professorPrompt }
        ]
      }),
      cache: "no-store",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Academic Discussion title request failed (${response.status})`);
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    return validateAcademicDiscussionTitle(payload.choices?.[0]?.message?.content);
  } finally {
    clearTimeout(timeout);
  }
}
