import { attachIncomingOccurrencesToHistoricalPackage } from "./historicalDedup.ts";
import type {
  ExistingReadingLogicalItem,
  PreparedReadingImportPackage
} from "./importer.ts";
import type { ReadingImportPackage } from "./types.ts";

export type ReadingDuplicateResolutionInput = {
  pendingId: string;
  action: "reuse_existing" | "create_new";
  candidateLogicalItemId?: string;
};

export type ReadingDuplicateReviewPlan = {
  pendingId: string;
  reason: string;
  incoming: PreparedReadingImportPackage;
  candidates: ReadingImportPackage[];
};

export type ResolvedReadingImport = {
  packageData: ReadingImportPackage;
  existingItem: ExistingReadingLogicalItem | null;
  members: PreparedReadingImportPackage[];
  manuallyResolved: boolean;
};

export function buildReadingDuplicateReviewPlans(
  prepared: PreparedReadingImportPackage[],
  groupedDuplicates: Array<{ reason: string; sourceOccurrences: string[] }>
): ReadingDuplicateReviewPlan[] {
  const batchCandidates = new Map<PreparedReadingImportPackage, ReadingImportPackage[]>();
  const batchReasons = new Map<PreparedReadingImportPackage, string>();

  for (const duplicate of groupedDuplicates) {
    const sourceLabels = new Set(duplicate.sourceOccurrences);
    const matches = prepared.filter((item) =>
      item.packageData.occurrences.some((occurrence) => sourceLabels.has(occurrence.sourceLabel))
    );
    // Exact/semantic coalescing may already have safely put all occurrences in
    // one package. Only distinct packages need a manual decision.
    if (matches.length < 2) continue;
    for (const incoming of matches) {
      const peers = matches
        .filter((candidate) => candidate !== incoming)
        .map((candidate) => candidate.packageData);
      batchCandidates.set(incoming, [...(batchCandidates.get(incoming) ?? []), ...peers]);
      batchReasons.set(incoming, duplicate.reason);
    }
  }

  return prepared.flatMap((incoming) => {
    const candidates = uniquePackages([
      ...incoming.possibleDuplicateCandidates,
      ...(batchCandidates.get(incoming) ?? [])
    ]).filter((candidate) => candidate.item.logicalItemId !== incoming.packageData.item.logicalItemId);
    if (candidates.length === 0) return [];
    return [{
      pendingId: `reading-duplicate:${incoming.packageData.item.logicalItemId}`,
      reason: batchReasons.get(incoming) ?? possibleDuplicateReason(incoming.packageData.item.module),
      incoming,
      candidates
    }];
  });
}

