import {
  CTW_LOGICAL_IDENTITY_VERSION,
  buildCtwMaskedFramework,
  buildCtwLogicalIdentity,
  compareCtwLogicalIdentity,
  ctwSlotReviewText,
  normalizeCtwAnswer,
  normalizeCtwIdentityPassage,
  reconstructCompletedCtwPassage
} from "./ctwLogicalIdentity.server.ts";
import type { CtwQuestion } from "./types.ts";

export type CtwAuditOccurrence = {
  occurrenceId: string;
  sourceKind: string;
  sourceLabel: string;
  occurrenceDate: string;
  sourceModule: string;
  sourceOrder: number;
  sourceQuestionStart: number;
  sourceQuestionEnd: number;
};

export type CtwAuditLogicalItemInput = {
  logicalItemId: string;
  title: string | null;
  firstSeenDate: string;
  firstSeenSourceLabel: string;
  firstSeenSourceOrder: number;
  oldFingerprint: string;
  question: CtwQuestion;
  occurrences: CtwAuditOccurrence[];
  relatedRecordCounts?: Record<string, number>;
};

export type CtwAuditPrefixConflict = {
  kind: "prefix_conflict";
  slotOrder: number;
  answer: string;
  versions: Array<{
    logicalItemId: string;
    prefix: string;
    sources: Array<{
      occurrenceId: string;
      sourceLabel: string;
      occurrenceDate: string;
      sourceModule: string;
      sourceOrder: number;
    }>;
  }>;
};

export type CtwAuditSlotContentConflict = {
  kind: "prefix_conflict" | "answer_conflict" | "prefix_and_answer_conflict";
  slotOrder: number;
  versions: Array<{
    logicalItemId: string;
    prefix: string;
    answer: string;
    reviewText: string;
    sources: CtwAuditOccurrence[];
  }>;
};

export type CtwAuditDuplicateOccurrenceMapping = {
  kind: "duplicate_occurrence_mapping";
  sourceMappingKey: string;
  mappings: Array<{
    logicalItemId: string;
    occurrenceId: string;
    sourceLabel: string;
    occurrenceDate: string;
    sourceModule: string;
    sourceOrder: number;
    sourceQuestionStart: number;
    sourceQuestionEnd: number;
  }>;
};

export type CtwAuditRepresentationDifference = {
  kind:
    | "punctuation_difference"
    | "whitespace_or_case_difference"
    | "blank_rendering_difference"
    | "raw_serialization_difference"
    | "answer_normalization_difference"
    | "stem_difference"
    | "paragraph_or_blank_structure_difference";
  requiresManualReview: boolean;
  description: string;
};

export type CtwAuditCanonicalRepresentation = {
  questionId: string;
  stem: string;
  rawDisplayText: string | null;
  completedPassage: string;
  paragraphs: Array<{
    paragraphOrder: number;
    rawText: string;
    segments: Array<
      | { kind: "text"; text: string }
      | { kind: "blank"; slotOrder: number }
    >;
  }>;
  slots: Array<{
    slotOrder: number;
    paragraphOrder: number;
    answer: string;
    prefix: string;
    displayText: string;
    missingText: string;
    missingLength: number;
  }>;
};

export type CtwAuditClusterMember = {
  logicalItemId: string;
  title: string | null;
  firstSeen: {
    date: string;
    sourceLabel: string;
    sourceOrder: number;
  };
  oldFingerprint: string;
  occurrenceCount: number;
  occurrences: CtwAuditOccurrence[];
  relatedRecordCounts: Record<string, number>;
  canonicalRepresentation: CtwAuditCanonicalRepresentation;
};

