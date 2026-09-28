"use client";

import { useState } from "react";
import { assignmentPreviewVisibility } from "@/lib/assignmentCatalog";

/**
 * The one shared Assignment preview list (Writing and Reading). More than five
 * selected items collapse to the first five with a 查看剩余 N 题 toggle and a
 * 收起 control; the fold is pure display state and never touches the selection
 * or the submitted payload.
 */
export function TeacherAssignmentSelectionPreview({
  items
}: {
  items: ReadonlyArray<{ key: string; label: string }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const { expandable, remaining, visible } = assignmentPreviewVisibility(items, expanded);
  return (
    <div className="grid gap-3">
      <ol className="grid gap-2">
        {visible.map((item, index) => (
          <li className="flex gap-3 text-sm text-student-text" key={item.key}>
            <span className="w-6 shrink-0 text-right font-semibold text-student-muted">{index + 1}.</span>
            <span className="min-w-0 font-semibold">{item.label}</span>
          </li>
        ))}
      </ol>
      {expandable && !expanded ? (
        <button
          className="justify-self-start text-sm font-semibold text-student-primary underline-offset-4 hover:text-student-primary-hover hover:underline"
          onClick={() => setExpanded(true)}
          type="button"
        >
          查看剩余 {remaining} 题
        </button>
      ) : null}
      {expandable && expanded ? (
        <button
          className="justify-self-start text-sm font-semibold text-student-primary underline-offset-4 hover:text-student-primary-hover hover:underline"
          onClick={() => setExpanded(false)}
          type="button"
        >
          收起
        </button>
      ) : null}
    </div>
  );
}
