"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useStudentDataCache } from "@/components/StudentDataCache";
import { fetchReview } from "@/lib/lexical/wordbookReviewRequest";

export function useVocabularyRequest() {
  const { getSession, studentId, sessionReady } = useStudentDataCache();
  const owner = useRef(studentId); owner.current = studentId;
  const request = useCallback(async <T,>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
    const session = getSession();
    if (!session || !studentId || session.studentId !== studentId) throw new Error("请重新登录。");
    const data = await fetchReview<T>(url, session.accessToken, body, signal);
    if (owner.current !== studentId) throw new Error("登录账号已变化，请刷新页面。");
    return data;
  }, [getSession, studentId]);
  return { request, studentId, sessionReady };
}
export function useVocabularyRead<T>(url: string | null) {
  const { request, studentId, sessionReady } = useVocabularyRequest();
  const key = `${studentId}:${url}`;
  const [state, setState] = useState<{ key?: string; data?: T; error?: string; loading: boolean }>({ loading: true });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setState({ key, loading: Boolean(url) });
    if (url && sessionReady && studentId) void request<T>(url, undefined, abort.signal)
      .then(data => { if (!abort.signal.aborted) setState({ key, data, loading: false }); })
      .catch(error => { if (!abort.signal.aborted) setState({ key, error: error instanceof Error ? error.message : "加载失败。", loading: false }); });
    return () => abort.abort();
  }, [url, key, request, studentId, sessionReady, revision]);
  const retry = useCallback(() => setRevision(value => value + 1), []);
  return { ...(state.key === key ? state : { loading: Boolean(url) }), retry };
}
