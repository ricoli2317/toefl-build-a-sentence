import {
  buildAcademicDiscussionAvatarMap,
  type AcademicDiscussionAvatarRow
} from "@/lib/academicDiscussionAvatars";
import {
  requireWritingAssignmentTeacher,
  writingAssignmentJson
} from "@/lib/writingAssignmentsServer";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const auth = await requireWritingAssignmentTeacher(request);
    if (auth.error) return auth.error;
    if (!auth.supabase) {
      return writingAssignmentJson({ message: "无权读取头像数据。" }, { status: 401 });
    }
    const { data, error } = await auth.supabase
      .from("academic_discussion_avatars")
      .select("participant_name,participant_type,avatar_path")
      .order("participant_type", { ascending: true })
      .order("participant_name", { ascending: true });
    if (error) throw error;
    return writingAssignmentJson({
      avatars: buildAcademicDiscussionAvatarMap((data ?? []) as AcademicDiscussionAvatarRow[])
    });
  } catch (error) {
    console.error("[writing-assignments] avatar_load_failed", error);
    return writingAssignmentJson(
      { code: "AVATAR_LOAD_FAILED", message: "头像加载失败，请稍后重试。" },
      { status: 500 }
    );
  }
}
