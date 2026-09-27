import Link from "next/link";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherOnly } from "@/components/RoleGate";
import { TeacherWritingReviewList } from "@/components/teacher/TeacherWritingReviewList";

function firstSearchParam(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0]?.trim() ?? "";
  return value?.trim() ?? "";
}

export default function TeacherWritingReviewsPage({
  searchParams
}: {
  searchParams?: { tab?: string | string[]; classId?: string | string[] };
}) {
  const tab = firstSearchParam(searchParams?.tab) === "class" ? "class" : "students";
  const classId = firstSearchParam(searchParams?.classId);

  return (
    <TeacherOnly>
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
      <TeacherWritingReviewList initialClassId={tab === "class" ? classId : ""} initialTab={tab} />
    </TeacherAppShell>
    </TeacherOnly>
  );
}
