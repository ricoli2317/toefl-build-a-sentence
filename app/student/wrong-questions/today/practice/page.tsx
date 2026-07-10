import { AppShell } from "@/components/AppShell";
import { WrongQuestionsPractice } from "@/components/WrongQuestions";

export default function StudentTodayWrongQuestionsPracticePage() {
  return (
    <AppShell brand="Build a Sentence" eyebrow="Practice" title="Build a Sentence">
      <WrongQuestionsPractice mode="today" />
    </AppShell>
  );
}
