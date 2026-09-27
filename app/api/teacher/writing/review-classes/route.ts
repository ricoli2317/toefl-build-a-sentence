import { NextResponse } from "next/server";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { listClassReviewSummaries } from "@/lib/teacherClasses.server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const auth = await requireTeacherOnly(bearerToken(request));
    if (auth.error || !auth.userId) {
      return NextResponse.json(
        {
          code: "UNAUTHORIZED",
          error: auth.error === "Forbidden" ? "仅普通教师可以查看班级批改。" : "Unauthorized"
        },
        {
          status: auth.error === "Forbidden" ? 403 : 401,
          headers: { "Cache-Control": "no-store" }
        }
      );
    }

    const classes = await listClassReviewSummaries(createServiceSupabase(), auth.userId);
    return NextResponse.json(
      { classes },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("[teacher-class-reviews] list_failed", error);
    return NextResponse.json(
      { code: "CLASS_REVIEWS_LOAD_FAILED", error: "班级批改列表加载失败，请稍后重试。" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
