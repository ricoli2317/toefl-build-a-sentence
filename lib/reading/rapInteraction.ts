export type RapPassageStructure = {
  paragraphs: Array<{
    paragraphId: string;
    sentences: Array<{ sentenceId: string; sentenceOrder: number }>;
  }>;
};

export type RapInsertionAnchor = {
  anchorId: string;
  anchorOrder: number;
  paragraphId: string;
  boundaryIndex: number;
  afterSentenceId: string | null;
};

export type RapInsertionValidation =
  | { valid: true; anchors: RapInsertionAnchor[] }
  | { valid: false; reason: string };

export type RapSentenceTargetValidation =
  | { valid: true; paragraphId: string; sentenceIds: string[] }
  | { valid: false; reason: string };

export function validateRapInsertionAnchors(
  passage: RapPassageStructure,
  anchors: RapInsertionAnchor[]
): RapInsertionValidation {
  if (anchors.length !== 4) return { valid: false, reason: "expected exactly four insertion anchors" };
  const orderedAnchors = [...anchors].sort((left, right) => left.anchorOrder - right.anchorOrder);
  const anchorIds = new Set<string>();
  const boundaries = new Set<string>();

  for (let index = 0; index < orderedAnchors.length; index += 1) {
    const anchor = orderedAnchors[index];
    if (!anchor.anchorId || anchorIds.has(anchor.anchorId)) {
      return { valid: false, reason: `invalid or duplicate anchor identity at order ${anchor.anchorOrder}` };
    }
    if (anchor.anchorOrder !== index + 1) {
      return { valid: false, reason: "anchor order is not contiguous" };
    }
    const paragraph = passage.paragraphs.find((candidate) => candidate.paragraphId === anchor.paragraphId);
    if (!paragraph) return { valid: false, reason: `anchor ${anchor.anchorOrder} references a missing paragraph` };
    const sentences = [...paragraph.sentences].sort((left, right) => left.sentenceOrder - right.sentenceOrder);
    if (!Number.isInteger(anchor.boundaryIndex) || anchor.boundaryIndex < 0 || anchor.boundaryIndex > sentences.length) {
      return { valid: false, reason: `anchor ${anchor.anchorOrder} has an invalid sentence boundary` };
    }
    const boundaryKey = `${anchor.paragraphId}:${anchor.boundaryIndex}`;
    if (boundaries.has(boundaryKey)) {
      return { valid: false, reason: `anchor ${anchor.anchorOrder} duplicates an insertion boundary` };
    }
    const expectedAfterSentenceId = anchor.boundaryIndex === 0
      ? null
      : sentences[anchor.boundaryIndex - 1]?.sentenceId ?? null;
    if (anchor.afterSentenceId !== expectedAfterSentenceId) {
      return { valid: false, reason: `anchor ${anchor.anchorOrder} does not match its sentence boundary` };
    }
    anchorIds.add(anchor.anchorId);
    boundaries.add(boundaryKey);
  }

  return { valid: true, anchors: orderedAnchors };
}

export function insertionAnchorAtBoundary(
  validation: RapInsertionValidation,
  paragraphId: string,
  boundaryIndex: number
): RapInsertionAnchor | null {
  if (!validation.valid) return null;
  return validation.anchors.find(
    (anchor) => anchor.paragraphId === paragraphId && anchor.boundaryIndex === boundaryIndex
  ) ?? null;
}

export function validateRapSentenceTarget(
  passage: RapPassageStructure,
  targetParagraphId: string
): RapSentenceTargetValidation {
  const paragraph = passage.paragraphs.find((candidate) => candidate.paragraphId === targetParagraphId);
  if (!paragraph) return { valid: false, reason: "target paragraph does not exist" };
  const sentenceIds = [...paragraph.sentences]
    .sort((left, right) => left.sentenceOrder - right.sentenceOrder)
    .map((sentence) => sentence.sentenceId);
  if (!sentenceIds.length || sentenceIds.some((sentenceId) => !sentenceId) || new Set(sentenceIds).size !== sentenceIds.length) {
    return { valid: false, reason: "target paragraph has invalid sentence identities" };
  }
  return { valid: true, paragraphId: targetParagraphId, sentenceIds };
}

export function isRapSentenceSelectable(
  validation: RapSentenceTargetValidation,
  paragraphId: string,
  sentenceId: string
) {
  return validation.valid
    && validation.paragraphId === paragraphId
    && validation.sentenceIds.includes(sentenceId);
}
