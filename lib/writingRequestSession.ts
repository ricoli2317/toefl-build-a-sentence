export type WritingRequestSession = {
  accessToken: string;
  email: string | null;
  studentId: string;
};

export type WritingRequestSessionLookup = () => Promise<WritingRequestSession | null>;

export type WritingRequestSessionDependencies = {
  getSession: WritingRequestSessionLookup;
  refreshSession: WritingRequestSessionLookup;
};

/**
 * Raised when a writing request cannot obtain a usable session even after the
 * single automatic refresh/retry. Callers use this to switch from silent
 * recovery to the manual recovery flow instead of guessing from status codes.
 */
export class WritingSessionError extends Error {
  constructor(message = "登录状态已失效，请重新登录。") {
    super(message);
    this.name = "WritingSessionError";
  }
}

export function isWritingSessionError(error: unknown): error is WritingSessionError {
  return error instanceof WritingSessionError;
}

/**
 * Sends one writing request with the session that is current at call time.
 *
 * The session is read for every request (never captured once at page load) so
 * Supabase's own refresh cycle keeps the token fresh. A 401 triggers exactly
 * one refresh-and-retry; every other status is returned untouched, so
 * non-authentication failures never trigger a token refresh.
 */
export async function sendWritingRequestWithSession(
  send: (accessToken: string) => Promise<Response>,
  dependencies: WritingRequestSessionDependencies
): Promise<{ response: Response; session: WritingRequestSession }> {
  const session = await dependencies.getSession();
  if (!session) throw new WritingSessionError();

  let response = await send(session.accessToken);
  if (response.status !== 401) return { response, session };

  const refreshed = await dependencies.refreshSession();
  if (refreshed) response = await send(refreshed.accessToken);
  if (!refreshed || response.status === 401) throw new WritingSessionError();

  return { response, session: refreshed };
}
