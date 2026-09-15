export type PracticeReviewItem = {
  completed: boolean;
  key: string;
  label: string;
  questionNumber?: number;
};

export function PracticeReview({
  currentIndex,
  items,
  layout = "default",
  onSelect
}: {
  currentIndex: number;
  items: PracticeReviewItem[];
  layout?: "default" | "compact";
  onSelect: (index: number) => void;
}) {
  const compact = layout === "compact";

  return (
    <article className="student-card" data-testid="practice-review">
      <div>
        <p className="text-sm font-semibold text-student-primary">Review</p>
        {compact ? null : <h2 className="mt-1 text-xl font-bold">Question status</h2>}
      </div>
      <div
        className={compact
          ? "mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 min-[1100px]:grid-cols-5"
          : "mt-5 grid gap-3 sm:grid-cols-2"}
      >
        {items.map((item, index) => (
          <button
            aria-current={currentIndex === index ? "true" : undefined}
            className={`${compact
              ? "flex min-h-[52px] items-center justify-between gap-2 rounded-[10px] border px-3 py-2 text-left font-semibold transition hover:border-student-primary"
              : "flex items-center justify-between gap-3 rounded-[10px] border px-4 py-3 text-left font-semibold transition hover:border-student-primary"} ${
              currentIndex === index ? "border-student-primary bg-student-primary-soft" : "border-student-border bg-student-bg"
            }`}
            data-completed={item.completed ? "true" : "false"}
            key={item.key}
            onClick={() => onSelect(index)}
            type="button"
          >
            <span className={compact ? "inline-flex items-center tabular-nums leading-none" : undefined}>
              {compact && item.questionNumber !== undefined ? item.questionNumber : item.label}
            </span>
            <span
              className={`${compact
                ? "inline-flex min-h-6 items-center justify-center rounded-full px-2.5 py-1 text-xs font-bold leading-none"
                : "rounded-full px-3 py-1 text-xs font-bold"} ${
                item.completed ? "bg-student-primary-soft text-student-primary" : "bg-student-error-soft text-student-error"
              }`}
            >
              {item.completed ? "Completed" : "Incomplete"}
            </span>
          </button>
        ))}
      </div>
    </article>
  );
}
