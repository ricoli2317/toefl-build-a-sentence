import {
  publishCacheInvalidation,
  subscribeToCacheInvalidation
} from "@/lib/cacheInvalidation";

export function broadcastQuestionBankUpdated() {
  publishCacheInvalidation({ type: "PRACTICE_CATALOG_UPDATED" });
}

export function subscribeToQuestionBankUpdates(callback: () => void) {
  return subscribeToCacheInvalidation((event) => {
    if (event.type === "PRACTICE_CATALOG_UPDATED") callback();
  });
}
