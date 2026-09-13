import { Check } from "lucide-react";
import type {
  ReadingContentConflictItem,
  ReadingContentConflictResolution,
  ReadingContentQuestionVersion
} from "@/lib/reading/contentReconciliation";

export type ReadingContentResolutionDraft =
  | { action: null }
  | ReadingContentConflictResolution;

export function ReadingContentConflictList({
  drafts,
  items,
  onChange
}: {
  drafts: Record<string, ReadingContentResolutionDraft>;
  items: ReadingContentConflictItem[];
  onChange: (resolutionId: string, draft: ReadingContentResolutionDraft) => void;
}) {
  return (
    <section className="mt-6 rounded-2xl border border-amber-300 bg-amber-50/40 p-5">
      <h2 className="text-xl font-bold text-student-text">题目内容冲突待确认</h2>
      <p className="mt-1 text-sm text-student-muted">
        Logical identity 已确定；请逐项决定保留题库 canonical 内容，或使用当前来源修正 canonical 内容。完成前不会正式导入。
      </p>
      <div className="mt-5 grid gap-5">
        {items.map((item) => {
          const draft = drafts[item.resolutionId] ?? { action: null };
          return (
            <article className="rounded-2xl border border-amber-200 bg-white p-5" key={item.resolutionId}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-bold text-student-text">
                    {item.questionType.toUpperCase()} · {item.passageTitle ?? item.materialId ?? "无标题"}
                  </p>
                  <p className="mt-1 text-sm text-student-muted">
                    {item.sourceLabel} · {item.occurrenceDate} · {item.sourceModule.toUpperCase()} · 顺序 {item.sourceOrder}
                    {item.sourceQuestionRange ? ` · 原题 ${item.sourceQuestionRange}` : ""}
                  </p>
                  <p className="mt-1 text-xs text-student-muted">Logical item: {item.logicalItemId}</p>
                  {item.materialId ? <p className="mt-1 text-xs text-student-muted">Material: {item.materialId}</p> : null}
                </div>
                {draft.action ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-student-primary-soft px-3 py-1 text-sm font-bold text-student-primary">
                    <Check aria-hidden="true" size={14} />
                    {draft.action === "keep_existing" ? "已选择保留题库版本" : "已选择使用来源版本"}
                  </span>
                ) : (
                  <span className="rounded-full bg-amber-100 px-3 py-1 text-sm font-bold text-amber-800">待处理</span>
                )}
              </div>

              <div className="mt-5 grid gap-5">
                {item.questionConflicts.map((conflict) => (
                  <section className="rounded-xl border border-student-border p-4" key={conflict.questionOrder}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="font-bold text-student-text">
                        Question {conflict.sourceQuestionNumber ?? conflict.questionOrder}
                      </h3>
                      <span className={`rounded-full px-3 py-1 text-xs font-bold ${
                        conflict.correctAnswerSemanticallyDifferent
                          ? "bg-student-error-soft text-student-error"
                          : "bg-student-primary-soft text-student-primary"
                      }`}>
                        {conflict.correctAnswerSemanticallyDifferent
                          ? "Correct semantic answer 不同"
                          : "Correct semantic answer 相同"}
                      </span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {conflict.differences.map((difference) => (
                        <span
                          className={difference.substantive
                            ? "rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-800"
                            : "rounded-full bg-student-primary-soft px-2.5 py-1 text-xs font-bold text-student-primary"}
                          key={difference.kind}
                        >
                          {difference.label}
                        </span>
                      ))}
                    </div>
                    <div className="mt-4 grid gap-4 lg:grid-cols-2">
                      <QuestionVersion title="题库版本" version={conflict.existing} />
                      <QuestionVersion title="来源 CSV" version={conflict.incoming} />
                    </div>
                  </section>
                ))}
              </div>

              <div className="mt-5 flex flex-wrap gap-3">
                <button
                  className="teacher-button-secondary"
                  onClick={() => onChange(item.resolutionId, {
                    resolutionId: item.resolutionId,
                    action: "keep_existing"
                  })}
                  type="button"
                >
                  保留题库版本
                </button>
                <button
                  className="teacher-button-primary"
                  onClick={() => onChange(item.resolutionId, {
                    resolutionId: item.resolutionId,
                    action: "update_from_source"
                  })}
                  type="button"
                >
                  使用来源版本更新题库
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function QuestionVersion({ title, version }: { title: string; version: ReadingContentQuestionVersion }) {
  return (
    <div className="rounded-xl border border-student-border bg-student-primary-soft/20 p-4 text-sm">
      <h4 className="font-bold text-student-primary">{title}</h4>
      <Detail label="Question type" value={version.questionType} />
      <Detail label="Stem" value={version.stem} />
      {version.options ? (
        <Detail
          label="Options"
          value={version.options.map((option) =>
            `${option.label}. ${option.text}${option.correct ? " ✓" : ""}`
          ).join("\n")}
        />
      ) : null}
      {version.correctAnswer ? <Detail label="Correct" value={version.correctAnswer} /> : null}
      {version.ctwPassage ? <Detail label="Passage" value={version.ctwPassage} /> : null}
      {version.ctwBlanks ? <Detail label="Ordered blanks" value={version.ctwBlanks.join("\n")} /> : null}
      {version.insertSentence ? <Detail label="Insert sentence" value={version.insertSentence} /> : null}
      {version.insertionAnchors ? <Detail label="Insertion anchors" value={version.insertionAnchors.join("\n")} /> : null}
      {version.correctInsertionLocation ? <Detail label="Correct location" value={version.correctInsertionLocation} /> : null}
      {version.targetSentenceStructure ? <Detail label="Target sentences" value={version.targetSentenceStructure.join("\n")} /> : null}
      {version.selectedSentence ? <Detail label="Selected sentence" value={version.selectedSentence} /> : null}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-3">
      <div className="font-bold text-student-muted">{label}</div>
      <div className="mt-0.5 whitespace-pre-wrap text-student-text">{value}</div>
    </div>
  );
}
