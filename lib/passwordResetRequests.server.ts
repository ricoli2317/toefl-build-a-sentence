import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveLoginAuthEmail } from "./accountIdentifier.ts";

/**
 * Server-only helpers for the forgot-password approval flow.
 *
 * The initial password is never stored in the database. It only exists here as
 * the value a privileged approval writes through Supabase Auth Admin.
 */
export const PASSWORD_RESET_INITIAL_PASSWORD = "123456";

export type PasswordResetDecision = "approve" | "reject";
export type PasswordResetTargetRole = "student" | "teacher";

export type PasswordResetRequestRow = {
  request_id: string;
  user_id: string;
  account_role: string;
  status: string;
};

export type CreatePasswordResetOutcome =
  | { ok: true; role: PasswordResetTargetRole }
  | { ok: false; status: number; message: string };

export type ResolvePasswordResetOutcome =
  | { ok: true; status: "approved" | "rejected" }
  | { ok: false; status: number; message: string };

type ProfileLookupRow = {
  id: string;
  role: string | null;
  is_active: boolean | null;
};

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * Creates (or refreshes) the single pending reset request for the account typed
 * on the login page. Account existence and role are resolved server-side from
 * the profile row; nothing about Supabase Auth internals is returned.
 */
export async function createPasswordResetRequestByAccount(
  db: SupabaseClient,
  accountInput: string
): Promise<CreatePasswordResetOutcome> {
  const authEmail = resolveLoginAuthEmail(typeof accountInput === "string" ? accountInput : "");
  if (!authEmail) {
    return { ok: false, status: 400, message: "请输入账号。" };
  }

  const { data: profile, error } = await db
    .from("profiles")
    .select("id,role,is_active")
    .ilike("email", escapeLikePattern(authEmail))
    .maybeSingle<ProfileLookupRow>();
  if (error) {
    console.error("[password-reset] profile_lookup_failed", { message: error.message });
    return { ok: false, status: 500, message: "请求提交失败，请稍后重试。" };
  }
  if (!profile || (profile.role !== "student" && profile.role !== "teacher")) {
    return { ok: false, status: 404, message: "未找到该账号，请检查后重试。" };
  }
  if (profile.is_active === false) {
    return { ok: false, status: 403, message: "该账号已停用，请联系管理员。" };
  }

  const saved = await upsertPendingPasswordResetRequest(db, {
    userId: profile.id,
    role: profile.role
  });
  if (!saved.ok) {
    return { ok: false, status: 500, message: "请求提交失败，请稍后重试。" };
  }
  return { ok: true, role: profile.role };
}

/**
 * Repeated requests keep exactly one pending row per user: the existing pending
 * row is refreshed in place; otherwise a row is inserted. A unique-index race
 * falls back to refreshing the row the other write just created.
 */
export async function upsertPendingPasswordResetRequest(
  db: SupabaseClient,
  input: { userId: string; role: PasswordResetTargetRole }
): Promise<{ ok: boolean }> {
  const now = new Date().toISOString();
  const { data: existing, error: readError } = await db
    .from("password_reset_requests")
    .select("request_id")
    .eq("user_id", input.userId)
    .eq("status", "pending")
    .maybeSingle<{ request_id: string }>();
  if (readError) {
    console.error("[password-reset] pending_lookup_failed", { message: readError.message });
    return { ok: false };
  }

  if (existing) {
    const { error } = await db
      .from("password_reset_requests")
      .update({
        account_role: input.role,
        requested_at: now,
        resolved_at: null,
        resolved_by: null
      })
      .eq("request_id", existing.request_id)
      .eq("status", "pending");
    if (error) {
      console.error("[password-reset] pending_refresh_failed", { message: error.message });
      return { ok: false };
    }
    return { ok: true };
  }

  const { error: insertError } = await db.from("password_reset_requests").insert({
    user_id: input.userId,
    account_role: input.role,
    status: "pending",
    requested_at: now
  });
  if (!insertError) return { ok: true };

  if (insertError.code === "23505") {
    const { error: retryError } = await db
      .from("password_reset_requests")
      .update({ requested_at: now })
      .eq("user_id", input.userId)
      .eq("status", "pending");
    if (!retryError) return { ok: true };
    console.error("[password-reset] pending_race_refresh_failed", {
      message: retryError.message
    });
    return { ok: false };
  }

  console.error("[password-reset] pending_insert_failed", { message: insertError.message });
  return { ok: false };
}

/**
 * Loads a request row for permission checks. Never exposes Supabase Auth data.
 */
export async function loadPasswordResetRequest(
  db: SupabaseClient,
  requestId: string
): Promise<{ ok: true; request: PasswordResetRequestRow } | { ok: false; error: string }> {
  const { data, error } = await db
    .from("password_reset_requests")
    .select("request_id,user_id,account_role,status")
    .eq("request_id", requestId)
    .maybeSingle<PasswordResetRequestRow>();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "not_found" };
  return { ok: true, request: data };
}

const PENDING_REQUEST_BATCH_SIZE = 100;

