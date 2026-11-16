import { isCategoryAssignmentItemType } from "@/lib/assignmentCatalog";
import { loadCategoryAssignmentOptions } from "@/lib/categoryAssignment.server";
import {
  requireWritingAssignmentTeacher,
  writingAssignmentJson
} from "@/lib/writingAssignmentsServer";

export const dynamic = "force-dynamic";

/**
 * Lightweight category options for the teacher wizard. BAS uses the real
 * grammar-tag summary (deduped by final sentence, exactly like the practice
 * loader); RAP uses the fixed ten question-level categories. Counts are only
 * guidance — the creation RPC re-draws and re-validates the frozen manifest.
 */
export async function GET(request: Request) {
  try {
    const auth = await requireWritingAssignmentTeacher(request);
    if (auth.error) return auth.error;
    if (!auth.supabase) {
      return writingAssignmentJson({ message: "无权访问教师端作业数据。" }, { status: 401 });
    }
    const type = new URL(request.url).searchParams.get("type")?.trim() ?? "";
    if (!isCategoryAssignmentItemType(type)) {
      return writingAssignmentJson(
        { code: "INVALID_CATEGORY_TYPE", message: "请选择有效的分类作业类型。" },
        { status: 400 }
      );
    }
    return writingAssignmentJson({
      type,
      categories: await loadCategoryAssignmentOptions(auth.supabase, type)
    });
  } catch (error) {
    console.error("[writing-assignments] category_options_failed", error);
    return writingAssignmentJson(
      { code: "CATEGORY_OPTIONS_FAILED", message: "分类题库加载失败，请稍后重试。" },
      { status: 500 }
    );
  }
}
