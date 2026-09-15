import { createHash } from "node:crypto";
import {
  buildCtwLogicalIdentity as buildSharedCtwLogicalIdentity,
  compareCtwLogicalIdentity as compareSharedCtwLogicalIdentity,
  ctwQuestionFromPackage,
  serializeCtwLogicalIdentity,
  type CtwLogicalIdentity,
  type CtwLogicalIdentityComparison
} from "./ctwLogicalIdentity.ts";
import type { CtwQuestion, ReadingImportPackage } from "./types.ts";

export {
  CTW_LOGICAL_IDENTITY_VERSION,
  buildCtwMaskedFramework,
  ctwQuestionFromPackage,
  ctwSlotReviewText,
  normalizeCtwAnswer,
  normalizeCtwIdentityPassage,
  normalizeCtwMaskedFramework,
  normalizeCtwOrderedAnswers,
  reconstructCompletedCtwPassage,
  serializeCtwLogicalIdentity
} from "./ctwLogicalIdentity.ts";

export type {
  CtwLogicalIdentity,
  CtwLogicalIdentityComparison,
  CtwSlotContentConflict
} from "./ctwLogicalIdentity.ts";

export type CtwHashedLogicalIdentity = CtwLogicalIdentity & { key: string };

export type CtwHashedLogicalIdentityComparison = Omit<
  CtwLogicalIdentityComparison,
  "leftIdentity" | "rightIdentity"
> & {
  leftIdentity: CtwHashedLogicalIdentity;
  rightIdentity: CtwHashedLogicalIdentity;
};

export function buildCtwLogicalIdentity(
  question: Pick<CtwQuestion, "questionId" | "payload">
): CtwHashedLogicalIdentity {
  return withFingerprint(buildSharedCtwLogicalIdentity(question));
}

export function buildCtwPackageLogicalIdentity(
  packageData: ReadingImportPackage
): CtwHashedLogicalIdentity {
  return buildCtwLogicalIdentity(ctwQuestionFromPackage(packageData));
}

export function compareCtwPackageLogicalIdentity(
  left: ReadingImportPackage,
  right: ReadingImportPackage
): CtwHashedLogicalIdentityComparison {
  return compareCtwLogicalIdentity(
    ctwQuestionFromPackage(left),
    ctwQuestionFromPackage(right)
  );
}

export function compareCtwLogicalIdentity(
  left: Pick<CtwQuestion, "questionId" | "payload">,
  right: Pick<CtwQuestion, "questionId" | "payload">
): CtwHashedLogicalIdentityComparison {
  const comparison = compareSharedCtwLogicalIdentity(left, right);
  return {
    ...comparison,
    leftIdentity: withFingerprint(comparison.leftIdentity),
    rightIdentity: withFingerprint(comparison.rightIdentity)
  };
}

function withFingerprint(identity: CtwLogicalIdentity): CtwHashedLogicalIdentity {
  return {
    ...identity,
    key: createHash("sha256")
      .update(serializeCtwLogicalIdentity(identity))
      .digest("hex")
  };
}
