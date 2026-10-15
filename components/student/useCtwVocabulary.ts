"use client";

import { useCallback, useRef, useState } from "react";
import { useStudentDataCache } from "@/components/StudentDataCache";
import { fetchReview } from "@/lib/lexical/wordbookReviewRequest";
import { useWordbookRead } from "./StudentWordbook";
import { ctwCacheKey } from "@/lib/ctw-vocabulary/review";

export function useVocabularyRequest() {
  const { getSession, studentId, sessionReady, load, getEntry } = useStudentDataCache();
  const owner = useRef(studentId); owner.current = studentId;
  const request = useCallback(async <T,>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
    const session = getSession();
    if (!session || !studentId || session.studentId !== studentId) throw new Error("请重新登录。");
    const data = body === undefined ? await load<T>(ctwCacheKey(url), () => fetchReview<T>(url, session.accessToken, undefined, signal))
      : await fetchReview<T>(url, session.accessToken, body, signal);
    if (owner.current !== studentId) throw new Error("登录账号已变化，请刷新页面。");
    if (data === undefined) { const error = getEntry(ctwCacheKey(url)); throw new Error(error?.status === "error" ? error.error : "读取失败，请重试。"); }
    return data;
  }, [getSession, studentId, load, getEntry]);
  return { request, studentId, sessionReady };
}
export function useVocabularyRead<T>(url: string | null) {
  const cache = useStudentDataCache();
  const [revision, setRevision] = useState(0);
  const state = useWordbookRead<T>(url, revision, cache, ctwCacheKey(url ?? ""));
  const retry = useCallback(() => setRevision(value => value + 1), []);
  return { ...state, retry };
}
