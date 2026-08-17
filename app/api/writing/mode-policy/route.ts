import {
  getStudentWritingModeAvailability
} from "@/lib/writingModePolicy";
import { requireWritingStudent, writingJson } from "@/lib/writingServer";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const auth = await requireWritingStudent(request);
    if (auth.error) return auth.error;
    if (!auth.supabase || !auth.userId) {
      return writingJson({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await getStudentWritingModeAvailability(
      auth.supabase,
      auth.userId
    );
    if (result.error || !result.data) {
      return writingJson(
        { error: "暂时无法加载写作模式，请稍后重试。" },
        { status: 500 }
      );
    }

    return writingJson(result.data);
  } catch {
    return writingJson(
      { error: "暂时无法加载写作模式，请稍后重试。" },
      { status: 500 }
    );
  }
}
