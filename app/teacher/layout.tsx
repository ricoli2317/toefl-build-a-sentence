import { TeacherDataCacheProvider } from "@/components/TeacherDataCache";
import { RoleGate } from "@/components/RoleGate";
import { NotificationProvider } from "@/components/notifications/NotificationCenter";

export default function TeacherLayout({ children }: { children: React.ReactNode }) {
  return (
    <RoleGate area="teacher">
      <NotificationProvider>
        <TeacherDataCacheProvider>{children}</TeacherDataCacheProvider>
      </NotificationProvider>
    </RoleGate>
  );
}
