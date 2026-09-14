"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import type {
  ReadingDuplicateCandidate,
  ReadingDuplicatePreview,
  ReadingDuplicateResolutionChoice,
  ReadingDuplicateResolutionItem
} from "@/lib/reading/duplicateResolutionModel";
import { ReadingInlineVersionValue } from "./ReadingInlineVersionValue";
import { ReadingFullContentComparison } from "./ReadingFullContentComparison";

export type ReadingResolutionDraft =
  | { action: null; logicalItemId: string }
  | ReadingDuplicateResolutionChoice;

export function ReadingDuplicateResolutionList({ drafts, items, onChange }: {
  drafts: Record<string, ReadingResolutionDraft>;
  items: ReadingDuplicateResolutionItem[];
  onChange: (resolutionId: string, draft: ReadingResolutionDraft) => void;
}) {
  const [expandedReviewItems, setExpandedReviewItems] = useState<Set<string>>(new Set());
  const [expandedContentItems, setExpandedContentItems] = useState<Set<string>>(new Set());
  const collapseReviewItem = (resolutionId: string) => {
    setExpandedReviewItems((current) => removeFromSet(current, resolutionId));
  };
  const confirmResolution = (resolutionId: string, draft: ReadingResolutionDraft) => {
    onChange(resolutionId, draft);
    collapseReviewItem(resolutionId);
  };
  return (
    <section className="mt-6 rounded-2xl border border-student-primary-border bg-white p-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-xl font-bold text-student-text">相似题待确认</h2>
          <p className="mt-1 text-sm text-student-muted">只有题目框架无法确定时，才需要判断是不是同一道题。</p>
        </div>
      </div>
      <div className="mt-5 grid gap-3">
        {items.map((item) => {
          const draft = drafts[item.resolutionId] ?? {
            action: null,
            logicalItemId: item.candidates[0]?.logicalItemId ?? ""
          };
          const selectedId = draft.action === "reuse_existing" || draft.action === null
            ? draft.logicalItemId
            : item.candidates[0]?.logicalItemId ?? "";
          const selectedCandidate = item.candidates.find((candidate) =>
            candidate.logicalItemId === selectedId
          ) ?? item.candidates[0];
          const resolved = Boolean(draft.action);
          const reviewExpanded = expandedReviewItems.has(item.resolutionId);
          if (resolved && !reviewExpanded) {
            return (
              <ResolvedDuplicateSummary
                draft={draft}
                item={item}
                key={item.resolutionId}
                onReopen={() => setExpandedReviewItems((current) => addToSet(current, item.resolutionId))}
                selectedCandidate={selectedCandidate}
              />
            );
          }
          return (
            <article className="rounded-2xl border border-student-border p-5" key={item.resolutionId}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-bold text-student-text">
                    {readingModuleLabel(item.questionType)} · {item.incoming.title ?? "未命名题目"}
                  </p>
                  <p className="mt-1 text-sm text-student-muted">{compactReadingSourceLabel(item.incoming)}</p>
                  <p className="mt-1 text-sm font-semibold text-amber-800">{item.reason}</p>
                </div>
                {resolved ? (
                  <button className="teacher-button-secondary" onClick={() => collapseReviewItem(item.resolutionId)} type="button">收起</button>
                ) : (
                  <span className="rounded-full bg-amber-100 px-3 py-1 text-sm font-bold text-amber-800">待处理</span>
                )}
              </div>

              {item.candidates.length > 1 ? (
                <label className="mt-4 grid gap-1 text-sm font-bold text-student-text">
                  对比题库候选
                  <select
                    className="rounded-xl border border-student-border bg-white px-3 py-2 font-normal"
                    onChange={(event) => onChange(item.resolutionId, { action: null, logicalItemId: event.target.value })}
                    value={selectedId}
                  >
                    {item.candidates.map((candidate) => (
                      <option key={candidate.logicalItemId} value={candidate.logicalItemId}>
                        {candidate.title ?? readingModuleLabel(candidate.questionType)} · {candidate.firstSeenSourceLabel}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              {item.questionType === "rdl" && selectedCandidate?.questionType === "rdl"
                && item.incoming.questionType === "rdl" ? (
                <RdlMaterialComparison candidate={selectedCandidate} incoming={item.incoming} />
              ) : null}
              <CompactDuplicateDifferences candidate={selectedCandidate ?? null} />
              <button
                className="mt-3 text-sm font-bold text-student-primary underline"
                disabled={!selectedCandidate}
                onClick={() => setExpandedContentItems((current) => toggleSet(current, item.resolutionId))}
                type="button"
              >
                {expandedContentItems.has(item.resolutionId) ? "收起完整内容" : "展开完整内容"}
              </button>
              {selectedCandidate && expandedContentItems.has(item.resolutionId) ? (
                <ReadingFullContentComparison
                  existing={selectedCandidate.reviewVersion}
                  incoming={item.incoming.reviewVersion}
                />
              ) : null}

              <div className="mt-3 flex flex-wrap gap-3">
                <button
                  className={draft.action === "reuse_existing" ? "teacher-button-primary ring-2 ring-student-primary" : "teacher-button-secondary"}
                  disabled={!selectedCandidate}
                  onClick={() => selectedCandidate && confirmResolution(item.resolutionId, {
                    action: "reuse_existing",
                    logicalItemId: selectedCandidate.logicalItemId
                  })}
                  type="button"
                >
                  这是同一道题，归入题库版本
                </button>
                <button
                  className={draft.action === "create_new" ? "teacher-button-primary ring-2 ring-student-primary" : "teacher-button-secondary"}
                  onClick={() => confirmResolution(item.resolutionId, { action: "create_new" })}
                  type="button"
                >
                  不是同一道题，保留为新题
                </button>
              </div>
              {draft.action ? (
                <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-student-primary-soft p-3 text-sm font-bold text-student-primary">
                  <span className="inline-flex items-center gap-1"><Check size={15} />已选择：{duplicateActionLabel(draft.action)}</span>
                  <button className="underline" onClick={() => onChange(item.resolutionId, { action: null, logicalItemId: selectedId })} type="button">修改选择</button>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function CompactDuplicateDifferences({ candidate }: { candidate: ReadingDuplicateCandidate | null }) {
  const differences = candidate?.reviewDifferences ?? [];
  return (
    <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
      <h3 className="text-sm font-bold text-amber-900">需要判断的实际差异</h3>
      {differences.length === 0 ? <p className="mt-2 text-sm">文字内容一致；请结合两侧素材或结构判断。</p> : (
        <div className="mt-3 grid gap-3">
          {differences.map((difference, index) => (
            <div className="rounded-lg bg-white p-3" key={`${difference.label}-${index}`}>
              <div className="font-bold text-student-text">{difference.label}</div>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <ReadingInlineVersionValue title="题库版本" segments={difference.inlineDiff.existing} />
                <ReadingInlineVersionValue title="来源 CSV" segments={difference.inlineDiff.incoming} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RdlMaterialComparison({ candidate, incoming }: {
  candidate: Extract<ReadingDuplicateCandidate, { questionType: "rdl" }>;
  incoming: Extract<ReadingDuplicatePreview, { questionType: "rdl" }>;
}) {
  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <MaterialImage title="题库已有素材" preview={candidate} />
      <MaterialImage title="来源 CSV 素材" preview={incoming} />
    </div>
  );
}

function MaterialImage({ title, preview }: {
  title: string;
  preview: Extract<ReadingDuplicatePreview, { questionType: "rdl" }>;
}) {
  const caption = `${preview.detail.materialId} · ${preview.detail.materialSource || preview.sourceLabel}`;
  return <figure className="overflow-hidden rounded-xl border border-student-border bg-student-primary-soft/20 p-3"><figcaption className="mb-2 text-sm font-bold text-student-text">{title} · {caption}</figcaption>{preview.detail.imageUrl ? <a href={preview.detail.imageUrl} rel="noreferrer" target="_blank" title="点击放大素材图片"><img alt={`${title} ${preview.detail.materialId}`} className="h-auto max-h-[32rem] w-full rounded-lg bg-white object-contain" loading="lazy" src={preview.detail.imageUrl} /></a> : <div className="grid min-h-40 place-items-center rounded-lg border border-dashed bg-white text-sm text-student-muted">素材图片暂不可用</div>}</figure>;
}

function ResolvedDuplicateSummary({ draft, item, onReopen, selectedCandidate }: {
  draft: ReadingResolutionDraft;
  item: ReadingDuplicateResolutionItem;
  onReopen: () => void;
  selectedCandidate: ReadingDuplicateCandidate | undefined;
}) {
  const difference = selectedCandidate?.reviewDifferences[0];
  return (
    <article className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-student-primary-border bg-student-primary-soft/40 p-4">
      <div>
        <div className="flex items-center gap-2 font-bold text-student-text"><Check className="text-student-primary" size={16} />{compactReadingSourceLabel(item.incoming)}</div>
        <p className="mt-1 text-sm text-student-muted">{duplicateActionLabel(draft.action)}{difference ? ` · ${difference.label}` : ""}</p>
      </div>
      <button className="teacher-button-secondary" onClick={onReopen} type="button">重新查看</button>
    </article>
  );
}

function duplicateActionLabel(action: ReadingResolutionDraft["action"]) {
  return action === "reuse_existing" ? "归入题库版本" : action === "create_new" ? "保留为新题" : "尚未选择";
}

function readingModuleLabel(questionType: ReadingDuplicatePreview["questionType"]) { return questionType.toUpperCase(); }
function compactReadingSourceLabel(source: Pick<ReadingDuplicatePreview, "sourceLabel" | "sourceModule" | "sourceQuestionRange">) {
  return [source.sourceLabel, source.sourceModule ? source.sourceModule.toUpperCase() : null, source.sourceQuestionRange ? `Q${source.sourceQuestionRange}` : null].filter(Boolean).join(" · ");
}
function addToSet(values: Set<string>, value: string) { const next = new Set(values); next.add(value); return next; }
function removeFromSet(values: Set<string>, value: string) { const next = new Set(values); next.delete(value); return next; }
function toggleSet(values: Set<string>, value: string) { const next = new Set(values); next.has(value) ? next.delete(value) : next.add(value); return next; }
