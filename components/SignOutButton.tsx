"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { getPreferredUserDisplayName } from "@/lib/userDisplayName";
import {
  TEACHER_CURRENT_USER_CACHE_KEY,
  useOptionalTeacherDataCache
} from "@/components/TeacherDataCache";

export function SignOutButton() {
  const router = useRouter();
  const teacherCache = useOptionalTeacherDataCache();
  const loadTeacherData = teacherCache?.load;
  const clearTeacherData = teacherCache?.clear;
  const [displayName, setDisplayName] = useState("");

  useEffect(() => {
    let ignore = false;

    async function loadDisplayName() {
      const loader = async () => {
        const supabase = createBrowserSupabase();
        const {
          data: { user }
        } = await supabase.auth.getUser();

        return user
          ? getPreferredUserDisplayName({
              email: user.email,
              metadata: user.user_metadata
            })
          : "";
      };
      const name = loadTeacherData
        ? await loadTeacherData(TEACHER_CURRENT_USER_CACHE_KEY, loader)
        : await loader();

      if (!ignore && name) setDisplayName(name);
    }

    loadDisplayName();
    return () => {
      ignore = true;
    };
  }, [loadTeacherData]);

  async function signOut() {
    const supabase = createBrowserSupabase();
    await supabase.auth.signOut();
    clearTeacherData?.();
    router.push("/");
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {displayName ? (
        <span className="text-sm font-semibold text-ink/70">{displayName}</span>
      ) : null}
      <button
        className="rounded-md border border-line bg-white px-3 py-2 text-sm font-semibold hover:border-ocean"
        onClick={signOut}
        type="button"
      >
        Sign out
      </button>
    </div>
  );
}