export type CtwAuditDuplicateCluster = {
  clusterId: string;
  identityKey: string;
  normalizedMaskedParagraphs: string[];
  orderedBlankSequence: number[];
  logicalItemCount: number;
  logicalItemIds: string[];
  theoreticalOccurrenceCount: number;
  distinctOccurrenceIdCount: number;
  members: CtwAuditClusterMember[];
  prefixConflicts: CtwAuditPrefixConflict[];
  slotContentConflicts: CtwAuditSlotContentConflict[];
  representationDifferences: CtwAuditRepresentationDifference[];
  duplicateOccurrenceMappings: CtwAuditDuplicateOccurrenceMapping[];
  conflictKinds: string[];
  punctuationOrRenderingOnly: boolean;
  requiresOtherManualReview: boolean;
};

export type CtwLogicalIdentityAuditManifest = {
  schemaVersion: 1;
  identityVersion: string;
  generatedAt: string;
  totalLogicalItems: number;
  totalOccurrencesAudited: number;
  uniqueIdentityCount: number;
  uniqueLogicalItemCount: number;
  duplicateClusterCount: number;
  duplicateLogicalItemCount: number;
  theoreticalLogicalItemReduction: number;
  prefixConflictClusterCount: number;
  answerConflictClusterCount: number;
  prefixAndAnswerConflictClusterCount: number;
  punctuationOnlyClusterCount: number;
  duplicateOccurrenceMappingCount: number;
  duplicateOccurrenceMappingRecordCount: number;
  otherManualReviewClusterCount: number;
  knownAccessCaseVerification: {
    status: "not_found" | "single_database_version" | "duplicate_cluster_found" | "multiple_distinct_matches";
    matchingLogicalItemCount: number;
    acPrefixVersionPresent: boolean;
    accPrefixVersionPresent: boolean;
    resourcesSuchVersionPresent: boolean;
    resourcesCommaSuchVersionPresent: boolean;
    logicalItems: Array<{
      logicalItemId: string;
      identityKey: string;
      accessPrefix: string | null;
      accessDisplayText: string | null;
      resourcesPrefix: string | null;
      resourcesDisplayText: string | null;
      hasCommaBetweenResourcesAndSuch: boolean;
      passageExcerpt: string;
      occurrences: CtwAuditOccurrence[];
    }>;
  };
  relatedTablesForFutureMerge: Array<{
    table: string;
    referenceFields: string[];
    role: string;
  }>;
  clusters: CtwAuditDuplicateCluster[];
};

export const CTW_RELATED_TABLES_FOR_FUTURE_MERGE = [
  { table: "reading_logical_items", referenceFields: ["logical_item_id"], role: "logical item root" },
  { table: "reading_source_occurrences", referenceFields: ["logical_item_id", "occurrence_id"], role: "source provenance" },
  { table: "reading_questions", referenceFields: ["logical_item_id", "question_id"], role: "canonical CTW question" },
  { table: "reading_question_occurrences", referenceFields: ["logical_item_id", "occurrence_id", "question_id"], role: "source-to-question mapping" },
  { table: "reading_ctw_paragraphs", referenceFields: ["question_id", "paragraph_id"], role: "canonical paragraph content" },
  { table: "reading_ctw_segments", referenceFields: ["question_id", "paragraph_id", "slot_id"], role: "canonical segment structure" },
  { table: "reading_ctw_slots", referenceFields: ["question_id", "slot_id"], role: "canonical answers and blank presentation" },
  { table: "reading_attempts", referenceFields: ["logical_item_id"], role: "ordinary student attempts" },
  { table: "reading_attempt_answers", referenceFields: ["logical_item_id", "question_id", "slot_id"], role: "ordinary attempt answers/statistics source" },
  { table: "reading_full_set_answers", referenceFields: ["occurrence_id", "logical_item_id", "question_id", "slot_id"], role: "full-set answers/statistics source" },
  { table: "reading_full_set_load_pauses", referenceFields: ["occurrence_id"], role: "full-set occurrence load tracking" },
  { table: "reading_wrongbook_attempts", referenceFields: ["logical_item_id", "targets"], role: "ordinary and full-set correction attempts" },
  { table: "reading_wrongbook_attempt_answers", referenceFields: ["logical_item_id", "question_id", "slot_id", "source_occurrence_id"], role: "wrongbook answers and source occurrence references" }
] as const;

