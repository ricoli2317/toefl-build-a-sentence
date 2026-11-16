import { GrammarQuestionsPractice } from "@/components/GrammarPractice";
import { StudentPage } from "@/components/student/StudentUI";
import { normalizeGrammarPracticeMode } from "@/lib/grammarPractice";

export default function StudentGrammarQuestionsPracticePage({
  searchParams
}: {
  searchParams: {
    mode?: string;
    tag?: string;
    session?: string;
    requestId?: string;
  };
}) {
  const mode = normalizeGrammarPracticeMode(searchParams.mode);
  const tag = searchParams.tag?.trim() ?? "";
  const sessionId = searchParams.session?.trim() || undefined;
  const requestId = searchParams.requestId?.trim() || undefined;

  return (
    <StudentPage title="Build a Sentence">
      <GrammarQuestionsPractice
        mode={mode}
        requestId={requestId}
        sessionId={sessionId}
        tag={tag}
      />
    </StudentPage>
  );
}
