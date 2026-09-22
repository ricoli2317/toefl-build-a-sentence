import { NextResponse } from "next/server";
import { bearerToken, requireAdmin } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const json = (data: unknown, init?: ResponseInit) => NextResponse.json(data, {
  ...init,
  headers: { ...init?.headers, "Cache-Control": "no-store" }
});

export async function DELETE(request: Request, { params }: { params: { bindingId: string } }) {
  const auth = await requireAdmin(bearerToken(request));
  if (auth.error) return json({ message: "仅管理员可以删除教师绑定。" }, { status: 403 });
  const db = createServiceSupabase();
  const { error } = await db.from("teacher_student_bindings")
    .delete()
    .eq("binding_id", params.bindingId);
  if (error) return json({ message: error.message }, { status: 500 });
  return json({ success: true });
}