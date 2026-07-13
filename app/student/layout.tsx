import { StudentDataCacheProvider } from "@/components/StudentDataCache";

export default function StudentLayout({ children }: { children: React.ReactNode }) {
  return <StudentDataCacheProvider>{children}</StudentDataCacheProvider>;
}
