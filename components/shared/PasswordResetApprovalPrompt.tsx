"use client";

import { useState } from "react";
import { Check, X } from "lucide-react";
import { createBrowserSupabase } from "@/lib/supabase/client";

/**
 * Inline 是/否 approval prompt for a pending forgot-password request. The
 * button styling intentionally matches the inline student-name editor's
 * 确定/取消 controls (same size, radius, font, spacing, and visual language).
 *
 * The caller supplies the permission-checked resolve endpoint; the server
 * re-verifies the acting account (bound teacher / Admin) on every call.
 */
export function PasswordResetApprovalPrompt({
  endpoint,
  prompt,
  onResolved
}: {
  endpoint: string;
  prompt: string;
  onResolved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function resolve(decision: "approve" | "reject") {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const supabase = createBrowserSupabase();
      const {
        data: { session }
      } = await supabase.auth.getSession();
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token ?? ""}`
        },
        body: JSON.stringify({ decision }),
        cache: "no-store"
      });
      const payload = (await response.json().catch(() => ({}))) as { message?: string };
      if (!response.ok) {
        throw new Error(payload.message ?? "操作失败，请稍后重试。");
      }
      onResolved();
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : "操作失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-student-text">{prompt}</span>
      <button
        className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-student-primary px-3 text-sm font-semibold text-white transition hover:bg-student-primary-hover disabled:opacity-50"
        disabled={busy}
        onClick={() => void resolve("approve")}
        type="button"
      >
        <Check aria-hidden="true" size={15} strokeWidth={2.2} />
        是
      </button>
      <button
        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-student-border bg-white px-3 text-sm font-semibold text-student-muted transition hover:border-student-primary hover:text-student-primary disabled:opacity-50"
        disabled={busy}
        onClick={() => void resolve("reject")}
        type="button"
      >
        <X aria-hidden="true" size={15} strokeWidth={2.2} />
        否
      </button>
      {error ? (
        <span className="text-xs font-semibold text-student-error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
