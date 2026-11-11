"use client";

import { useEffect, useRef, type ReactNode } from "react";
import clsx from "clsx";
import { createPortal } from "react-dom";

// A portaled child (notification image preview) must own Escape/Tab while it is
// open. Closing it must not also dismiss the notification underneath it.
const modalStack: symbol[] = [];

/**
 * Shared modal shell + yes/no confirm dialog. The project keeps its existing
 * purple card visual language: no new design system, just the same border,
 * radius, shadow, and button classes used elsewhere.
 *
 * The dialog is portaled to document.body. Some shells (for example the
 * Student header, which uses backdrop-filter) become the containing block for
 * fixed-position descendants, which would otherwise anchor the "fixed" overlay
 * to a 72px header instead of the viewport and clip the dialog's top.
 * The panel is also capped to the viewport height and scrolls internally so
 * top content and the action buttons stay reachable on short viewports.
 */
export function ModalShell({
  open,
  onClose,
  dismissible = true,
  size = "default",
  children,
  label,
  containFocus = false
}: {
  open: boolean;
  onClose: () => void;
  dismissible?: boolean;
  /** "wide" keeps the same panel styling for forms that need two columns. */
  size?: "default" | "wide" | "notification" | "image";
  children: ReactNode;
  label?: string;
  /** Opt-in for callers replacing a native modal dialog. */
  containFocus?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const layer = useRef(Symbol("modal"));
  useEffect(() => {
    if (!open) return;
    const id = layer.current;
    modalStack.push(id);
    return () => { const index = modalStack.indexOf(id); if (index >= 0) modalStack.splice(index, 1); };
  }, [open]);
  useEffect(() => {
    if (!open || !containFocus) return;
    const panel = panelRef.current;
    const previous = document.activeElement;
    const focusable = () => Array.from(panel?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]'
    ) ?? []).filter((element) => element.getClientRects().length > 0);
    focusable()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.defaultPrevented || modalStack[modalStack.length - 1] !== layer.current) return;
      const controls = focusable();
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); panel?.focus(); return; }
      if (!panel?.contains(document.activeElement) || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault(); first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      }
    };
    document.addEventListener("keydown", trap, true);
    return () => {
      document.removeEventListener("keydown", trap, true);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [open, containFocus]);
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented && dismissible && modalStack[modalStack.length - 1] === layer.current) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, dismissible, onClose]);

  if (!open) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] overflow-y-auto overscroll-contain">
      <button
        aria-label="关闭对话框"
        className="fixed inset-0 cursor-default bg-student-text/25"
        onClick={dismissible ? onClose : undefined}
        type="button"
      />
      <div className="relative flex min-h-full items-center justify-center px-5 py-6">
        <div
          aria-modal="true"
          aria-label={label}
          className={clsx(
            "relative rounded-2xl border border-student-border bg-white shadow-[0_22px_70px_rgba(44,35,99,0.18)]",
            size === "notification" || size === "image"
              ? `flex max-h-[90dvh] min-w-0 max-w-none flex-col overflow-hidden ${size === "image" ? "w-[96vw]" : "w-[80vw]"}`
              : `max-h-[calc(100dvh-3rem)] w-full overflow-y-auto p-6 ${size === "wide" ? "max-w-[560px]" : "max-w-[420px]"}`
          )}
          role="dialog"
          ref={panelRef}
          tabIndex={containFocus ? -1 : undefined}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body
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
