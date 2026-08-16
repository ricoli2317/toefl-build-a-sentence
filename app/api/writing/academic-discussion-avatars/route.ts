import { createServiceSupabase } from "@/lib/supabase/server";
import {
  buildAcademicDiscussionAvatarMap,
  type AcademicDiscussionAvatarRow
} from "@/lib/academicDiscussionAvatars";
import { requireWritingStudent, writingJson } from "@/lib/writingServer";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireWritingStudent(request);
  if (auth.error) return auth.error;

  try {
    const { data, error } = await createServiceSupabase()
      .from("academic_discussion_avatars")
      .select("participant_name, participant_type, avatar_path")
      .order("participant_type", { ascending: true })
      .order("participant_name", { ascending: true });

    if (error) {
      return writingJson({ error: error.message }, { status: 500 });
    }

    return writingJson({
      avatars: buildAcademicDiscussionAvatarMap(
        (data ?? []) as AcademicDiscussionAvatarRow[]
      )
    });
  } catch (error) {
    return writingJson(
      {
        error:
          error instanceof Error
            ? error.message
            : "Academic discussion avatars could not be loaded."
      },
      { status: 500 }
    );
  }
}
