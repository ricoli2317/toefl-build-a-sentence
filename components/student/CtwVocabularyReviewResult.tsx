"use client";
import type { ReviewRound, ReviewState } from "@/lib/lexical/wordbookReview";
import { WordbookReviewResult } from "./WordbookReviewWorkspace";
import { ctwMetadata } from "@/lib/ctw-vocabulary/review";
import { sourceReturnHref, VOCABULARY_ROOT } from "@/lib/ctw-vocabulary/round";

/** Only the CTW-specific mistake fields are a slot; overview/actions are the
 * actual Wordbook result component, not a second result-page implementation. */
export function CtwVocabularyReviewResult({ round, state, pending = 0, busy = false, onRetry }: {
  round: ReviewRound; state: ReviewState; pending?: number; busy?: boolean; onRetry: () => void;
}) {
  const wrong = round.cards.filter(card => card.answer && !card.answer.correct);
  return <div className="reading-theme mx-auto w-full max-w-3xl"><WordbookReviewResult state={state} pending={pending > 0} busy={busy || pending > 0} spellingOnly
    setupHref={sourceReturnHref(ctwMetadata(round).source)} historyHref={`${VOCABULARY_ROOT}/history`} onRetry={onRetry}>
    {wrong.length ? <section aria-label="错词详情" className="grid gap-4 text-left"><h2 className="text-lg font-bold">错词详情</h2>
      {wrong.map(card => <article key={card.itemId} className="student-card grid gap-3 p-5 [overflow-wrap:anywhere]">
        <h3 className="text-xl font-bold">{card.expected.expression}</h3>
        <div className="grid gap-1 text-sm font-medium leading-relaxed text-student-muted">{card.studySenses?.map((s, i) => <p key={i}>{s.pos} {s.meaning}</p>)}</div>
        {card.spellingGroups?.filter(group => group.id === "base" || !card.answer!.assessments[group.id]).map(group =>
          <div key={group.id} className="grid gap-1 border-t border-student-border pt-2 text-sm font-medium leading-relaxed">
            <p className="font-semibold">{group.label ?? "拼写"} · {card.answer!.assessments[group.id] ? "正确" : "错误"}</p>
            <p><span className="font-semibold">你的拼写：</span>{card.answer!.student.spellings?.[group.id] ? <span className="font-semibold text-student-error" data-student-spelling>{card.answer!.student.spellings[group.id]}</span> : "未填写"}</p><p><span className="font-semibold">正确拼写：</span><strong>{group.accepted.join(" / ")}</strong></p>
          </div>)}
      </article>)}
    </section> : null}
  </WordbookReviewResult></div>;
}
