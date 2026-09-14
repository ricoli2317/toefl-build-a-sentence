import type { ReadingInlineDiff } from "@/lib/reading/reviewDiff";

export function ReadingInlineVersionValue({ title, segments }: {
  title: "题库版本" | "来源 CSV";
  segments: ReadingInlineDiff["existing"];
}) {
  return (
    <div>
      <div className="text-xs font-bold text-student-muted">【{title}】</div>
      <div className="mt-1 whitespace-pre-wrap break-words font-mono text-sm text-student-text">
        {segments.map((segment, index) => segment.changed ? (
          <mark
            className={segment.text
              ? "rounded bg-amber-300 px-0.5 text-inherit"
              : "inline-block min-w-px bg-amber-300 text-inherit"}
            key={index}
          >
            {segment.text}
          </mark>
        ) : <span key={index}>{segment.text}</span>)}
      </div>
    </div>
  );
}
