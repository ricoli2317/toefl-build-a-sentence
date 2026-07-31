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
import { subscribeToQuestionBankUpdates } from "@/lib/questionBankCacheEvents";
import { subscribeToStudentPracticeCompleted } from "@/lib/studentCacheEvents";
import {
  mergeOfficialAttemptIntoSetsPayload,
  isLaterOfficialAttempt,
  normalizeSetId,
  type OfficialAttemptStatus
} from "@/lib/studentSetStatus";

export const STUDENT_SETS_CACHE_PREFIX = "sets";
export const STUDENT_SETS_CACHE_KEY = "sets:all";
export const STUDENT_WRONG_QUESTIONS_CACHE_PREFIX = "wrong-questions";
export const STUDENT_CURRENT_USER_CACHE_KEY = "current-user";

export function studentQuestionsCacheKey(setId: string) {
  return `questions:${setId}`;
}

export function studentAttemptCacheKey(attemptId: string) {
  return `attempt:current-question-v2:${attemptId}`;
}

export function studentWrongQuestionsCacheKey(query: string) {
  return `${STUDENT_WRONG_QUESTIONS_CACHE_PREFIX}:${query}`;
}

export type StudentCacheSession = {
  accessToken: string;
  studentId: string;
};

type CacheEntry =
  | { status: "loading"; promise: Promise<unknown>; generation: number }
  | { status: "success"; data: unknown }
  | { status: "error"; error: string };

type CachedSetsPayload = {
  sets?: Array<{
    set_id: string;
    completed?: boolean;
    latest_attempt_id?: string | null;
    latest_correct_count?: number | null;
    latest_total_questions?: number | null;
    latest_accuracy?: number | null;
    latest_submitted_at?: string | null;
  }>;
};

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
  updateData: <T>(key: string, updater: (data: T) => T) => boolean;
  recordOfficialAttempt: (attempt: OfficialAttemptStatus) => void;
  studentId: string | null;
  version: number;
};

const StudentDataCacheContext = createContext<StudentDataCacheValue | null>(null);

export function StudentDataCacheProvider({ children }: { children: ReactNode }) {
  const entries = useRef(new Map<string, CacheEntry>());
  const generations = useRef(new Map<string, number>());
  const officialAttemptOverrides = useRef(
    new Map<string, OfficialAttemptStatus>()
  );
  const sessionRef = useRef<StudentCacheSession | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [studentId, setStudentId] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const notify = useCallback(() => setVersion((value) => value + 1), []);

  const clear = useCallback(() => {
    entries.current.clear();
    generations.current.clear();
    officialAttemptOverrides.current.clear();
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
          generations.current.set(key, (generations.current.get(key) ?? 0) + 1);
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
      generations.current.set(
        keyWithStudent,
        (generations.current.get(keyWithStudent) ?? 0) + 1
      );
      notify();
    },
    [notify, scopedKey]
  );

  const updateData = useCallback(
    <T,>(key: string, updater: (data: T) => T) => {
      const keyWithStudent = scopedKey(key);
      if (!keyWithStudent) return false;

      const current = entries.current.get(keyWithStudent);
      if (current?.status !== "success") return false;

      entries.current.set(keyWithStudent, {
        status: "success",
        data: updater(current.data as T)
      });
      generations.current.set(
        keyWithStudent,
        (generations.current.get(keyWithStudent) ?? 0) + 1
      );
      notify();
      return true;
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

      const generation = generations.current.get(keyWithStudent) ?? 0;
      const promise = loader(session);
      entries.current.set(keyWithStudent, {
        status: "loading",
        promise,
        generation
      });
      notify();

      try {
        const data = await promise;
        const current = entries.current.get(keyWithStudent);
        if (
          current?.status === "loading" &&
          current.promise === promise &&
          current.generation === generation &&
          (generations.current.get(keyWithStudent) ?? 0) === generation
        ) {
          let resolvedData = data as T;

          if (key === STUDENT_SETS_CACHE_KEY) {
            for (const attempt of Array.from(
              officialAttemptOverrides.current.values()
            )) {
              resolvedData = mergeOfficialAttemptIntoSetsPayload(
                resolvedData as CachedSetsPayload,
                attempt
              ).payload as T;
            }
          }

          entries.current.set(keyWithStudent, {
            status: "success",
            data: resolvedData
          });
          notify();
          return resolvedData;
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

  const recordOfficialAttempt = useCallback(
    (attempt: OfficialAttemptStatus) => {
      const setId = normalizeSetId(attempt.set_id);
      const keyWithStudent = scopedKey(STUDENT_SETS_CACHE_KEY);
      if (!setId || !keyWithStudent) return;

      const normalizedAttempt = {
        ...attempt,
        set_id: setId
      };
      const existingOverride = officialAttemptOverrides.current.get(setId);
      const effectiveAttempt =
        existingOverride &&
        isLaterOfficialAttempt(existingOverride, normalizedAttempt)
          ? existingOverride
          : normalizedAttempt;
      officialAttemptOverrides.current.set(setId, effectiveAttempt);

      const current = entries.current.get(keyWithStudent);
      if (current?.status === "success") {
        const result = mergeOfficialAttemptIntoSetsPayload(
          current.data as CachedSetsPayload,
          effectiveAttempt
        );

        if (result.matched) {
          entries.current.set(keyWithStudent, {
            status: "success",
            data: result.payload
          });
          generations.current.set(
            keyWithStudent,
            (generations.current.get(keyWithStudent) ?? 0) + 1
          );
          notify();
          return;
        }
      }

      if (current?.status !== "loading") {
        entries.current.delete(keyWithStudent);
        generations.current.set(
          keyWithStudent,
          (generations.current.get(keyWithStudent) ?? 0) + 1
        );
        notify();
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
        generations.current.clear();
        officialAttemptOverrides.current.clear();
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

  useEffect(
    () => subscribeToQuestionBankUpdates(() => invalidate(STUDENT_SETS_CACHE_PREFIX)),
    [invalidate]
  );

  useEffect(
    () =>
      subscribeToStudentPracticeCompleted((event) => {
        if (event.studentId !== sessionRef.current?.studentId) return;

        invalidate(STUDENT_WRONG_QUESTIONS_CACHE_PREFIX);
        if (!event.isWrongQuestionsPractice) {
          if (event.attempt) {
            recordOfficialAttempt(event.attempt);
          } else {
            invalidate(STUDENT_SETS_CACHE_PREFIX);
          }
        }
      }),
    [invalidate, recordOfficialAttempt]
  );

  const value = useMemo(
    () => ({
      clear,
      getEntry,
      invalidate,
      load,
      sessionReady,
      setData,
      studentId,
      updateData,
      recordOfficialAttempt,
      version
    }),
    [
      clear,
      getEntry,
      invalidate,
      load,
      sessionReady,
      setData,
      studentId,
      updateData,
      recordOfficialAttempt,
      version
    ]
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
