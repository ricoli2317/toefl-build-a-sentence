import { CtwVocabularySession } from "@/components/student/CtwVocabularyWorkspace";

export default function Page({ params }: { params: { attemptId: string } }) {
  return <CtwVocabularySession attemptId={params.attemptId} />;
}