export function auditCtwLogicalIdentities(
  items: CtwAuditLogicalItemInput[],
  generatedAt = new Date().toISOString()
): CtwLogicalIdentityAuditManifest {
  const byIdentity = new Map<string, Array<{
    input: CtwAuditLogicalItemInput;
    identity: ReturnType<typeof buildCtwLogicalIdentity>;
  }>>();
  for (const input of items) {
    const identity = buildCtwLogicalIdentity(input.question);
    byIdentity.set(identity.key, [...(byIdentity.get(identity.key) ?? []), { input, identity }]);
  }

  const duplicateGroups = Array.from(byIdentity.values())
    .filter((group) => group.length >= 2)
    .sort((left, right) => left[0].identity.key.localeCompare(right[0].identity.key));

  const clusters = duplicateGroups.map((group, index) => buildDuplicateCluster(
    group.map((entry) => entry.input),
    group[0].identity,
    `CTW-DUP-${String(index + 1).padStart(3, "0")}`
  ));
  const duplicateLogicalItemCount = clusters.reduce(
    (total, cluster) => total + cluster.logicalItemCount,
    0
  );

  return {
    schemaVersion: 1,
    identityVersion: items[0]
      ? buildCtwLogicalIdentity(items[0].question).version
      : CTW_LOGICAL_IDENTITY_VERSION,
    generatedAt,
    totalLogicalItems: items.length,
    totalOccurrencesAudited: items.reduce((total, item) => total + item.occurrences.length, 0),
    uniqueIdentityCount: byIdentity.size,
    uniqueLogicalItemCount: Array.from(byIdentity.values()).filter((group) => group.length === 1).length,
    duplicateClusterCount: clusters.length,
    duplicateLogicalItemCount,
    theoreticalLogicalItemReduction: duplicateLogicalItemCount - clusters.length,
    prefixConflictClusterCount: clusters.filter((cluster) => cluster.prefixConflicts.length > 0).length,
    answerConflictClusterCount: clusters.filter((cluster) =>
      cluster.slotContentConflicts.some((conflict) => conflict.kind === "answer_conflict")
    ).length,
    prefixAndAnswerConflictClusterCount: clusters.filter((cluster) =>
      cluster.slotContentConflicts.some((conflict) => conflict.kind === "prefix_and_answer_conflict")
    ).length,
    punctuationOnlyClusterCount: clusters.filter((cluster) => cluster.punctuationOrRenderingOnly).length,
    duplicateOccurrenceMappingCount: clusters.filter(
      (cluster) => cluster.duplicateOccurrenceMappings.length > 0
    ).length,
    duplicateOccurrenceMappingRecordCount: clusters.reduce(
      (total, cluster) => total + cluster.duplicateOccurrenceMappings.length,
      0
    ),
    otherManualReviewClusterCount: clusters.filter(
      (cluster) => cluster.requiresOtherManualReview
    ).length,
    knownAccessCaseVerification: verifyKnownAccessCase(items),
    relatedTablesForFutureMerge: CTW_RELATED_TABLES_FOR_FUTURE_MERGE.map((entry) => ({
      table: entry.table,
      referenceFields: [...entry.referenceFields],
      role: entry.role
    })),
    clusters
  };
}

