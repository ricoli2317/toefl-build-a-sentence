import { ReadingWrongbookPractice } from "@/components/reading/ReadingWrongbookPractice";
import { isReadingModule } from "@/lib/reading/catalog";

export default function TodayReadingWrongbookPracticePage({
  searchParams
}: {
  searchParams: { itemId?: string; taskType?: string };
}) {
  if (!isReadingModule(searchParams.taskType)) return null;
  return (
    <ReadingWrongbookPractice
      itemId={searchParams.itemId}
      scope="today"
      taskType={searchParams.taskType}
    />
  );
}
