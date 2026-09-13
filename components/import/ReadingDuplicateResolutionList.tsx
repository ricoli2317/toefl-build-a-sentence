"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import type {
  ReadingDuplicateCandidate,
  ReadingDuplicatePreview,
  ReadingDuplicateResolutionChoice,
  ReadingDuplicateResolutionItem
} from "@/lib/reading/duplicateResolutionModel";

export type ReadingResolutionDraft =
  | { action: null; logicalItemId: string }
  | ReadingDuplicateResolutionChoice;

export function ReadingDuplicateResolutionList({ drafts, items, onChange }: {
  drafts: Record<string, ReadingResolutionDraft>;
  items: ReadingDuplicateResolutionItem[];
  onChange: (resolutionId: string, draft: ReadingResolutionDraft) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [reopened, setReopened] = useState<Set<string>>(new Set());
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
          if (resolved && !reopened.has(item.resolutionId)) {
            return (
              <ResolvedDuplicateSummary
                draft={draft}
                item={item}
                key={item.resolutionId}
                onReopen={() => setReopened(addToSet(reopened, item.resolutionId))}
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
                <span className="rounded-full bg-amber-100 px-3 py-1 text-sm font-bold text-amber-800">
                  {resolved ? "正在修改选择" : "待处理"}
                </span>
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

              <CompactDuplicateDifferences candidate={selectedCandidate ?? null} />

              <div className="mt-3 flex flex-wrap gap-3">
                <button
                  className={draft.action === "reuse_existing" ? "teacher-button-primary ring-2 ring-student-primary" : "teacher-button-secondary"}
                  disabled={!selectedCandidate}
                  onClick={() => selectedCandidate && onChange(item.resolutionId, {
                    action: "reuse_existing",
                    logicalItemId: selectedCandidate.logicalItemId
                  })}
                  type="button"
                >
                  这是同一道题，归入题库版本
                </button>
                <button
                  className={draft.action === "create_new" ? "teacher-button-primary ring-2 ring-student-primary" : "teacher-button-secondary"}
                  onClick={() => onChange(item.resolutionId, { action: "create_new" })}
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

              <button
                className="mt-4 text-sm font-bold text-student-primary underline"
                onClick={() => setExpanded(toggleSet(expanded, item.resolutionId))}
                type="button"
              >
                {expanded.has(item.resolutionId) ? "收起完整内容" : "展开完整内容"}
              </button>
              {expanded.has(item.resolutionId) ? (
                <FullDuplicateComparison candidate={selectedCandidate ?? null} incoming={item.incoming} />
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
      {differences.length === 0 ? <p className="mt-2 text-sm">题目框架存在结构差异，请展开完整内容核对。</p> : (
        <div className="mt-3 grid gap-3">
          {differences.map((difference, index) => (
            <div className="rounded-lg bg-white p-3" key={`${difference.label}-${index}`}>
              <div className="font-bold text-student-text">{difference.label}</div>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <VersionValue title="题库版本" value={difference.existing} />
                <VersionValue title="来源 CSV" value={difference.incoming} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FullDuplicateComparison({ candidate, incoming }: {
  candidate: ReadingDuplicateCandidate | null;
  incoming: ReadingDuplicatePreview;
}) {
  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-2">
      <div>
        <div className="mb-2 text-xs font-semibold text-student-muted">题库版本 · {candidate ? readingSourceLabel(candidate) : "不可用"}</div>
        <ReadingDuplicateDetail preview={candidate} />
        {candidate?.sourceOccurrences.length ? <CandidateOccurrences candidate={candidate} /> : null}
      </div>
      <div>
        <div className="mb-2 text-xs font-semibold text-student-muted">来源 CSV · {readingSourceLabel(incoming)}</div>
        <ReadingDuplicateDetail preview={incoming} />
      </div>
    </div>
  );
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

function ReadingDuplicateDetail({ preview }: { preview: ReadingDuplicatePreview | null }) {
  if (!preview) return <p className="text-sm text-student-muted">题目详情不可用。</p>;
  if (preview.questionType === "ctw") return <div className="rounded-xl border p-4 text-sm"><Detail label="Passage" value={preview.detail.passage} /><Detail label="Ordered blanks" value={preview.detail.orderedBlanks.join("\n")} /><Detail label="Correct answers" value={preview.detail.correctAnswers.join("\n")} /></div>;
  if (preview.questionType === "rdl") return <div className="rounded-xl border p-4 text-sm"><Detail label="Material" value={`${preview.detail.materialTitle ?? "无标题"}\n${preview.detail.materialType ?? "unknown"}\n${preview.detail.materialSource}`} /><Detail label="Questions" value={preview.detail.questions.join("\n\n")} /></div>;
  return <div className="rounded-xl border p-4 text-sm"><Detail label="Passage" value={`${preview.detail.passageTitle}\n${preview.detail.passage}`} /><Detail label="Questions" value={preview.detail.questions.join("\n\n")} /></div>;
}

function VersionValue({ title, value }: { title: "题库版本" | "来源 CSV"; value: string }) {
  return <div><div className="text-xs font-bold text-student-muted">【{title}】</div><div className="mt-1 whitespace-pre-wrap break-words font-mono text-sm text-student-text">{value}</div></div>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div className="mt-3 first:mt-0"><div className="font-bold text-student-muted">{label}</div><div className="mt-0.5 whitespace-pre-wrap text-student-text">{value}</div></div>;
}

function CandidateOccurrences({ candidate }: { candidate: ReadingDuplicateCandidate }) {
  return <div className="mt-3 text-xs text-student-muted">已有来源：{candidate.sourceOccurrences.map(readingSourceLabel).join("；")}</div>;
}

function duplicateActionLabel(action: ReadingResolutionDraft["action"]) {
  return action === "reuse_existing" ? "归入题库版本" : action === "create_new" ? "保留为新题" : "尚未选择";
}

function readingModuleLabel(questionType: ReadingDuplicatePreview["questionType"]) { return questionType.toUpperCase(); }
function readingSourceLabel(source: Pick<ReadingDuplicatePreview, "sourceLabel" | "occurrenceDate" | "sourceModule" | "sourceOrder" | "sourceQuestionRange">) {
  return [source.sourceLabel, source.occurrenceDate, source.sourceModule ? source.sourceModule.toUpperCase() : null, `顺序 ${source.sourceOrder}`, source.sourceQuestionRange ? `原题 ${source.sourceQuestionRange}` : null].filter(Boolean).join(" · ");
}
function compactReadingSourceLabel(source: Pick<ReadingDuplicatePreview, "sourceLabel" | "sourceModule" | "sourceQuestionRange">) {
  return [source.sourceLabel, source.sourceModule ? source.sourceModule.toUpperCase() : null, source.sourceQuestionRange ? `Q${source.sourceQuestionRange}` : null].filter(Boolean).join(" · ");
}
function addToSet(values: Set<string>, value: string) { const next = new Set(values); next.add(value); return next; }
function toggleSet(values: Set<string>, value: string) { const next = new Set(values); if (next.has(value)) next.delete(value); else next.add(value); return next; }
