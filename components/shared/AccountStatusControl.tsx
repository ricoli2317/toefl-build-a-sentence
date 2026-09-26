"use client";

import { useState } from "react";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { createBrowserSupabase } from "@/lib/supabase/client";

/**
 * Shared Admin account status control used by both the student and teacher
 * account lists (one implementation, one API). The status text stays in the
 * existing purple text visual language and the two-step confirmation runs
 * through the shared dialog shell.
 */
export function AccountStatusControl({
  accountId,
  isActive,
  onChanged
}: {
  accountId: string;
  isActive: boolean;
  onChanged: (isActive: boolean) => void;
}) {
  const [stage, setStage] = useState<"idle" | "confirm1" | "confirm2">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nextValue = !isActive;

  function close() {
    if (busy) return;
    setStage("idle");
    setError("");
  }

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const supabase = createBrowserSupabase();
      const {
        data: { session }
      } = await supabase.auth.getSession();
      const response = await fetch(
        `/api/admin/accounts/${encodeURIComponent(accountId)}/status`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session?.access_token ?? ""}`
          },
          body: JSON.stringify({ isActive: nextValue }),
          cache: "no-store"
        }
      );
      const payload = (await response.json().catch(() => ({}))) as { message?: string };
      if (!response.ok) {
        throw new Error(payload.message ?? "账号状态更新失败，请稍后重试。");
      }
      onChanged(nextValue);
      setStage("idle");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "账号状态更新失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        className={
          isActive
            ? "font-semibold text-student-primary hover:underline"
            : "font-semibold text-student-muted hover:text-student-primary hover:underline"
        }
        onClick={() => {
          setError("");
          setStage("confirm1");
        }}
        type="button"
      >
        {isActive ? "启用" : "停用"}
      </button>
      <ConfirmDialog
        open={stage === "confirm1"}
        title={isActive ? "是否停用账号？" : "是否启用账号？"}
        onCancel={close}
        onConfirm={() => setStage("confirm2")}
      />
      <ConfirmDialog
        open={stage === "confirm2"}
        title={isActive ? "确定停用账号吗？" : "确定启用账号吗？"}
        confirming={busy}
        error={error}
        onCancel={close}
        onConfirm={() => void submit()}
      />
    </>
  );
}
