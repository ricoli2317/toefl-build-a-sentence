import { ReadingPractice } from "@/components/reading/ReadingPractice";
import { safeStudentReturnTo } from "@/lib/studentNavigation";

export default function ReadingPracticePage({
  params,
  searchParams
}: {
  params: { itemId: string };
  searchParams: { returnTo?: string | string[] };
}) {
  return (
    <ReadingPractice
      itemId={params.itemId}
      returnTo={safeStudentReturnTo(searchParams.returnTo)}
    />
  );
}
