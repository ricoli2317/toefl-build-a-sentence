import { TeacherOnly } from "@/components/RoleGate";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherClassDetail } from "@/components/teacher/TeacherClassDetail";
import {
  firstSearchParamValue,
  safeTeacherReturnTo,
  TEACHER_HOME_CLASSES_HREF,
  TEACHER_HOME_HREF
} from "@/lib/teacherNavigation";

export default function TeacherClassDetailPage({
  params,
  searchParams
}: {
  params: { classId: string };
  searchParams?: { returnTo?: string | string[] };
}) {
  // The class list lives on the home classes tab; a direct or refreshed URL
  // falls back to that tab instead of a non-existent standalone class list.
  const classListHref = safeTeacherReturnTo(
    firstSearchParamValue(searchParams?.returnTo),
    TEACHER_HOME_CLASSES_HREF
  );

  return (
    <TeacherOnly>
      <TeacherAppShell
        crumbs={[
          { label: "首页", href: TEACHER_HOME_HREF },
          { label: "班级", href: classListHref }
        ]}
        subtitle="管理班级成员与班级作业"
        title="班级详情"
      >
        <TeacherClassDetail classId={params.classId} />
      </TeacherAppShell>
    </TeacherOnly>
  );
}
