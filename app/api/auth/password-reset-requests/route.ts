import { NextResponse } from "next/server";
import { createPasswordResetRequestByAccount } from "@/lib/passwordResetRequests.server";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const json = (data: unknown, init?: ResponseInit) =>
  NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });

/**
 * Login-page forgot-password request. Unauthenticated by design: the account
 * typed on the login form is resolved server-side to an existing Student or
 * Teacher profile. Repeated requests refresh the single pending row instead of
 * creating duplicates; no Auth-internal details are returned. The verified
 * account role is echoed back so the login page shows the correct waiting
 * message without guessing identity from the account string.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { account?: unknown };
  const account = typeof body.account === "string" ? body.account : "";

  try {
    const result = await createPasswordResetRequestByAccount(createServiceSupabase(), account);
    if (!result.ok) return json({ message: result.message }, { status: result.status });
    return json({ ok: true, role: result.role });
  } catch (error) {
    console.error("[password-reset] create_failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return json({ message: "请求提交失败，请稍后重试。" }, { status: 500 });
  }
}
