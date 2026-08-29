import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { listVisibleStudentIds } from "@/lib/accountAccess";
import type { ReadingCatalogItemRow } from "@/lib/reading/catalog";
import {
  buildTeacherReadingStats,
  type ReadingStatsAnswerRow,
  type ReadingStatsAttemptRow,
  type ReadingStatsProfileRow,
  type ReadingStatsQuestionRow,
  type ReadingStatsSlotRow
} from "@/lib/reading/teacherStats";
import { createServiceSupabase } from "@/lib/supabase/server";
import { readAllSupabaseRows } from "@/lib/supabasePagination";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const token = bearerToken(request);
  const auth = await requireUserWithRole(token, "teacher");
  if (auth.error || !auth.userId || !auth.role) {
    return json({ error: "无权查看阅读统计。" }, { status: 403 });
  }

  try {
    const db = createServiceSupabase();
    const studentIds = await listVisibleStudentIds(db, {
      userId: auth.userId,
      role: auth.role
    });
    const [profiles, items, attempts, questions, slots] = await Promise.all([
      fetchForIds<ReadingStatsProfileRow>(db, "profiles", "id,email,full_name", "id", studentIds),
      readAllSupabaseRows<ReadingCatalogItemRow>((from, to) =>
        db.from("reading_logical_items")
          .select("logical_item_id,module,title,first_seen_date,first_seen_source_label,first_seen_source_order,question_count,scored_item_count")
          .range(from, to)
      ),
      fetchForIds<ReadingStatsAttemptRow>(
        db,
        "reading_attempts",
        "attempt_id,student_id,logical_item_id,task_type,status,elapsed_seconds,total_points,correct_points,submitted_at",
        "student_id",
        studentIds,
        (query) => query.eq("status", "submitted")
      ),
      readAllSupabaseRows<ReadingStatsQuestionRow>((from, to) =>
        db.from("reading_questions")
          .select("question_id,logical_item_id,question_order,module,question_type")
          .range(from, to)
      ),
      readAllSupabaseRows<ReadingStatsSlotRow>((from, to) =>
        db.from("reading_ctw_slots")
          .select("question_id,slot_id,slot_order")
          .range(from, to)
      )
    ]);
    const firstError = profiles.error || items.error || attempts.error || questions.error || slots.error;
    if (firstError) throw firstError;

    const submittedAttempts = attempts.data ?? [];
    const answers = await fetchForIds<ReadingStatsAnswerRow>(
      db,
      "reading_attempt_answers",
      "attempt_id,logical_item_id,question_id,slot_id,answer_kind,is_correct",
      "attempt_id",
      submittedAttempts.map((attempt) => attempt.attempt_id)
    );
    if (answers.error) throw answers.error;

    return json(buildTeacherReadingStats({
      profiles: profiles.data ?? [],
      items: items.data ?? [],
      attempts: submittedAttempts,
      answers: answers.data ?? [],
      questions: questions.data ?? [],
      slots: slots.data ?? []
    }));
  } catch (error) {
    console.error("Teacher Reading statistics load failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return json({ error: "阅读统计加载失败，请稍后重试。" }, { status: 500 });
  }
}

async function fetchForIds<T>(
  db: SupabaseClient,
  table: string,
  columns: string,
  idColumn: string,
  ids: string[],
  refine?: (query: any) => any
) {
  if (ids.length === 0) return { data: [] as T[], error: null };
  const rows: T[] = [];
  for (let index = 0; index < ids.length; index += 100) {
    const batch = ids.slice(index, index + 100);
    const result = await readAllSupabaseRows<T>(async (from, to) => {
      let query = db.from(table).select(columns).in(idColumn, batch);
      if (refine) query = refine(query);
      return await query.range(from, to) as unknown as {
        data: T[] | null;
        error: { message: string } | null;
      };
    });
    if (result.error) return { data: null, error: result.error };
    rows.push(...(result.data ?? []));
  }
  return { data: rows, error: null };
}

function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(data, { ...init, headers });
}
