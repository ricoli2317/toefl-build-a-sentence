import { WrongQuestionsPractice } from "@/components/WrongQuestions";
import { StudentErrorState, StudentPage } from "@/components/student/StudentUI";

export default function StudentHistoryWrongQuestionsPracticePage({
  searchParams
}: {
  searchParams: { groupId?: string; mode?: string; scope?: string };
}) {
  const scope = searchParams.scope;
  const mode = searchParams.mode === "random" ? "random" : "all";

  if ((scope !== "entry" && scope !== "history") || (scope === "entry" && !searchParams.groupId)) {
    return (
      <StudentPage title="Build a Sentence">
        <StudentErrorState text="订正作用域无效，请从错题集重新进入。" />
      </StudentPage>
    );
  }

  return (
    <StudentPage title="Build a Sentence">
      <WrongQuestionsPractice groupId={searchParams.groupId} mode={mode} scope={scope} />
    </StudentPage>
  );
}
