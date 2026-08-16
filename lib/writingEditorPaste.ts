import type { WritingOvertimeRange, WritingTaskType } from "./writing.ts";
import { updateWritingOvertimeRanges } from "./writingOvertime.ts";

export const WRITING_EXTERNAL_PASTE_ACCOUNT = "student@test.com";

export function canUseExternalWritingPaste(
  email: string | null | undefined,
  taskType: WritingTaskType
) {
  return (
    (taskType === "email" || taskType === "academic_discussion") &&
    email?.trim().toLocaleLowerCase() === WRITING_EXTERNAL_PASTE_ACCOUNT
  );
}

export function applyExternalWritingPaste(input: {
  currentText: string;
  end: number;
  overtime: boolean;
  pastedText: string;
  previousRanges: WritingOvertimeRange[];
  start: number;
}) {
  const nextText =
    input.currentText.slice(0, input.start) +
    input.pastedText +
    input.currentText.slice(input.end);
  const cursor = input.start + input.pastedText.length;
  return {
    overtimeRanges: updateWritingOvertimeRanges({
      nextText,
      overtime: input.overtime,
      previousRanges: input.previousRanges,
      previousText: input.currentText
    }),
    selectionEnd: cursor,
    selectionStart: cursor,
    text: nextText
  };
}
