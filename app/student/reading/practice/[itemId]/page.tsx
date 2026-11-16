import { ReadingPractice } from "@/components/reading/ReadingPractice";
import { safeStudentReturnTo } from "@/lib/studentNavigation";

export default function ReadingPracticePage({
  params,
  searchParams
}: {
  params: { itemId: string };
  searchParams: {
    assignmentId?: string | string[];
    returnTo?: string | string[];
  };
}) {
  const assignmentId = Array.isArray(searchParams.assignmentId)
    ? searchParams.assignmentId[0]
    : searchParams.assignmentId;

  return (
    <ReadingPractice
      assignmentId={assignmentId?.trim() || null}
      itemId={params.itemId}
      returnTo={safeStudentReturnTo(searchParams.returnTo)}
    />
  );
}
