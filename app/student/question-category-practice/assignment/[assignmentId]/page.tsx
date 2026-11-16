import { QuestionCategoryPractice } from "@/components/reading/QuestionCategoryPractice";
import { safeStudentReturnTo } from "@/lib/studentNavigation";
import { isReadingQuestionCategory } from "@/lib/reading/questionCategory";

/**
 * Teacher-assigned RAP Question Category practice.
 *
 * It renders the same immersive reading workspace as the self-practice
 * category route: the StudentShell immersive branch removes the sidebar and the
 * component owns the whole viewport, so no outer page title or page wrapper is
 * added here.
 */
export default function StudentQuestionCategoryAssignmentPage({
  params,
  searchParams
}: {
  params: { assignmentId: string };
  searchParams: {
    new?: string;
    questionCategory?: string;
    requestId?: string;
    returnTo?: string | string[];
    session?: string;
  };
}) {
  const forceNew = searchParams.new === "1";
  const category = isReadingQuestionCategory(searchParams.questionCategory)
    ? searchParams.questionCategory
    : undefined;
  return (
    <QuestionCategoryPractice
      assignmentId={params.assignmentId}
      questionCategory={category}
      requestId={searchParams.requestId?.trim() || undefined}
      returnTo={safeStudentReturnTo(searchParams.returnTo) ?? undefined}
      sessionId={forceNew ? undefined : searchParams.session?.trim() || undefined}
    />
  );
}
