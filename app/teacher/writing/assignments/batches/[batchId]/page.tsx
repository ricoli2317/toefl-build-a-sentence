import { TeacherWritingAssignmentCollectionDetailView } from "@/components/teacher/TeacherWritingAssignmentCollectionDetailView";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherOnly } from "@/components/RoleGate";
import {
  firstSearchParamValue,
  safeTeacherReturnTo,
  TEACHER_ASSIGNMENTS_HREF
} from "@/lib/teacherNavigation";

export default function TeacherWritingAssignmentCollectionPage({
  params,
  searchParams
}: {
  params: { batchId: string };
  searchParams?: { returnTo?: string | string[] };
}) {
  const listReturnTo = safeTeacherReturnTo(
    firstSearchParamValue(searchParams?.returnTo),
    TEACHER_ASSIGNMENTS_HREF
  );

  return (
    <TeacherOnly>
    <TeacherAppShell
      crumbs={[
        { href: listReturnTo, label: "作业管理" },
        { label: "作业详情" }
      ]}
      subtitle="查看每名学生的完成情况，并进入已提交作文的批改。"
      title="作业进度"
    >
      <TeacherWritingAssignmentCollectionDetailView
        collectionId={params.batchId}
        returnTo={listReturnTo}
      />
    </TeacherAppShell>
    </TeacherOnly>
  );
}
