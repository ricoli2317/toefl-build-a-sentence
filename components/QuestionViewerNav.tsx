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
            className={`rounded-[10px] border px-3 py-2 text-sm font-bold transition ${
              currentIndex === index
                ? "border-student-primary bg-student-primary-soft text-student-primary"
                : "border-student-border bg-white text-student-text hover:border-student-primary"
            }`}
            key={index}
            onClick={() => onChange(index)}
            type="button"
          >
            第 {index + 1} 题
          </button>
        ))}
      </div>
      <div className="flex flex-wrap justify-end gap-3">
        <button
          className="teacher-button-secondary min-h-11 px-5 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={currentIndex === 0}
          onClick={() => onChange(currentIndex - 1)}
          type="button"
        >
          上一题
        </button>
        <button
          className="teacher-button-primary min-h-11 px-5 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={currentIndex === questionCount - 1}
          onClick={() => onChange(currentIndex + 1)}
          type="button"
        >
          下一题
        </button>
      </div>
    </div>
  );
}
