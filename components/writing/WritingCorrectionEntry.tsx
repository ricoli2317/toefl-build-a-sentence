"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { WritingAttempt } from "@/lib/writing";
import type { WritingCorrectionClient } from "@/lib/writingCorrectionUi";
import { writingCorrectionClient } from "@/lib/writingCorrectionClient";

/** Rendered only in the owned, published original's action area (closed in production). */
export function WritingCorrectionEntry({ originalAttemptId, client = writingCorrectionClient, onOpened }: {
  originalAttemptId: string;
  client?: WritingCorrectionClient;
  onOpened?: (attempt: WritingAttempt) => void;
}) {
  const router = useRouter();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function open() {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const attempt = await client.create(originalAttemptId);
      if (onOpened) onOpened(attempt);
      else router.push(`/student/writing-corrections/${encodeURIComponent(attempt.attempt_id)}?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法创建或恢复订正草稿。");
    } finally { busyRef.current = false; setBusy(false); }
  }
  return <div className="inline-flex flex-col items-start gap-1">
    <button className="student-button-primary" disabled={busy} onClick={() => void open()} type="button">{busy ? "正在恢复草稿…" : "编辑订正"}</button>
    {error ? <p className="text-sm text-student-error" role="alert">{error}</p> : null}
  </div>;
}
