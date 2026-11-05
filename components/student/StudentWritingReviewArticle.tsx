"use client";

import { forwardRef, type ReactNode } from "react";
import clsx from "clsx";

/** The published Writing article shell; content/rendering stays with its caller. */
export function StudentWritingReviewArticleCard({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={clsx("flex min-w-0 flex-col overflow-hidden rounded-xl border border-student-border bg-white shadow-[0_2px_12px_rgba(60,47,119,0.05)]", className)}>{children}</section>;
}

export function StudentWritingReviewArticleHeader({ title, caption, actions, singleRow = false, reserveCaption = false }: {
  title: ReactNode; caption?: ReactNode; actions?: ReactNode; singleRow?: boolean; reserveCaption?: boolean;
}) {
  return <div data-student-review-article-header className={clsx("flex shrink-0 items-center justify-between gap-x-4 gap-y-1 border-b border-student-border px-4 py-2.5", singleRow ? "flex-nowrap" : "flex-wrap")}>
    <div className={reserveCaption ? "flex min-h-[42.5px] items-center" : undefined}>
      <h2 className="font-bold text-student-text">{title}</h2>
      {caption ? <p className="mt-0.5 text-[11px] text-student-muted">{caption}</p> : null}
    </div>
    {actions}
  </div>;
}

export const StudentWritingReviewArticleBody = forwardRef<HTMLElement, { children: ReactNode }>(function StudentWritingReviewArticleBody({ children }, ref) {
  return <article data-student-review-article-body ref={ref} className="min-h-[360px] flex-1 overflow-y-auto px-5 py-3.5 text-[15px] leading-7 text-student-text lg:min-h-0 sm:text-base">{children}</article>;
});
