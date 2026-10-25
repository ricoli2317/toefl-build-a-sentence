"use client";

import { createBrowserSupabase } from "../supabase/client.ts";

type Session = { access_token: string; expires_at?: number; user: { id: string } };
type SessionResult = { data: { session: Session | null }; error: unknown };

function usableKeepaliveSession(cached: { accessToken: string; studentId: string } | null | undefined, studentId: string): Session | null {
  if (!cached || cached.studentId !== studentId) return null;
  try {
    const payload = cached.accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "="))) as { sub?: unknown; exp?: unknown };
    if (claims.sub !== studentId || typeof claims.exp !== "number" || !Number.isFinite(claims.exp)
      || claims.exp * 1000 <= Date.now() + 30_000) return null;
    // This is only a freshness hint for the transport. The API still verifies
    // the signed token and ownership; decoded claims never grant permission.
    return { access_token: cached.accessToken, expires_at: claims.exp, user: { id: studentId } };
  } catch {
    return null;
  }
}

export class ReadingFullSetSessionError extends Error {
  constructor(message = "登录状态已失效，请重新登录后继续套题练习。") {
    super(message);
    this.name = "ReadingFullSetSessionError";
  }
}

/** One send, with the SDK's current session. No auth POST or business retry is added. */
export async function fetchReadingFullSetWithSession(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  dependencies: {
    studentId: string;
    currentStudentId: () => string | null;
    cachedSession?: () => { accessToken: string; studentId: string } | null;
    getSession?: () => Promise<SessionResult>;
    fetchImpl?: typeof fetch;
  }
) {
  const assertOwner = () => {
    if (!dependencies.studentId || dependencies.currentStudentId() !== dependencies.studentId) {
      throw new ReadingFullSetSessionError("账号已切换或退出，请返回原账号继续这次练习。");
    }
  };
  assertOwner();
  // pagehide's existing keepalive writes must start before the document freezes.
  // Use the Auth-event-updated cache only when the same owner's JWT has ample
  // lifetime; expired/near-expiry credentials still go through the SDK.
  const cached = init?.keepalive ? usableKeepaliveSession(dependencies.cachedSession?.(), dependencies.studentId) : null;
  const { data: { session }, error } = cached
    ? { data: { session: cached }, error: null }
    : await (dependencies.getSession ? dependencies.getSession() : createBrowserSupabase().auth.getSession());
  assertOwner();
  if (error || !session?.access_token || session.user.id !== dependencies.studentId
    || (session.expires_at !== undefined && session.expires_at * 1000 <= Date.now())) {
    throw new ReadingFullSetSessionError();
  }
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  if (signal?.aborted) throw new DOMException("Request aborted", "AbortError");
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  headers.set("Authorization", `Bearer ${session.access_token}`);
  const response = await (dependencies.fetchImpl ?? fetch)(input, { ...init, headers });
  // Never apply a previous account's in-flight response to the next account.
  assertOwner();
  return response;
}
