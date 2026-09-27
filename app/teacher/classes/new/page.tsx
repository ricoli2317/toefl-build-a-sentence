import { TeacherOnly } from "@/components/RoleGate";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherCreateClass } from "@/components/teacher/TeacherCreateClass";

export default function TeacherNewClassPage() {
  return (
    <TeacherOnly>
      <TeacherAppShell
        crumbs={[
          { label: "首页", href: "/teacher/dashboard" },
          { label: "新增班级" }
        ]}
        subtitle="创建班级并添加学生"
        title="新增班级"
      >
        <TeacherCreateClass />
      </TeacherAppShell>
    </TeacherOnly>
  );
}
