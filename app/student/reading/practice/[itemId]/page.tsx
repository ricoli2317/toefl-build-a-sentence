import { ReadingPractice } from "@/components/reading/ReadingPractice";

export default function ReadingPracticePage({ params }: { params: { itemId: string } }) {
  return <ReadingPractice itemId={params.itemId} />;
}
