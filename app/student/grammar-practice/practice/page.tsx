import { GrammarQuestionsPractice } from "@/components/GrammarPractice";
import { StudentPage } from "@/components/student/StudentUI";

export default function StudentGrammarQuestionsPracticePage({
  searchParams
}: {
  searchParams: { mode?: string; tag?: string };
}) {
  const mode = searchParams.mode === "random" ? "random" : "all";
  const tag = searchParams.tag?.trim() ?? "";

  return (
    <StudentPage title="Build a Sentence">
      <GrammarQuestionsPractice mode={mode} tag={tag} />
    </StudentPage>
  );
}
