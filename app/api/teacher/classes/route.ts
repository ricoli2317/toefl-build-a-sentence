import { NextResponse } from "next/server";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  parseClassMemberInputs,
  validateClassName,
  validateClassSubjects
} from "@/lib/teacherClasses";
import { createTeacherClass, listTeacherClasses } from "@/lib/teacherClasses.server";

export const dynamic = "force-dynamic";

function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });
}

function authError(auth: { error?: string | null }) {
  return json(
    {
      code: "UNAUTHORIZED",
      error: auth.error === "Forbidden" ? "仅普通教师可以管理班级。" : "Unauthorized"
    },
    { status: auth.error === "Forbidden" ? 403 : 401 }
  );
}

export async function GET(request: Request) {
  try {
    const auth = await requireTeacherOnly(bearerToken(request));
    if (auth.error || !auth.userId) return authError(auth);
    const classes = await listTeacherClasses(createServiceSupabase(), auth.userId);
    return json({ classes });
  } catch (error) {
    console.error("[teacher-classes] list_failed", error);
    return json({ code: "CLASSES_LOAD_FAILED", error: "班级列表加载失败，请稍后重试。" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireTeacherOnly(bearerToken(request));
    if (auth.error || !auth.userId) return authError(auth);

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const name = validateClassName(body.name);
    if (!name.ok) return json({ code: "INVALID_CLASS", error: name.error }, { status: 400 });
    const subjects = validateClassSubjects(body.subjects);
    if (!subjects.ok) return json({ code: "INVALID_CLASS", error: subjects.error }, { status: 400 });
    const members = parseClassMemberInputs(body.members);
    if (!members.ok) {
      return json(
        { code: "INVALID_CLASS", error: members.error, memberIndex: members.member_index },
        { status: 400 }
      );
    }

    const result = await createTeacherClass(createServiceSupabase(), auth.userId, {
      name: name.name,
      subjects: subjects.subjects,
      members: members.members
    });
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
    return json({ class: result.class }, { status: 201 });
  } catch (error) {
    console.error("[teacher-classes] create_failed", error);
    return json({ code: "CLASS_CREATE_FAILED", error: "班级创建失败，请稍后重试。" }, { status: 500 });
  }
}
