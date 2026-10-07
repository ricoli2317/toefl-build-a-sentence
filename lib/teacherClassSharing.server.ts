import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllSupabaseRows } from "./supabasePagination.ts";
import { type StudentBindingDomain } from "./studentBindings.ts";
import {
  normalizeClassSubjects,
  type TeacherClassSearchResult,
  type TeacherClassSummary,
  type TeacherClassTeacherBinding
} from "./teacherClasses.ts";
import { getPreferredUserDisplayName } from "./userDisplayName.ts";

/**
 * Teacher <-> class sharing helpers, kept in a relative-import module so the
 * focused tests can exercise them with the in-memory Supabase fixture.
 *
 * Authorization model: the class owner (teacher_classes.teacher_id) OR a
 * teacher holding a teacher_class_bindings link may manage the class. All
 * checks funnel through loadTeacherClassRow; the SQL RPCs use the matching
 * public.is_class_teacher helper.
 *
 * Subject model: each teacher has their own subject set for the class. The
 * owner's set is teacher_classes.subjects; a bound teacher's set is
 * teacher_class_bindings.subjects. Teacher-facing class summaries expose the
 * VIEWING teacher's own subjects; teacher_student_bindings is only ever
 * backfilled from a teacher's own set.
 */

export type TeacherClassRow = {
  class_id: string;
  teacher_id: string;
  name: string;
  subjects: string[] | null;
  created_at: string;
};

