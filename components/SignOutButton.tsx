"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { getPreferredUserDisplayName } from "@/lib/userDisplayName";

export function SignOutButton() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");

  useEffect(() => {
    async function loadDisplayName() {
      const supabase = createBrowserSupabase();
      const {
        data: { user }
      } = await supabase.auth.getUser();

      if (user) {
        setDisplayName(
          getPreferredUserDisplayName({
            email: user.email,
            metadata: user.user_metadata
          })
        );
      }
    }

    loadDisplayName();
  }, []);

  async function signOut() {
    const supabase = createBrowserSupabase();
    await supabase.auth.signOut();
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
