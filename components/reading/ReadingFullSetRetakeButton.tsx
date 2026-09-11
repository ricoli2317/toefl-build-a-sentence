"use client";

import { RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  STUDENT_PRACTICE_HISTORY_CACHE_PREFIX,
  STUDENT_READING_FULL_SET_CACHE_PREFIX,
  useStudentDataCache
} from "@/components/StudentDataCache";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { isReadingFullSetAttemptSummary } from "@/lib/reading/fullSetAttempts";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";

export function ReadingFullSetRetakeButton({
  compact = false,
  fullSetId
}: {
  compact?: boolean;
  fullSetId: string;
}) {
  const router = useRouter();
  const cache = useStudentDataCache();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  async function retake() {
    if (loading) return;
    setLoading(true);
    setError("");
    try {
      const { data: { session } } = await createBrowserSupabase().auth.getSession();
      if (!session) throw new Error("请先登录后再重新练习。");
      const response = await fetch("/api/reading/full-set-attempts", {
        method: "POST",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ fullSetId })
      });
      const payload = await response.json().catch(() => ({})) as { attempt?: unknown; error?: string };
      if (!response.ok || !isReadingFullSetAttemptSummary(payload.attempt)) {
        throw new Error(payload.error ?? "暂时无法开始再次练习。");
      }
      cache.invalidate(STUDENT_READING_FULL_SET_CACHE_PREFIX);
      cache.invalidate(STUDENT_PRACTICE_HISTORY_CACHE_PREFIX);
      cache.setData(`reading:full-sets:attempt:${fullSetId}`, { attempt: payload.attempt });
      router.push(`${STUDENT_ROUTES.readingFullSets}/${encodeURIComponent(fullSetId)}/attempt/${encodeURIComponent(payload.attempt.attemptId)}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "暂时无法开始再次练习。");
      setLoading(false);
    }
  }
  return (
    <div>
      <button
        className={compact ? "student-button-primary min-h-9 px-3 py-1.5 text-sm" : "student-button-primary"}
        disabled={loading}
        onClick={retake}
        type="button"
      >
        <RotateCcw aria-hidden="true" size={17} />
        {loading ? "正在准备..." : "再次练习"}
      </button>
      {error ? <p className="mt-2 text-xs font-semibold text-student-error">{error}</p> : null}
    </div>
  );
}
