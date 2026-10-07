/** Serialize category writes per session. A delayed autosave may not overtake
 * Next/final Submit, and an error must remain visible to a navigation flush. */
export function createCategoryDraftQueue<T>(save: (itemId: string, draft: T) => Promise<void>) {
  const pending = new Map<string, T>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let tail = Promise.resolve();
  let failure: unknown;
  function enqueue(itemId: string) {
    const draft = pending.get(itemId);
    if (!draft) return tail;
    pending.delete(itemId);
    const job = tail.then(() => save(itemId, draft));
    tail = job.catch((error) => { failure = error; });
    return job;
  }
  return {
    schedule(itemId: string, draft: T, onError: (error: unknown) => void) {
      pending.set(itemId, draft);
      clearTimeout(timers.get(itemId));
      timers.set(itemId, setTimeout(() => { timers.delete(itemId); void enqueue(itemId).catch(onError); }, 500));
    },
    async flush(itemId: string) {
      clearTimeout(timers.get(itemId)); timers.delete(itemId);
      const hadPending = pending.has(itemId);
      await enqueue(itemId);
      // A successful replacement snapshot supersedes an earlier save failure.
      if (hadPending) failure = undefined;
      if (failure) { const error = failure; failure = undefined; throw error; }
    },
    dispose() { timers.forEach(clearTimeout); timers.clear(); pending.clear(); }
  };
}
