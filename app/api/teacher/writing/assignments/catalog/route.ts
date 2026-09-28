import { isAssignmentSubject } from "@/lib/assignmentCatalog";
import { loadTeacherAssignmentCatalog } from "@/lib/assignmentCatalog.server";
import {
  requireWritingAssignmentTeacher,
  writingAssignmentJson
} from "@/lib/writingAssignmentsServer";

export const dynamic = "force-dynamic";

/**
 * The Assignment picker's lightweight catalog: one request per subject, all
 * month / topic / length / title filtering happens on the client. The response
 * carries only stable id, item type, title, occurrence months, topic and the
 * RDL length metadata — never passage, material, prompt, question or option
 * content, and never student attempt state.
 */
export async function GET(request: Request) {
  try {
    const auth = await requireWritingAssignmentTeacher(request);
    if (auth.error) return auth.error;
    if (!auth.supabase) {
      return writingAssignmentJson({ message: "无权访问教师端作业数据。" }, { status: 401 });
    }
    const subject = new URL(request.url).searchParams.get("subject");
    if (!isAssignmentSubject(subject)) {
      return writingAssignmentJson(
        { code: "INVALID_SUBJECT", message: "请选择有效的作业科目。" },
        { status: 400 }
      );
    }
    return writingAssignmentJson({
      subject,
      items: await loadTeacherAssignmentCatalog(auth.supabase, subject)
    });
  } catch (error) {
    console.error("[writing-assignments] assignment_catalog_load_failed", error);
    return writingAssignmentJson(
      { code: "ASSIGNMENT_CATALOG_FAILED", message: "题目目录加载失败，请稍后重试。" },
      { status: 500 }
    );
  }
}
