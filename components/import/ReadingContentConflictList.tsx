"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import type {
  ReadingContentConflictItem,
  ReadingContentConflictResolution,
  ReadingQuestionContentConflict
} from "@/lib/reading/contentReconciliation";
import type {
  ReadingInsertionDuplicateReview,
  ReadingInsertionPositionReview
} from "@/lib/reading/reviewPresentation";
import { readingContentConflictSummary } from "@/lib/reading/contentReconciliation";
import { ReadingInlineVersionValue } from "./ReadingInlineVersionValue";
import {
  ReadingFullContentComparison,
  ReadingInsertionPosition
} from "./ReadingFullContentComparison";

export type ReadingContentResolutionDraft = { action: null } | ReadingContentConflictResolution;

export function ReadingContentConflictList({ drafts, items, onChange }: {
  drafts: Record<string, ReadingContentResolutionDraft>;
  items: ReadingContentConflictItem[];
  onChange: (resolutionId: string, draft: ReadingContentResolutionDraft) => void;
}) {
  const [expandedReviewItems, setExpandedReviewItems] = useState<Set<string>>(new Set());
  const [expandedContentItems, setExpandedContentItems] = useState<Set<string>>(new Set());
  const collapseReviewItem = (resolutionId: string) => {
    setExpandedReviewItems((current) => removeFromSet(current, resolutionId));
  };
  const confirmResolution = (resolutionId: string, draft: ReadingContentResolutionDraft) => {
    onChange(resolutionId, draft);
    collapseReviewItem(resolutionId);
  };
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
          const reviewExpanded = expandedReviewItems.has(item.resolutionId);
          if (resolved && !reviewExpanded) {
            return <ResolvedContentSummary draft={draft} item={item} key={item.resolutionId} onReopen={() => setExpandedReviewItems((current) => addToSet(current, item.resolutionId))} />;
          }
          return (
            <article className="rounded-2xl border border-amber-200 bg-white p-5" key={item.resolutionId}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-bold text-student-text">{item.questionType.toUpperCase()} · {item.passageTitle ?? item.materialId ?? "未命名题目"}</p>
                  <p className="mt-1 text-sm text-student-muted">{compactSourceLabel(item)}</p>
                  <p className="mt-1 text-sm font-semibold text-amber-800">{readingContentConflictSummary(item)}</p>
                </div>
                {resolved ? (
                  <button className="teacher-button-secondary" onClick={() => collapseReviewItem(item.resolutionId)} type="button">收起</button>
                ) : (
                  <span className="rounded-full bg-amber-100 px-3 py-1 text-sm font-bold text-amber-800">待处理</span>
                )}
              </div>

              <div className="mt-4 grid gap-3">
                {item.passageConflicts.map((difference, index) => (
                  <DifferenceCard difference={difference} key={`${difference.kind}-${index}`} />
                ))}
                {item.questionConflicts.map((conflict) => <CompactQuestionConflict conflict={conflict} key={conflict.questionOrder} />)}
              </div>

              <button
                className="mt-3 text-sm font-bold text-student-primary underline"
                onClick={() => setExpandedContentItems((current) => toggleSet(current, item.resolutionId))}
                type="button"
              >
                {expandedContentItems.has(item.resolutionId) ? "收起完整内容" : "展开完整内容"}
              </button>
              {expandedContentItems.has(item.resolutionId) ? (
                <ReadingFullContentComparison existing={item.existingVersion} incoming={item.incomingVersion} />
              ) : null}

              <div className="mt-3 flex flex-wrap gap-3">
                <button
                  className={draft.action === "keep_existing" ? "teacher-button-primary ring-2 ring-student-primary" : "teacher-button-secondary"}
                  onClick={() => confirmResolution(item.resolutionId, { resolutionId: item.resolutionId, action: "keep_existing" })}
                  type="button"
                >
                  保留题库版本
                </button>
                <button
                  className={draft.action === "update_from_source" ? "teacher-button-primary ring-2 ring-student-primary" : "teacher-button-secondary"}
                  onClick={() => confirmResolution(item.resolutionId, { resolutionId: item.resolutionId, action: "update_from_source" })}
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
              <ReadingInlineVersionValue title="题库版本" segments={slot.inlineDiff.existing} />
              <ReadingInlineVersionValue title="来源 CSV" segments={slot.inlineDiff.incoming} />
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
        {conflict.differences.map((difference, index) => (
          <DifferenceCard difference={difference} key={`${difference.kind}-${index}`} />
        ))}
      </div>
    </section>
  );
}

