"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import {
  cacheDomainsForEvent,
  subscribeToCacheInvalidation
} from "@/lib/cacheInvalidation";

export const TEACHER_STATS_CACHE_SCHEMA_VERSION = 2;
export const TEACHER_STATS_CACHE_KEY =
  `teacher:stats:logical-schema-${TEACHER_STATS_CACHE_SCHEMA_VERSION}`;
export const TEACHER_QUESTION_BANK_CACHE_PREFIX = "teacher:question-bank";
export const TEACHER_CURRENT_USER_CACHE_KEY = "teacher:current-user";
export const TEACHER_ACCESS_CACHE_KEY = "teacher:access";
export const TEACHER_WRITING_REVIEWS_CACHE_KEY =
  "teacher:writing-reviews:historical-display-v2";
export const TEACHER_WRITING_ASSIGNMENTS_CACHE_PREFIX = "teacher:writing-assignments";
export const TEACHER_WRITING_ASSIGNMENTS_CACHE_KEY = "teacher:writing-assignments:list";
export const TEACHER_WRITING_ASSIGNMENT_STUDENTS_CACHE_KEY =
  "teacher:writing-assignments:students";
export const TEACHER_WRITING_ASSIGNMENT_AVATARS_CACHE_KEY =
  "teacher:writing-assignments:academic-discussion-avatars";
export const TEACHER_WRITING_REVIEW_WORKSPACE_CACHE_PREFIX =
  "teacher:writing-review-workspace:historical-display-v2";

type CacheEntry =
  | { status: "loading"; promise: Promise<unknown>; generation: number }
  | { status: "refreshing"; data: unknown; promise: Promise<unknown>; generation: number }
  | { status: "success"; data: unknown }
  | { status: "error"; error: string };

type TeacherDataCacheValue = {
  clear: () => void;
  getEntry: (key: string) => CacheEntry | undefined;
  invalidate: (keyPrefix: string) => void;
  load: <T>(key: string, loader: () => Promise<T>) => Promise<T | undefined>;
  refresh: <T>(key: string, loader: () => Promise<T>) => Promise<T | undefined>;
  set: <T>(key: string, data: T) => void;
  version: number;
};

const TeacherDataCacheContext = createContext<TeacherDataCacheValue | null>(null);

