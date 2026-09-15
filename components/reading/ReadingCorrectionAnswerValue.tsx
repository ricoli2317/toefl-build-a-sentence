import type { ReadingCorrectionAnswerDisplay } from "@/lib/reading/correctionResult";

export function ReadingCorrectionAnswerValue({
  answer,
  emphasizeCtwFill = true
}: {
  answer: ReadingCorrectionAnswerDisplay;
  emphasizeCtwFill?: boolean;
}) {
  if (answer.kind === "text") return answer.text;
  return answer.parts.map((part, index) => (
    <span
      className={part.emphasized && emphasizeCtwFill ? "font-semibold text-student-primary" : undefined}
      data-ctw-correct-fill={part.emphasized && emphasizeCtwFill ? "true" : undefined}
      key={`${index}:${part.text}`}
    >
      {part.text}
    </span>
  ));
}
