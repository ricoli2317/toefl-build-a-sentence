import Link from "next/link";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherOnly } from "@/components/RoleGate";
import { TeacherWritingReviewList } from "@/components/teacher/TeacherWritingReviewList";
import { parseTeacherWritingReviewListSearchParams } from "@/lib/teacherWritingReviewNavigation";

export default function TeacherWritingReviewsPage({
  searchParams
}: {
  searchParams?: {
    tab?: string | string[];
    classId?: string | string[];
    studentId?: string | string[];
    status?: string | string[];
    taskType?: string | string[];
  };
}) {
  // The tab and every filter live in the URL, so a refresh, the class
  // drill-down and the browser Back/Forward all restore the exact list
  // context; invalid values fall back safely (see the parser).
  const initial = parseTeacherWritingReviewListSearchParams(searchParams);

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
      <TeacherWritingReviewList
        initialClassId={initial.classId}
        initialStudentId={initial.studentId}
        initialStatus={initial.status}
        initialTab={initial.tab}
        initialTaskType={initial.taskType}
      />
    </TeacherAppShell>
    </TeacherOnly>
  );
}