export type TeacherClassLinkRow = {
  class_id: string;
  teacher_id: string;
  /** Null only while the deployment window predates the subjects column. */
  subjects: string[] | null;
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

export function toTeacherClassSummary(
  row: TeacherClassRow,
  memberCount: number,
  subjects: readonly StudentBindingDomain[] = normalizeClassSubjects(row.subjects)
): TeacherClassSummary {
  return {
    class_id: String(row.class_id),
    name: String(row.name).trim() || "未命名班级",
    subjects: Array.from(subjects),
    member_count: memberCount,
    created_at: row.created_at
  };
}

/**
 * Home / tab list: the teacher's own classes plus classes shared with them
 * through teacher_class_bindings. Minimal fields only; member counts come from
 * the FK count. Each entry carries the VIEWING teacher's own subjects for the
 * class (owner: class row; bound teacher: their own link row).
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
  const linkSubjectsByClass = new Map<string, StudentBindingDomain[]>();
  for (const link of await readLinkRows(db, { teacherId })) {
    if (knownIds.has(link.class_id)) continue;
    linkSubjectsByClass.set(link.class_id, normalizeClassSubjects(link.subjects));
  }
  const linkedIds = Array.from(linkSubjectsByClass.keys());

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
    .map((row) => {
      const classId = String(row.class_id);
      const subjects =
        String(row.teacher_id) === teacherId
          ? normalizeClassSubjects(row.subjects)
          : linkSubjectsByClass.get(classId) ?? [];
      return toTeacherClassSummary(row, Number(row.class_members?.[0]?.count ?? 0), subjects);
    });
}

/**
 * teacher_class_bindings rows for the given class ids and/or teacher. Selects
 * the subjects column; before the subjects migration is applied the read
 * degrades to the legacy rows with subjects=null so owner flows keep working
 * until the SQL runs.
 */
async function readLinkRows(
  db: SupabaseClient,
  options: { classIds?: readonly string[]; teacherId?: string }
): Promise<TeacherClassLinkRow[]> {
  const classIds = options.classIds
    ? Array.from(new Set(options.classIds.map((classId) => String(classId))))
    : null;
  if (classIds && classIds.length === 0) return [];
  const batches: Array<string[] | null> = classIds ? chunkValues(classIds) : [null];
  const rows: TeacherClassLinkRow[] = [];

  for (const batch of batches) {
    const query = (columns: string) => {
      const base = db.from("teacher_class_bindings").select(columns);
      const scoped = options.teacherId ? base.eq("teacher_id", options.teacherId) : base;
      const filtered = batch ? scoped.in("class_id", batch) : scoped;
      return filtered.order("class_id", { ascending: true });
    };
    const run = (columns: string) =>
      readAllSupabaseRows<TeacherClassLinkRow>(
        (from, to) =>
          query(columns).range(from, to) as unknown as PromiseLike<{
            data: TeacherClassLinkRow[] | null;
            error: { message: string } | null;
          }>
      );

    let result = await run("class_id,teacher_id,subjects");
    if (result.error && isMissingRelationError(result.error.message, "teacher_class_bindings")) {
      return rows;
    }
    if (result.error && isMissingColumnError(result.error.message, "subjects")) {
      result = await run("class_id,teacher_id");
      if (result.error) {
        if (isMissingRelationError(result.error.message, "teacher_class_bindings")) return rows;
        throw result.error;
      }
    } else if (result.error) {
      throw result.error;
    }

    for (const row of result.data ?? []) {
      rows.push({
        class_id: String(row.class_id),
        teacher_id: String(row.teacher_id),
        subjects: Array.isArray(row.subjects)
          ? row.subjects.map((domain) => String(domain))
          : null
      });
    }
  }
  return rows;
}

/**
 * The acting teacher's own subject set for one class: the class row for the
 * owner, the teacher's teacher_class_bindings row for a bound teacher.
 */
export async function loadClassSubjectsForTeacher(
  db: SupabaseClient,
  teacherId: string,
  classRow: TeacherClassRow
): Promise<StudentBindingDomain[]> {
  if (String(classRow.teacher_id) === teacherId) {
    return normalizeClassSubjects(classRow.subjects);
  }
  const links = await readLinkRows(db, {
    classIds: [String(classRow.class_id)],
    teacherId
  });
  return normalizeClassSubjects(links[0]?.subjects ?? []);
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

type TeacherProfileLite = {
  id: string;
  email: string | null;
  full_name: string | null;
};

/**
 * Display names for every teacher bound to the matched classes (owner +
 * linked). Missing profiles degrade to 未命名教师, matching the student search
 * display.
 */
async function loadTeacherDisplayNames(
  db: SupabaseClient,
  teacherIds: readonly string[]
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const ids = Array.from(new Set(teacherIds.map((id) => String(id))));
  for (const batch of chunkValues(ids)) {
    const result = await readAllSupabaseRows<TeacherProfileLite>((from, to) =>
      db
        .from("profiles")
        .select("id,email,full_name")
        .in("id", batch)
        .order("id", { ascending: true })
        .range(from, to)
    );
    if (result.error) throw result.error;
    for (const row of result.data ?? []) {
      names.set(
        String(row.id),
        getPreferredUserDisplayName({
          email: row.email,
          profileFullName: row.full_name
        }) || "未命名教师"
      );
    }
  }
  return names;
}

/**
 * Name search for the 绑定学生/班级 page. Deliberately minimal output: the
 * class id, name, the class-wide subject union (info only), the CURRENT
 * teacher's already-bound subjects (they cannot be bound again), every teacher
 * already bound to the class (owner included, de-duplicated by teacher),
 * member count and whether the current teacher already manages the class. The
 * member list is never exposed here.
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

  const links = await readLinkRows(db, {
    classIds: rows.map((row) => String(row.class_id))
  });
  const viewerSubjects = new Map<string, StudentBindingDomain[]>();
  const linkDomains = new Map<string, string[]>();
  const linksByClass = new Map<string, TeacherClassLinkRow[]>();
  const teacherIds = new Set<string>(rows.map((row) => String(row.teacher_id)));
  for (const link of links) {
    teacherIds.add(link.teacher_id);
    const classLinks = linksByClass.get(link.class_id) ?? [];
    classLinks.push(link);
    linksByClass.set(link.class_id, classLinks);
    if (link.teacher_id === teacherId) {
      viewerSubjects.set(link.class_id, normalizeClassSubjects(link.subjects));
    }
    if (link.subjects) {
      linkDomains.set(link.class_id, [
        ...(linkDomains.get(link.class_id) ?? []),
        ...link.subjects
      ]);
    }
  }
  const teacherNames = await loadTeacherDisplayNames(db, Array.from(teacherIds));

  return rows.map((row) => {
    const classId = String(row.class_id);
    const ownerId = String(row.teacher_id);
    const isOwner = ownerId === teacherId;

    // 所有已绑定教师（含创建者）：owner 行与 link 行重叠时按 teacher 去重并
    // 合并科目，保证同一教师只显示一次。
    const bindingsByTeacher = new Map<
      string,
      { domains: Set<StudentBindingDomain>; isOwner: boolean }
    >();
    const addTeacherBinding = (
      bindingTeacherId: string,
      domains: readonly StudentBindingDomain[],
      owner: boolean
    ) => {
      const entry = bindingsByTeacher.get(bindingTeacherId) ?? {
        domains: new Set<StudentBindingDomain>(),
        isOwner: owner
      };
      for (const domain of domains) entry.domains.add(domain);
      entry.isOwner = entry.isOwner || owner;
      bindingsByTeacher.set(bindingTeacherId, entry);
    };
    addTeacherBinding(ownerId, normalizeClassSubjects(row.subjects), true);
    for (const link of linksByClass.get(classId) ?? []) {
      addTeacherBinding(
        link.teacher_id,
        normalizeClassSubjects(link.subjects),
        link.teacher_id === ownerId
      );
    }
    const teachers: TeacherClassTeacherBinding[] = Array.from(
      bindingsByTeacher,
      ([bindingTeacherId, entry]) => ({
        teacherId: bindingTeacherId,
        teacherName: teacherNames.get(bindingTeacherId) ?? "未命名教师",
        isOwner: entry.isOwner,
        domains: normalizeClassSubjects(Array.from(entry.domains))
      })
    ).sort((left, right) =>
      left.isOwner === right.isOwner
        ? left.teacherName.localeCompare(right.teacherName, "zh-Hans-CN") ||
          left.teacherId.localeCompare(right.teacherId)
        : left.isOwner
          ? -1
          : 1
    );

    return {
      class_id: classId,
      name: String(row.name).trim() || "未命名班级",
      // 班级整体科目 = 创建者科目 ∪ 所有绑定教师的科目（信息展示用）。
      subjects: normalizeClassSubjects([
        ...(Array.isArray(row.subjects) ? row.subjects : []),
        ...(linkDomains.get(classId) ?? [])
      ]),
      // 当前搜索教师已绑定的科目：不能重复创建，另一科目仍可选择。
      bound_subjects: isOwner
        ? normalizeClassSubjects(row.subjects)
        : viewerSubjects.get(classId) ?? [],
      teachers,
      member_count: Number(row.class_members?.[0]?.count ?? 0),
      bound: isOwner || viewerSubjects.has(classId)
    };
  });
}

/**
 * Binds an existing class to the acting teacher for exactly the selected
 * subjects: adds the sharing link and backfills only the CALLER's missing
 * member bindings through the subject-scoped bind_teacher_to_class RPC. Never
 * touches another teacher's link, subjects or teacher_student_bindings, and
 * never changes teacher_classes.subjects for a non-owner. Idempotent by
 * construction: repeating a submission creates no duplicate rows.
 */
export async function bindTeacherToClass(
  db: SupabaseClient,
  teacherId: string,
  classId: string,
  subjects: readonly StudentBindingDomain[]
): Promise<
  | {
      ok: true;
      class: TeacherClassSummary;
      subjects: StudentBindingDomain[];
      alreadyBound: boolean;
      createdBindingCount: number;
    }
  | { ok: false; status: number; code?: string; error: string }
> {
  const { data, error } = await db.rpc("bind_teacher_to_class", {
    p_teacher_id: teacherId,
    p_class_id: classId,
    p_subjects: subjects
  });
  if (error) {
    if (/CLASS_NOT_FOUND/.test(error.message)) {
      return { ok: false, status: 404, error: "班级不存在或无权操作。" };
    }
    if (/INVALID_TEACHER/.test(error.message)) {
      return { ok: false, status: 403, error: "仅普通教师可以绑定班级。" };
    }
    if (/INVALID_SUBJECTS/.test(error.message)) {
      return { ok: false, status: 400, error: "授课科目无效，请重新选择。" };
    }
    console.error("[teacher-classes] bind_failed", error.message);
    return { ok: false, status: 500, error: "绑定班级失败，请稍后重试。" };
  }

  const classRow = await loadTeacherClassRow(db, teacherId, classId);
  if (!classRow) return { ok: false, status: 404, error: "班级不存在或无权操作。" };
  const payload = (data ?? {}) as Record<string, unknown>;
  const payloadMemberCount = Number(payload.member_count);
  const boundSubjects = normalizeClassSubjects(
    Array.isArray(payload.subjects) ? payload.subjects : subjects
  );
  return {
    ok: true,
    subjects: boundSubjects,
    alreadyBound: payload.linked === false,
    createdBindingCount: Number(payload.bindings_inserted ?? 0),
    class: toTeacherClassSummary(
      classRow,
      Number.isFinite(payloadMemberCount) && payloadMemberCount >= 0
        ? payloadMemberCount
        : await classMemberCount(db, classId),
      boundSubjects
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

function isMissingColumnError(message: string | undefined, column: string) {
  const text = message ?? "";
  return text.includes(column)
    && /(does not exist|could not find|schema cache)/i.test(text);
}
