import { ReadingWrongbookPractice } from "@/components/reading/ReadingWrongbookPractice";
import { ReadingFullSetWrongbookPractice } from "@/components/reading/ReadingFullSetWrongbookPractice";
import { isReadingModule } from "@/lib/reading/catalog";

export default function TodayReadingWrongbookPracticePage({
  searchParams
}: {
  searchParams: { itemId?: string; sourceAttemptId?: string; taskType?: string };
}) {
  if (searchParams.taskType === "full_set" && searchParams.sourceAttemptId) {
    return <ReadingFullSetWrongbookPractice scope="today" sourceAttemptId={searchParams.sourceAttemptId} />;
  }
  if (!isReadingModule(searchParams.taskType)) return null;
  return (
    <ReadingWrongbookPractice
      itemId={searchParams.itemId}
      scope="today"
      taskType={searchParams.taskType}
    />
  );
}