function verifyKnownAccessCase(items: CtwAuditLogicalItemInput[]) {
  const matching = items.flatMap((item) => {
    const identity = buildCtwLogicalIdentity(item.question);
    const completedPassage = reconstructCompletedCtwPassage(item.question);
    if (!normalizeCtwIdentityPassage(completedPassage).includes("dictate access to resources such")) return [];
    const slots = [...item.question.payload.slots].sort(
      (left, right) => left.slotOrder - right.slotOrder
    );
    const access = slots.find((slot) => normalizeCtwAnswer(slot.answer) === "access") ?? null;
    const resources = slots.find((slot) => normalizeCtwAnswer(slot.answer) === "resources") ?? null;
    const matchIndex = completedPassage.toLocaleLowerCase("en-US").indexOf("dictate");
    return [{
      logicalItemId: item.logicalItemId,
      identityKey: identity.key,
      accessPrefix: access?.prefix ?? null,
      accessDisplayText: access?.displayText ?? null,
      resourcesPrefix: resources?.prefix ?? null,
      resourcesDisplayText: resources?.displayText ?? null,
      hasCommaBetweenResourcesAndSuch: /resources\s*,\s*such/i.test(completedPassage),
      passageExcerpt: matchIndex >= 0
        ? completedPassage.slice(matchIndex, matchIndex + 100)
        : completedPassage.slice(0, 100),
      occurrences: [...item.occurrences].sort(compareOccurrences)
    }];
  });
  const identityCounts = new Map<string, number>();
  for (const item of matching) {
    identityCounts.set(item.identityKey, (identityCounts.get(item.identityKey) ?? 0) + 1);
  }
  const duplicateClusterFound = Array.from(identityCounts.values()).some((count) => count >= 2);
  return {
    status: matching.length === 0
      ? "not_found" as const
      : duplicateClusterFound
        ? "duplicate_cluster_found" as const
        : matching.length === 1
          ? "single_database_version" as const
          : "multiple_distinct_matches" as const,
    matchingLogicalItemCount: matching.length,
    acPrefixVersionPresent: matching.some((item) => normalizeCtwAnswer(item.accessPrefix ?? "") === "ac"),
    accPrefixVersionPresent: matching.some((item) => normalizeCtwAnswer(item.accessPrefix ?? "") === "acc"),
    resourcesSuchVersionPresent: matching.some((item) => !item.hasCommaBetweenResourcesAndSuch),
    resourcesCommaSuchVersionPresent: matching.some((item) => item.hasCommaBetweenResourcesAndSuch),
    logicalItems: matching
  };
}

function buildDuplicateCluster(
  items: CtwAuditLogicalItemInput[],
  identity: ReturnType<typeof buildCtwLogicalIdentity>,
  clusterId: string
): CtwAuditDuplicateCluster {
  const orderedItems = [...items].sort((left, right) =>
    left.firstSeenDate.localeCompare(right.firstSeenDate)
    || left.firstSeenSourceLabel.localeCompare(right.firstSeenSourceLabel)
    || left.firstSeenSourceOrder - right.firstSeenSourceOrder
    || left.logicalItemId.localeCompare(right.logicalItemId)
  );
  assertOneSharedIdentity(orderedItems);
  const members = orderedItems.map(buildMember);
  const slotContentConflicts = buildSlotContentConflicts(orderedItems);
  const prefixConflicts = slotContentConflicts
    .filter((conflict) => conflict.kind === "prefix_conflict")
    .map((conflict) => ({
      kind: "prefix_conflict" as const,
      slotOrder: conflict.slotOrder,
      answer: conflict.versions[0]?.answer ?? "",
      versions: conflict.versions.map((version) => ({
        logicalItemId: version.logicalItemId,
        prefix: version.prefix,
        sources: version.sources
      }))
    }));
  const representationDifferences = buildRepresentationDifferences(orderedItems, members);
  const duplicateOccurrenceMappings = findDuplicateOccurrenceMappings(orderedItems);
  const requiresOtherManualReview = representationDifferences.some(
    (difference) => difference.requiresManualReview
  );
  const presentationDifferenceKinds = new Set([
    "punctuation_difference",
    "whitespace_or_case_difference",
    "blank_rendering_difference",
    "raw_serialization_difference",
    "answer_normalization_difference"
  ]);
  const punctuationOrRenderingOnly =
    slotContentConflicts.length === 0
    && duplicateOccurrenceMappings.length === 0
    && !requiresOtherManualReview
    && representationDifferences.length > 0
    && representationDifferences.every((difference) => presentationDifferenceKinds.has(difference.kind));
  const conflictKinds = Array.from(new Set([
    ...slotContentConflicts.map((conflict) => conflict.kind),
    ...representationDifferences.map((difference) => difference.kind),
    ...duplicateOccurrenceMappings.map((mapping) => mapping.kind)
  ]));

  return {
    clusterId,
    identityKey: identity.key,
    normalizedMaskedParagraphs: identity.normalizedMaskedParagraphs,
    orderedBlankSequence: identity.orderedBlankSequence,
    logicalItemCount: members.length,
    logicalItemIds: members.map((member) => member.logicalItemId),
    theoreticalOccurrenceCount: members.reduce((total, member) => total + member.occurrenceCount, 0),
    distinctOccurrenceIdCount: new Set(
      members.flatMap((member) => member.occurrences.map((occurrence) => occurrence.occurrenceId))
    ).size,
    members,
    prefixConflicts,
    slotContentConflicts,
    representationDifferences,
    duplicateOccurrenceMappings,
    conflictKinds,
    punctuationOrRenderingOnly,
    requiresOtherManualReview
  };
}

