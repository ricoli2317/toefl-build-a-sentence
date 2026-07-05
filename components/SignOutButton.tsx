"use client";

import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/client";

export function SignOutButton() {
  const router = useRouter();

  async function signOut() {
    const supabase = createBrowserSupabase();
    await supabase.auth.signOut();
    router.push("/");
  }

  return (
    <button
      className="rounded-md border border-line bg-white px-3 py-2 text-sm font-semibold hover:border-ocean"
      onClick={signOut}
      type="button"
    >
      Sign out
    </button>
  );
}