/**
 * Distinguishes "the password_reset_requests migration has not been applied
 * yet" from a real query failure, so existing list pages keep working before
 * the manual SQL is executed and the new feature simply has no requests yet.
 */
export function isPasswordResetTableMissing(
  error: { code?: string | null; message?: string | null } | null | undefined
) {
  if (!error) return false;
  const code = String(error.code ?? "");
  const message = String(error.message ?? "");
  return (
    code === "PGRST205" ||
    code === "42P01" ||
    /could not find the table|relation .* does not exist|schema cache/i.test(message)
  );
}

/**
 * Pending request ids for the given users and target role, keyed by user id.
 * Used to decorate the Teacher student list / Admin teacher list; a missing
 * migration degrades to "no pending requests" instead of breaking the list.
 */
export async function readPendingPasswordResetRequestIds(
  db: SupabaseClient,
  input: { userIds: readonly string[]; role: PasswordResetTargetRole }
): Promise<Map<string, string>> {
  const ids = Array.from(new Set(input.userIds.map((userId) => String(userId)).filter(Boolean)));
  const pendingByUserId = new Map<string, string>();
  for (let index = 0; index < ids.length; index += PENDING_REQUEST_BATCH_SIZE) {
    const batch = ids.slice(index, index + PENDING_REQUEST_BATCH_SIZE);
    const { data, error } = await db
      .from("password_reset_requests")
      .select("request_id,user_id")
      .eq("status", "pending")
      .eq("account_role", input.role)
      .in("user_id", batch)
      .order("user_id", { ascending: true });
    if (error) {
      if (isPasswordResetTableMissing(error)) {
        console.warn("[password-reset] pending_lookup_skipped_missing_table", {
          message: error.message
        });
        return new Map();
      }
      throw new Error(error.message);
    }
    for (const row of data ?? []) {
      pendingByUserId.set(String(row.user_id), String(row.request_id));
    }
  }
  return pendingByUserId;
}

/**
 * Resolves a pending request exactly once.
 *
 * Order and concurrency:
 * 1. The caller verifies identity, target role, and (for teachers) the live
 *    teacher_student_bindings row before this function is reached.
 * 2. The request is claimed with a conditional UPDATE ... WHERE status='pending'.
 *    A losing concurrent resolver gets 409 and never runs a second approval.
 * 3. Only the winner of the claim resets the Supabase Auth password. If that
 *    reset fails, the claim is rolled back to pending so the UI never reports a
 *    resolved request whose password was not actually changed.
 */
export async function resolvePasswordResetRequest(
  db: SupabaseClient,
  input: {
    requestId: string;
    decision: PasswordResetDecision;
    resolverId: string;
    targetRole: PasswordResetTargetRole;
    authorize: (request: PasswordResetRequestRow) => Promise<boolean>;
  }
): Promise<ResolvePasswordResetOutcome> {
  const loaded = await loadPasswordResetRequest(db, input.requestId);
  if (!loaded.ok) {
    return loaded.error === "not_found"
      ? { ok: false, status: 404, message: "未找到该请求。" }
      : { ok: false, status: 500, message: "请求处理失败，请稍后重试。" };
  }
  const request = loaded.request;
  if (request.account_role !== input.targetRole) {
    return { ok: false, status: 403, message: "无权处理该请求。" };
  }
  if (request.status !== "pending") {
    return { ok: false, status: 409, message: "该请求已被处理。" };
  }

  const authorized = await input.authorize(request);
  if (!authorized) {
    return { ok: false, status: 403, message: "无权处理该请求。" };
  }

  const nextStatus = input.decision === "approve" ? "approved" : "rejected";
  const { data: claimed, error: claimError } = await db
    .from("password_reset_requests")
    .update({
      status: nextStatus,
      resolved_at: new Date().toISOString(),
      resolved_by: input.resolverId
    })
    .eq("request_id", input.requestId)
    .eq("status", "pending")
    .select("request_id")
    .maybeSingle<{ request_id: string }>();
  if (claimError) {
    return { ok: false, status: 500, message: "请求处理失败，请稍后重试。" };
  }
  if (!claimed) {
    return { ok: false, status: 409, message: "该请求已被处理。" };
  }

  if (input.decision === "reject") {
    return { ok: true, status: "rejected" };
  }

  const reset = await db.auth.admin.updateUserById(request.user_id, {
    password: PASSWORD_RESET_INITIAL_PASSWORD
  });
  if (reset.error) {
    console.error("[password-reset] auth_reset_failed", {
      requestId: input.requestId,
      message: reset.error.message
    });
    const { error: revertError } = await db
      .from("password_reset_requests")
      .update({ status: "pending", resolved_at: null, resolved_by: null })
      .eq("request_id", input.requestId)
      .eq("status", "approved");
    if (revertError) {
      console.error("[password-reset] auth_reset_revert_failed", {
        requestId: input.requestId,
        message: revertError.message
      });
    }
    return { ok: false, status: 500, message: "密码重置失败，请重试。" };
  }

  return { ok: true, status: "approved" };
}
