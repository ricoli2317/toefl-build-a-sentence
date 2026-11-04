import type { CorrectionResolutionStatus } from "./writingCorrectionReviewSchema.ts";
import type {
  CorrectionCompletion,
  CorrectionIssueView,
  CorrectionReviewState
} from "./writingCorrectionReview.ts";
import { CORRECTION_ISSUE_WEIGHT } from "./writingCorrectionReview.ts";

export const CORRECTION_STATUS_LABEL: Record<CorrectionResolutionStatus, string> = {
  resolved: "已解决",
  partially_resolved: "部分解决",
  unresolved: "未解决",
  uncertain: "无法确定"
};

export const CORRECTION_STATUS_ORDER: CorrectionResolutionStatus[] = [
  "resolved",
  "partially_resolved",
  "unresolved",
  "uncertain"
];

export const CORRECTION_STATUS_TONE: Record<CorrectionResolutionStatus, string> = {
  resolved: "bg-emerald-50 text-emerald-700",
  partially_resolved: "bg-amber-50 text-amber-700",
  unresolved: "bg-rose-50 text-rose-700",
  uncertain: "bg-slate-100 text-slate-600"
};

export const CORRECTION_ISSUE_TYPE_LABEL: Record<string, string> = {
  language_edit: "语言",
  content_feedback: "内容"
};

export function correctionPercent(rate: number | null) {
  if (rate === null) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

export function correctionWeightLabel(issue: CorrectionIssueView) {
  return issue.issue_type === "content_feedback"
    ? `${CORRECTION_ISSUE_WEIGHT.content_feedback} 分权重`
    : `${CORRECTION_ISSUE_WEIGHT.language_edit} 分权重`;
}

export function correctionCompletionSummary(completion: CorrectionCompletion) {
  if (!completion.applicable) {
    return {
      label: "无原始问题",
      detail: "原始批改没有可审核的问题，完成度不适用。"
    };
  }
  return {
    label: correctionPercent(completion.rate),
    detail: `已获权重 ${formatWeight(completion.completed_weight)} / 总权重 ${formatWeight(completion.total_weight)}`
  };
}

function formatWeight(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** The reviewer sees one row per frozen issue, in published order. */
export function correctionIssueSummary(state: CorrectionReviewState) {
  return {
    total: state.issues.length,
    language: state.issues.filter((issue) => issue.issue_type === "language_edit").length,
    content: state.issues.filter((issue) => issue.issue_type === "content_feedback").length,
    counts: state.completion.counts
  };
}

export function correctionScoreLabel(score: number | null) {
  return score === null ? "—" : String(score);
}

export function correctionDeltaLabel(delta: number | null) {
  if (delta === null) return "—";
  if (delta === 0) return "0";
  return delta > 0 ? `+${delta}` : String(delta);
}
