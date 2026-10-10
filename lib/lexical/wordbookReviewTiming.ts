import type { ReviewState } from "./wordbookReview.ts";

export const REVIEW_SWITCH_DELAY = 1000;
type PendingSwitch = { itemId: string; deadline: number };
const key = (owner: string, session: string) => `tps:wordbook-review:switch:${owner}:${session}`;

// Only a short-lived item/deadline is persisted, not answers, prepared cards,
// credentials or scores. This also gates a refresh after the server advanced.
export function readReviewSwitch(owner: string, session: string): PendingSwitch | null {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(key(owner, session)) ?? "null");
    return value && typeof value.itemId === "string" && Number.isFinite(value.deadline) ? value : null;
  } catch { return null; }
}
export function saveReviewSwitch(owner: string, session: string, value: PendingSwitch) {
  try { window.sessionStorage.setItem(key(owner, session), JSON.stringify(value)); } catch { /* Storage may be disabled. */ }
}
export function clearReviewSwitch(owner: string, session: string) {
  try { window.sessionStorage.removeItem(key(owner, session)); } catch { /* Storage may be disabled. */ }
}

export function waitForReviewSwitch(deadline: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  const remaining = Math.max(0, deadline - Date.now());
  if (!remaining) return Promise.resolve(true);
  return new Promise(resolve => {
    const finish = (ready: boolean) => {
      clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(ready);
    };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(true), remaining);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Start preparation NOW. Only publication waits for the click-based deadline.
 * A slow request publishes as soon as it succeeds, with no second 1s delay. */
export async function prepareReviewAdvance(prepare: () => Promise<ReviewState>, deadline: number,
  signal: AbortSignal, publish: (state: ReviewState) => void) {
  if (signal.aborted) return;
  const next = await prepare();
  if (await waitForReviewSwitch(deadline, signal) && !signal.aborted) publish(next);
}
