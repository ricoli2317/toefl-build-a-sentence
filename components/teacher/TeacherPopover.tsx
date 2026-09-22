"use client";

import clsx from "clsx";
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Minimal in-place popover for teacher list controls. It never navigates and
 * closes on outside click or Escape so it stays usable inside dense cards.
 */
export function TeacherPopover({
  buttonClassName,
  buttonContent,
  children,
  menuAlign = "right",
  menuClassName
}: {
  buttonClassName: string;
  buttonContent: ReactNode;
  children: (close: () => void) => ReactNode;
  menuAlign?: "left" | "right";
  menuClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        aria-expanded={open}
        className={buttonClassName}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {buttonContent}
      </button>
      {open ? (
        <div
          className={clsx(
            "absolute top-full z-40 mt-2 min-w-[12rem] rounded-xl border border-student-border bg-white p-1.5 shadow-[0_12px_32px_rgba(23,32,51,0.14)]",
            menuAlign === "left" ? "left-0" : "right-0",
            menuClassName
          )}
          role="menu"
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

export function TeacherPopoverMenuItem({
  children,
  onClick
}: {
  children: ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-student-text transition hover:bg-student-primary-soft"
      onClick={onClick}
      role="menuitem"
      type="button"
    >
      {children}
    </button>
  );
}
