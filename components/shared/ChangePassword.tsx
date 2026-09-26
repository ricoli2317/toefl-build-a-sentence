"use client";

import { useState, type FormEvent } from "react";
import { ModalShell } from "@/components/shared/ConfirmDialog";
import {
  describePasswordChangeError,
  validatePasswordChangeInput
} from "@/lib/accountCredentials";
import { createBrowserSupabase } from "@/lib/supabase/client";

/**
 * Header entry for Student / Teacher self-service password change.
 *
 * Security shape:
 * - The account is always the current authenticated Supabase session user;
 *   no user id is read from the URL, form, or any client input.
 * - The current password is verified by Supabase Auth itself
 *   (signInWithPassword) before updateUser is allowed to set the new one.
 * - The browser only ever uses the anon client; the service-role key stays
 *   server-side.
 */
export function ChangePasswordLink({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className={className ?? "text-sm font-medium text-student-primary hover:underline"}
        onClick={() => setOpen(true)}
        type="button"
      >
        修改密码
      </button>
      {open ? <ChangePasswordDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [succeeded, setSucceeded] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const validation = validatePasswordChangeInput({
      currentPassword,
      newPassword,
      confirmPassword
    });
    if (!validation.ok) {
      setError(validation.message);
      return;
    }

    setBusy(true);
    setError("");
    try {
      const supabase = createBrowserSupabase();
      const {
        data: { session }
      } = await supabase.auth.getSession();
      const email = session?.user?.email ?? null;
      if (!session || !email) {
        setError("登录状态已失效，请重新登录。");
        return;
      }

      const { error: verifyError } = await supabase.auth.signInWithPassword({
        email,
        password: validation.currentPassword
      });
      if (verifyError) {
        setError(describePasswordChangeError(verifyError.message));
        return;
      }

      const { error: updateError } = await supabase.auth.updateUser({
        password: validation.newPassword
      });
      if (updateError) {
        setError(describePasswordChangeError(updateError.message));
        return;
      }

      setSucceeded(true);
    } catch {
      setError("密码修改失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell open onClose={onClose}>
      {succeeded ? (
        <div>
          <p className="text-base font-bold text-student-text">密码修改成功</p>
          <p className="mt-3 text-sm text-student-muted">新密码已生效，无需重新登录。</p>
          <div className="mt-6 flex justify-end">
            <button className="teacher-button-primary" onClick={onClose} type="button">
              确定
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit}>
          <p className="text-base font-bold text-student-text">修改密码</p>
          <div className="mt-5 grid gap-4">
            <label className="grid gap-2 text-sm font-semibold text-student-text">
              当前密码
              <input
                autoComplete="current-password"
                autoFocus
                className="h-11 rounded-xl border border-student-border px-4 font-normal"
                disabled={busy}
                onChange={(event) => setCurrentPassword(event.target.value)}
                type="password"
                value={currentPassword}
              />
            </label>
            <label className="grid gap-2 text-sm font-semibold text-student-text">
              新密码
              <input
                autoComplete="new-password"
                className="h-11 rounded-xl border border-student-border px-4 font-normal"
                disabled={busy}
                minLength={6}
                onChange={(event) => setNewPassword(event.target.value)}
                type="password"
                value={newPassword}
              />
            </label>
            <label className="grid gap-2 text-sm font-semibold text-student-text">
              确认新密码
              <input
                autoComplete="new-password"
                className="h-11 rounded-xl border border-student-border px-4 font-normal"
                disabled={busy}
                minLength={6}
                onChange={(event) => setConfirmPassword(event.target.value)}
                type="password"
                value={confirmPassword}
              />
            </label>
          </div>
          {error ? (
            <p className="mt-4 text-sm font-semibold text-student-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="mt-6 flex justify-end gap-3">
            <button className="teacher-button-secondary" disabled={busy} onClick={onClose} type="button">
              取消
            </button>
            <button className="teacher-button-primary" disabled={busy} type="submit">
              {busy ? "处理中…" : "确认修改"}
            </button>
          </div>
        </form>
      )}
    </ModalShell>
  );
}
