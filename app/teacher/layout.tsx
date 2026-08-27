import { TeacherDataCacheProvider } from "@/components/TeacherDataCache";
import { RoleGate } from "@/components/RoleGate";

export default function TeacherLayout({ children }: { children: React.ReactNode }) {
  return (
    <RoleGate area="teacher">
      <TeacherDataCacheProvider>{children}</TeacherDataCacheProvider>
    </RoleGate>
  );
}
