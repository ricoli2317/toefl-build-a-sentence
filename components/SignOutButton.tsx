"use client";

import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { useOptionalTeacherDataCache } from "@/components/TeacherDataCache";
import { useOptionalStudentDataCache } from "@/components/StudentDataCache";

/**
 * Sign-out only. The current account display name belongs to the shell
 * (RoleGate's account context), so this button never resolves identity itself.
 */
export function SignOutButton({
  locale = "en",
  variant = "default"
}: {
  locale?: "en" | "zh-CN";
  variant?: "default" | "student";
}) {
  const router = useRouter();
  const teacherCache = useOptionalTeacherDataCache();
  const studentCache = useOptionalStudentDataCache();
  const clearTeacherData = teacherCache?.clear;
  const clearStudentData = studentCache?.clear;

  async function signOut() {
    const supabase = createBrowserSupabase();
    await supabase.auth.signOut();
    clearTeacherData?.();
    clearStudentData?.();
    router.push("/");
  }

  return (
    <button
      className={
        variant === "student"
          ? "student-button-secondary"
          : "rounded-md border border-line bg-white px-3 py-2 text-sm font-semibold hover:border-ocean"
      }
      onClick={signOut}
      type="button"
    >
      {locale === "zh-CN" ? "退出登录" : "Sign out"}
    </button>
  );
}
