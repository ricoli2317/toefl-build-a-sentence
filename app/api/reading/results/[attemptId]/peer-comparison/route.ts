import { buildResultPeerComparison } from "@/lib/resultPeerComparison";
import { readingAttemptJson, requireReadingAttemptStudent } from "@/lib/reading/attemptServer";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type ReadingPeerAttemptRow = {
  attempt_id: string;
  student_id: string;
  correct_points: number;
  total_points: number;
  elapsed_seconds: number;
  submitted_at: string | null;
};

export async function GET(
  request: Request,
  { params }: { params: { attemptId: string } }
) {
  const auth = await requireReadingAttemptStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client || !auth.userId) {
    return readingAttemptJson({ error: "请先登录后再查看同班比较。" }, { status: 401 });
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(params.attemptId)) {
    return readingAttemptJson({ error: "无效的阅读结果请求。" }, { status: 400 });
  }

  const { data: ownedAttempt, error: attemptError } = await auth.client
    .from("reading_attempts")
    .select("attempt_id,logical_item_id,status,correct_points,total_points,elapsed_seconds")
    .eq("attempt_id", params.attemptId)
    .maybeSingle();
  if (attemptError || !ownedAttempt || ownedAttempt.status !== "submitted") {
    return readingAttemptJson({ error: "没有找到这次阅读练习结果。" }, { status: 404 });
  }

  const { data: peerAttempts, error: peerError } = await createServiceSupabase()
    .from("reading_attempts")
    .select("attempt_id,student_id,correct_points,total_points,elapsed_seconds,submitted_at")
    .eq("logical_item_id", ownedAttempt.logical_item_id)
    .eq("status", "submitted")
    .neq("student_id", auth.userId)
    .order("submitted_at", { ascending: false });
  if (peerError) {
    console.error("Reading peer comparison load failed", { message: peerError.message });
    return readingAttemptJson({ error: "同班比较暂时无法加载。" }, { status: 500 });
  }

  const comparison = buildResultPeerComparison(
    {
      attemptId: ownedAttempt.attempt_id,
      correctCount: ownedAttempt.correct_points,
      totalQuestions: ownedAttempt.total_points,
      timeSpentSeconds: ownedAttempt.elapsed_seconds
    },
    ((peerAttempts ?? []) as ReadingPeerAttemptRow[]).map((attempt) => ({
      attemptId: attempt.attempt_id,
      studentId: attempt.student_id,
      correctCount: attempt.correct_points,
      totalQuestions: attempt.total_points,
      timeSpentSeconds: attempt.elapsed_seconds,
      submittedAt: attempt.submitted_at
    }))
  );

  return readingAttemptJson({ peer_comparison: comparison });
}
