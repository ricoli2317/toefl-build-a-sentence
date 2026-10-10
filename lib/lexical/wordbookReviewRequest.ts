export class ReviewRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) { super(message); this.status = status; this.code = code; }
  get retryable() { return this.status === 0 || [408, 425, 429, 500, 502, 503, 504].includes(this.status); }
}
/** Scope retry/timeout recovery to Wordbook, never change shared auth or fetch. */
export async function fetchReview<T>(url: string, token: string, body?: unknown, signal?: AbortSignal, attempt = 0): Promise<T> {
  const abort = new AbortController(); const cancel = () => abort.abort();
  signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) abort.abort();
  const timeout = setTimeout(() => abort.abort(), 12000);
  try {
    const response = await fetch(url, { method: body === undefined ? "GET" : "POST", cache: "no-store", signal: abort.signal,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json().catch(error => {
      const failure = new ReviewRequestError("复习服务响应不完整，请重试；未确认的保存不会移出队列。", 502, "REVIEW_RESPONSE");
      failure.cause = error; throw failure;
    });
    if (!response.ok) throw new ReviewRequestError(result.error ?? "复习服务暂不可用，请重试。", response.status, result.code ?? "REVIEW_REQUEST");
    return result as T;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof ReviewRequestError && (!error.retryable || body !== undefined || attempt)) throw error;
    // Safari's TypeError('Load failed') comes from fetch/body transport, not
    // grading. Preserve it as cause, but provide an actionable sync message.
    const saving = body && typeof body === "object" && "action" in body && body.action === "sync";
    const failure = error instanceof ReviewRequestError ? error : new ReviewRequestError(abort.signal.aborted
      ? saving ? "连接超时，待同步记录已保留，正在等待重试。" : "连接超时，请稍后重试。"
      : saving ? "网络连接中断，待同步记录已保留，恢复连接后自动重试。" : "网络连接中断，请检查网络后重试。", 0, "REVIEW_NETWORK");
    if (failure !== error) failure.cause = error;
    // One safe read retry; writes are retried ONLY by the durable ordered queue.
    if (body === undefined && !attempt) {
      clearTimeout(timeout); await new Promise(resolve => setTimeout(resolve, 150));
      if (signal?.aborted) throw failure;
      return fetchReview<T>(url, token, body, signal, attempt + 1);
    }
    throw failure;
  } finally { clearTimeout(timeout); signal?.removeEventListener("abort", cancel); }
}
