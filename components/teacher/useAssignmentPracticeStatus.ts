"use client";

import { useEffect, useRef, useState } from "react";
import {
  assignmentPracticeStatusRecord,
  type AssignmentPracticeStatusPayload,
  type AssignmentPracticeStatusRecord
} from "@/lib/assignmentPracticeStatus";
import type { AssignmentSubject } from "@/lib/assignmentCatalog";
import { teacherApiFetch } from "@/lib/teacherClientApi";

/**
 * Batched practice badge state for the currently selected Assignment
 * recipients. The selection (class or student ids) and subject form the
 * request identity: any change starts a new request and every older response
 * is discarded, so a slow request for a previous class can never decorate the
 * new one. A failed request keeps an explicit error; it is never converted to
 * "no badge means un-practiced".
 */
export function useAssignmentPracticeStatus(input: {
  classId: string;
  enabled: boolean;
  studentIds: readonly string[];
  subject: AssignmentSubject | null;
}) {
  const studentIdsKey = Array.from(
    new Set(input.studentIds.map((id) => id.trim()).filter(Boolean))
  ).sort().join(",");
  const selectionKey = input.classId
    ? `class:${input.classId}`
    : studentIdsKey
      ? `students:${studentIdsKey}`
      : "";
  const requestKey = input.enabled && input.subject && selectionKey
    ? `${input.subject}|${selectionKey}`
    : "";
  const [data, setData] = useState<{
    key: string;
    statuses: AssignmentPracticeStatusRecord;
  }>({ key: "", statuses: {} });
  const [loadingKey, setLoadingKey] = useState("");
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    if (!requestKey) return;
    const requestId = generation.current + 1;
    generation.current = requestId;
    const controller = new AbortController();
    setLoadingKey(requestKey);
    setFailure((current) => (current?.key === requestKey ? null : current));
    void teacherApiFetch<AssignmentPracticeStatusPayload>(
      "/api/teacher/writing/assignments/practice-status",
      {
        body: JSON.stringify({
          classId: input.classId || null,
          studentIds: studentIdsKey ? studentIdsKey.split(",") : [],
          subject: input.subject
        }),
        method: "POST",
        signal: controller.signal
      }
    )
      .then((payload) => {
        if (generation.current !== requestId) return;
        setData({
          key: requestKey,
          statuses: assignmentPracticeStatusRecord(
            Array.isArray(payload.statuses) ? payload.statuses : []
          )
        });
        setLoadingKey("");
      })
      .catch((error: unknown) => {
        if (generation.current !== requestId) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        setData((current) =>
          current.key === requestKey ? { key: "", statuses: {} } : current
        );
        setFailure({
          key: requestKey,
          message: error instanceof Error
            ? error.message
            : "练习状态加载失败，请稍后重试。"
        });
        setLoadingKey("");
      });
    return () => controller.abort();
  }, [input.classId, input.subject, requestKey, studentIdsKey]);

  return {
    statuses: data.key === requestKey ? data.statuses : {},
    loading: Boolean(requestKey) && loadingKey === requestKey,
    error: failure?.key === requestKey ? failure.message : ""
  };
}
