import type { SupabaseClient } from "@supabase/supabase-js";
import { TEACHER_PRACTICE_TASK_TYPES, type TeacherPracticeTaskType } from "./teacherStudentPractice.ts";
import { parseWordbookQuery } from "./lexical/wordbookList.ts";

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
  return { dates: data as string[], month: query.month };
}
