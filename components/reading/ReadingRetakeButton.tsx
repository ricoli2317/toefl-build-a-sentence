"use client";

import { RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { isReadingAttemptSummary } from "@/lib/reading/attempts";
import {
  studentReadingCatalogCacheKey,
  useStudentDataCache
} from "@/components/StudentDataCache";

export function ReadingRetakeButton({
  attemptId,
  compact = false,
  label
}: {
  attemptId: string;
  compact?: boolean;
  label?: string;
}) {
  const router = useRouter();
  const { invalidate } = useStudentDataCache();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function retake() {
    if (loading) return;
    setLoading(true);
    setError("");
    try {
      const { data: { session } } = await createBrowserSupabase().auth.getSession();
      if (!session) throw new Error("请先登录后再重新练习。");
      const response = await fetch(`/api/reading/attempts/${encodeURIComponent(attemptId)}/retake`, {
        method: "POST",
        cache: "no-store",
        headers: { Authorization: `Bearer ${session.access_token}` }
      });
      const payload = await response.json().catch(() => ({})) as {
        attempt?: unknown;
        error?: string;
      };
      if (!response.ok || !isReadingAttemptSummary(payload.attempt)) {
        throw new Error(payload.error ?? "暂时无法开始重新练习。");
      }
      invalidate(studentReadingCatalogCacheKey(payload.attempt.taskType));
      router.push(`/student/reading/practice/${encodeURIComponent(payload.attempt.logicalItemId)}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "暂时无法开始重新练习。");
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        className={compact
          ? "student-button-primary min-h-8 px-3 py-1 text-xs sm:text-[13px]"
          : "student-button-primary"}
        disabled={loading}
        onClick={retake}
        type="button"
      >
        <RotateCcw aria-hidden="true" size={17} />
        {loading ? "正在准备..." : label ?? (compact ? "再练一次" : "重新练习")}
      </button>
      {error ? <p className="mt-2 text-xs font-semibold text-student-error">{error}</p> : null}
    </div>
  );
}
