import Link from "next/link";
import type { ReactNode } from "react";
import { assignmentItemTypeLabel, type AssignmentItemType } from "@/lib/assignmentCatalog";
import {
  assignmentGroupProgress,
  assignmentGroupProgressText,
  type AssignmentGroupProgress,
  type WritingAssignmentLifecycleStatus
} from "@/lib/writingAssignments";

/**
 * The one shared Assignment presentation layer for the teacher and the student
 * UI (list cards, group cards and detail headers). It owns layout only:
 * card outer layout, title, badge row, group status badge, `X / Y 已完成`,
 * meta rows, spacing, border, radius and the action area alignment.
 *
 * Role-specific actions and role-specific detail (教师批改 / 学生开始练习…)
 * are always passed in by the caller; no teacher business logic lives here and
 * the student side never renders a teacher-only control.
 */

export const ASSIGNMENT_CARD_CLASS =
  "rounded-2xl border border-student-border bg-white shadow-[0_1px_2px_rgba(23,32,51,0.035)]";

/** 未完成 / 进行中 / 已完成 (已撤回 stays a lifecycle badge of the same shape). */
export function AssignmentStatusBadge({
  className = "",
  completedCount,
  lifecycleStatus,
  totalCount
}: {
  className?: string;
  completedCount: number;
  lifecycleStatus?: WritingAssignmentLifecycleStatus;
  totalCount: number;
}) {
  const progress = assignmentGroupProgress({ completedCount, lifecycleStatus, totalCount });
  return (
    <span
      className={`rounded-full px-3 py-1 text-xs font-bold ${progress.badgeClass} ${className}`.trim()}
      data-assignment-group-status={progress.badge}
    >
      {progress.label}
    </span>
  );
}

/** The one shared progress text: `X / Y 已完成`. */
export function AssignmentProgressText({
  className = "",
  completedCount,
  totalCount
}: {
  className?: string;
  completedCount: number;
  totalCount: number;
}) {
  return (
    <span className={className}>
      {assignmentGroupProgressText(completedCount, totalCount)}
    </span>
  );
}

/** One metadata cell of a card / detail header (icon + text). */
export function AssignmentMetaItem({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center gap-2">{children}</span>;
}

/**
 * One shared Assignment summary card: leading icon (optional), badge row,
 * title (optionally linking to the detail), metadata row and the action area.
 * The teacher card, the student list card, the student group card and the
 * student detail item cards all render through this shell.
 */
export function AssignmentSummaryCard({
  actions,
  badges,
  children,
  className = "",
  leading,
  meta,
  title,
  titleHref
}: {
  actions?: ReactNode;
  badges?: ReactNode;
  children?: ReactNode;
  className?: string;
  leading?: ReactNode;
  meta?: ReactNode;
  title: ReactNode;
  titleHref?: string;
}) {
  return (
    <article
      className={`${ASSIGNMENT_CARD_CLASS} flex flex-wrap items-center gap-5 p-4 sm:p-5 ${className}`.trim()}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3.5">
        {leading}
        <div className="min-w-0 flex-1">
          {badges ? <div className="flex flex-wrap items-center gap-2">{badges}</div> : null}
          <h2 className="mt-3 truncate text-lg font-bold text-student-text">
            {titleHref ? (
              <Link className="group block" href={titleHref}>
                {title}
              </Link>
            ) : title}
          </h2>
          {meta ? (
            <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-student-muted">
              {meta}
            </div>
          ) : null}
          {children}
        </div>
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>
      ) : null}
    </article>
  );
}

/**
 * The one shared Assignment Detail header (teacher detail body and student
 * group detail): badge row with the group status, the Assignment title, the
 * `X / Y 已完成` progress plus the date metadata, and the role action area.
 */
export function AssignmentDetailHeaderCard({
  actions,
  badges,
  className = "",
  meta,
  title
}: {
  actions?: ReactNode;
  badges?: ReactNode;
  className?: string;
  meta?: ReactNode;
  title: ReactNode;
}) {
  return (
    <section
      className={`${ASSIGNMENT_CARD_CLASS} p-4 sm:p-5 ${className}`.trim()}
      data-assignment-detail-header
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          {badges ? <div className="flex flex-wrap items-center gap-2">{badges}</div> : null}
          <h2 className="mt-3 text-xl font-bold text-student-text">{title}</h2>
          {meta ? (
            <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-student-muted">
              {meta}
            </div>
          ) : null}
        </div>
        {actions ? (
          <div className="flex flex-wrap justify-end gap-2">{actions}</div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * One shared item heading shell (`第 N 篇 · 题型` + the item title). The
 * teacher's student-completion table and the student's detail item cards both
 * read their item identity through it; the visible row number is display-only.
 */
export function AssignmentItemHeading({
  index,
  itemType,
  title
}: {
  index?: number;
  itemType: AssignmentItemType;
  title: string;
}) {
  return (
    <>
      <span className="block text-xs font-bold text-student-primary">
        {typeof index === "number" ? `第 ${index + 1} 篇 · ` : ""}
        {assignmentItemTypeLabel(itemType)}
      </span>
      <span className="mt-1 block font-semibold text-student-text">{title}</span>
    </>
  );
}
