import type { StudentCacheSession } from "@/components/StudentDataCache";
import type {
  GrammarPracticeDraft,
  GrammarPracticeSessionPayload
} from "./grammarPractice.ts";
import { createBrowserSupabase } from "./supabase/client.ts";

const SESSION_API = "/api/grammar-practice/sessions";

export function grammarPracticeSessionUrl(sessionId: string) {
  return `${SESSION_API}/${encodeURIComponent(sessionId)}`;
}

export async function startGrammarPracticeSession(
  tag: string,
  requestId: string,
  auth: StudentCacheSession
): Promise<GrammarPracticeSessionPayload> {
  const response = await fetch(SESSION_API, {
    method: "POST",
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ tag, requestId })
  });
  return parseGrammarSessionResponse(response);
}

export async function startGrammarCategoryAssignmentSession(
  assignmentId: string,
  requestId: string,
  auth: StudentCacheSession
): Promise<GrammarPracticeSessionPayload & { created?: boolean }> {
  const response = await fetch(
    `/api/grammar-practice/assignments/${encodeURIComponent(assignmentId)}`,
    {
      method: "POST",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ requestId })
    }
  );
  return parseGrammarSessionResponse(response) as Promise<
    GrammarPracticeSessionPayload & { created?: boolean }
  >;
}

export async function loadGrammarPracticeSession(
  sessionId: string,
  auth: StudentCacheSession
): Promise<GrammarPracticeSessionPayload> {
  const response = await fetch(grammarPracticeSessionUrl(sessionId), {
    cache: "no-store",
    headers: { Authorization: `Bearer ${auth.accessToken}` }
  });
  return parseGrammarSessionResponse(response);
}

export async function saveGrammarPracticeSessionDraft(
  sessionId: string,
  draft: GrammarPracticeDraft
): Promise<void> {
  const supabase = createBrowserSupabase();
  const {
    data: { session }
  } = await supabase.auth.getSession();
  const response = await fetch(grammarPracticeSessionUrl(sessionId), {
    method: "PATCH",
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${session?.access_token ?? ""}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(draft)
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(payload.error ?? "练习进度保存失败。");
  }
}

async function parseGrammarSessionResponse(
  response: Response
): Promise<GrammarPracticeSessionPayload> {
  const payload = (await response.json().catch(() => ({}))) as
    | GrammarPracticeSessionPayload
    | { error?: string };
  if (!response.ok || "error" in payload) {
    throw new Error(
      ("error" in payload ? payload.error : "") ?? "语法练习加载失败，请稍后重试。"
    );
  }
  if (!("session" in payload) || !payload.session) {
    throw new Error("语法练习加载结果无效。");
  }
  return payload;
}
