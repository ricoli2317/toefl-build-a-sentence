import { TeacherImportQuestions } from "@/components/TeacherImportQuestions";
import { TeacherImportReviews } from "@/components/TeacherImportReviews";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";

export default function TeacherImportPage() {
  return (
    <TeacherAppShell
      crumbs={[
        { label: "首页", href: "/teacher/dashboard" },
        { label: "导入 CSV" }
      ]}
      subtitle="上传并导入新的题库文件"
      title="导入题库 CSV"
    >
      <div className="grid gap-5">
        <TeacherImportQuestions />
        <TeacherImportReviews />
      </div>
    </TeacherAppShell>
  );
}
