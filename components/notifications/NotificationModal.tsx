"use client";

import { useEffect, type FormEventHandler, type ReactNode } from "react";
import { ModalShell } from "@/components/shared/ConfirmDialog";

let scrollLocks = 0;
let restorePageScroll: (() => void) | undefined;
function lockPageScroll() {
  if (scrollLocks++ === 0) {
    const body = document.body, html = document.documentElement;
    const original = { position: body.style.position, top: body.style.top, left: body.style.left, width: body.style.width,
      overflow: body.style.overflow, htmlOverflow: html.style.overflow, behavior: html.style.scrollBehavior };
    const x = window.scrollX, y = window.scrollY;
    // Only while a notification is open. Prevent background scrolling (and
    // narrow-screen shell overflow) without changing any navigation styling.
    body.style.position = "fixed"; body.style.top = `${-y}px`; body.style.left = `${-x}px`;
    body.style.width = "100%"; body.style.overflow = "hidden"; html.style.overflow = "hidden";
    restorePageScroll = () => {
      body.style.position = original.position; body.style.top = original.top; body.style.left = original.left;
      body.style.width = original.width; body.style.overflow = original.overflow; html.style.overflow = original.htmlOverflow;
      html.style.scrollBehavior = "auto"; window.scrollTo(x, y); html.style.scrollBehavior = original.behavior;
    };
  }
  return () => { if (--scrollLocks === 0) { restorePageScroll?.(); restorePageScroll = undefined; } };
}

/** One geometry/scroll contract for recipient list/detail and Admin forms. */
export function NotificationModal({ open, onClose, title, label = "通知中心", dismissible = true, children, footer, onSubmit, image = false }: {
  open: boolean; onClose: () => void; title: ReactNode; label?: string; dismissible?: boolean;
  children: ReactNode; footer?: ReactNode; onSubmit?: FormEventHandler<HTMLFormElement>; image?: boolean;
}) {
  useEffect(() => { if (open) return lockPageScroll(); }, [open]);
  const content = <>
    <header className="shrink-0 border-b border-student-border px-4 py-4 sm:px-6">
      <h2 className="break-words text-xl font-bold text-student-text">{title}</h2>
    </header>
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 [overflow-wrap:anywhere] sm:px-6" data-notification-scroll>
      {children}
    </div>
    {footer ? <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-student-border px-4 py-3 sm:px-6">{footer}</footer> : null}
  </>;
  const className = "flex max-h-[calc(90dvh-2px)] min-h-0 min-w-0 flex-col overflow-hidden";
  return <ModalShell open={open} onClose={onClose} label={label} size={image ? "image" : "notification"} containFocus dismissible={dismissible}>
    {onSubmit ? <form className={className} onSubmit={onSubmit}>{content}</form> : <div className={className}>{content}</div>}
  </ModalShell>;
}
