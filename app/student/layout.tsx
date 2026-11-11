import { StudentDataCacheProvider } from "@/components/StudentDataCache";
import { StudentShell } from "@/components/student/StudentShell";
import { RoleGate } from "@/components/RoleGate";
import { NotificationProvider } from "@/components/notifications/NotificationCenter";

export default function StudentLayout({ children }: { children: React.ReactNode }) {
  return (
    <RoleGate area="student">
      <NotificationProvider>
        <StudentDataCacheProvider>
          <StudentShell>{children}</StudentShell>
        </StudentDataCacheProvider>
      </NotificationProvider>
    </RoleGate>
  );
}
