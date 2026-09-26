import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Admin-managed Student/Teacher account activation, shared by both account
 * lists. Admin accounts are never managed here.
 *
 * Deactivation uses two independent gates:
 * 1. profiles.is_active = false — the app-level gate already enforced by
 *    requireAuthenticatedAccount on every API route and by RoleGate.
 * 2. Supabase Auth ban (admin.updateUserById ban_duration) — blocks new
 *    sign-ins and token refreshes at the Auth layer without deleting the user.
 *
 * No profile, binding, assignment, attempt, review, or history row is deleted
 * or rewritten; only the activation flags change.
 */
export const ACCOUNT_BAN_DURATION = "876000h";

export type ManagedAccountStatusRow = {
  id: string;
  role: "student" | "teacher";
  isActive: boolean;
};

export type SetAccountStatusResult =
  | { ok: true; isActive: boolean; banSynced: boolean }
  | { ok: false; message: string };

export async function loadManagedAccountStatus(
  db: SupabaseClient,
  accountId: string
): Promise<{ ok: true; account: ManagedAccountStatusRow } | { ok: false; message: string }> {
  const { data, error } = await db
    .from("profiles")
    .select("id,role,is_active")
    .eq("id", accountId)
    .maybeSingle<{ id: string; role: string | null; is_active: boolean | null }>();
  if (error) {
    console.error("[account-status] load_failed", { message: error.message });
    return { ok: false, message: "账号状态加载失败，请稍后重试。" };
  }
  if (!data || (data.role !== "student" && data.role !== "teacher")) {
    return { ok: false, message: "未找到该账号。" };
  }
  return {
    ok: true,
    account: { id: data.id, role: data.role, isActive: data.is_active !== false }
  };
}

export async function setManagedAccountActive(
  db: SupabaseClient,
  account: ManagedAccountStatusRow,
  isActive: boolean
): Promise<SetAccountStatusResult> {
  if (isActive) {
    // Enable: clear any Auth ban first. If this fails nothing changed, so the
    // account stays blocked and the admin can retry — never a false "enabled".
    const unban = await db.auth.admin.updateUserById(account.id, { ban_duration: "none" });
    if (unban.error) {
      console.error("[account-status] unban_failed", {
        accountId: account.id,
        message: unban.error.message
      });
      return { ok: false, message: "账号启用失败，请稍后重试。" };
    }
    const { error } = await db
      .from("profiles")
      .update({ is_active: true })
      .eq("id", account.id)
      .in("role", ["student", "teacher"]);
    if (error) {
      console.error("[account-status] enable_profile_failed", {
        accountId: account.id,
        message: error.message
      });
      return { ok: false, message: "账号启用失败，请稍后重试。" };
    }
    return { ok: true, isActive: true, banSynced: true };
  }

  // Disable: flip the app-level gate first; every API and role gate rejects
  // the account from this moment on. The Auth ban is then added on top.
  const { error } = await db
    .from("profiles")
    .update({ is_active: false })
    .eq("id", account.id)
    .in("role", ["student", "teacher"]);
  if (error) {
    console.error("[account-status] disable_profile_failed", {
      accountId: account.id,
      message: error.message
    });
    return { ok: false, message: "账号停用失败，请稍后重试。" };
  }

  const ban = await db.auth.admin.updateUserById(account.id, {
    ban_duration: ACCOUNT_BAN_DURATION
  });
  if (ban.error) {
    // is_active=false already blocks the account on every request; report the
    // unsynced Auth ban truthfully and let a retry finish the ban.
    console.error("[account-status] ban_failed", {
      accountId: account.id,
      message: ban.error.message
    });
    return { ok: true, isActive: false, banSynced: false };
  }
  return { ok: true, isActive: false, banSynced: true };
}
