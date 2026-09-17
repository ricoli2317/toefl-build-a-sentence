import Link from "next/link";

export type ReadingAnswerStateName = "correct" | "incorrect" | "unanswered";

type ReadingStatusAnswer = {
  answerId: string;
  isAnswered: boolean;
  isCorrect: boolean;
  order: number;
  reviewIndex?: number;
};

export function readingAnswerState(answer: Pick<ReadingStatusAnswer, "isAnswered" | "isCorrect">): ReadingAnswerStateName {
  return !answer.isAnswered ? "unanswered" : answer.isCorrect ? "correct" : "incorrect";
}

export function readingAnswerStateToneClassName(state: ReadingAnswerStateName) {
  return state === "correct"
    ? "border-student-primary-border bg-student-primary-soft text-student-primary"
    : state === "incorrect"
      ? "border-student-error-border bg-student-error-soft text-student-error"
      : "border-student-border bg-student-bg text-student-muted";
}

export function ReadingQuestionStatusChips({
  answers,
  questionHrefBase,
  questionHref
}: {
  answers: ReadingStatusAnswer[];
  questionHrefBase: string;
  questionHref?: (reviewIndex: number) => string;
}) {
  return (
    <div className="mt-6 flex flex-wrap justify-center gap-3" data-testid="reading-result-question-chips">
      {answers.map((answer, answerIndex) => {
        const state = readingAnswerState(answer);
        const reviewIndex = answer.reviewIndex ?? answerIndex;
        return (
          <Link
            aria-label={`第${answer.order}题，${state === "correct" ? "正确" : state === "incorrect" ? "错误" : "未作答"}`}
            className={`inline-flex h-10 w-10 items-center justify-center rounded-full border text-sm font-semibold tabular-nums ${readingAnswerStateToneClassName(state)}`}
            data-answer-state={state}
            href={questionHref
              ? questionHref(reviewIndex)
              : `${questionHrefBase}/questions/${reviewIndex}`}
            key={answer.answerId}
          >
            {answer.order}
          </Link>
        );
      })}
    </div>
  );
}
