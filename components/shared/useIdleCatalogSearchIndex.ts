"use client";

import { useEffect, useState } from "react";
import {
  useStudentCachedData,
  type StudentCacheSession
} from "@/components/StudentDataCache";

/**
 * Search-index prefetch for the student catalogs.
 *
 * The main catalog renders first; the search index is only requested after the
 * browser goes idle (with a short initial delay so it never competes with the
 * first screen). If the student starts searching before the idle prefetch
 * fired, the request starts immediately through the same StudentDataCache
 * entry, so the idle path and the user path can never produce two fetches.
 */
export function useIdleCatalogSearchIndex<T>(input: {
  cacheKey: string;
  load: (session: StudentCacheSession) => Promise<T>;
  mainCatalogReady: boolean;
  /** true as soon as the student actually started searching. */
  immediate: boolean;
  initialDelayMs?: number;
  idleTimeoutMs?: number;
  fallbackDelayMs?: number;
}) {
  const {
    cacheKey,
    fallbackDelayMs = 1200,
    idleTimeoutMs = 2000,
    immediate,
    initialDelayMs = 300,
    load,
    mainCatalogReady
  } = input;
  const [idleEnabled, setIdleEnabled] = useState(false);

  useEffect(() => {
    if (!mainCatalogReady || idleEnabled) return;
    let cancelled = false;
    let idleHandle: number | null = null;
    let timeoutHandle: number | null = null;

    const enable = () => {
      if (!cancelled) setIdleEnabled(true);
    };
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const schedule = () => {
      if (cancelled) return;
      if (typeof idleWindow.requestIdleCallback === "function") {
        idleHandle = idleWindow.requestIdleCallback(enable, { timeout: idleTimeoutMs });
      } else {
        timeoutHandle = window.setTimeout(enable, fallbackDelayMs);
      }
    };
    timeoutHandle = window.setTimeout(schedule, initialDelayMs);

    return () => {
      cancelled = true;
      if (timeoutHandle !== null) window.clearTimeout(timeoutHandle);
      if (idleHandle !== null) idleWindow.cancelIdleCallback?.(idleHandle);
    };
  }, [
    fallbackDelayMs,
    idleEnabled,
    idleTimeoutMs,
    initialDelayMs,
    mainCatalogReady
  ]);

  return useStudentCachedData<T>(cacheKey, load, {
    enabled: mainCatalogReady && (idleEnabled || immediate)
  });
}
