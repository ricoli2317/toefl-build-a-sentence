import { NextResponse } from "next/server";
import { bearerToken, requireAdmin } from "@/lib/auth";
import { loadManagedAccountStatus, setManagedAccountActive } from "@/lib/accountStatus.server";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const json = (data: unknown, init?: ResponseInit) =>
  NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });

/**
 * Admin enable/disable for Student and Teacher accounts (one shared endpoint
 * for both account lists). Only the profiles.is_active flag and the Supabase
 * Auth ban are touched; no profile, binding, assignment, attempt, review, or
 * history row is deleted. Admin accounts are not a valid target.
 */
export async function PATCH(
  request: Request,
  { params }: { params: { accountId: string } }
) {
  const auth = await requireAdmin(bearerToken(request));
  if (auth.error || !auth.userId) {
    return json({ message: "仅管理员可以启用或停用账号。" }, { status: 403 });
  }

  const accountId = String(params.accountId ?? "").trim();
  if (!accountId) return json({ message: "无效的账号。" }, { status: 400 });

  const body = (await request.json().catch(() => ({}))) as { isActive?: unknown };
  if (typeof body.isActive !== "boolean") {
    return json({ message: "无效的账号状态。" }, { status: 400 });
  }

  try {
    const db = createServiceSupabase();
    const loaded = await loadManagedAccountStatus(db, accountId);
    if (!loaded.ok) {
      return json({ message: loaded.message }, { status: 404 });
    }
    const result = await setManagedAccountActive(db, loaded.account, body.isActive);
    if (!result.ok) return json({ message: result.message }, { status: 500 });
    return json({
      accountId,
      isActive: result.isActive,
      banSynced: result.banSynced
    });
  } catch (error) {
    console.error("[account-status] update_failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return json({ message: "账号状态更新失败，请稍后重试。" }, { status: 500 });
  }
}
