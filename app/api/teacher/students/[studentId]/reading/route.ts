import { NextResponse } from "next/server";
import { canAccessStudentDomain } from "@/lib/accountAccess";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import type { ReadingCatalogItemRow } from "@/lib/reading/catalog";
import {
  buildTeacherStudentReadingDetail,
  type ReadingStatsAttemptRow,
  type ReadingStatsProfileRow,
  type ReadingStatsWrongbookAttemptRow
} from "@/lib/reading/teacherStats";
import { createServiceSupabase } from "@/lib/supabase/server";
import { readAllSupabaseRows } from "@/lib/supabasePagination";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: { studentId: string } }
) {
  const auth = await requireTeacherOnly(bearerToken(request));
  if (auth.error || !auth.userId || !auth.role) {
    return json({ error: "无权查看该学生的阅读数据。" }, { status: 403 });
  }

  const studentId = String(params.studentId ?? "").trim();
  if (!studentId) {
    return json({ error: "无效的学生。" }, { status: 400 });
  }

  try {
    const db = createServiceSupabase();
    const allowed = await canAccessStudentDomain(
      db,
      { userId: auth.userId, role: auth.role },
      studentId,
      "reading"
    );
    if (!allowed) {
      return json({ error: "无权查看该学生的阅读数据。" }, { status: 403 });
    }

    const [profileResult, itemsResult, attemptsResult, wrongbookResult] = await Promise.all([
      db
        .from("profiles")
        .select("id,email,full_name")
        .eq("id", studentId)
        .eq("role", "student")
        .eq("is_active", true)
        .maybeSingle(),
      readAllSupabaseRows<ReadingCatalogItemRow>((from, to) =>
        db
          .from("reading_logical_items")
          .select(
            "logical_item_id,module,title,first_seen_date,first_seen_source_label,first_seen_source_order,question_count,scored_item_count"
          )
          .range(from, to)
      ),
      readAllSupabaseRows<ReadingStatsAttemptRow>((from, to) =>
        db
          .from("reading_attempts")
          .select(
            "attempt_id,student_id,logical_item_id,task_type,status,elapsed_seconds,total_points,correct_points,submitted_at"
          )
          .eq("student_id", studentId)
          .order("submitted_at", { ascending: false })
          .range(from, to)
      ),
      readAllSupabaseRows<ReadingStatsWrongbookAttemptRow>((from, to) =>
        db
          .from("reading_wrongbook_attempts")
          .select(
            "attempt_id,student_id,logical_item_id,task_type,scope,status,elapsed_seconds,total_points,correct_points,submitted_at"
          )
          .eq("student_id", studentId)
          .order("submitted_at", { ascending: false })
          .range(from, to)
      )
    ]);

    const profile = profileResult.data as ReadingStatsProfileRow | null;
    if (profileResult.error || !profile) {
      return json({ error: "未找到该学生。" }, { status: 404 });
    }

    const queryError = itemsResult.error ?? attemptsResult.error ?? wrongbookResult.error;
    if (queryError) throw new Error(queryError.message);

    return json(
      buildTeacherStudentReadingDetail({
        profile,
        items: itemsResult.data ?? [],
        attempts: attemptsResult.data ?? [],
        wrongbookAttempts: wrongbookResult.data ?? []
      })
    );
  } catch (error) {
    console.error("Teacher student Reading detail load failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return json({ error: "学生阅读数据加载失败，请稍后重试。" }, { status: 500 });
  }
}

function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(data, { ...init, headers });
}
