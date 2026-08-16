import Link from "next/link";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherWritingReviewList } from "@/components/teacher/TeacherWritingReviewList";

export default function TeacherWritingReviewsPage() {
  return (
    <TeacherAppShell
      action={
        <Link className="teacher-button-secondary" href="/teacher/writing/reviews/logs">
          AI 调用日志
        </Link>
      }
      crumbs={[
        { label: "首页", href: "/teacher/dashboard" },
        { label: "写作批改" }
      ]}
      subtitle="查看写作提交并进行 AI 或手动批改"
      title="写作批改"
    >
      <TeacherWritingReviewList />
    </TeacherAppShell>
  );
}
