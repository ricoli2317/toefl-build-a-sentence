"use client";

import { useRouter } from "next/navigation";
import {
  TEACHER_STUDENT_READING_CACHE_PREFIX,
  useTeacherCachedData
} from "@/components/TeacherDataCache";
import {
  ReadingFullSetReviewShell,
  ReadingPracticeMessage,
  ReadingReadonlyReviewShell
} from "@/components/reading/ReadingPractice";
import { createBrowserSupabase } from "@/lib/supabase/client";
import type { ReadingFullSetReviewPayload } from "@/lib/reading/fullSetReview";
import { readingLookupEnabled } from "@/lib/reading/lookupCapabilities";
import type { TeacherReadingAttemptReviewPayload } from "@/lib/teacherStudentPractice";

export type TeacherReadingAttemptDetailKind = "attempt" | "wrongbook" | "full-set";

type ReadingAttemptDetailPayload =
  | TeacherReadingAttemptReviewPayload
  | ReadingFullSetReviewPayload;

/**
 * Teacher drill-down for one Reading attempt. The payload is fetched only after
 * a record is opened, keyed by the attempt id, and cached in the existing
 * TeacherDataCache so revisits and Back navigation do not reload the student
 * detail list or the attempt.
 */
export function TeacherStudentReadingAttemptDetail({
  attemptId,
  kind,
  studentId
}: {
  attemptId: string;
  kind: TeacherReadingAttemptDetailKind;
  studentId: string;
}) {
  const router = useRouter();
  const backHref = `/teacher/students/${encodeURIComponent(studentId)}`;
  const state = useTeacherCachedData<ReadingAttemptDetailPayload>(
    `${TEACHER_STUDENT_READING_CACHE_PREFIX}:${kind}:${studentId}:${attemptId}`,
    () => loadReadingAttemptDetail(kind, studentId, attemptId)
  );

  if (state.loading) {
    return (
      <ReadingPracticeMessage
        description="正在加载这次练习的作答与题目内容..."
        title="正在准备阅读作答"
      />
    );
  }
  if (state.error || !state.data) {
    return (
      <ReadingPracticeMessage
        description={toReadingDetailErrorMessage(state.error)}
        leaveLabel="返回学生详情"
        onLeave={() => router.push(backHref)}
        title="无法打开阅读作答"
      />
    );
  }

  if (kind === "full-set") {
    return (
      <ReadingFullSetReviewShell
        initialSourceAnswerIndex={0}
        onBack={() => router.push(backHref)}
        payload={state.data as ReadingFullSetReviewPayload}
      />
    );
  }

  const payload = state.data as TeacherReadingAttemptReviewPayload;
  return (
    <ReadingReadonlyReviewShell
      answers={payload.answers}
      lookupEnabled={readingLookupEnabled("submitted_review", payload.practice.item.module)}
      onBack={() => router.push(backHref)}
      practice={payload.practice}
      reviewDisclosures={payload.disclosures}
      reviewItems={payload.reviewItems}
      title={payload.practice.item.title}
    />
  );
}

function loadReadingAttemptDetail(
  kind: TeacherReadingAttemptDetailKind,
  studentId: string,
  attemptId: string
) {
  if (kind === "full-set") {
    return loadTeacherStudentReadingJson<ReadingFullSetReviewPayload>(
      `/api/teacher/students/${encodeURIComponent(studentId)}/reading/full-set-attempts/${encodeURIComponent(attemptId)}`
    );
  }
  const segment = kind === "wrongbook" ? "wrongbook-attempts" : "attempts";
  return loadTeacherStudentReadingJson<TeacherReadingAttemptReviewPayload>(
    `/api/teacher/students/${encodeURIComponent(studentId)}/reading/${segment}/${encodeURIComponent(attemptId)}`
  );
}

async function loadTeacherStudentReadingJson<T>(path: string): Promise<T> {
  const {
    data: { session }
  } = await createBrowserSupabase().auth.getSession();
  const response = await fetch(path, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${session?.access_token ?? ""}` }
  });
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok || payload.error) {
    throw new Error(payload.error || "阅读作答加载失败，请稍后重试。");
  }
  return payload;
}

function toReadingDetailErrorMessage(message: string) {
  if (/无权|forbidden/i.test(message)) return "无权查看该学生的阅读练习记录。";
  if (/未找到|not found/i.test(message)) return "没有找到这次阅读练习记录。";
  return /[\u3400-\u9fff]/.test(message) ? message : "阅读作答加载失败，请稍后重试。";
}
