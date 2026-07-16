const QUESTION_BANK_UPDATED_EVENT = "question-bank-updated";
const QUESTION_BANK_UPDATED_CHANNEL = "question-bank-cache-updates";

export function broadcastQuestionBankUpdated() {
  if (typeof window === "undefined") return;

  window.dispatchEvent(new Event(QUESTION_BANK_UPDATED_EVENT));
  if (typeof BroadcastChannel === "undefined") return;

  const channel = new BroadcastChannel(QUESTION_BANK_UPDATED_CHANNEL);
  channel.postMessage({ type: QUESTION_BANK_UPDATED_EVENT });
  channel.close();
}

export function subscribeToQuestionBankUpdates(callback: () => void) {
  if (typeof window === "undefined") return () => undefined;

  window.addEventListener(QUESTION_BANK_UPDATED_EVENT, callback);
  const channel =
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel(QUESTION_BANK_UPDATED_CHANNEL);
  const onMessage = (event: MessageEvent) => {
    if (event.data?.type === QUESTION_BANK_UPDATED_EVENT) callback();
  };
  channel?.addEventListener("message", onMessage);

  return () => {
    window.removeEventListener(QUESTION_BANK_UPDATED_EVENT, callback);
    channel?.removeEventListener("message", onMessage);
    channel?.close();
  };
}
