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

export const TEACHER_STATS_CACHE_KEY = "teacher:stats:complete-answers-v2";
export const TEACHER_QUESTION_BANK_CACHE_PREFIX = "teacher:question-bank";
export const TEACHER_CURRENT_USER_CACHE_KEY = "teacher:current-user";
export const TEACHER_ACCESS_CACHE_KEY = "teacher:access";

type CacheEntry =
  | { status: "loading"; promise: Promise<unknown> }
  | { status: "success"; data: unknown }
  | { status: "error"; error: string };

type TeacherDataCacheValue = {
  clear: () => void;
  getEntry: (key: string) => CacheEntry | undefined;
  invalidate: (keyPrefix: string) => void;
  load: <T>(key: string, loader: () => Promise<T>) => Promise<T | undefined>;
  version: number;
};

const TeacherDataCacheContext = createContext<TeacherDataCacheValue | null>(null);

export function TeacherDataCacheProvider({ children }: { children: ReactNode }) {
  const entries = useRef(new Map<string, CacheEntry>());
  const [version, setVersion] = useState(0);

  const notify = useCallback(() => setVersion((value) => value + 1), []);

  const clear = useCallback(() => {
    entries.current.clear();
    notify();
  }, [notify]);

  const invalidate = useCallback(
    (keyPrefix: string) => {
      let changed = false;
      entries.current.forEach((_entry, key) => {
        if (key === keyPrefix || key.startsWith(`${keyPrefix}:`)) {
          entries.current.delete(key);
          changed = true;
        }
      });
      if (changed) notify();
    },
    [notify]
  );

  const getEntry = useCallback((key: string) => entries.current.get(key), []);

  const load = useCallback(
    async <T,>(key: string, loader: () => Promise<T>) => {
      const existing = entries.current.get(key);
      if (existing?.status === "success") return existing.data as T;
      if (existing?.status === "loading") return existing.promise as Promise<T>;
      if (existing?.status === "error") return undefined;

      const promise = loader();
      entries.current.set(key, { status: "loading", promise });
      notify();

      try {
        const data = await promise;
        const current = entries.current.get(key);
        if (current?.status === "loading" && current.promise === promise) {
          entries.current.set(key, { status: "success", data });
          notify();
        }
        return data;
      } catch (error) {
        const current = entries.current.get(key);
        if (current?.status === "loading" && current.promise === promise) {
          entries.current.set(key, {
            status: "error",
            error: error instanceof Error ? error.message : "Could not load teacher data."
          });
          notify();
        }
        return undefined;
      }
    },
    [notify]
  );

  const value = useMemo(
    () => ({ clear, getEntry, invalidate, load, version }),
    [clear, getEntry, invalidate, load, version]
  );

  return (
    <TeacherDataCacheContext.Provider value={value}>
      {children}
    </TeacherDataCacheContext.Provider>
  );
}

export function useTeacherCachedData<T>(key: string, loader: () => Promise<T>) {
  const cache = useContext(TeacherDataCacheContext);
  if (!cache) {
    throw new Error("Teacher data cache is unavailable outside the teacher layout.");
  }

  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const entry = cache.getEntry(key);

  useEffect(() => {
    if (!cache.getEntry(key)) {
      void cache.load(key, () => loaderRef.current());
    }
  }, [cache, key]);

  return {
    data: entry?.status === "success" ? (entry.data as T) : null,
    error: entry?.status === "error" ? entry.error : "",
    loading: !entry || entry.status === "loading"
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