function assertOneSharedIdentity(items: CtwAuditLogicalItemInput[]) {
  for (let leftIndex = 0; leftIndex < items.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < items.length; rightIndex += 1) {
      const comparison = compareCtwLogicalIdentity(
        items[leftIndex].question,
        items[rightIndex].question
      );
      if (!comparison.sameLogicalItem) {
        throw new Error("CTW audit cluster contains more than one logical identity");
      }
    }
  }
}

function buildMember(input: CtwAuditLogicalItemInput): CtwAuditClusterMember {
  return {
    logicalItemId: input.logicalItemId,
    title: input.title,
    firstSeen: {
      date: input.firstSeenDate,
      sourceLabel: input.firstSeenSourceLabel,
      sourceOrder: input.firstSeenSourceOrder
    },
    oldFingerprint: input.oldFingerprint,
    occurrenceCount: input.occurrences.length,
    occurrences: [...input.occurrences].sort(compareOccurrences),
    relatedRecordCounts: sortRecord(input.relatedRecordCounts ?? {}),
    canonicalRepresentation: canonicalRepresentation(input.question)
  };
}

function canonicalRepresentation(question: CtwQuestion): CtwAuditCanonicalRepresentation {
  const paragraphOrder = new Map(
    question.payload.paragraphs.map((paragraph) => [paragraph.paragraphId, paragraph.paragraphOrder])
  );
  const slotOrder = new Map(
    question.payload.slots.map((slot) => [slot.slotId, slot.slotOrder])
  );
  return {
    questionId: question.questionId,
    stem: question.stem,
    rawDisplayText: question.rawDisplayText,
    completedPassage: reconstructCompletedCtwPassage(question),
    paragraphs: [...question.payload.paragraphs]
      .sort((left, right) => left.paragraphOrder - right.paragraphOrder)
      .map((paragraph) => ({
        paragraphOrder: paragraph.paragraphOrder,
        rawText: paragraph.rawText,
        segments: paragraph.segments.map((segment) => segment.kind === "text"
          ? { kind: "text" as const, text: segment.text }
          : { kind: "blank" as const, slotOrder: requiredMap(slotOrder, segment.slotId) })
      })),
    slots: [...question.payload.slots]
      .sort((left, right) => left.slotOrder - right.slotOrder)
      .map((slot) => ({
        slotOrder: slot.slotOrder,
        paragraphOrder: requiredMap(paragraphOrder, slot.paragraphId),
        answer: slot.answer,
        prefix: slot.prefix,
        displayText: slot.displayText,
        missingText: slot.missingText,
        missingLength: slot.missingLength
      }))
  };
}

