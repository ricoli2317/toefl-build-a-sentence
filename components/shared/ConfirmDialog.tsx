"use client";

import { useEffect, type ReactNode } from "react";

/**
 * Shared modal shell + yes/no confirm dialog. The project keeps its existing
 * purple card visual language: no new design system, just the same border,
 * radius, shadow, and button classes used elsewhere.
 */
export function ModalShell({
  open,
  onClose,
  dismissible = true,
  children
}: {
  open: boolean;
  onClose: () => void;
  dismissible?: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && dismissible) onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, dismissible, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center px-5 py-8">
      <button
        aria-label="关闭对话框"
        className="absolute inset-0 cursor-default bg-student-text/25"
        onClick={dismissible ? onClose : undefined}
        type="button"
      />
      <div
        aria-modal="true"
        className="relative w-full max-w-[420px] rounded-2xl border border-student-border bg-white p-6 shadow-[0_22px_70px_rgba(44,35,99,0.18)]"
        role="dialog"
      >
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = "是",
  cancelText = "否",
  confirming = false,
  error = "",
  onConfirm,
  onCancel
}: {
  open: boolean;
  title: ReactNode;
  message?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  confirming?: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ModalShell open={open} onClose={onCancel}>
      <p className="text-base font-bold text-student-text">{title}</p>
      {message ? <div className="mt-3 text-sm text-student-muted">{message}</div> : null}
      {error ? (
        <p className="mt-3 text-sm font-semibold text-student-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-6 flex justify-end gap-3">
        <button className="teacher-button-secondary" disabled={confirming} onClick={onCancel} type="button">
          {cancelText}
        </button>
        <button className="teacher-button-primary" disabled={confirming} onClick={onConfirm} type="button">
          {confirming ? "处理中…" : confirmText}
        </button>
      </div>
    </ModalShell>
  );
}
