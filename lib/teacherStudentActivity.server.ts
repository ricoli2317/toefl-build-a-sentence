import type { SupabaseClient } from "@supabase/supabase-js";

export const TEACHER_INACTIVITY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

const ID_BATCH_SIZE = 100;
const ACTIVITY_PAGE_SIZE = 500;

type ActivityQueryResult = {
  data: Array<Record<string, unknown>> | null;
  error: { message: string } | null;
};

type ActivitySource = {
  table: "attempts" | "writing_attempts" | "reading_attempts";
  idColumn: "student_id" | "user_id";
};

/**
 * Valid student practice records for teacher activity checks:
 * Build a Sentence (and wrong-question practice), submitted Writing, and
 * submitted Reading. Drafts are not practice activity.
 */
const ACTIVITY_SOURCES: ActivitySource[] = [
  { table: "attempts", idColumn: "student_id" },
  { table: "writing_attempts", idColumn: "user_id" },
  { table: "reading_attempts", idColumn: "student_id" }
];

/**
 * Returns the visible students with no valid practice activity inside the
 * inactivity window. Only recent activity rows (id column only) are read.
 */
export async function findInactiveStudentIds(
  db: SupabaseClient,
  studentIds: string[],
  sinceIso: string
) {
  const ids = unique(studentIds);
  if (ids.length === 0) return [];
  const activeIds = new Set<string>();

  await Promise.all(
    ACTIVITY_SOURCES.map(async (source) => {
      for (const batch of chunkValues(ids)) {
        const { data, error } = await (activityQuery(db, source, source.idColumn)
          .in(source.idColumn, batch)
          .not("submitted_at", "is", null)
          .gte("submitted_at", sinceIso) as unknown as PromiseLike<ActivityQueryResult>);
        if (error) throw new Error(error.message);
        for (const row of data ?? []) {
          activeIds.add(String(row[source.idColumn]));
        }
      }
    })
  );

  return ids.filter((studentId) => !activeIds.has(studentId));
}

/**
 * Latest valid activity time per student, read from each practice source with
 * a newest-first, stably ordered scan that stops as soon as every requested
 * student has been seen. No student history is loaded.
 */
export async function loadLatestActivityByStudent(
  db: SupabaseClient,
  studentIds: string[]
) {
  const lastActivityByStudent = new Map<string, string>();
  const batches = chunkValues(unique(studentIds));
  if (batches.length === 0) return lastActivityByStudent;

  await Promise.all(
    ACTIVITY_SOURCES.map(async (source) => {
      for (const batch of batches) {
        const remaining = new Set(batch);
        for (let from = 0; remaining.size > 0; from += ACTIVITY_PAGE_SIZE) {
          const { data, error } = await (activityQuery(
            db,
            source,
            `${source.idColumn},submitted_at`
          )
            .in(source.idColumn, batch)
            .not("submitted_at", "is", null)
            .order("submitted_at", { ascending: false })
            .order("attempt_id", { ascending: false })
            .range(from, from + ACTIVITY_PAGE_SIZE - 1) as unknown as PromiseLike<ActivityQueryResult>);
          if (error) throw new Error(error.message);
          const rows = data ?? [];
          for (const row of rows) {
            const studentId = String(row[source.idColumn]);
            if (!remaining.has(studentId)) continue;
            remaining.delete(studentId);
            const submittedAt = typeof row.submitted_at === "string" ? row.submitted_at : null;
            if (submittedAt) mergeLatest(lastActivityByStudent, studentId, submittedAt);
          }
          if (rows.length < ACTIVITY_PAGE_SIZE) break;
        }
      }
    })
  );

  return lastActivityByStudent;
}

/**
 * Inactive students with their latest valid activity time. Students who never
 * practiced keep a null time.
 */
export async function loadInactiveStudentsWithLastActivity(
  db: SupabaseClient,
  studentIds: string[],
  now = new Date()
) {
  const inactiveStudentIds = await findInactiveStudentIds(
    db,
    studentIds,
    new Date(now.getTime() - TEACHER_INACTIVITY_WINDOW_MS).toISOString()
  );
  const lastActivityByStudent = await loadLatestActivityByStudent(db, inactiveStudentIds);
  return { inactiveStudentIds, lastActivityByStudent };
}

function activityQuery(db: SupabaseClient, source: ActivitySource, columns: string) {
  const query = db.from(source.table).select(columns);
  switch (source.table) {
    case "writing_attempts":
      return query.eq("status", "submitted");
    case "reading_attempts":
      return query.eq("status", "submitted");
    default:
      return query;
  }
}

function mergeLatest(
  activityByStudent: Map<string, string>,
  studentId: string,
  submittedAt: string
) {
  const current = activityByStudent.get(studentId);
  if (!current || Date.parse(submittedAt) > Date.parse(current)) {
    activityByStudent.set(studentId, submittedAt);
  }
}

function chunkValues(values: string[], size = ID_BATCH_SIZE) {
  const chunks: string[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function unique(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
