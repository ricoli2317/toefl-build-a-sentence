import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllSupabaseRows } from "./supabasePagination.ts";
import {
  mapPracticeEntitlementError,
  mapPracticeEntitlementRows,
  type PracticeEntitlementFailure,
  type PracticeEntitlementSnapshotItem,
  type PracticeEntitlementValues
} from "./practiceEntitlements.ts";

export type PracticeEntitlementResult =
  | { ok: true; entitlements: PracticeEntitlementSnapshotItem[] }
  | ({ ok: false } & PracticeEntitlementFailure);

/**
 * Server-only switch read for the category-practice routes. The runtime config
 * table is never exposed to authenticated clients. Callers that enforce a
 * Student restriction must fail closed when this throws.
 */
export async function loadPracticeEntitlementEnforcementEnabled(
  db: SupabaseClient
): Promise<boolean> {
  const { data, error } = await db
    .from("practice_entitlement_runtime_config")
    .select("enforcement_enabled")
    .eq("singleton", true)
    .maybeSingle();
  if (error) {
    throw new Error(`Practice entitlement runtime config failed: ${error.message}`);
  }
  return data?.enforcement_enabled === true;
}

function snapshotResult(
  data: unknown,
  fallback: string
): PracticeEntitlementResult {
  try {
    return { ok: true, entitlements: mapPracticeEntitlementRows(data) };
  } catch {
    return { ok: false, status: 500, message: fallback };
  }
}

export async function loadAdminStudentPracticeEntitlements(
  db: SupabaseClient,
  studentId: string,
  fallback = "练习额度加载失败，请稍后重试。"
): Promise<PracticeEntitlementResult> {
  const { data, error } = await db.rpc("admin_get_student_practice_entitlements", {
    p_student_id: studentId
  });
  if (error) return { ok: false, ...mapPracticeEntitlementError(error, fallback) };
  return snapshotResult(data, fallback);
}

export async function saveAdminStudentPracticeEntitlements(
  db: SupabaseClient,
  studentId: string,
  values: PracticeEntitlementValues,
  reason: string | null,
  fallback = "练习额度保存失败，请稍后重试。"
): Promise<PracticeEntitlementResult> {
  const { data, error } = await db.rpc("admin_set_student_practice_entitlements", {
    p_student_id: studentId,
    p_values: values,
    p_reason: reason
  });
  if (error) return { ok: false, ...mapPracticeEntitlementError(error, fallback) };
  return snapshotResult(data, fallback);
}

export async function loadOwnStudentPracticeEntitlements(
  db: SupabaseClient,
  fallback = "练习额度加载失败，请稍后重试。"
): Promise<PracticeEntitlementResult> {
  const { data, error } = await db.rpc("student_practice_entitlements_self");
  if (error) return { ok: false, ...mapPracticeEntitlementError(error, fallback) };
  return snapshotResult(data, fallback);
}

/**
 * Batch unlock-state read for one directory. This is the only catalog unlock
 * query: one indexed service-role read per task type, never one request or one
 * query per card. `student_practice_unlocks` is intentionally not exposed to
 * authenticated clients.
 */
export async function loadStudentPracticeUnlockItemIds(
  db: SupabaseClient,
  input: {
    studentId: string;
    taskType: "build_sentence" | "email" | "academic_discussion" | "ctw" | "rdl" | "rap";
  }
): Promise<Set<string>> {
  const result = await readAllSupabaseRows<{ item_id: string }>((from, to) =>
    db
      .from("student_practice_unlocks")
      .select("item_id")
      .eq("student_id", input.studentId)
      .eq("task_type", input.taskType)
      .order("item_id", { ascending: true })
      .range(from, to)
  );
  if (result.error) {
    throw new Error(`Student practice unlocks failed: ${result.error.message}`);
  }
  return new Set((result.data ?? []).map((row) => String(row.item_id)));
}
