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
import {
  cacheDomainsForEvent,
  subscribeToCacheInvalidation
} from "@/lib/cacheInvalidation";
import {
  mergeOfficialAttemptIntoSetsPayload,
  isLaterOfficialAttempt,
  normalizeSetId,
  type OfficialAttemptStatus
} from "@/lib/studentSetStatus";

export const STUDENT_SETS_CACHE_PREFIX = "sets";
export const STUDENT_SETS_CACHE_KEY = "sets:all";
export const STUDENT_LOGICAL_CATALOG_CACHE_PREFIX = "logical-practice-catalog";
export const STUDENT_QUESTIONS_CACHE_PREFIX = "questions";
export const STUDENT_WRONG_QUESTIONS_CACHE_PREFIX = "wrong-questions";
export const STUDENT_PRACTICE_HISTORY_CACHE_PREFIX = "practice-history";
export const STUDENT_ATTEMPT_CACHE_PREFIX = "attempt";
export const STUDENT_GRAMMAR_PRACTICE_CACHE_PREFIX = "grammar-practice";
export const STUDENT_WRITING_CACHE_PREFIX = "writing";
export const STUDENT_WRITING_CATALOG_CACHE_PREFIX = "writing:catalog";
export const STUDENT_WRITING_OVERVIEW_CACHE_KEY = "writing:overview";
export const STUDENT_WRITING_SUBMISSION_HISTORY_CACHE_PREFIX =
  "writing:historical-submission";
export const STUDENT_WRITING_PUBLISHED_REVIEWS_CACHE_PREFIX =
  "writing:published-reviews";
export const STUDENT_WRITING_PUBLISHED_REVIEWS_CACHE_KEY =
  `${STUDENT_WRITING_PUBLISHED_REVIEWS_CACHE_PREFIX}:list`;
export const STUDENT_WRITING_ASSIGNMENTS_CACHE_KEY = "writing:assignments";
export const STUDENT_WRITING_MODE_POLICY_CACHE_KEY = "writing:mode-policy";
export const STUDENT_ACADEMIC_DISCUSSION_AVATARS_CACHE_KEY =
  "writing:academic-discussion-avatars";
export const STUDENT_CURRENT_USER_CACHE_KEY = "current-user";

export function studentWritingCatalogCacheKey(taskType: "email" | "academic_discussion") {
  return `${STUDENT_WRITING_CATALOG_CACHE_PREFIX}:${taskType}`;
}

export function studentLogicalCatalogCacheKey(
  taskType: "build_sentence" | "email" | "academic_discussion"
) {
  return `${STUDENT_LOGICAL_CATALOG_CACHE_PREFIX}:${taskType}`;
}

export function studentQuestionsCacheKey(setId: string) {
  return `questions:${setId}`;
}

export function studentAttemptCacheKey(attemptId: string) {
  return `${STUDENT_ATTEMPT_CACHE_PREFIX}:historical-display-v3:${attemptId}`;
}

export function studentWritingAttemptCacheKey(attemptId: string) {
  return `${STUDENT_WRITING_CACHE_PREFIX}:attempt:${attemptId}`;
}

