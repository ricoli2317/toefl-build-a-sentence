"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useStudentDataCache } from "@/components/StudentDataCache";
import { fetchReview } from "@/lib/lexical/wordbookReviewRequest";
import type { VocabularyOverallProgress } from "@/lib/ctw-vocabulary/model";
import { VOCABULARY_API } from "@/lib/ctw-vocabulary/round";

export const CTW_PROGRESS_CHANGED = "ctw-vocabulary-progress-changed";

/** Intentionally not in the persistent layout cache: imports can happen outside
 * this browser. Every catalog entry/reload obtains a fresh server aggregate.
 * Focus/pageshow and a visible-only interval also cover another tab/device.
 */
export function useCtwVocabularyProgress() {
  const { getSession, studentId, sessionReady } = useStudentDataCache();
  const [state, setState] = useState<{ owner: string | null; data?: VocabularyOverallProgress; error?: string }>({ owner: null });
  const [revision, setRevision] = useState(0);
  const owner = useRef(studentId); owner.current = studentId;
  const retry = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (!sessionReady || !studentId) return;
    let active = true, pending = false, again = false;
    const controller = new AbortController();
    const read = async () => {
      if (!active || document.visibilityState === "hidden") return;
      if (pending) { again = true; return; }
      const session = getSession();
      if (!session || session.studentId !== studentId) return;
      pending = true;
      try {
        const data = await fetchReview<VocabularyOverallProgress>(`${VOCABULARY_API}/progress`, session.accessToken, undefined, controller.signal);
        if (active && owner.current === studentId) setState({ owner: studentId, data });
      } catch (error) {
        if (active && owner.current === studentId) setState({ owner: studentId,
          error: error instanceof Error ? error.message : "总进度读取失败，请重试。" });
      } finally {
        pending = false;
        if (again && active) { again = false; void read(); }
      }
    };
    const refresh = () => { void read(); };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    window.addEventListener(CTW_PROGRESS_CHANGED, refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 30000);
    return () => {
      active = false; controller.abort(); window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener(CTW_PROGRESS_CHANGED, refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [getSession, studentId, sessionReady, revision]);
  return { data: state.owner === studentId ? state.data : undefined,
    error: state.owner === studentId ? state.error : undefined, retry };
}
