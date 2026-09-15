export type PracticeReviewItem = {
  completed: boolean;
  key: string;
  label: string;
};

export function PracticeReview({
  currentIndex,
  items,
  onSelect
}: {
  currentIndex: number;
  items: PracticeReviewItem[];
  onSelect: (index: number) => void;
}) {
  return (
    <article className="student-card" data-testid="practice-review">
      <div>
        <p className="text-sm font-semibold text-student-primary">Review</p>
        <h2 className="mt-1 text-xl font-bold">Question status</h2>
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {items.map((item, index) => (
          <button
            aria-current={currentIndex === index ? "true" : undefined}
            className={`flex items-center justify-between gap-3 rounded-[10px] border px-4 py-3 text-left font-semibold transition hover:border-student-primary ${
              currentIndex === index ? "border-student-primary bg-student-primary-soft" : "border-student-border bg-student-bg"
            }`}
            data-completed={item.completed ? "true" : "false"}
            key={item.key}
            onClick={() => onSelect(index)}
            type="button"
          >
            <span>{item.label}</span>
            <span
              className={`rounded-full px-3 py-1 text-xs font-bold ${
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
