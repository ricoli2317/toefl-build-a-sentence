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

export function ReadingDuplicateResolutionList({
  drafts,
  items,
  onChange
}: {
  drafts: Record<string, ReadingResolutionDraft>;
  items: ReadingDuplicateResolutionItem[];
  onChange: (resolutionId: string, draft: ReadingResolutionDraft) => void;
}) {
  return (
    <section className="mt-6 rounded-2xl border border-student-primary-border bg-white p-5">
      <h2 className="text-xl font-bold text-student-text">重复题待确认</h2>
      <p className="mt-1 text-sm text-student-muted">
        逐项确认归入候选逻辑题，或明确保留为新的逻辑题。完成全部选择前不会写入 Reading 正式题库。
      </p>
      <div className="mt-5 grid gap-5">
        {items.map((item) => {
          const draft = drafts[item.resolutionId] ?? {
            action: null,
            logicalItemId: item.candidates[0]?.logicalItemId ?? ""
          };
          const selectedId = draft.action === "reuse_existing" || draft.action === null
            ? draft.logicalItemId
            : item.candidates[0]?.logicalItemId ?? "";
          const selectedCandidate = item.candidates.find(
            (candidate) => candidate.logicalItemId === selectedId
          ) ?? item.candidates[0];
          return (
            <article className="rounded-2xl border border-student-border p-5" key={item.resolutionId}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-bold text-student-text">
                    {readingModuleLabel(item.questionType)} · {item.incoming.title ?? "无标题"}
                  </p>
                  <p className="mt-1 text-sm text-student-muted">
                    当前来源：{readingSourceLabel(item.incoming)}
                  </p>
                  <p className="mt-1 text-sm font-semibold text-amber-800">{item.reason}</p>
                </div>
                {draft.action ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-student-primary-soft px-3 py-1 text-sm font-bold text-student-primary">
                    <Check aria-hidden="true" size={14} />
                    {draft.action === "reuse_existing" ? "已选择归入已有题" : "已确认为新逻辑题"}
                  </span>
                ) : (
                  <span className="rounded-full bg-amber-100 px-3 py-1 text-sm font-bold text-amber-800">待处理</span>
                )}
              </div>

              {item.candidates.length > 1 ? (
                <label className="mt-4 grid gap-1 text-sm font-bold text-student-text">
                  归入候选逻辑题
                  <select
                    className="rounded-xl border border-student-border bg-white px-3 py-2 font-normal"
                    onChange={(event) => onChange(item.resolutionId, {
                      action: null,
                      logicalItemId: event.target.value
                    })}
                    value={selectedId}
                  >
                    {item.candidates.map((candidate) => (
                      <option key={candidate.logicalItemId} value={candidate.logicalItemId}>
                        {candidate.title ?? readingModuleLabel(candidate.questionType)} · {candidate.logicalItemId}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <div>
                  <div className="mb-2 text-xs font-semibold text-student-muted">
                    Incoming · {readingSourceLabel(item.incoming)}
                  </div>
                  <ReadingDuplicateDetail preview={item.incoming} title="当前准备导入的 Reading 内容" />
                </div>
                <div>
                  <div className="mb-2 text-xs font-semibold text-student-muted">
                    {selectedCandidate
                      ? `Logical item: ${selectedCandidate.logicalItemId} · First seen: ${selectedCandidate.firstSeenDate} / ${selectedCandidate.firstSeenSourceLabel}`
                      : "候选详情不可用"}
                  </div>
                  <ReadingDuplicateDetail preview={selectedCandidate ?? null} title="系统找到的候选内容" />
                  {selectedCandidate?.sourceOccurrences.length ? (
                    <CandidateOccurrences candidate={selectedCandidate} />
                  ) : null}
                </div>
              </div>

              <div className="mt-5 flex flex-wrap gap-3">
                <button
                  className="teacher-button-primary"
                  disabled={!selectedCandidate}
                  onClick={() => selectedCandidate && onChange(item.resolutionId, {
                    action: "reuse_existing",
                    logicalItemId: selectedCandidate.logicalItemId
                  })}
                  type="button"
                >
                  归入该已有题
                </button>
                <button
                  className="teacher-button-secondary"
                  onClick={() => onChange(item.resolutionId, { action: "create_new" })}
                  type="button"
                >
                  确认为新逻辑题
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ReadingDuplicateDetail({
  preview,
  title
}: {
  preview: ReadingDuplicatePreview | null;
  title: string;
}) {
  return (
    <div className="rounded-xl border border-student-border bg-student-primary-soft/20 p-4">
      <h3 className="text-sm font-bold text-student-primary">{title}</h3>
      {!preview ? (
        <p className="mt-3 text-sm text-student-muted">题目详情不可用。</p>
      ) : preview.questionType === "ctw" ? (
        <CtwDuplicateDetail preview={preview} />
      ) : preview.questionType === "rdl" ? (
        <RdlDuplicateDetail preview={preview} />
      ) : (
        <RapDuplicateDetail preview={preview} />
      )}
    </div>
  );
}

function CtwDuplicateDetail({ preview }: { preview: Extract<ReadingDuplicatePreview, { questionType: "ctw" }> }) {
  return (
    <div className="mt-3 grid gap-3 text-sm">
      <Detail label="Passage" value={preview.detail.passage} />
      <Detail label="Ordered blanks" value={preview.detail.orderedBlanks.join("\n")} />
      <Detail label="Correct answers" value={preview.detail.correctAnswers.join("\n")} />
    </div>
  );
}

function RdlDuplicateDetail({ preview }: { preview: Extract<ReadingDuplicatePreview, { questionType: "rdl" }> }) {
  const canonical = [
    `material_id: ${preview.detail.materialId}`,
    `type: ${preview.detail.materialType ?? "unknown"}`,
    `title: ${preview.detail.materialTitle ?? "无标题"}`,
    `source: ${preview.detail.materialSource}`,
    `image: ${preview.detail.imageAssetPath ?? "未绑定"}`,
    `selection map: ${preview.detail.hitboxDataPath ?? "未绑定"}`
  ].join("\n");
  return (
    <div className="mt-3 grid gap-3 text-sm">
      <Detail label="Canonical material" value={canonical} />
      <Detail label="Questions" value={preview.detail.questions.join("\n\n")} />
    </div>
  );
}

function RapDuplicateDetail({ preview }: { preview: Extract<ReadingDuplicatePreview, { questionType: "rap" }> }) {
  return (
    <div className="mt-3 grid gap-3 text-sm">
      <Detail label="Passage" value={`${preview.detail.passageTitle}\n${preview.detail.passage}`} />
      <Detail label="Question types" value={preview.detail.questionTypes.join(", ")} />
      <Detail label="Questions" value={preview.detail.questions.join("\n\n")} />
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-bold text-student-muted">{label}</div>
      <div className="mt-0.5 whitespace-pre-wrap text-student-text">{value}</div>
    </div>
  );
}

function CandidateOccurrences({ candidate }: { candidate: ReadingDuplicateCandidate }) {
  return (
    <div className="mt-3 rounded-xl border border-student-border bg-student-primary-soft/20 p-3 text-xs text-student-muted">
      <div className="font-bold text-student-text">已有来源记录</div>
      <ul className="mt-1 grid gap-1">
        {candidate.sourceOccurrences.map((occurrence, index) => (
          <li key={`${occurrence.sourceLabel}-${occurrence.sourceModule}-${occurrence.sourceOrder}-${index}`}>
            {readingSourceLabel(occurrence)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function readingModuleLabel(questionType: ReadingDuplicatePreview["questionType"]) {
  return questionType.toUpperCase();
}

function readingSourceLabel(source: Pick<ReadingDuplicatePreview, "sourceLabel" | "occurrenceDate" | "sourceModule" | "sourceOrder" | "sourceQuestionRange">) {
  return [
    source.sourceLabel,
    source.occurrenceDate,
    source.sourceModule ? source.sourceModule.toUpperCase() : null,
    `顺序 ${source.sourceOrder}`,
    source.sourceQuestionRange ? `原题 ${source.sourceQuestionRange}` : null
  ].filter(Boolean).join(" · ");
}