function DifferenceCard({ difference }: {
  difference: ReadingQuestionContentConflict["differences"][number];
}) {
  return (
    <div className="rounded-lg bg-white p-3">
      <div className="font-bold text-student-text">{difference.label}</div>
      {difference.insertionPositions?.comparisonKind === "set_difference" ? (
        <div className="mt-2 grid gap-3">
          <PositionVersion title="题库版本独有" positions={difference.insertionPositions.existingOnly} />
          <PositionVersion title="来源 CSV 独有" positions={difference.insertionPositions.incomingOnly} />
          <DuplicatePositions title="题库版本存在重复可插入位置" duplicates={difference.insertionPositions.existingDuplicates} />
          <DuplicatePositions title="来源 CSV 存在重复可插入位置" duplicates={difference.insertionPositions.incomingDuplicates} />
        </div>
      ) : difference.insertionPositions?.comparisonKind === "version_comparison" ? (
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <PositionVersion title="题库版本" positions={difference.insertionPositions.existing} />
          <PositionVersion title="来源 CSV" positions={difference.insertionPositions.incoming} />
        </div>
      ) : (
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <ReadingInlineVersionValue title="题库版本" segments={difference.inlineDiff.existing} />
          <ReadingInlineVersionValue title="来源 CSV" segments={difference.inlineDiff.incoming} />
        </div>
      )}
    </div>
  );
}

function PositionVersion({ positions, title }: {
  positions: ReadingInsertionPositionReview[];
  title: string;
}) {
  if (positions.length === 0) return null;
  return (
    <section>
      <h4 className="mb-2 text-sm font-bold text-student-muted">{title}</h4>
      <div className="grid gap-2">
        {positions.map((position) => <ReadingInsertionPosition key={position.semanticKey} position={position} />)}
      </div>
    </section>
  );
}

function DuplicatePositions({ duplicates, title }: {
  duplicates: ReadingInsertionDuplicateReview[];
  title: string;
}) {
  if (duplicates.length === 0) return null;
  return (
    <section>
      <h4 className="mb-2 text-sm font-bold text-red-700">{title}</h4>
      <div className="grid gap-2">
        {duplicates.map((duplicate) => (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3" key={duplicate.position.semanticKey}>
            <p className="text-sm font-bold text-student-text">位置：{duplicate.position.label}</p>
            <p className="mt-1 text-sm text-red-700">
              Location {duplicate.locationNumbers.join("、Location ")} 指向同一个 semantic boundary
            </p>
          </div>
        ))}
      </div>
    </section>
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

function contentActionLabel(action: ReadingContentResolutionDraft["action"]) { return action === "keep_existing" ? "保留题库版本" : action === "update_from_source" ? "使用来源版本更新题库" : "尚未选择"; }
function compactSourceLabel(item: ReadingContentConflictItem) {
  const labels = Array.from(new Set(item.sources.map((source) => source.sourceLabel)));
  if (labels.length > 1) return `来源：${labels.join("、")}`;
  return [labels[0] ?? item.sourceLabel, item.sourceModule.toUpperCase(), item.sourceQuestionRange ? `Q${item.sourceQuestionRange}` : null].filter(Boolean).join(" · ");
}
function addToSet(values: Set<string>, value: string) { const next = new Set(values); next.add(value); return next; }
function removeFromSet(values: Set<string>, value: string) { const next = new Set(values); next.delete(value); return next; }
function toggleSet(values: Set<string>, value: string) { const next = new Set(values); next.has(value) ? next.delete(value) : next.add(value); return next; }