function buildSlotContentConflicts(
  items: CtwAuditLogicalItemInput[]
): CtwAuditSlotContentConflict[] {
  const slotOrders = Array.from(new Set(items.flatMap((item) =>
    item.question.payload.slots.map((slot) => slot.slotOrder)
  ))).sort((left, right) => left - right);
  return slotOrders.flatMap((slotOrder) => {
    const versions = items.map((item) => {
      const slot = item.question.payload.slots.find((candidate) => candidate.slotOrder === slotOrder);
      if (!slot) throw new Error(`CTW audit cannot resolve slot order ${slotOrder}`);
      return {
        logicalItemId: item.logicalItemId,
        prefix: slot.prefix,
        answer: slot.answer,
        reviewText: ctwSlotReviewText(slot),
        normalizedPrefix: normalizeCtwAnswer(slot.prefix),
        normalizedAnswer: normalizeCtwAnswer(slot.answer),
        sources: [...item.occurrences].sort(compareOccurrences)
      };
    });
    const prefixDiffers = new Set(versions.map((version) => version.normalizedPrefix)).size > 1;
    const answerDiffers = new Set(versions.map((version) => version.normalizedAnswer)).size > 1;
    if (!prefixDiffers && !answerDiffers) return [];
    return [{
      kind: prefixDiffers && answerDiffers
        ? "prefix_and_answer_conflict" as const
        : prefixDiffers
          ? "prefix_conflict" as const
          : "answer_conflict" as const,
      slotOrder,
      versions: versions.map(({
        normalizedPrefix: _normalizedPrefix,
        normalizedAnswer: _normalizedAnswer,
        ...version
      }) => version)
    }];
  });
}

function buildRepresentationDifferences(
  items: CtwAuditLogicalItemInput[],
  members: CtwAuditClusterMember[]
): CtwAuditRepresentationDifference[] {
  const differences: CtwAuditRepresentationDifference[] = [];
  const maskedFrameworks = items.map((item) => buildCtwMaskedFramework(item.question).join("\n"));
  const normalizedCaseWhitespace = maskedFrameworks.map(normalizeCaseWhitespace);
  if (new Set(normalizedCaseWhitespace).size > 1) {
    differences.push({
      kind: "punctuation_difference",
      requiresManualReview: false,
      description: "Masked frameworks differ before punctuation removal but share the same CTW identity text."
    });
  } else if (new Set(maskedFrameworks).size > 1) {
    differences.push({
      kind: "whitespace_or_case_difference",
      requiresManualReview: false,
      description: "Masked frameworks differ only in whitespace and/or letter case."
    });
  }

  const renderingSignatures = items.map((item) => stableStringify({
    slots: [...item.question.payload.slots]
      .sort((left, right) => left.slotOrder - right.slotOrder)
      .map((slot) => [slot.slotOrder, slot.displayText, slot.missingText, slot.missingLength]),
    standaloneUnderscores: item.question.payload.paragraphs.map((paragraph) =>
      paragraph.segments.flatMap((segment) => segment.kind === "text"
        ? (segment.text.match(/_+/g) ?? [])
        : [])
    )
  }));
  if (new Set(renderingSignatures).size > 1) {
    differences.push({
      kind: "blank_rendering_difference",
      requiresManualReview: false,
      description: "Slot display/missing serialization or standalone underscore rendering differs."
    });
  }

  const rawSignatures = members.map((member) => stableStringify({
    rawDisplayText: member.canonicalRepresentation.rawDisplayText,
    paragraphRawText: member.canonicalRepresentation.paragraphs.map((paragraph) => paragraph.rawText)
  }));
  if (new Set(rawSignatures).size > 1) {
    differences.push({
      kind: "raw_serialization_difference",
      requiresManualReview: false,
      description: "Raw display/paragraph serialization differs; structured completed identity remains equal."
    });
  }

  const stemSignatures = items.map((item) => normalizeCaseWhitespace(item.question.stem));
  if (new Set(stemSignatures).size > 1) {
    differences.push({
      kind: "stem_difference",
      requiresManualReview: true,
      description: "Question stems differ even though CTW logical identity is the same."
    });
  }

  const structureSignatures = members.map((member) => stableStringify(
    member.canonicalRepresentation.paragraphs.map((paragraph) => ({
      paragraphOrder: paragraph.paragraphOrder,
      segments: paragraph.segments.map((segment) => segment.kind === "text"
        ? { kind: "text" }
        : { kind: "blank", slotOrder: segment.slotOrder })
    }))
  ));
  if (new Set(structureSignatures).size > 1) {
    differences.push({
      kind: "paragraph_or_blank_structure_difference",
      requiresManualReview: true,
      description: "Paragraph boundaries or blank segment structure differs and requires canonical review."
    });
  }
  return differences;
}

