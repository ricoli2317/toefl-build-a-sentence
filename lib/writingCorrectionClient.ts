"use client";

import { createWritingCorrectionClient } from "./writingCorrectionUi";
import { getWritingClientSession, refreshWritingClientSession } from "./writingClientSession";
import { sendWritingRequestWithSession } from "./writingRequestSession";
import { publishCacheInvalidation } from "./cacheInvalidation";

export const writingCorrectionClient = createWritingCorrectionClient(async (path, init) => {
  const { response } = await sendWritingRequestWithSession((token) => fetch(path, {
    ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` }
  }), { getSession: getWritingClientSession, refreshSession: refreshWritingClientSession });
  return response;
}, (attempt) => publishCacheInvalidation({
  type: "WRITING_CORRECTION_UPDATED", attemptKind: "correction",
  attemptId: attempt.attempt_id, originalAttemptId: attempt.original_attempt_id,
  studentId: attempt.user_id
}));
