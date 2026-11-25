"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject
} from "react";
import {
  useTeacherCachedData,
  useTeacherDataCache
} from "@/components/TeacherDataCache";

/**
 * One accumulated, cursor-paginated teacher list.
 *
 * The first page lives in TeacherDataCache under the list's own key (tab +
 * filters), and every appended page is merged back into that same entry, so
 * returning from a detail page restores the loaded rows instead of starting
 * over. Only one next-page request may run at a time; a filter change replaces
 * the key, and a response for an older key (or for a refreshed snapshot) is
 * dropped instead of being merged into the new list.
 */
export type TeacherIncrementalPage<T> = {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
};

export function useTeacherIncrementalList<T>({
  cacheKey,
  enabled = true,
  getId,
  loadPage
}: {
  cacheKey: string;
  enabled?: boolean;
  getId: (item: T) => string;
  loadPage: (cursor: string | null) => Promise<TeacherIncrementalPage<T>>;
}) {
  const cache = useTeacherDataCache();
  const state = useTeacherCachedData<TeacherIncrementalPage<T>>(
    cacheKey,
    () => loadPage(null),
    { enabled }
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState("");
  const loadingRef = useRef(false);
  const requestIdRef = useRef(0);
  const cacheKeyRef = useRef(cacheKey);
  const dataRef = useRef(state.data);
  const getIdRef = useRef(getId);
  const loadPageRef = useRef(loadPage);
  cacheKeyRef.current = cacheKey;
  dataRef.current = state.data;
  getIdRef.current = getId;
  loadPageRef.current = loadPage;

  // A new tab/filter context starts with its own first page; the old request
  // (if any) must not append into it.
  useEffect(() => {
    requestIdRef.current += 1;
    loadingRef.current = false;
    setLoadingMore(false);
    setLoadMoreError("");
  }, [cacheKey]);

  const loadMore = useCallback(async () => {
    const current = dataRef.current;
    if (!current || !current.hasMore || !current.nextCursor) return;
    if (loadingRef.current) return;
    const requestKey = cacheKeyRef.current;
    const cursor = current.nextCursor;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    loadingRef.current = true;
    setLoadingMore(true);
    setLoadMoreError("");
    try {
      const page = await loadPageRef.current(cursor);
      if (cacheKeyRef.current !== requestKey || requestIdRef.current !== requestId) return;
      const entry = cache.getEntry(requestKey);
      if (
        (entry?.status !== "success" && entry?.status !== "refreshing") ||
        entry.data !== current
      ) {
        // The list was invalidated / refreshed while this page was in flight;
        // the fresh first page is authoritative.
        return;
      }
      const seen = new Set(current.items.map((item) => getIdRef.current(item)));
      const appended = page.items.filter((item) => !seen.has(getIdRef.current(item)));
      cache.set<TeacherIncrementalPage<T>>(requestKey, {
        items: [...current.items, ...appended],
        nextCursor: page.nextCursor,
        hasMore: page.hasMore
      });
    } catch (error) {
      if (cacheKeyRef.current === requestKey && requestIdRef.current === requestId) {
        setLoadMoreError(loadMoreErrorMessage(error));
      }
    } finally {
      if (requestIdRef.current === requestId) {
        loadingRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [cache]);

  const reload = useCallback(() => {
    void cache.refresh(cacheKey, () => loadPageRef.current(null));
  }, [cache, cacheKey]);

  return {
    data: state.data,
    items: state.data?.items ?? [],
    hasMore: state.data?.hasMore ?? false,
    loading: state.loading,
    refreshing: state.refreshing,
    error: state.error,
    loadingMore,
    loadMoreError,
    loadMore,
    reload
  };
}

/**
 * Observes a sentinel at the end of the list instead of listening to scroll
 * events, so the next page is requested only when the user actually approaches
 * the bottom. Re-observing after a load keeps a short first page (filtered
 * list) advancing without a manual click.
 */
export function useInfiniteListTrigger({
  hasMore,
  loading,
  loadingMore,
  onLoadMore
}: {
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}): RefObject<HTMLDivElement> {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore) return;
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (entries) => {
              if (entries.some((entry) => entry.isIntersecting)) {
                onLoadMoreRef.current();
              }
            },
            { rootMargin: "480px 0px" }
          );
    observer?.observe(node);

    // Fallback for environments that do not deliver IntersectionObserver
    // notifications (older embedded webviews). The listener is passive and rAF
    // throttled, and it only checks the sentinel's rect, so scrolling never
    // turns into a per-event request.
    let frame = 0;
    const isNearViewport = () => {
      const rect = node.getBoundingClientRect();
      return rect.top <= window.innerHeight + 480 && rect.bottom >= -480;
    };
    const check = () => {
      frame = 0;
      if (isNearViewport()) onLoadMoreRef.current();
    };
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(check);
    };
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      observer?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [hasMore, loading, loadingMore]);

  return sentinelRef;
}

export function TeacherInfiniteListFooter({
  hasMore,
  itemsCount,
  loadingMore,
  loadMoreError,
  onRetry,
  sentinelRef
}: {
  hasMore: boolean;
  itemsCount: number;
  loadingMore: boolean;
  loadMoreError: string;
  onRetry: () => void;
  sentinelRef: RefObject<HTMLDivElement>;
}) {
  if (!hasMore && itemsCount === 0) return null;
  return (
    <div className="grid gap-2 pt-1">
      {hasMore ? <div aria-hidden="true" className="h-px w-full" ref={sentinelRef} /> : null}
      {loadingMore ? (
        <p className="teacher-loading text-center text-sm">正在加载更多…</p>
      ) : loadMoreError ? (
        <div className="flex flex-wrap items-center justify-center gap-3 text-sm text-student-error">
          <span>{loadMoreError}</span>
          <button className="teacher-button-secondary" onClick={onRetry} type="button">
            重试
          </button>
        </div>
      ) : !hasMore && itemsCount > 0 ? (
        <p className="text-center text-xs text-student-muted">已全部加载</p>
      ) : null}
    </div>
  );
}

function loadMoreErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (/unauthorized|access token|session/i.test(message)) return "登录状态已失效，请重新登录。";
  return /[\u3400-\u9fff]/.test(message) ? message : "加载失败，请重试。";
}
