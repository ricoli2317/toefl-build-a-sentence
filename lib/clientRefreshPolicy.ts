/** Shared TPS refresh contract: entry/manual/confirmed mutation may requery;
 * focus, blur, visibility, same-user auth events must not invalidate UI data.
 * Optional polling is visible-only, never catch-up on focus, and must not clear
 * displayed data or remount editors. Keep business timers separate from this.
 */
export function startVisiblePolling(task: () => void, intervalMs: number, environment: {
  visible: () => boolean;
  setInterval: (callback: () => void, milliseconds: number) => ReturnType<typeof setInterval>;
  clearInterval: (timer: ReturnType<typeof setInterval>) => void;
} = {
  visible: () => document.visibilityState === "visible",
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: timer => clearInterval(timer)
}) {
  const timer = environment.setInterval(() => { if (environment.visible()) task(); }, intervalMs);
  return () => environment.clearInterval(timer);
}

// Own one gate per resource/owner. A newer load, mutation, close or unmount
// invalidates older results, including their error/finally handlers.
export function createLatestRequestGate() {
  let generation = 0;
  return { begin: () => ++generation, invalidate: () => { generation++; }, isCurrent: (token: number) => token === generation };
}
