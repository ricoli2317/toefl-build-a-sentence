import type { WritingOvertimeRange } from "@/lib/writing";
import { splitWritingTextByOvertime } from "@/lib/writingOvertime";

export const WRITING_OVERTIME_TEXT_CLASS = "text-[#8f1025]";

export function WritingOvertimeText({
  ranges,
  sourceStart = 0,
  text
}: {
  ranges: WritingOvertimeRange[] | null | undefined;
  sourceStart?: number;
  text: string;
}) {
  return splitWritingTextByOvertime(text, ranges, sourceStart).map((segment) => (
    <span
      className={segment.overtime ? WRITING_OVERTIME_TEXT_CLASS : undefined}
      data-overtime={segment.overtime ? "true" : undefined}
      key={`${segment.start}-${segment.end}`}
    >
      {segment.text}
    </span>
  ));
}
