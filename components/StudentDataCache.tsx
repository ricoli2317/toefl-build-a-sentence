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
import { createBrowserSupabase } from "@/lib/supabase/client";

export const STUDENT_SETS_CACHE_PREFIX = "sets";
export const STUDENT_SETS_CACHE_KEY = "sets:all";
export const STUDENT_WRONG_QUESTIONS_CACHE_PREFIX = "wrong-questions";
export const STUDENT_CURRENT_USER_CACHE_KEY = "current-user";

export function studentQuestionsCacheKey(setId: string) {
  return `questions:${setId}`;
}

export function studentAttemptCacheKey(attemptId: string) {
  return `attempt:${attemptId}`;
}

export function studentWrongQuestionsCacheKey(query: string) {
  return `${STUDENT_WRONG_QUESTIONS_CACHE_PREFIX}:${query}`;
}

export type StudentCacheSession = {
  accessToken: string;
  studentId: string;
};

type CacheEntry =
  | { status: "loading"; promise: Promise<unknown> }
  | { status: "success"; data: unknown }
  | { status: "error"; error: string };

type StudentDataCacheValue = {
  clear: () => void;
  getEntry: (key: string) => CacheEntry | undefined;
  invalidate: (keyPrefix: string) => void;
  load: <T>(
    key: string,
    loader: (session: StudentCacheSession) => Promise<T>
  ) => Promise<T | undefined>;
  sessionReady: boolean;
  setData: <T>(key: string, data: T) => void;
  studentId: string | null;
  version: number;
};

const StudentDataCacheContext = createContext<StudentDataCacheValue | null>(null);

export function StudentDataCacheProvider({ children }: { children: ReactNode }) {
  const entries = useRef(new Map<string, CacheEntry>());
  const sessionRef = useRef<StudentCacheSession | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [studentId, setStudentId] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const notify = useCallback(() => setVersion((value) => value + 1), []);

  const clear = useCallback(() => {
    entries.current.clear();
    notify();
  }, [notify]);

  const scopedKey = useCallback((key: string) => {
    const activeStudentId = sessionRef.current?.studentId;
    return activeStudentId ? `student:${activeStudentId}:${key}` : null;
  }, []);

  const getEntry = useCallback(
    (key: string) => {
      const keyWithStudent = scopedKey(key);
      return keyWithStudent ? entries.current.get(keyWithStudent) : undefined;
    },
    [scopedKey]
  );

  const invalidate = useCallback(
    (keyPrefix: string) => {
      const prefixWithStudent = scopedKey(keyPrefix);
      if (!prefixWithStudent) return;

      let changed = false;
      entries.current.forEach((_entry, key) => {
        if (key === prefixWithStudent || key.startsWith(`${prefixWithStudent}:`)) {
          entries.current.delete(key);
          changed = true;
        }
      });
      if (changed) notify();
    },
    [notify, scopedKey]
  );

  const setData = useCallback(
    <T,>(key: string, data: T) => {
      const keyWithStudent = scopedKey(key);
      if (!keyWithStudent) return;
      entries.current.set(keyWithStudent, { status: "success", data });
      notify();
    },
    [notify, scopedKey]
  );

  const load = useCallback(
    async <T,>(
      key: string,
      loader: (session: StudentCacheSession) => Promise<T>
    ) => {
      const session = sessionRef.current;
      const keyWithStudent = scopedKey(key);
      if (!session || !keyWithStudent) return undefined;

      const existing = entries.current.get(keyWithStudent);
      if (existing?.status === "success") return existing.data as T;
      if (existing?.status === "loading") return existing.promise as Promise<T>;
      if (existing?.status === "error") return undefined;

      const promise = loader(session);
      entries.current.set(keyWithStudent, { status: "loading", promise });
      notify();

      try {
        const data = await promise;
        const current = entries.current.get(keyWithStudent);
        if (current?.status === "loading" && current.promise === promise) {
          entries.current.set(keyWithStudent, { status: "success", data });
          notify();
        }
        return data;
      } catch (error) {
        const current = entries.current.get(keyWithStudent);
        if (current?.status === "loading" && current.promise === promise) {
          entries.current.set(keyWithStudent, {
            status: "error",
            error: error instanceof Error ? error.message : "Could not load student data."
          });
          notify();
        }
        return undefined;
      }
    },
    [notify, scopedKey]
  );

  useEffect(() => {
    let mounted = true;
    const supabase = createBrowserSupabase();

    function applySession(
      session: { access_token: string; user: { id: string } } | null
    ) {
      if (!mounted) return;
      const nextSession = session
        ? { accessToken: session.access_token, studentId: session.user.id }
        : null;
      const previousStudentId = sessionRef.current?.studentId ?? null;

      if (previousStudentId !== nextSession?.studentId) {
        entries.current.clear();
        notify();
      }
      sessionRef.current = nextSession;
      setStudentId(nextSession?.studentId ?? null);
      setSessionReady(true);
    }

    void supabase.auth.getSession().then(({ data }) => applySession(data.session));
    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((_event, session) => applySession(session));

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [notify]);

  const value = useMemo(
    () => ({
      clear,
      getEntry,
      invalidate,
      load,
      sessionReady,
      setData,
      studentId,
      version
    }),
    [clear, getEntry, invalidate, load, sessionReady, setData, studentId, version]
  );

  return (
    <StudentDataCacheContext.Provider value={value}>
      {children}
    </StudentDataCacheContext.Provider>
  );
}

export function useStudentCachedData<T>(
  key: string,
  loader: (session: StudentCacheSession) => Promise<T>,
  options?: { enabled?: boolean }
) {
  const cache = useContext(StudentDataCacheContext);
  if (!cache) {
    throw new Error("Student data cache is unavailable outside the student layout.");
  }

  const enabled = options?.enabled ?? true;
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const entry = enabled ? cache.getEntry(key) : undefined;

  useEffect(() => {
    if (
      enabled &&
      cache.sessionReady &&
      cache.studentId &&
      !cache.getEntry(key)
    ) {
      void cache.load(key, (session) => loaderRef.current(session));
    }
  }, [cache, enabled, key]);

  if (!enabled) return { data: null, error: "", loading: false };

  return {
    data: entry?.status === "success" ? (entry.data as T) : null,
    error:
      entry?.status === "error"
        ? entry.error
        : cache.sessionReady && !cache.studentId
          ? "Student session is unavailable."
          : "",
    loading:
      !cache.sessionReady ||
      Boolean(cache.studentId && (!entry || entry.status === "loading"))
  };
}

export function useStudentDataCache() {
  const cache = useContext(StudentDataCacheContext);
  if (!cache) {
    throw new Error("Student data cache is unavailable outside the student layout.");
  }
  return cache;
}

export function useOptionalStudentDataCache() {
  return useContext(StudentDataCacheContext);
}
