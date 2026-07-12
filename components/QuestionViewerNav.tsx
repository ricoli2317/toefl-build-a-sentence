"use client";

export function QuestionViewerNav({
  currentIndex,
  onChange,
  questionCount
}: {
  currentIndex: number;
  onChange: (index: number) => void;
  questionCount: number;
}) {
  return (
    <div className="mt-6 grid gap-4">
      <div className="flex flex-wrap justify-center gap-2">
        {Array.from({ length: questionCount }, (_, index) => (
          <button
            className={`rounded-md border px-3 py-2 text-sm font-bold ${
              currentIndex === index
                ? "border-ocean bg-ocean/10 text-ocean"
                : "border-line bg-white hover:border-ocean"
            }`}
            key={index}
            onClick={() => onChange(index)}
            type="button"
          >
            Q{index + 1}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap justify-end gap-3">
        <button
          className="rounded-md bg-ink px-5 py-3 font-semibold text-white hover:bg-ocean disabled:cursor-not-allowed disabled:opacity-50"
          disabled={currentIndex === 0}
          onClick={() => onChange(currentIndex - 1)}
          type="button"
        >
          Previous
        </button>
        <button
          className="rounded-md bg-ink px-5 py-3 font-semibold text-white hover:bg-ocean disabled:cursor-not-allowed disabled:opacity-50"
          disabled={currentIndex === questionCount - 1}
          onClick={() => onChange(currentIndex + 1)}
          type="button"
        >
          Next
        </button>
      </div>
    </div>
  );
}
