import { ReadingWrongbookPractice } from "@/components/reading/ReadingWrongbookPractice";
import { isReadingModule } from "@/lib/reading/catalog";

export default function HistoryReadingWrongbookPracticePage({
  searchParams
}: {
  searchParams: { itemId?: string; taskType?: string };
}) {
  if (!isReadingModule(searchParams.taskType)) return null;
  return (
    <ReadingWrongbookPractice
      itemId={searchParams.itemId}
      scope="history"
      taskType={searchParams.taskType}
    />
  );
}
