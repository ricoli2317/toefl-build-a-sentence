import type { StudentReadingPracticePayload } from "./studentPractice.ts";

/** Saving locks mutations, not the material workspace. Only content misses or
 * explicit finalization may replace it with pending UI. */
export function readingSessionActivity(materialPending: boolean, saving: boolean, finalizing: boolean) {
  return { pending: materialPending || finalizing, navigationDisabled: materialPending || saving || finalizing };
}

/** Same-turn guard as well as a render-time disabled button: double clicks must
 * never race a source save, Previous flush, or final Submit. */
export function acquireReadingSessionWrite(lock: { current: boolean }, finished: boolean) {
  if (lock.current || finished) return false;
  lock.current = true;
  return true;
}

/** Read the existing shared cache synchronously. Stale/refreshing content is
 * still usable; answer metadata is a separate async dependency. */
export function readReadingSessionCache<T>(cache: {
  getEntry: (key: string) => { status: string; data?: unknown } | undefined;
}, key: string): T | null {
  const entry = cache.getEntry(key);
  return entry && ["success", "stale", "refreshing"].includes(entry.status)
    ? (entry.data as T) ?? null : null;
}

export function readReadingSessionPractice(cache: Parameters<typeof readReadingSessionCache>[0], key: string) {
  return readReadingSessionCache<{ practice?: StudentReadingPracticePayload }>(cache, key)?.practice ?? null;
}
