import type { ReadingCorrectionAnswerDisplay } from "@/lib/reading/correctionResult";

export function ReadingCorrectionAnswerValue({
  answer
}: {
  answer: ReadingCorrectionAnswerDisplay;
}) {
  if (answer.kind === "text") return answer.text;
  return answer.parts.map((part, index) => (
    <span
      className={part.emphasized ? "font-semibold text-student-primary" : undefined}
      data-ctw-correct-fill={part.emphasized ? "true" : undefined}
      key={`${index}:${part.text}`}
    >
      {part.text}
    </span>
  ));
}
