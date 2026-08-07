import { redirect } from "next/navigation";
import { GrammarPracticeHome } from "@/components/GrammarPractice";
import { StudentPage } from "@/components/student/StudentUI";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";

export default function StudentGrammarPracticePage({
  searchParams
}: {
  searchParams: { tag?: string };
}) {
  const tag = searchParams.tag?.trim() ?? "";
  if (tag) redirect(STUDENT_ROUTES.grammarPractice);

  return (
    <StudentPage title="按语法分类练习">
      <GrammarPracticeHome />
    </StudentPage>
  );
}
