import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllSupabaseRows } from "./supabasePagination.ts";
import { practiceRangeDateKey } from "./teacherStudentPracticeRange.ts";
import { TEACHER_PRACTICE_TASK_TYPES, type TeacherPracticeTaskType } from "./teacherStudentPractice.ts";
import { parseWordbookQuery, zonedMidnight } from "./lexical/wordbookList.ts";

export function parsePracticeActivityQuery(params: URLSearchParams) {
  params.forEach((_value, key) => {
    if (!["month", "timeZone", "tasks"].includes(key) || params.getAll(key).length !== 1) throw new Error("无效日期查询。");
  });
  const query = parseWordbookQuery(new URLSearchParams({ month: params.get("month") ?? "", timeZone: params.get("timeZone") ?? "Asia/Shanghai" }));
  const currentMonth = new Intl.DateTimeFormat("en-CA", { timeZone: query.timeZone, year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const max = `${currentMonth.find(p => p.type === "year")?.value}-${currentMonth.find(p => p.type === "month")?.value}`;
  if (!query.month || query.month < "2026-07" || query.month > max) throw new Error("无效月份。");
  const raw = params.get("tasks");
  const tasks = raw === "none" ? [] : raw === null ? [...TEACHER_PRACTICE_TASK_TYPES] : raw.split(",");
  if (new Set(tasks).size !== tasks.length || tasks.some(t => !TEACHER_PRACTICE_TASK_TYPES.includes(t as TeacherPracticeTaskType))) throw new Error("无效题型。");
  return { month: query.month, timeZone: query.timeZone, tasks: tasks as TeacherPracticeTaskType[] };
}

export async function readPracticeActivityDates(db: SupabaseClient, studentId: string, query: ReturnType<typeof parsePracticeActivityQuery>, domains: string[], teacher = false) {
  // Intersect before calling SQL, never read then discard an unauthorized subject.
  const tasks = query.tasks.filter(t => domains.includes(["ctw", "rdl", "rap", "full_set"].includes(t) ? "reading" : "writing"));
  if (!tasks.length) return { dates: [], month: query.month };
  const { data, error } = await db.rpc("read_practice_activity_dates_v1", {
    p_student: studentId, p_month: `${query.month}-01`, p_timezone: query.timeZone, p_tasks: tasks, p_teacher: teacher
  });
  if (error || !Array.isArray(data)) throw new Error("练习日期暂时无法读取，请稍后重试。");
  const dates = new Set(data as string[]);
  // The Reading category session is already part of the SQL RPC. BAS Grammar
  // teacher category sessions are not: their virtual `grammar-random-*`
  // attempt is deliberately hidden from Student history, so the session's own
  // completion date is added here. Teacher views already include the attempt.
  if (!teacher && tasks.includes("build_sentence")) {
    for (const date of await readBasCategoryActivityDates(db, studentId, query)) {
      dates.add(date);
    }
  }
  return { dates: Array.from(dates).sort(), month: query.month };
}

async function readBasCategoryActivityDates(
  db: SupabaseClient,
  studentId: string,
  query: Pick<ReturnType<typeof parsePracticeActivityQuery>, "month" | "timeZone">
) {
  const start = zonedMidnight(`${query.month}-01`, query.timeZone);
  const end = zonedMidnight(`${nextMonthKey(query.month)}-01`, query.timeZone);
  const result = await readAllSupabaseRows<{ completed_at: string | null }>((from, to) =>
    db
      .from("bas_grammar_practice_sessions")
      .select("completed_at")
      .eq("student_id", studentId)
      .eq("status", "completed")
      .not("assignment_id", "is", null)
      .gte("completed_at", start)
      .lt("completed_at", end)
      .order("completed_at", { ascending: true })
      .range(from, to)
  );
  if (result.error) throw new Error(result.error.message);
  return (result.data ?? []).flatMap((row) => {
    const date = practiceRangeDateKey(row.completed_at, query.timeZone);
    return date ? [date] : [];
  });
}

function nextMonthKey(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  return monthNumber === 12
    ? `${year + 1}-01`
    : `${year}-${String(monthNumber + 1).padStart(2, "0")}`;
}
