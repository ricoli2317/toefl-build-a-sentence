import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherOnly } from "@/components/RoleGate";
import { TeacherBindStudent } from "@/components/teacher/TeacherBindStudent";
import { normalizeBindingDomains } from "@/lib/studentBindings";

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default function TeacherBindStudentPage({
  searchParams
}: {
  searchParams?: { q?: string | string[]; studentId?: string | string[]; domains?: string | string[] };
}) {
  const initialDomains = normalizeBindingDomains(
    firstValue(searchParams?.domains).split(",").filter(Boolean)
  );
  return (
    <TeacherAppShell
      crumbs={[
        { label: "首页", href: "/teacher/dashboard" },
        { label: "学生", href: "/teacher/students" },
        { label: "绑定学生" }
      ]}
      subtitle="搜索已有学生并建立授课绑定"
      title="绑定学生"
    >
      <TeacherOnly>
        <TeacherBindStudent
          initialDomains={initialDomains}
          initialQuery={firstValue(searchParams?.q).trim()}
          initialStudentId={firstValue(searchParams?.studentId).trim()}
        />
      </TeacherOnly>
    </TeacherAppShell>
  );
}
