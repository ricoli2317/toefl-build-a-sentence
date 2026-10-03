import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllSupabaseRows } from "./supabasePagination.ts";
import {
  normalizeClassSubjects,
  type TeacherClassSearchResult,
  type TeacherClassSummary
} from "./teacherClasses.ts";

/**
 * Teacher <-> class sharing helpers, kept in a relative-import module so the
 * focused tests can exercise them with the in-memory Supabase fixture.
 *
 * Authorization model: the class owner (teacher_classes.teacher_id) OR a
 * teacher holding a teacher_class_bindings link may manage the class. All
 * checks funnel through loadTeacherClassRow; the SQL RPCs use the matching
 * public.is_class_teacher helper.
 */

export type TeacherClassRow = {
  class_id: string;
  teacher_id: string;
  name: string;
  subjects: string[] | null;
  created_at: string;
};

type ClassMembersCount = Array<{ count: number }> | null;

const QUERY_BATCH_SIZE = 100;

export function chunkValues<T>(values: T[], size = QUERY_BATCH_SIZE) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export function toTeacherClassSummary(row: TeacherClassRow, memberCount: number): TeacherClassSummary {
  return {
    class_id: String(row.class_id),
    name: String(row.name).trim() || "未命名班级",
    subjects: normalizeClassSubjects(row.subjects),
    member_count: memberCount,
    created_at: row.created_at
  };
}

/**
 * Home / tab list: the teacher's own classes plus classes shared with them
 * through teacher_class_bindings. Minimal fields only; member counts come from
 * the FK count.
 */
export async function listTeacherClasses(
  db: SupabaseClient,
  teacherId: string
): Promise<TeacherClassSummary[]> {
  const ownedResult = await readAllSupabaseRows<
    TeacherClassRow & { class_members: ClassMembersCount }
  >((from, to) =>
    db
      .from("teacher_classes")
      .select("class_id,teacher_id,name,subjects,created_at,class_members(count)")
      .eq("teacher_id", teacherId)
      .order("created_at", { ascending: false })
      .order("class_id", { ascending: false })
      .range(from, to)
  );
  if (ownedResult.error) throw ownedResult.error;

  const rows: Array<TeacherClassRow & { class_members: ClassMembersCount }> =
    ownedResult.data ?? [];
  const knownIds = new Set(rows.map((row) => String(row.class_id)));
  const linkedIds = (await listLinkedClassIds(db, teacherId)).filter(
    (classId) => !knownIds.has(classId)
  );

  for (const batch of chunkValues(linkedIds)) {
    const linkedResult = await readAllSupabaseRows<
      TeacherClassRow & { class_members: ClassMembersCount }
    >((from, to) =>
      db
        .from("teacher_classes")
        .select("class_id,teacher_id,name,subjects,created_at,class_members(count)")
        .in("class_id", batch)
        .order("created_at", { ascending: false })
        .order("class_id", { ascending: false })
        .range(from, to)
    );
    if (linkedResult.error) throw linkedResult.error;
    for (const row of linkedResult.data ?? []) {
      if (!knownIds.has(String(row.class_id))) {
        knownIds.add(String(row.class_id));
        rows.push(row);
      }
    }
  }

  return rows
    .sort(
      (left, right) =>
        String(right.created_at).localeCompare(String(left.created_at)) ||
        String(right.class_id).localeCompare(String(left.class_id))
    )
    .map((row) => toTeacherClassSummary(row, Number(row.class_members?.[0]?.count ?? 0)));
}

/**
 * Class ids shared with the teacher through teacher_class_bindings. Before the
 * sharing migration is applied the table is missing; the read then degrades to
 * an empty list so class management keeps working for the owner.
 */
export async function listLinkedClassIds(db: SupabaseClient, teacherId: string) {
  const result = await readAllSupabaseRows<{ class_id: string }>((from, to) =>
    db
      .from("teacher_class_bindings")
      .select("class_id")
      .eq("teacher_id", teacherId)
      .order("class_id", { ascending: true })
      .range(from, to)
  );
  if (result.error) {
    if (isMissingRelationError(result.error.message, "teacher_class_bindings")) return [];
    throw result.error;
  }
  return (result.data ?? []).map((row) => String(row.class_id));
}

async function loadLinkedClassIdSet(db: SupabaseClient, teacherId: string, classIds: string[]) {
  if (classIds.length === 0) return new Set<string>();
  const linked = new Set<string>();
  for (const batch of chunkValues(classIds)) {
    const result = await readAllSupabaseRows<{ class_id: string }>((from, to) =>
      db
        .from("teacher_class_bindings")
        .select("class_id")
        .eq("teacher_id", teacherId)
        .in("class_id", batch)
        .order("class_id", { ascending: true })
        .range(from, to)
    );
    if (result.error) {
      if (isMissingRelationError(result.error.message, "teacher_class_bindings")) {
        return new Set<string>();
      }
      throw result.error;
    }
    for (const row of result.data ?? []) linked.add(String(row.class_id));
  }
  return linked;
}