export function TeacherDataCacheProvider({ children }: { children: ReactNode }) {
  const entries = useRef(new Map<string, CacheEntry>());
  const generations = useRef(new Map<string, number>());
  const [version, setVersion] = useState(0);

  const notify = useCallback(() => setVersion((value) => value + 1), []);

  const clear = useCallback(() => {
    entries.current.clear();
    generations.current.clear();
    notify();
  }, [notify]);

  const invalidate = useCallback(
    (keyPrefix: string) => {
      let changed = false;
      entries.current.forEach((_entry, key) => {
        if (key === keyPrefix || key.startsWith(`${keyPrefix}:`)) {
          entries.current.delete(key);
          generations.current.set(key, (generations.current.get(key) ?? 0) + 1);
          changed = true;
        }
      });
      if (changed) notify();
    },
    [notify]
  );

  const getEntry = useCallback((key: string) => entries.current.get(key), []);

  const set = useCallback(
    <T,>(key: string, data: T) => {
      entries.current.set(key, { status: "success", data });
      generations.current.set(key, (generations.current.get(key) ?? 0) + 1);
      notify();
    },
    [notify]
  );

  const load = useCallback(
    async <T,>(key: string, loader: () => Promise<T>) => {
      const existing = entries.current.get(key);
      if (existing?.status === "success") return existing.data as T;
      if (existing?.status === "loading") return existing.promise as Promise<T>;
      if (existing?.status === "refreshing") return existing.promise as Promise<T>;
      if (existing?.status === "error") return undefined;

      const generation = generations.current.get(key) ?? 0;
      const promise = loader();
      entries.current.set(key, { status: "loading", promise, generation });
      notify();

      try {
        const data = await promise;
        const current = entries.current.get(key);
        if (
          current?.status === "loading" &&
          current.promise === promise &&
          current.generation === generation &&
          (generations.current.get(key) ?? 0) === generation
        ) {
          entries.current.set(key, { status: "success", data });
          notify();
        }
        return data;
      } catch (error) {
        const current = entries.current.get(key);
        if (current?.status === "loading" && current.promise === promise) {
          entries.current.set(key, {
            status: "error",
            error: error instanceof Error ? error.message : "无法加载教师端数据。"
          });
          notify();
        }
        return undefined;
      }
    },
    [notify]
  );

  const refresh = useCallback(
    async <T,>(key: string, loader: () => Promise<T>) => {
      const existing = entries.current.get(key);
      if (existing?.status === "loading" || existing?.status === "refreshing") {
        return existing.promise as Promise<T>;
      }
      if (existing?.status !== "success") return load(key, loader);

      const previousData = existing.data as T;
      const generation = generations.current.get(key) ?? 0;
      const promise = loader();
      entries.current.set(key, {
        status: "refreshing",
        data: previousData,
        promise,
        generation
      });
      notify();
      try {
        const data = await promise;
        const current = entries.current.get(key);
        if (
          current?.status === "refreshing" &&
          current.promise === promise &&
          current.generation === generation &&
          (generations.current.get(key) ?? 0) === generation
        ) {
          entries.current.set(key, { status: "success", data });
          notify();
        }
        return data;
      } catch {
        const current = entries.current.get(key);
        if (current?.status === "refreshing" && current.promise === promise) {
          entries.current.set(key, { status: "success", data: previousData });
          notify();
        }
        return undefined;
      }
    },
    [load, notify]
  );

  useEffect(
    () =>
      subscribeToCacheInvalidation((event) => {
        for (const domain of cacheDomainsForEvent(event)) {
          switch (domain) {
            case "teacherStats":
              invalidate(TEACHER_STATS_CACHE_KEY);
              break;
            case "teacherQuestionBank":
              invalidate(TEACHER_QUESTION_BANK_CACHE_PREFIX);
              break;
            case "teacherWritingReviews":
              invalidate(TEACHER_WRITING_REVIEWS_CACHE_KEY);
              break;
            case "teacherWritingReviewWorkspace":
              invalidate(TEACHER_WRITING_REVIEW_WORKSPACE_CACHE_PREFIX);
              break;
            case "teacherAssignments":
              invalidate(TEACHER_WRITING_ASSIGNMENTS_CACHE_PREFIX);
              break;
          }
        }
      }),
    [invalidate]
  );

  const value = useMemo(
    () => ({ clear, getEntry, invalidate, load, refresh, set, version }),
    [clear, getEntry, invalidate, load, refresh, set, version]
  );

  return (
    <TeacherDataCacheContext.Provider value={value}>
      {children}
    </TeacherDataCacheContext.Provider>
  );
}

export function useTeacherCachedData<T>(
  key: string,
  loader: () => Promise<T>,
  options?: { refreshOnMount?: boolean }
) {
  const cache = useContext(TeacherDataCacheContext);
  if (!cache) {
    throw new Error("Teacher data cache is unavailable outside the teacher layout.");
  }

  const loaderRef = useRef(loader);
  const mountedRequestRef = useRef<string | null>(null);
  loaderRef.current = loader;
  const entry = cache.getEntry(key);

  useEffect(() => {
    const entry = cache.getEntry(key);
    if (!entry) {
      mountedRequestRef.current = key;
      void cache.load(key, () => loaderRef.current());
      return;
    }
    if (options?.refreshOnMount && mountedRequestRef.current !== key) {
      mountedRequestRef.current = key;
      void cache.refresh(key, () => loaderRef.current());
    }
  }, [cache, key, options?.refreshOnMount]);

  return {
    data:
      entry?.status === "success" || entry?.status === "refreshing"
        ? (entry.data as T)
        : null,
    error: entry?.status === "error" ? entry.error : "",
    loading: !entry || entry.status === "loading",
    refreshing: entry?.status === "refreshing"
  };
}

export function useTeacherDataCache() {
  const cache = useContext(TeacherDataCacheContext);
  if (!cache) {
    throw new Error("Teacher data cache is unavailable outside the teacher layout.");
  }
  return cache;
}

export function useOptionalTeacherDataCache() {
  return useContext(TeacherDataCacheContext);
}
