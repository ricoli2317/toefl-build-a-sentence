import { attachIncomingOccurrencesToHistoricalPackage } from "./historicalDedup.ts";
import type {
  ExistingReadingLogicalItem,
  PreparedReadingImportPackage
} from "./importer.ts";
import {
  readingDuplicateIdentityScope,
  readingDuplicateReasonCode,
  type ReadingDuplicateResolutionInput
} from "./duplicateResolutionModel.ts";
import { arePossibleReadingDuplicates } from "./semantic.ts";
import type { ReadingImportPackage } from "./types.ts";
import {
  buildCtwPackageLogicalIdentity,
  compareCtwPackageLogicalIdentity
} from "./ctwLogicalIdentity.ts";

export type ReadingDuplicateReviewPlan = {
  resolutionId: string;
  questionType: ReadingImportPackage["item"]["module"];
  identityScope: ReturnType<typeof readingDuplicateIdentityScope>;
  reasonCode: ReturnType<typeof readingDuplicateReasonCode>;
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

export function indexReadingDuplicateResolutions(
  reviews: ReadingDuplicateReviewPlan[],
  inputs: ReadingDuplicateResolutionInput[]
) {
  const reviewById = new Map(reviews.map((review) => [review.resolutionId, review]));
  const resolutions = new Map<string, ReadingDuplicateResolutionInput>();
  for (const input of inputs) {
    const review = reviewById.get(input.resolutionId);
    if (!review) throw resolutionError(`待确认项 ${input.resolutionId} 不存在或已经失效。`);
    if (resolutions.has(input.resolutionId)) throw resolutionError(`待确认项 ${input.resolutionId} 重复提交。`);
    if (input.questionType !== review.questionType) {
      throw resolutionError(`待确认项 ${input.resolutionId} 的题型无效。`);
    }
    if (input.action === "reuse_existing" && !review.candidates.some(
      (candidate) => candidate.item.logicalItemId === input.logicalItemId
    )) {
      throw resolutionError(`待确认项 ${input.resolutionId} 选择了无效的候选题。`);
    }
    resolutions.set(input.resolutionId, input);
  }
  return resolutions;
}

export function buildReadingDuplicateReviewPlans(
  prepared: PreparedReadingImportPackage[]
): ReadingDuplicateReviewPlan[] {
  assertCtwPreparedIdentityClusters(prepared);
  const reviews = prepared.flatMap((incoming) => {
    const batchCandidates = prepared
      .filter((candidate) => candidate !== incoming)
      .filter((candidate) => arePossibleReadingDuplicates(incoming.packageData, candidate.packageData))
      .map((candidate) => candidate.packageData);
    const candidatePool = uniquePackages([
      ...incoming.possibleDuplicateCandidates,
      ...batchCandidates
    ]);
    if (incoming.packageData.item.module === "ctw") {
      assertCtwCandidateIdentityClusters(incoming.packageData, candidatePool);
    }
    const candidates = candidatePool.filter(
      (candidate) => candidate.item.logicalItemId !== incoming.packageData.item.logicalItemId
    );
    if (candidates.length === 0) return [];
    const questionType = incoming.packageData.item.module;
    return [{
      resolutionId: `reading-duplicate:${questionType}:${incoming.packageData.item.logicalItemId}`,
      questionType,
      identityScope: readingDuplicateIdentityScope(questionType),
      reasonCode: readingDuplicateReasonCode(questionType),
      reason: possibleDuplicateReason(questionType),
      incoming,
      candidates
    }];
  });

  const reviewByIncoming = new Set(reviews.map((review) => review.incoming));
  const orphanMaterialPending = prepared.find((incoming) =>
    incoming.materialMatchKind === "possible_material_duplicate" && !reviewByIncoming.has(incoming)
  );
  if (orphanMaterialPending) {
    throw resolutionError(
      `RDL 素材 ${orphanMaterialPending.packageData.materials[0]?.materialId ?? "unknown"} ` +
      "需要确认，但系统没有生成可操作候选。"
    );
  }

  return reviews;
}

function assertCtwPreparedIdentityClusters(prepared: PreparedReadingImportPackage[]) {
  const owners = new Map<string, string>();
  for (const item of prepared) {
    if (item.packageData.item.module !== "ctw") continue;
    const identity = buildCtwPackageLogicalIdentity(item.packageData).key;
    const owner = owners.get(identity);
    if (owner && owner !== item.packageData.item.logicalItemId) {
      throw ctwIdentityClusterError(
        `CTW identity ${identity} escaped incoming clustering as ${owner} and ${item.packageData.item.logicalItemId}`
      );
    }
    owners.set(identity, item.packageData.item.logicalItemId);
  }
}

function assertCtwCandidateIdentityClusters(
  incoming: ReadingImportPackage,
  candidates: ReadingImportPackage[]
) {
  const identities = new Map<string, string>();
  for (const candidate of candidates) {
    if (candidate.item.module !== "ctw") continue;
    const comparison = compareCtwPackageLogicalIdentity(incoming, candidate);
    if (comparison.sameLogicalItem) {
      throw ctwIdentityClusterError(
        `CTW ${incoming.item.logicalItemId} and candidate ${candidate.item.logicalItemId} are the same logical item`
      );
    }
    const identity = comparison.rightIdentity.key;
    const owner = identities.get(identity);
    if (owner && owner !== candidate.item.logicalItemId) {
      throw ctwIdentityClusterError(
        `CTW candidate identity ${identity} appears as both ${owner} and ${candidate.item.logicalItemId}`
      );
    }
    identities.set(identity, candidate.item.logicalItemId);
  }
}

function ctwIdentityClusterError(message: string) {
  return Object.assign(new Error(message), {
    code: "READING_CTW_IDENTITY_CLUSTER_INVARIANT",
    operation: "cluster Reading CTW logical identities"
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
    const resolution = resolutions.get(review.resolutionId);
    if (!resolution) throw resolutionError(`待确认项 ${review.resolutionId} 尚未处理。`);
    if (resolution.questionType !== review.questionType) {
      throw resolutionError(`待确认项 ${review.resolutionId} 的题型无效。`);
    }
    if (resolution.action === "create_new") {
      rootCache.set(logicalItemId, logicalItemId);
      return logicalItemId;
    }
    const candidateId = resolution.logicalItemId.trim();
    if (!review.candidates.some((candidate) => candidate.item.logicalItemId === candidateId)) {
      throw resolutionError(`待确认项 ${review.resolutionId} 选择了无效的候选题。`);
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
  return Object.assign(new Error(message), {
    code: "READING_DUPLICATE_RESOLUTION_REQUIRED",
    operation: "resolve Reading possible duplicates"
  });
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