function findDuplicateOccurrenceMappings(
  items: CtwAuditLogicalItemInput[]
): CtwAuditDuplicateOccurrenceMapping[] {
  const byMapping = new Map<string, CtwAuditDuplicateOccurrenceMapping["mappings"]>();
  for (const item of items) {
    for (const occurrence of item.occurrences) {
      const sourceMappingKey = [
        occurrence.sourceLabel,
        occurrence.sourceModule,
        occurrence.sourceOrder,
        occurrence.sourceQuestionStart,
        occurrence.sourceQuestionEnd
      ].join("|");
      byMapping.set(sourceMappingKey, [
        ...((byMapping.get(sourceMappingKey) ?? [])),
        {
          logicalItemId: item.logicalItemId,
          occurrenceId: occurrence.occurrenceId,
          sourceLabel: occurrence.sourceLabel,
          occurrenceDate: occurrence.occurrenceDate,
          sourceModule: occurrence.sourceModule,
          sourceOrder: occurrence.sourceOrder,
          sourceQuestionStart: occurrence.sourceQuestionStart,
          sourceQuestionEnd: occurrence.sourceQuestionEnd
        }
      ]);
    }
  }
  return Array.from(byMapping.entries()).flatMap(([sourceMappingKey, mappings]) =>
    new Set(mappings.map((mapping) => mapping.logicalItemId)).size >= 2
      ? [{ kind: "duplicate_occurrence_mapping" as const, sourceMappingKey, mappings }]
      : []
  );
}