export function studentPublishedWritingReviewCacheKey(attemptId: string) {
  return `${STUDENT_WRITING_PUBLISHED_REVIEWS_CACHE_PREFIX}:detail:${attemptId}`;
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
  | { status: "refreshing"; data: unknown; promise: Promise<unknown>; generation: number }
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
  refresh: <T>(
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
      if (current?.status !== "success" && current?.status !== "refreshing") return false;

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
      if (existing?.status === "refreshing") return existing.promise as Promise<T>;
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

  const refresh = useCallback(
    async <T,>(
      key: string,
      loader: (session: StudentCacheSession) => Promise<T>
    ) => {
      const session = sessionRef.current;
      const keyWithStudent = scopedKey(key);
      if (!session || !keyWithStudent) return undefined;

      const existing = entries.current.get(keyWithStudent);
      if (existing?.status === "loading" || existing?.status === "refreshing") {
        return existing.promise as Promise<T>;
      }
      if (existing?.status !== "success") {
        return load(key, loader);
      }

      const generation = generations.current.get(keyWithStudent) ?? 0;
      const previousData = existing.data as T;
      const promise = loader(session);
      entries.current.set(keyWithStudent, {
        status: "refreshing",
        data: previousData,
        promise,
        generation
      });
      notify();

      try {
        const data = await promise;
        const current = entries.current.get(keyWithStudent);
        if (
          current?.status === "refreshing" &&
          current.promise === promise &&
          current.generation === generation &&
          (generations.current.get(keyWithStudent) ?? 0) === generation
        ) {
          entries.current.set(keyWithStudent, { status: "success", data });
          notify();
        }
        return data;
      } catch {
        const current = entries.current.get(keyWithStudent);
        if (current?.status === "refreshing" && current.promise === promise) {
          entries.current.set(keyWithStudent, {
            status: "success",
            data: previousData
          });
          notify();
        }
        return undefined;
      }
    },
    [load, notify, scopedKey]
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
    () =>
      subscribeToCacheInvalidation((event) => {
        if (event.studentId && event.studentId !== sessionRef.current?.studentId) return;

        for (const domain of cacheDomainsForEvent(event)) {
          switch (domain) {
            case "studentPracticeCatalog":
              invalidate(STUDENT_LOGICAL_CATALOG_CACHE_PREFIX);
              invalidate(STUDENT_SETS_CACHE_PREFIX);
              invalidate(STUDENT_QUESTIONS_CACHE_PREFIX);
              invalidate(STUDENT_GRAMMAR_PRACTICE_CACHE_PREFIX);
              break;
            case "studentPracticeState":
              invalidate(STUDENT_LOGICAL_CATALOG_CACHE_PREFIX);
              if (!event.isWrongQuestionsPractice) {
                if (event.attempt) recordOfficialAttempt(event.attempt);
                else invalidate(STUDENT_SETS_CACHE_PREFIX);
              }
              break;
            case "studentPracticeHistory":
              invalidate(STUDENT_PRACTICE_HISTORY_CACHE_PREFIX);
              break;
            case "studentAttemptResult":
              invalidate(STUDENT_ATTEMPT_CACHE_PREFIX);
              break;
            case "studentWrongQuestions":
              invalidate(STUDENT_WRONG_QUESTIONS_CACHE_PREFIX);
              break;
            case "studentWritingCatalog":
              invalidate(STUDENT_WRITING_CATALOG_CACHE_PREFIX);
              break;
            case "studentWritingOverview":
              invalidate(STUDENT_WRITING_OVERVIEW_CACHE_KEY);
              break;
            case "studentWritingHistory":
              invalidate(STUDENT_WRITING_SUBMISSION_HISTORY_CACHE_PREFIX);
              break;
            case "studentPublishedReviews":
              invalidate(STUDENT_WRITING_PUBLISHED_REVIEWS_CACHE_PREFIX);
              break;
            case "studentAssignments":
              invalidate(STUDENT_WRITING_ASSIGNMENTS_CACHE_KEY);
              break;
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
      refresh,
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
      refresh,
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
  options?: { enabled?: boolean; refreshOnMount?: boolean }
) {
  const cache = useContext(StudentDataCacheContext);
  if (!cache) {
    throw new Error("Student data cache is unavailable outside the student layout.");
  }

  const enabled = options?.enabled ?? true;
  const loaderRef = useRef(loader);
  const mountedRequestRef = useRef<string | null>(null);
  loaderRef.current = loader;
  const entry = enabled ? cache.getEntry(key) : undefined;

  useEffect(() => {
    if (!enabled || !cache.sessionReady || !cache.studentId) return;
    const requestIdentity = `${cache.studentId}:${key}`;
    const entry = cache.getEntry(key);
    if (!entry) {
      mountedRequestRef.current = requestIdentity;
      void cache.load(key, (session) => loaderRef.current(session));
      return;
    }
    if (
      options?.refreshOnMount &&
      mountedRequestRef.current !== requestIdentity
    ) {
      mountedRequestRef.current = requestIdentity;
      void cache.refresh(key, (session) => loaderRef.current(session));
    }
  }, [cache, enabled, key, options?.refreshOnMount]);

  if (!enabled) return { data: null, error: "", loading: false };

  return {
    data:
      entry?.status === "success" || entry?.status === "refreshing"
        ? (entry.data as T)
        : null,
    error:
      entry?.status === "error"
        ? entry.error
        : cache.sessionReady && !cache.studentId
          ? "Student session is unavailable."
          : "",
    loading:
      !cache.sessionReady ||
      Boolean(cache.studentId && (!entry || entry.status === "loading")),
    refreshing: entry?.status === "refreshing"
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
