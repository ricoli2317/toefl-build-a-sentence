"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import type {
  ReadingContentConflictItem,
  ReadingContentConflictResolution,
  ReadingContentQuestionVersion,
  ReadingQuestionContentConflict
} from "@/lib/reading/contentReconciliation";

export type ReadingContentResolutionDraft = { action: null } | ReadingContentConflictResolution;

export function ReadingContentConflictList({ drafts, items, onChange }: {
  drafts: Record<string, ReadingContentResolutionDraft>;
  items: ReadingContentConflictItem[];
  onChange: (resolutionId: string, draft: ReadingContentResolutionDraft) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [reopened, setReopened] = useState<Set<string>>(new Set());
  return (
    <section className="mt-6 rounded-2xl border border-amber-300 bg-amber-50/40 p-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-xl font-bold text-student-text">同题内容差异待确认</h2>
          <p className="mt-1 text-sm text-student-muted">系统已确认这是同一道题，请选择要保留的题目版本。</p>
        </div>
      </div>
      <div className="mt-5 grid gap-3">
        {items.map((item) => {
          const draft = drafts[item.resolutionId] ?? { action: null };
          const resolved = Boolean(draft.action);
          if (resolved && !reopened.has(item.resolutionId)) {
            return <ResolvedContentSummary draft={draft} item={item} key={item.resolutionId} onReopen={() => setReopened(addToSet(reopened, item.resolutionId))} />;
          }
          return (
            <article className="rounded-2xl border border-amber-200 bg-white p-5" key={item.resolutionId}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-bold text-student-text">{item.questionType.toUpperCase()} · {item.passageTitle ?? item.materialId ?? "未命名题目"}</p>
                  <p className="mt-1 text-sm text-student-muted">{compactSourceLabel(item)}</p>
                </div>
                <span className="rounded-full bg-amber-100 px-3 py-1 text-sm font-bold text-amber-800">{resolved ? "正在修改选择" : "待处理"}</span>
              </div>

              <div className="mt-4 grid gap-3">
                {item.questionConflicts.map((conflict) => <CompactQuestionConflict conflict={conflict} key={conflict.questionOrder} />)}
              </div>

              <div className="mt-3 flex flex-wrap gap-3">
                <button
                  className={draft.action === "keep_existing" ? "teacher-button-primary ring-2 ring-student-primary" : "teacher-button-secondary"}
                  onClick={() => onChange(item.resolutionId, { resolutionId: item.resolutionId, action: "keep_existing" })}
                  type="button"
                >
                  保留题库版本
                </button>
                <button
                  className={draft.action === "update_from_source" ? "teacher-button-primary ring-2 ring-student-primary" : "teacher-button-secondary"}
                  onClick={() => onChange(item.resolutionId, { resolutionId: item.resolutionId, action: "update_from_source" })}
                  type="button"
                >
                  使用来源版本更新题库
                </button>
              </div>
              {draft.action ? (
                <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-student-primary-soft p-3 text-sm font-bold text-student-primary">
                  <span className="inline-flex items-center gap-1"><Check size={15} />已选择：{contentActionLabel(draft.action)}</span>
                  <button className="underline" onClick={() => onChange(item.resolutionId, { action: null })} type="button">修改选择</button>
                </div>
              ) : null}

              <button className="mt-4 text-sm font-bold text-student-primary underline" onClick={() => setExpanded(toggleSet(expanded, item.resolutionId))} type="button">
                {expanded.has(item.resolutionId) ? "收起完整内容" : "展开完整内容"}
              </button>
              {expanded.has(item.resolutionId) ? <FullContentComparison item={item} /> : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function CompactQuestionConflict({ conflict }: { conflict: ReadingQuestionContentConflict }) {
  if (conflict.ctwSlotConflicts?.length) {
    return (
      <section className="rounded-xl border border-amber-200 bg-amber-50 p-4">
        {conflict.ctwSlotConflicts.map((slot) => (
          <div className="mt-3 first:mt-0" key={slot.slotOrder}>
            <h3 className="font-bold text-student-text">第 {slot.slotOrder} 空内容不同</h3>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <VersionValue title="题库版本" value={slot.existing} />
              <VersionValue title="来源 CSV" value={slot.incoming} />
            </div>
          </div>
        ))}
      </section>
    );
  }
  return (
    <section className="rounded-xl border border-amber-200 bg-amber-50 p-4">
      <h3 className="font-bold text-student-text">题目 {conflict.sourceQuestionNumber ?? conflict.questionOrder}</h3>
      <div className="mt-3 grid gap-3">
        {conflict.differences.filter((difference) => difference.substantive).map((difference) => {
          const values = differenceValues(conflict, difference.kind);
          return <div className="rounded-lg bg-white p-3" key={difference.kind}><div className="font-bold text-student-text">{difference.label}</div><div className="mt-2 grid gap-3 sm:grid-cols-2"><VersionValue title="题库版本" value={values.existing} /><VersionValue title="来源 CSV" value={values.incoming} /></div></div>;
        })}
      </div>
    </section>
  );
}

function FullContentComparison({ item }: { item: ReadingContentConflictItem }) {
  return (
    <div className="mt-4 rounded-xl border border-student-border p-4">
      <div className="text-xs text-student-muted">来源：{sourceLabel(item)} · 内部题目编号：{item.logicalItemId}</div>
      <div className="mt-4 grid gap-5">
        {item.questionConflicts.map((conflict) => (
          <section key={conflict.questionOrder}>
            <h3 className="font-bold text-student-text">题目 {conflict.sourceQuestionNumber ?? conflict.questionOrder}</h3>
            <div className="mt-3 grid gap-4 lg:grid-cols-2">
              <QuestionVersion title="题库版本" version={conflict.existing} />
              <QuestionVersion title="来源 CSV" version={conflict.incoming} />
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function ResolvedContentSummary({ draft, item, onReopen }: {
  draft: ReadingContentResolutionDraft;
  item: ReadingContentConflictItem;
  onReopen: () => void;
}) {
  const slot = item.questionConflicts.flatMap((conflict) => conflict.ctwSlotConflicts ?? [])[0];
  const chosen = draft.action === "keep_existing" ? slot?.existingAnswer : slot?.incomingAnswer;
  return (
    <article className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-student-primary-border bg-student-primary-soft/40 p-4">
      <div>
        <div className="flex items-center gap-2 font-bold text-student-text"><Check className="text-student-primary" size={16} />{compactSourceLabel(item)}</div>
        <p className="mt-1 text-sm text-student-muted">{contentActionLabel(draft.action)}{slot ? ` · 第 ${slot.slotOrder} 空：${chosen}` : ""}</p>
      </div>
      <button className="teacher-button-secondary" onClick={onReopen} type="button">重新查看</button>
    </article>
  );
}

function differenceValues(conflict: ReadingQuestionContentConflict, kind: ReadingQuestionContentConflict["differences"][number]["kind"]) {
  const value = (version: ReadingContentQuestionVersion) => {
    if (kind === "question_type") return version.questionType;
    if (kind === "stem") return version.stem;
    if (kind === "options" || kind === "option_order") return version.options?.map((option) => `${option.label}. ${option.text}${option.correct ? " ✓" : ""}`).join("\n") ?? "未提供";
    if (kind === "correct_answer") return version.correctAnswer ?? "未提供";
    if (kind === "insert_sentence") return version.insertSentence ?? "未提供";
    if (kind === "insertion_anchors") return version.insertionAnchors?.join("\n") ?? "未提供";
    if (kind === "correct_insertion_location") return version.correctInsertionLocation ?? "未提供";
    if (kind === "target_sentence_structure") return version.targetSentenceStructure?.join("\n") ?? "未提供";
    if (kind === "selected_sentence") return version.selectedSentence ?? "未提供";
    return version.correctAnswer ?? version.stem;
  };
  return { existing: value(conflict.existing), incoming: value(conflict.incoming) };
}

function QuestionVersion({ title, version }: { title: "题库版本" | "来源 CSV"; version: ReadingContentQuestionVersion }) {
  return <div className="rounded-xl border border-student-border bg-student-primary-soft/20 p-4 text-sm"><h4 className="font-bold text-student-primary">【{title}】</h4><Detail label="Question type" value={version.questionType} /><Detail label="Stem" value={version.stem} />{version.options ? <Detail label="Options" value={version.options.map((option) => `${option.label}. ${option.text}${option.correct ? " ✓" : ""}`).join("\n")} /> : null}{version.correctAnswer ? <Detail label="Correct answers" value={version.correctAnswer} /> : null}{version.ctwPassage ? <Detail label="Passage" value={version.ctwPassage} /> : null}{version.ctwBlanks ? <Detail label="Ordered blanks" value={version.ctwBlanks.join("\n")} /> : null}{version.insertSentence ? <Detail label="Insert sentence" value={version.insertSentence} /> : null}{version.insertionAnchors ? <Detail label="Insertion anchors" value={version.insertionAnchors.join("\n")} /> : null}{version.correctInsertionLocation ? <Detail label="Correct location" value={version.correctInsertionLocation} /> : null}{version.targetSentenceStructure ? <Detail label="Target sentences" value={version.targetSentenceStructure.join("\n")} /> : null}{version.selectedSentence ? <Detail label="Selected sentence" value={version.selectedSentence} /> : null}</div>;
}

function VersionValue({ title, value }: { title: "题库版本" | "来源 CSV"; value: string }) { return <div><div className="text-xs font-bold text-student-muted">【{title}】</div><div className="mt-1 whitespace-pre-wrap break-words font-mono text-sm text-student-text">{value}</div></div>; }
function Detail({ label, value }: { label: string; value: string }) { return <div className="mt-3"><div className="font-bold text-student-muted">{label}</div><div className="mt-0.5 whitespace-pre-wrap text-student-text">{value}</div></div>; }
function contentActionLabel(action: ReadingContentResolutionDraft["action"]) { return action === "keep_existing" ? "保留题库版本" : action === "update_from_source" ? "使用来源版本更新题库" : "尚未选择"; }
function sourceLabel(item: ReadingContentConflictItem) { return [item.sourceLabel, item.occurrenceDate, item.sourceModule.toUpperCase(), `顺序 ${item.sourceOrder}`, item.sourceQuestionRange ? `原题 ${item.sourceQuestionRange}` : null].filter(Boolean).join(" · "); }
function compactSourceLabel(item: ReadingContentConflictItem) { return [item.sourceLabel, item.sourceModule.toUpperCase(), item.sourceQuestionRange ? `Q${item.sourceQuestionRange}` : null].filter(Boolean).join(" · "); }
function addToSet(values: Set<string>, value: string) { const next = new Set(values); next.add(value); return next; }
function toggleSet(values: Set<string>, value: string) { const next = new Set(values); if (next.has(value)) next.delete(value); else next.add(value); return next; }
