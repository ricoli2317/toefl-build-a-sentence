import { StudentDataCacheProvider } from "@/components/StudentDataCache";
import { StudentShell } from "@/components/student/StudentShell";
import { RoleGate } from "@/components/RoleGate";

export default function StudentLayout({ children }: { children: React.ReactNode }) {
  return (
    <RoleGate area="student">
      <StudentDataCacheProvider>
        <StudentShell>{children}</StudentShell>
      </StudentDataCacheProvider>
    </RoleGate>
  );
}
