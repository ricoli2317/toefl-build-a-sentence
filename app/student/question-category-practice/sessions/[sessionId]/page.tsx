import { QuestionCategorySessionResult } from "@/components/reading/QuestionCategorySessionResult";
import { StudentPage } from "@/components/student/StudentUI";
import { safeStudentReturnTo } from "@/lib/studentNavigation";
export default function CategoryResultPage({ params, searchParams }: {
  params: { sessionId: string }; searchParams: { returnTo?: string | string[] };
}) {
  return <StudentPage title="查看阅读结果"><QuestionCategorySessionResult sessionId={params.sessionId}
    returnTo={safeStudentReturnTo(searchParams.returnTo)} /></StudentPage>;
}
