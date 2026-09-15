import Link from "next/link";
import {
  readingFullSetReviewItemLabel,
  type ReadingFullSetReviewItem
} from "@/lib/reading/fullSetReview";
import {
  readingAnswerState,
  readingAnswerStateToneClassName
} from "./ReadingQuestionStatusChips";
import { ReadingReviewStatusLine } from "./ReadingReviewStatusLine";

export function ReadingFullSetQuestionNavigator({
  currentIndex,
  items,
  onSelect,
  showCurrentStatus = false
}: {
  currentIndex?: number;
  items: ReadingFullSetReviewItem[];
  onSelect?: (index: number) => void;
  showCurrentStatus?: boolean;
}) {
  const current = currentIndex === undefined ? undefined : items[currentIndex];

  return (
    <section className="rounded-2xl border border-student-border bg-white px-4 py-3 shadow-sm" data-testid="reading-full-set-review-status">
      {showCurrentStatus && current ? (
        <ReadingReviewStatusLine
          className="mb-3"
          isAnswered={current.isAnswered}
          isCorrect={current.isCorrect}
          order={readingFullSetReviewItemLabel(current)}
          questionTimeSeconds={current.questionTimeSeconds}
        />
      ) : null}
      <div className="grid gap-2" aria-label="完整阅读套题作答题号导航">
        {([1, 2] as const).map((moduleNumber) => (
          <div className="flex min-w-0 items-start gap-3" data-module-number={moduleNumber} key={moduleNumber}>
            <p className="w-20 shrink-0 pt-1.5 text-xs font-bold text-student-text">Module {moduleNumber}</p>
            <div className="flex min-w-0 flex-wrap gap-1.5">
              {items.map((item, index) => {
                if (item.moduleNumber !== moduleNumber) return null;
                const state = readingAnswerState(item);
                const className = `min-h-8 min-w-8 rounded-full border px-2 text-xs font-bold tabular-nums ${
                  index === currentIndex
                    ? "border-amber-500 bg-amber-100 text-student-text ring-2 ring-amber-200"
                    : readingAnswerStateToneClassName(state)
                }`;
                const label = readingFullSetReviewItemLabel(item);
                return onSelect ? (
                  <button
                    aria-current={index === currentIndex ? "true" : undefined}
                    aria-label={`Module ${moduleNumber} 第${label}题`}
                    className={className}
                    data-answer-state={state}
                    data-review-item-key={item.key}
                    key={item.key}
                    onClick={() => onSelect(index)}
                    type="button"
                  >
                    {label}
                  </button>
                ) : item.href ? (
                  <Link
                    aria-label={`Module ${moduleNumber} 第${label}题`}
                    className={`inline-flex items-center justify-center ${className}`}
                    data-answer-state={state}
                    data-review-item-key={item.key}
                    href={item.href}
                    key={item.key}
                  >
                    {label}
                  </Link>
                ) : null;
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
