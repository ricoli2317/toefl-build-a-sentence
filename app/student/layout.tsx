import { StudentDataCacheProvider } from "@/components/StudentDataCache";
import { StudentShell } from "@/components/student/StudentShell";

export default function StudentLayout({ children }: { children: React.ReactNode }) {
  return (
    <StudentDataCacheProvider>
      <StudentShell>{children}</StudentShell>
    </StudentDataCacheProvider>
  );
}
