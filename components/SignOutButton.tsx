"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { getPreferredUserDisplayName } from "@/lib/userDisplayName";
import { formatAccountForDisplay } from "@/lib/accountIdentifier";
import {
  TEACHER_CURRENT_USER_CACHE_KEY,
  useOptionalTeacherDataCache
} from "@/components/TeacherDataCache";
import {
  STUDENT_CURRENT_USER_CACHE_KEY,
  useOptionalStudentDataCache
} from "@/components/StudentDataCache";

export function SignOutButton({
  locale = "en",
  showIdentity = true,
  variant = "default"
}: {
  locale?: "en" | "zh-CN";
  showIdentity?: boolean;
  variant?: "default" | "student";
}) {
  const router = useRouter();
  const teacherCache = useOptionalTeacherDataCache();
  const studentCache = useOptionalStudentDataCache();
  const loadTeacherData = teacherCache?.load;
  const clearTeacherData = teacherCache?.clear;
  const loadStudentData = studentCache?.load;
  const clearStudentData = studentCache?.clear;
  const studentSessionReady = studentCache?.sessionReady;
  const studentId = studentCache?.studentId;
  const [displayName, setDisplayName] = useState("");

  useEffect(() => {
    let ignore = false;

    async function loadDisplayName() {
      if (!showIdentity) return;
      if (studentCache && (!studentSessionReady || !studentId)) return;

      const loader = async (accessToken?: string) => {
        const supabase = createBrowserSupabase();
        const {
          data: { user }
        } = await supabase.auth.getUser(accessToken);

        if (!user) return "";
        if (variant === "student") return formatAccountForDisplay(user.email);
        return getPreferredUserDisplayName({
          email: user.email,
          metadata: user.user_metadata
        });
      };
      const name = loadTeacherData
        ? await loadTeacherData(TEACHER_CURRENT_USER_CACHE_KEY, () => loader())
        : loadStudentData
          ? await loadStudentData(STUDENT_CURRENT_USER_CACHE_KEY, (session) =>
              loader(session.accessToken)
            )
          : await loader();

      if (!ignore && name) setDisplayName(name);
    }

    loadDisplayName();
    return () => {
      ignore = true;
    };
  }, [loadStudentData, loadTeacherData, showIdentity, studentCache, studentId, studentSessionReady, variant]);

  async function signOut() {
    const supabase = createBrowserSupabase();
    await supabase.auth.signOut();
    clearTeacherData?.();
    clearStudentData?.();
    router.push("/");
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {showIdentity && displayName ? (
        <span
          className={
            variant === "student"
              ? "hidden text-sm font-medium text-student-muted sm:inline"
              : "text-sm font-semibold text-ink/70"
          }
        >
          {displayName}
        </span>
      ) : null}
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
    </div>
  );
}
