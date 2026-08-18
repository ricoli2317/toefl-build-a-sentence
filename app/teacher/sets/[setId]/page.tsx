import { TeacherSetSummary } from "@/components/TeacherDashboard";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";

export default function TeacherSetPage({ params }: { params: { setId: string } }) {
  const setId = decodeURIComponent(params.setId);

  return (
    <TeacherAppShell
      crumbs={[
        { label: "首页", href: "/teacher/dashboard" },
        { label: "套题统计", href: "/teacher/sets" },
        { label: "套题详情" }
      ]}
      title="套题详情"
    >
      <TeacherSetSummary setId={setId} />
    </TeacherAppShell>
  );
}
