import { NextResponse } from "next/server";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { parseClassMemberInputs } from "@/lib/teacherClasses";
import { addTeacherClassMembers, loadTeacherClassDetail } from "@/lib/teacherClasses.server";

export const dynamic = "force-dynamic";

function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });
}

export async function POST(
  request: Request,
  { params }: { params: { classId: string } }
) {
  try {
    const auth = await requireTeacherOnly(bearerToken(request));
    if (auth.error || !auth.userId) {
      return json(
        {
          code: "UNAUTHORIZED",
          error: auth.error === "Forbidden" ? "仅普通教师可以管理班级。" : "Unauthorized"
        },
        { status: auth.error === "Forbidden" ? 403 : 401 }
      );
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const members = parseClassMemberInputs(body.members);
    if (!members.ok) {
      return json(
        { code: "INVALID_CLASS", error: members.error, memberIndex: members.member_index },
        { status: 400 }
      );
    }
    if (members.members.length === 0) {
      return json({ code: "INVALID_CLASS", error: "请至少添加一名学生。" }, { status: 400 });
    }

    const db = createServiceSupabase();
    const result = await addTeacherClassMembers(db, auth.userId, params.classId, members.members);
    if (!result.ok) {
      return json(
        {
          code: result.code,
          error: result.error,
          members: result.members,
          memberIndex: result.member_index
        },
        { status: result.status }
      );
    }

    const detail = await loadTeacherClassDetail(db, auth.userId, params.classId);
    if (!detail) return json({ code: "CLASS_NOT_FOUND", error: "班级不存在或无权查看。" }, { status: 404 });
    return json({ class: detail.class, detail }, { status: 201 });
  } catch (error) {
    console.error("[teacher-classes] add_members_failed", error);
    return json({ code: "CLASS_MEMBERS_ADD_FAILED", error: "添加学生失败，请稍后重试。" }, { status: 500 });
  }
}