export function renderCtwLogicalIdentityAuditMarkdown(
  manifest: CtwLogicalIdentityAuditManifest
): string {
  const lines = [
    "# CTW Logical Identity Full-Database Audit",
    "",
    `Generated: ${manifest.generatedAt}`,
    "",
    "This is a read-only factual manifest. It does not choose a canonical survivor or canonical prefix.",
    "",
    "## Summary",
    "",
    `- Total CTW logical items: ${manifest.totalLogicalItems}`,
    `- Total CTW occurrences audited: ${manifest.totalOccurrencesAudited}`,
    `- New logical identities: ${manifest.uniqueIdentityCount}`,
    `- Duplicate clusters: ${manifest.duplicateClusterCount}`,
    `- Logical items in duplicate clusters: ${manifest.duplicateLogicalItemCount}`,
    `- Theoretical logical-item reduction: ${manifest.theoreticalLogicalItemReduction}`,
    `- Prefix-conflict clusters: ${manifest.prefixConflictClusterCount}`,
    `- Answer-conflict clusters: ${manifest.answerConflictClusterCount}`,
    `- Prefix+answer-conflict clusters: ${manifest.prefixAndAnswerConflictClusterCount}`,
    `- Punctuation/rendering-only clusters: ${manifest.punctuationOnlyClusterCount}`,
    `- Clusters with duplicate occurrence mappings: ${manifest.duplicateOccurrenceMappingCount}`,
    `- Clusters with other manual-review differences: ${manifest.otherManualReviewClusterCount}`,
    "",
    "## Known access/resources case",
    "",
    `- Status: ${manifest.knownAccessCaseVerification.status}`,
    `- Matching logical items: ${manifest.knownAccessCaseVerification.matchingLogicalItemCount}`,
    `- \`ac____\` version present: ${manifest.knownAccessCaseVerification.acPrefixVersionPresent}`,
    `- \`acc___\` same-passage version present: ${manifest.knownAccessCaseVerification.accPrefixVersionPresent}`,
    `- \`resources such\` version present: ${manifest.knownAccessCaseVerification.resourcesSuchVersionPresent}`,
    `- \`resources, such\` same-passage version present: ${manifest.knownAccessCaseVerification.resourcesCommaSuchVersionPresent}`,
    ""
  ];
  for (const item of manifest.knownAccessCaseVerification.logicalItems) {
    lines.push(
      `- \`${item.logicalItemId}\`: access prefix \`${item.accessPrefix ?? "missing"}\`, resources display \`${item.resourcesDisplayText ?? "missing"}\`; sources ${item.occurrences.map((occurrence) => occurrence.sourceLabel).join(", ") || "none"}`
    );
  }
  if (manifest.knownAccessCaseVerification.logicalItems.length > 0) lines.push("");
  for (const cluster of manifest.clusters) {
    lines.push(
      `## ${cluster.clusterId}`,
      "",
      `- Identity key: \`${cluster.identityKey}\``,
      `- Logical items: ${cluster.logicalItemCount}`,
      `- IDs: ${cluster.logicalItemIds.map((id) => `\`${id}\``).join(", ")}`,
      `- Masked framework: ${cluster.normalizedMaskedParagraphs.join(" / ")}`,
      `- Blank sequence: ${cluster.orderedBlankSequence.join(", ")}`,
      `- Occurrences after theoretical union: ${cluster.theoreticalOccurrenceCount}`,
      `- Conflicts/differences: ${cluster.conflictKinds.join(", ") || "none"}`,
      "",
      "### Sources",
      ""
    );
    for (const member of cluster.members) {
      lines.push(
        `- \`${member.logicalItemId}\` — ${member.occurrences.map((occurrence) =>
          `${occurrence.sourceLabel} ${occurrence.sourceModule.toUpperCase()}#${occurrence.sourceOrder} (${occurrence.occurrenceDate})`
        ).join("; ") || "no occurrence"}`
      );
    }
    lines.push("");
    if (cluster.slotContentConflicts.length > 0) {
      lines.push("### Slot content conflicts", "");
      for (const conflict of cluster.slotContentConflicts) {
        lines.push(`- Slot ${conflict.slotOrder}: ${conflict.kind}`);
        for (const version of conflict.versions) {
          lines.push(
            `  - \`${version.logicalItemId}\`: \`${version.reviewText}\`; sources ${version.sources.map((source) => source.sourceLabel).join(", ") || "none"}`
          );
        }
      }
      lines.push("");
    }
    if (cluster.representationDifferences.length > 0) {
      lines.push("### Representation differences", "");
      for (const difference of cluster.representationDifferences) {
        lines.push(`- ${difference.kind}: ${difference.description}`);
      }
      lines.push("");
    }
    if (cluster.duplicateOccurrenceMappings.length > 0) {
      lines.push("### Duplicate occurrence mappings", "");
      for (const mapping of cluster.duplicateOccurrenceMappings) {
        lines.push(`- \`${mapping.sourceMappingKey}\`: ${mapping.mappings.map((entry) =>
          `\`${entry.logicalItemId}\`/\`${entry.occurrenceId}\``
        ).join(", ")}`);
      }
      lines.push("");
    }
    lines.push("### Related records", "");
    for (const member of cluster.members) {
      const counts = Object.entries(member.relatedRecordCounts)
        .filter(([, count]) => count > 0)
        .map(([table, count]) => `${table}=${count}`)
        .join(", ");
      lines.push(`- \`${member.logicalItemId}\`: ${counts || "none"}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function compareOccurrences(left: CtwAuditOccurrence, right: CtwAuditOccurrence) {
  return left.occurrenceDate.localeCompare(right.occurrenceDate)
    || left.sourceLabel.localeCompare(right.sourceLabel)
    || left.sourceModule.localeCompare(right.sourceModule)
    || left.sourceOrder - right.sourceOrder
    || left.occurrenceId.localeCompare(right.occurrenceId);
}

function normalizeCaseWhitespace(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();
}

function sortRecord(record: Record<string, number>) {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify(record[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requiredMap<K, V>(map: Map<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`CTW audit cannot resolve ${String(key)}`);
  return value;
}
