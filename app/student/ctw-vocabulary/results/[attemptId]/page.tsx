import { StudentPage } from "@/components/student/StudentUI";
import { CtwVocabularyResult } from "@/components/student/CtwVocabulary";

export default function Page({ params }: { params: { attemptId: string } }) {
  return <StudentPage title="词测结果"><CtwVocabularyResult attemptId={params.attemptId} /></StudentPage>;
}