export function resolveReadingDuplicateImports(
  prepared: PreparedReadingImportPackage[],
  reviews: ReadingDuplicateReviewPlan[],
  resolutions: Map<string, ReadingDuplicateResolutionInput>
): ResolvedReadingImport[] {
  const preparedById = new Map(
    prepared.map((item) => [item.packageData.item.logicalItemId, item])
  );
  const reviewByIncomingId = new Map(
    reviews.map((review) => [review.incoming.packageData.item.logicalItemId, review])
  );
  const candidateById = new Map<string, ReadingImportPackage>();
  for (const item of prepared) candidateById.set(item.packageData.item.logicalItemId, item.packageData);
  for (const review of reviews) {
    for (const candidate of review.candidates) {
      candidateById.set(candidate.item.logicalItemId, candidate);
    }
  }

  const rootCache = new Map<string, string>();
  function rootFor(logicalItemId: string, path: string[] = []): string {
    const cached = rootCache.get(logicalItemId);
    if (cached) return cached;
    if (path.includes(logicalItemId)) {
      throw resolutionError("Reading 重复题处理形成了循环归组，请调整候选题选择。");
    }
    const review = reviewByIncomingId.get(logicalItemId);
    if (!review) return logicalItemId;
    const resolution = resolutions.get(review.pendingId);
    if (!resolution) throw resolutionError(`待确认项 ${review.pendingId} 尚未处理。`);
    if (resolution.action === "create_new") {
      rootCache.set(logicalItemId, logicalItemId);
      return logicalItemId;
    }
    const candidateId = resolution.candidateLogicalItemId?.trim() ?? "";
    if (!review.candidates.some((candidate) => candidate.item.logicalItemId === candidateId)) {
      throw resolutionError(`待确认项 ${review.pendingId} 选择了无效的候选题。`);
    }
    const root = preparedById.has(candidateId)
      ? rootFor(candidateId, [...path, logicalItemId])
      : candidateId;
    rootCache.set(logicalItemId, root);
    return root;
  }

  const membersByRoot = new Map<string, PreparedReadingImportPackage[]>();
  for (const item of prepared) {
    const itemId = item.packageData.item.logicalItemId;
    const root = rootFor(itemId);
    membersByRoot.set(root, [...(membersByRoot.get(root) ?? []), item]);
  }

  return Array.from(membersByRoot.entries()).map(([rootId, members]) => {
    const canonical = candidateById.get(rootId);
    if (!canonical) throw resolutionError(`Reading 候选题 ${rootId} 的标准内容不可用。`);
    const occurrences = new Map<string, ReadingImportPackage["occurrences"][number]>();
    for (const member of members) {
      const incoming = member.packageData;
      const mapped = incoming.item.logicalItemId === rootId
        ? incoming
        : attachIncomingOccurrencesToHistoricalPackage(canonical, incoming);
      for (const occurrence of mapped.occurrences) occurrences.set(occurrence.occurrenceId, occurrence);
    }
    const rootPrepared = preparedById.get(rootId);
    // An incoming root without a historical match is still new. Only roots
    // that came exclusively from the candidate library may be synthesized as
    // existing; treating every canonical package as existing corrupts final
    // import metrics while the RPC still creates the row.
    const existingItem = rootPrepared
      ? rootPrepared.existingItem
      : existingLogicalItemFromPackage(canonical);
    const orderedOccurrences = Array.from(occurrences.values()).sort(compareOccurrences);
    const firstOccurrence = orderedOccurrences[0];
    return {
      packageData: {
        ...canonical,
        item: {
          ...canonical.item,
          firstSeenDate: firstOccurrence.occurrenceDate,
          firstSeenSourceLabel: firstOccurrence.sourceLabel,
          firstSeenSourceOrder: firstOccurrence.sourceOrder
        },
        occurrences: orderedOccurrences
      },
      existingItem,
      members,
      manuallyResolved: members.some((member) => reviewByIncomingId.has(member.packageData.item.logicalItemId))
    };
  });
}

const sourceLabelCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function compareOccurrences(
  left: ReadingImportPackage["occurrences"][number],
  right: ReadingImportPackage["occurrences"][number]
) {
  return left.occurrenceDate.localeCompare(right.occurrenceDate)
    || sourceLabelCollator.compare(left.sourceLabel, right.sourceLabel)
    || left.sourceOrder - right.sourceOrder;
}

function resolutionError(message: string) {
  return Object.assign(new Error(message), { operation: "resolve Reading possible duplicates" });
}

function existingLogicalItemFromPackage(packageData: ReadingImportPackage): ExistingReadingLogicalItem {
  return {
    logicalItemId: packageData.item.logicalItemId,
    dedupFingerprint: packageData.item.dedupFingerprint,
    date: packageData.item.firstSeenDate,
    sourceLabel: packageData.item.firstSeenSourceLabel,
    sourceOrder: packageData.item.firstSeenSourceOrder
  };
}

function uniquePackages(packages: ReadingImportPackage[]) {
  return Array.from(new Map(packages.map((item) => [item.item.logicalItemId, item])).values());
}

function possibleDuplicateReason(module: ReadingImportPackage["item"]["module"]) {
  if (module === "ctw") return "文章框架相似，但正文或填空答案存在实质差异。";
  if (module === "rdl") return "素材可能相同，但题目转录或答案信息存在差异。";
  return "文章可能相同，但题组内容存在差异。";
}