async function teacherHasClassLink(db: SupabaseClient, teacherId: string, classId: string) {
  const result = await db
    .from("teacher_class_bindings")
    .select("class_id")
    .eq("class_id", classId)
    .eq("teacher_id", teacherId)
    .maybeSingle();
  if (result.error) {
    if (isMissingRelationError(result.error.message, "teacher_class_bindings")) {
      return false;
    }
    throw result.error;
  }
  return Boolean(result.data);
}

/**
 * One class the teacher may manage: the owner or a teacher holding a sharing
 * link. Every class read / mutation goes through this check.
 */
export async function loadTeacherClassRow(
  db: SupabaseClient,
  teacherId: string,
  classId: string
): Promise<TeacherClassRow | null> {
  const result = await db
    .from("teacher_classes")
    .select("class_id,teacher_id,name,subjects,created_at")
    .eq("class_id", classId)
    .maybeSingle();
  if (result.error) throw result.error;
  const row = (result.data as TeacherClassRow | null) ?? null;
  if (!row) return null;
  if (String(row.teacher_id) === teacherId) return row;
  if (await teacherHasClassLink(db, teacherId, classId)) return row;
  return null;
}

/**
 * Name search for the 绑定学生/班级 page. Deliberately minimal output: the
 * class id, name, subjects, member count and whether the current teacher
 * already manages the class. The member list is never exposed here.
 */
export async function searchTeacherClasses(
  db: SupabaseClient,
  teacherId: string,
  query: string,
  limit = 20
): Promise<TeacherClassSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const result = await db
    .from("teacher_classes")
    .select("class_id,teacher_id,name,subjects,class_members(count)")
    .ilike("name", `%${escapeLikePattern(trimmed)}%`)
    .order("name", { ascending: true })
    .order("class_id", { ascending: true })
    .limit(limit);
  if (result.error) throw result.error;

  const rows = (result.data ?? []) as Array<TeacherClassRow & { class_members: ClassMembersCount }>;
  if (rows.length === 0) return [];
  const linked = await loadLinkedClassIdSet(
    db,
    teacherId,
    rows.map((row) => String(row.class_id))
  );
  return rows.map((row) => ({
    class_id: String(row.class_id),
    name: String(row.name).trim() || "未命名班级",
    subjects: normalizeClassSubjects(row.subjects),
    member_count: Number(row.class_members?.[0]?.count ?? 0),
    bound: String(row.teacher_id) === teacherId || linked.has(String(row.class_id))
  }));
}

/**
 * Binds an existing class to the acting teacher: adds the sharing link and
 * backfills exactly the missing member bindings for the class's current
 * subjects through the bind_teacher_to_class RPC. Idempotent by construction;
 * never transfers assignments, attempts, reviews or another teacher's data.
 */
export async function bindTeacherToClass(
  db: SupabaseClient,
  teacherId: string,
  classId: string
): Promise<
  | {
      ok: true;
      class: TeacherClassSummary;
      alreadyBound: boolean;
      createdBindingCount: number;
    }
  | { ok: false; status: number; code?: string; error: string }
> {
  const { data, error } = await db.rpc("bind_teacher_to_class", {
    p_teacher_id: teacherId,
    p_class_id: classId
  });
  if (error) {
    if (/CLASS_NOT_FOUND/.test(error.message)) {
      return { ok: false, status: 404, error: "班级不存在或无权操作。" };
    }
    if (/INVALID_TEACHER/.test(error.message)) {
      return { ok: false, status: 403, error: "仅普通教师可以绑定班级。" };
    }
    console.error("[teacher-classes] bind_failed", error.message);
    return { ok: false, status: 500, error: "绑定班级失败，请稍后重试。" };
  }

  const classRow = await loadTeacherClassRow(db, teacherId, classId);
  if (!classRow) return { ok: false, status: 404, error: "班级不存在或无权操作。" };
  const payload = (data ?? {}) as Record<string, unknown>;
  const payloadMemberCount = Number(payload.member_count);
  return {
    ok: true,
    alreadyBound: payload.linked === false,
    createdBindingCount: Number(payload.bindings_inserted ?? 0),
    class: toTeacherClassSummary(
      classRow,
      Number.isFinite(payloadMemberCount) && payloadMemberCount >= 0
        ? payloadMemberCount
        : await classMemberCount(db, classId)
    )
  };
}

async function classMemberCount(db: SupabaseClient, classId: string) {
  const result = await db
    .from("class_members")
    .select("student_id", { count: "exact", head: true })
    .eq("class_id", classId);
  if (result.error) throw result.error;
  return result.count ?? 0;
}

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function isMissingRelationError(message: string | undefined, relation: string) {
  const text = message ?? "";
  return text.includes(relation)
    && /(does not exist|schema cache|could not find the table)/i.test(text);
}
