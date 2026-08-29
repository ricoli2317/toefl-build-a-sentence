import { notFound } from "next/navigation";
import { ReadingCatalog } from "@/components/reading/ReadingCatalog";
import { StudentPage } from "@/components/student/StudentUI";
import { isReadingModule } from "@/lib/reading/catalog";
import { READING_PRODUCT_NAMES } from "@/lib/reading/product";

export default function ReadingCatalogPage({ params }: { params: { taskType: string } }) {
  if (!isReadingModule(params.taskType)) notFound();
  return (
    <StudentPage title={READING_PRODUCT_NAMES[params.taskType]}>
      <ReadingCatalog taskType={params.taskType} />
    </StudentPage>
  );
}
