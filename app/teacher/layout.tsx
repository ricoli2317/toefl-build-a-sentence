import { TeacherDataCacheProvider } from "@/components/TeacherDataCache";

export default function TeacherLayout({ children }: { children: React.ReactNode }) {
  return <TeacherDataCacheProvider>{children}</TeacherDataCacheProvider>;
}
