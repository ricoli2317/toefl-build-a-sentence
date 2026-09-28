import { NextResponse } from "next/server";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  normalizeClassSubjects,
  validateClassName,
  validateClassSubjects
} from "@/lib/teacherClasses";
import {
  loadTeacherClassDetail,
  loadTeacherClassRow,
  renameTeacherClass,
  updateTeacherClassSubjects
} from "@/lib/teacherClasses.server";

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

export async function GET(
  request: Request,
  { params }: { params: { classId: string } }
) {
  try {
    const auth = await requireTeacherOnly(bearerToken(request));
    if (auth.error || !auth.userId) return authError(auth);

    const detail = await loadTeacherClassDetail(
      createServiceSupabase(),
      auth.userId,
      params.classId
    );
    if (!detail) return json({ code: "CLASS_NOT_FOUND", error: "班级不存在或无权查看。" }, { status: 404 });
    return json({ detail });
  } catch (error) {
    console.error("[teacher-classes] detail_failed", error);
    return json({ code: "CLASS_LOAD_FAILED", error: "班级信息加载失败，请稍后重试。" }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: { classId: string } }
) {
  try {
    const auth = await requireTeacherOnly(bearerToken(request));
    if (auth.error || !auth.userId) return authError(auth);
    const db = createServiceSupabase();

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const hasName = body.name !== undefined;
    const hasSubjects = body.subjects !== undefined;
    if (!hasName && !hasSubjects) {
      return json({ code: "INVALID_CLASS", error: "没有需要保存的修改。" }, { status: 400 });
    }

    if (hasName) {
      const name = validateClassName(body.name);
      if (!name.ok) return json({ code: "INVALID_CLASS", error: name.error }, { status: 400 });
      const renamed = await renameTeacherClass(db, auth.userId, params.classId, name.name);
      if (!renamed.ok) return json({ code: renamed.code, error: renamed.error }, { status: renamed.status });
    }

    if (hasSubjects) {
      const subjects = validateClassSubjects(body.subjects);
      if (!subjects.ok) return json({ code: "INVALID_CLASS", error: subjects.error }, { status: 400 });

      // Subject changes only ever add the required member bindings; removing a
      // subject from a class never releases a student's binding.
      const updated = await updateTeacherClassSubjects(
        db,
        auth.userId,
        params.classId,
        subjects.subjects
      );
      if (!updated.ok) return json({ code: updated.code, error: updated.error }, { status: updated.status });
    }

    const detail = await loadTeacherClassDetail(db, auth.userId, params.classId);
    if (!detail) return json({ code: "CLASS_NOT_FOUND", error: "班级不存在或无权查看。" }, { status: 404 });
    return json({ class: detail.class, detail });
  } catch (error) {
    console.error("[teacher-classes] update_failed", error);
    return json({ code: "CLASS_UPDATE_FAILED", error: "保存失败，请稍后重试。" }, { status: 500 });
  }
}
