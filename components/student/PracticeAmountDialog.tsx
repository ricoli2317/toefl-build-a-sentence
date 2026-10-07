"use client";
import { X } from "lucide-react";
import { WRONG_QUESTION_HISTORY_AMOUNTS, type WrongQuestionAmountOption, type WrongQuestionHistoryAmount } from "@/lib/wrongQuestionBank";

/** Shared history/category amount chooser. Rule calculation stays in one helper. */
export function PracticeAmountDialog({ subtitle, count, options, loading, error, errorText, loadingText, emptyText, onClose, onStart, tone = "error" }: {
  subtitle: string; count: number | null; options: WrongQuestionAmountOption[];
  loading?: boolean; error?: string | null; errorText?: string; loadingText?: string; emptyText?: string;
  onClose: () => void; onStart: (amount: WrongQuestionHistoryAmount) => void; tone?: "primary" | "error";
}) {
  return <div aria-labelledby="practice-amount-title" aria-modal="true"
    className="fixed inset-0 z-50 flex items-center justify-center bg-student-text/25 px-5" role="dialog">
    <section className="w-full max-w-md rounded-2xl border border-student-border bg-white p-5 shadow-[0_18px_45px_rgba(23,32,51,0.18)]">
      <div className="flex items-start justify-between gap-4">
        <div><h2 className="text-lg font-bold text-student-text" id="practice-amount-title">选择练习题目数量</h2>
          <p className="mt-1 text-sm text-student-muted">{subtitle}</p></div>
        <button aria-label="关闭" className="inline-flex h-8 w-8 items-center justify-center rounded-full text-student-muted transition hover:bg-student-bg hover:text-student-text" onClick={onClose} type="button">
          <X aria-hidden="true" size={18} />
        </button>
      </div>
      {error ? <p className="mt-4 rounded-xl border border-student-error-border bg-student-error-soft px-3 py-2 text-sm font-semibold text-student-error">{errorText ?? "题目数量加载失败，请稍后重试。"}</p>
        : loading ? <p className="mt-4 text-sm text-student-muted">{loadingText ?? "正在加载题目数量..."}</p>
        : count === 0 ? <p className="mt-4 rounded-xl border border-student-border bg-student-bg px-3 py-3 text-sm font-semibold text-student-muted">{emptyText ?? "暂无可练习题目。"}</p> : null}
      <div className="mt-4 grid grid-cols-4 gap-2.5">
        {WRONG_QUESTION_HISTORY_AMOUNTS.map((amount) => {
          const option = options.find((candidate) => candidate.amount === amount);
          const enabled = Boolean(option?.enabled);
          const enabledStyle = tone === "error"
            ? "border-student-error-border text-student-error hover:border-student-error hover:bg-student-error-soft"
            : "border-student-primary-border text-student-primary hover:border-student-primary hover:bg-student-primary-soft";
          return <div className="flex flex-col items-center gap-1.5" key={amount}>
            <button className={enabled
              ? `inline-flex h-14 w-full items-center justify-center rounded-xl border bg-white text-lg font-bold tabular-nums transition ${enabledStyle}`
              : "inline-flex h-14 w-full cursor-not-allowed items-center justify-center rounded-xl border border-student-border bg-student-bg text-lg font-bold tabular-nums text-student-muted"}
              data-testid={`wrong-question-amount-${amount}`} disabled={!enabled || loading || Boolean(error)}
              onClick={() => onStart(amount)} type="button">{amount}</button>
            {option?.shortfallHint ? <span className={`text-center text-[11px] font-semibold leading-4 ${tone === "error" ? "text-student-error" : "text-student-primary"}`}>{option.shortfallHint}</span> : null}
          </div>;
        })}
      </div>
    </section>
  </div>;
}
