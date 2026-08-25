"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, RefreshCw } from "lucide-react";
import { broadcastQuestionBankUpdated } from "@/lib/questionBankCacheEvents";
import { teacherApiFetch } from "@/lib/teacherClientApi";

type QuestionPreview = {
  questionId: string;
  setId: string;
  setTitle: string;
  fields: Array<{ label: string; value: string }>;
};

type ReviewCandidate = {
  itemId: string;
  displayNumber: string;
  displayTitle: string | null;
  canonical: QuestionPreview | null;
};

type ImportReview = {
  reviewId: string;
  taskType: "build_sentence" | "email" | "academic_discussion";
  createdAt: string;
  sourceQuestionId: string | null;
  proposedDisplayTitle: string;
  similarity: Record<string, unknown>;
  occurrences: Array<{ occurred_on?: string; source_label?: string }>;
  incoming: QuestionPreview | null;
  candidates: ReviewCandidate[];
  canResolve: boolean;
};

type ReviewDraft = {
  candidateItemId: string;
  displayTitle: string;
};

export function TeacherImportReviews() {
  const [reviews, setReviews] = useState<ImportReview[]>([]);
  const [drafts, setDrafts] = useState<Record<string, ReviewDraft>>({});
  const [loading, setLoading] = useState(true);
  const [resolvingId, setResolvingId] = useState("");
  const [error, setError] = useState("");

  const loadReviews = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const payload = await teacherApiFetch<{ reviews: ImportReview[] }>(
        "/api/teacher/import-reviews"
      );
      setReviews(payload.reviews);
      setDrafts((current) => Object.fromEntries(payload.reviews.map((review) => [
        review.reviewId,
        current[review.reviewId] ?? {
          candidateItemId: review.candidates[0]?.itemId ?? "",
          displayTitle: review.proposedDisplayTitle
        }
      ])));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "无法读取待确认题目。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadReviews();
    const refresh = () => void loadReviews();
    window.addEventListener("tps:import-reviews-updated", refresh);
    return () => window.removeEventListener("tps:import-reviews-updated", refresh);
  }, [loadReviews]);

  async function resolve(review: ImportReview, resolution: "merge" | "new") {
    const draft = drafts[review.reviewId] ?? {
      candidateItemId: review.candidates[0]?.itemId ?? "",
      displayTitle: review.proposedDisplayTitle
    };
    const candidate = review.candidates.find((item) => item.itemId === draft.candidateItemId);
    const prompt = resolution === "merge"
      ? `确认把 ${review.sourceQuestionId ?? "该来源"} 归入题目${candidate?.displayNumber ?? ""}？原始题不会删除，只会补充来源和出现日期。`
      : `确认把 ${review.sourceQuestionId ?? "该来源"} 建立为新的逻辑题？`;
    if (!window.confirm(prompt)) return;

    setResolvingId(review.reviewId);
    setError("");
    try {
      await teacherApiFetch("/api/teacher/import-reviews", {
        method: "POST",
        body: JSON.stringify({
          reviewId: review.reviewId,
          resolution,
          candidateItemId: draft.candidateItemId,
          displayTitle: draft.displayTitle
        })
      });
      broadcastQuestionBankUpdated();
      await loadReviews();
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : "待确认题目处理失败。");
    } finally {
      setResolvingId("");
    }
  }

  return (
    <section className="teacher-card p-6 sm:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-student-text">重复题待确认</h2>
          <p className="mt-1 text-sm text-student-muted">
            人工确认近似题是归入已有逻辑题，还是作为一题新建。
          </p>
        </div>
        <button
          className="teacher-button-secondary inline-flex items-center gap-2"
          disabled={loading || Boolean(resolvingId)}
          onClick={() => void loadReviews()}
          type="button"
        >
          <RefreshCw aria-hidden="true" size={16} />
          刷新
        </button>
      </div>

      {error ? <p className="teacher-error mt-4">{error}</p> : null}
      {loading ? (
        <p className="mt-5 text-sm font-semibold text-student-muted" role="status">
          正在读取待确认记录…
        </p>
      ) : reviews.length === 0 ? (
        <p className="mt-5 rounded-xl border border-student-border bg-student-primary-soft/30 p-4 text-sm font-semibold text-student-muted">
          当前没有待确认的重复题。
        </p>
      ) : (
        <div className="mt-5 grid gap-5">
          {reviews.map((review) => {
            const draft = drafts[review.reviewId] ?? {
              candidateItemId: review.candidates[0]?.itemId ?? "",
              displayTitle: review.proposedDisplayTitle
            };
            const selectedCandidate = review.candidates.find(
              (candidate) => candidate.itemId === draft.candidateItemId
            ) ?? review.candidates[0];
            return (
              <article className="rounded-2xl border border-student-primary-border p-5" key={review.reviewId}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-bold text-student-text">
                      {taskLabel(review.taskType)} · {review.sourceQuestionId ?? review.incoming?.setId ?? "未知来源"}
                    </p>
                    <p className="mt-1 text-xs font-semibold text-student-muted">
                      来源：{occurrenceLabel(review)} · 相似度：{similarityLabel(review.similarity)}
                    </p>
                  </div>
                  {selectedCandidate ? (
                    <span className="rounded-full bg-student-primary-soft px-3 py-1 text-sm font-bold text-student-primary">
                      候选：题目{selectedCandidate.displayNumber}{selectedCandidate.displayTitle ? ` ${selectedCandidate.displayTitle}` : ""}
                    </span>
                  ) : null}
                </div>

                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  <QuestionCard title="待确认来源" preview={review.incoming} />
                  <QuestionCard title="已有逻辑题的标准来源" preview={selectedCandidate?.canonical ?? null} />
                </div>

                {review.candidates.length > 1 ? (
                  <label className="mt-4 grid gap-1 text-sm font-bold text-student-text">
                    归入候选题
                    <select
                      className="rounded-xl border border-student-border bg-white px-3 py-2 font-normal"
                      onChange={(event) => updateDraft(review.reviewId, { candidateItemId: event.target.value })}
                      value={draft.candidateItemId}
                    >
                      {review.candidates.map((candidate) => (
                        <option key={candidate.itemId} value={candidate.itemId}>
                          题目{candidate.displayNumber} {candidate.displayTitle ?? ""}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                {review.canResolve ? (
                  <div className="mt-5 flex flex-wrap items-end gap-3">
                    <button
                      className="teacher-button-primary inline-flex items-center gap-2"
                      disabled={!selectedCandidate || resolvingId === review.reviewId}
                      onClick={() => void resolve(review, "merge")}
                      type="button"
                    >
                      <Check aria-hidden="true" size={16} />
                      {resolvingId === review.reviewId ? "处理中…" : "确认归入已有题"}
                    </button>
                    <label className="grid min-w-56 flex-1 gap-1 text-sm font-bold text-student-text">
                      若作为新题，小标题（1–5 个英文单词）
                      <input
                        className="rounded-xl border border-student-border bg-white px-3 py-2 font-normal"
                        onChange={(event) => updateDraft(review.reviewId, { displayTitle: event.target.value })}
                        placeholder="例如 Mentorship Appreciation"
                        value={draft.displayTitle}
                      />
                    </label>
                    <button
                      className="teacher-button-secondary"
                      disabled={!draft.displayTitle.trim() || resolvingId === review.reviewId}
                      onClick={() => void resolve(review, "new")}
                      type="button"
                    >
                      确认为新逻辑题
                    </button>
                  </div>
                ) : (
                  <p className="mt-4 text-sm font-semibold text-student-error">
                    BAS 待确认项暂不支持在此处理。
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );

  function updateDraft(reviewId: string, patch: Partial<ReviewDraft>) {
    setDrafts((current) => ({
      ...current,
      [reviewId]: { ...current[reviewId], ...patch }
    }));
  }
}

function QuestionCard({ preview, title }: { preview: QuestionPreview | null; title: string }) {
  return (
    <div className="rounded-xl border border-student-border bg-student-primary-soft/20 p-4">
      <h3 className="text-sm font-bold text-student-primary">{title}</h3>
      {!preview ? (
        <p className="mt-3 text-sm text-student-muted">题目详情不可用。</p>
      ) : (
        <div className="mt-3 grid gap-3 text-sm">
          {preview.fields.map((field) => (
            <div key={field.label}>
              <div className="font-bold text-student-muted">{field.label}</div>
              <div className="mt-0.5 whitespace-pre-wrap text-student-text">{field.value}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function taskLabel(taskType: ImportReview["taskType"]) {
  if (taskType === "email") return "Email";
  if (taskType === "academic_discussion") return "Academic Discussion";
  return "Build a Sentence";
}

function occurrenceLabel(review: ImportReview) {
  const labels = review.occurrences.map((occurrence) =>
    occurrence.source_label || occurrence.occurred_on || ""
  ).filter(Boolean);
  return labels.join(" / ") || "无日期";
}

function similarityLabel(summary: Record<string, unknown>) {
  const score = typeof summary.score === "number"
    ? summary.score
    : typeof summary.remainingSimilarity === "number"
      ? summary.remainingSimilarity
      : null;
  return score === null ? "近似重复" : `${(score * 100).toFixed(1)}%`;
}
