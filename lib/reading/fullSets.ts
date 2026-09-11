import { compareReadingSourceLabels } from "./grouping.ts";
import type { ReadingModule, ReadingTestModule } from "./types.ts";

export const READING_FULL_SET_MODULE_1_PATTERN_1_SECONDS = 1230;
export const READING_FULL_SET_MODULE_1_PATTERN_2_SECONDS = 1110;
export const READING_FULL_SET_MODULE_2_SECONDS = 540;

export type ReadingFullSetPattern = "pattern_1" | "pattern_2";
export type ReadingFullSetRdlLength = "short" | "long";

export type ReadingFullSetOccurrenceInput = {
  occurrenceId: string;
  logicalItemId: string;
  taskType: ReadingModule;
  occurrenceDate: string;
  sourceLabel: string;
  sourceModule: ReadingTestModule;
  sourceOrder: number;
  sourceQuestionStart: number;
  sourceQuestionEnd: number;
  scoringPointCount: number;
};

export type ReadingFullSetOccurrence = ReadingFullSetOccurrenceInput & {
  rdlLength: ReadingFullSetRdlLength | null;
};

export type ReadingFullSetValidationCode =
  | "SOURCE_IDENTITY_MISMATCH"
  | "DUPLICATE_FULL_SET_ID"
  | "DUPLICATE_OCCURRENCE_ID"
  | "DUPLICATE_SOURCE_ORDER"
  | "SOURCE_RANGE_OVERLAP"
  | "SOURCE_RANGE_OUT_OF_BOUNDS"
  | "SOURCE_ORDER_RANGE_MISMATCH"
  | "INVALID_OCCURRENCE_SCORING_POINTS"
  | "INVALID_RDL_LENGTH"
  | "M1_MISSING_QUESTIONS"
  | "M1_INVALID_PATTERN"
  | "M2_MISSING_QUESTIONS"
  | "M2_INVALID_STRUCTURE";

export type ReadingFullSetValidation = {
  valid: boolean;
  identityValid: boolean;
  module1Valid: boolean;
  module2Valid: boolean;
  questionCoverageValid: boolean;
  patternValid: boolean;
  reasons: ReadingFullSetValidationCode[];
};

export type ReadingFullSet = {
  fullSetId: string | null;
  title: string | null;
  occurrenceDate: string;
  sourceLabel: string;
  module1: {
    pattern: ReadingFullSetPattern | null;
    timeLimitSeconds: number | null;
    scoringPointCount: number;
    occurrences: ReadingFullSetOccurrence[];
  };
  module2: {
    timeLimitSeconds: typeof READING_FULL_SET_MODULE_2_SECONDS;
    scoringPointCount: number;
    occurrences: ReadingFullSetOccurrence[];
  };
  validation: ReadingFullSetValidation;
};

export type ReadingFullSetCatalogItem = {
  fullSetId: string;
  title: string;
  occurrenceDate: string;
  sourceLabel: string;
  module1Pattern: ReadingFullSetPattern;
  module1TimeLimitSeconds: number;
  module2TimeLimitSeconds: typeof READING_FULL_SET_MODULE_2_SECONDS;
  studentState: ReadingFullSetCatalogStudentState;
};

export type ReadingFullSetCatalogStudentState = {
  activeAttemptId: string | null;
  latestCompletedAttemptId: string | null;
  hasCompleted: boolean;
  status: "unstarted" | "in_progress" | "completed";
};

export type ReadingFullSetCatalogAttemptRow = {
  attempt_id: string;
  full_set_id: string;
  status: "in_progress" | "completed";
  completed_at: string | null;
  created_at: string;
};

export class ReadingFullSetIdentityError extends Error {
  readonly code = "SOURCE_IDENTITY_MISMATCH" as const;

  constructor(message: string) {
    super(message);
    this.name = "ReadingFullSetIdentityError";
  }
}

export function readingFullSetIdentity(input: {
  occurrenceDate: string;
  sourceLabel: string;
}) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.occurrenceDate);
  if (!dateMatch || !isRealIsoDate(input.occurrenceDate)) {
    throw new ReadingFullSetIdentityError(`Invalid occurrence date: ${input.occurrenceDate}`);
  }
  if (input.sourceLabel !== input.sourceLabel.trim()) {
    throw new ReadingFullSetIdentityError("Source label must not contain surrounding whitespace");
  }
  const sourceMatch = /^(\d{1,2})\.(\d{1,2})([A-Za-z]*)$/.exec(input.sourceLabel);
  if (!sourceMatch) {
    throw new ReadingFullSetIdentityError(`Invalid Reading source label: ${input.sourceLabel}`);
  }
  if (Number(sourceMatch[1]) !== Number(dateMatch[2]) || Number(sourceMatch[2]) !== Number(dateMatch[3])) {
    throw new ReadingFullSetIdentityError(
      `Reading source label ${input.sourceLabel} does not match ${input.occurrenceDate}`
    );
  }
  const fullSetId = `${dateMatch[1]}${dateMatch[2]}${dateMatch[3]}${sourceMatch[3]}`;
  return { fullSetId, title: fullSetId };
}

export function buildReadingFullSets(inputs: ReadingFullSetOccurrenceInput[]): ReadingFullSet[] {
  const groups = new Map<string, ReadingFullSetOccurrenceInput[]>();
  for (const input of inputs) {
    const key = `${input.occurrenceDate}\u001f${input.sourceLabel}`;
    groups.set(key, [...(groups.get(key) ?? []), input]);
  }
  const fullSets = Array.from(groups.values()).map(buildReadingFullSet);
  const byId = new Map<string, number[]>();
  fullSets.forEach((fullSet, index) => {
    if (!fullSet.fullSetId) return;
    byId.set(fullSet.fullSetId, [...(byId.get(fullSet.fullSetId) ?? []), index]);
  });
  for (const indexes of Array.from(byId.values())) {
    if (indexes.length < 2) continue;
    indexes.forEach((index: number) => {
      fullSets[index] = withValidationReason(fullSets[index], "DUPLICATE_FULL_SET_ID", {
        identityValid: false
      });
    });
  }
  return fullSets.sort(compareReadingFullSetsOldestFirst);
}

export function buildReadingFullSetCatalog(
  fullSets: ReadingFullSet[],
  attempts: ReadingFullSetCatalogAttemptRow[] = []
): ReadingFullSetCatalogItem[] {
  const stateByFullSet = buildReadingFullSetCatalogStates(attempts);
  return fullSets
    .filter((fullSet): fullSet is ReadingFullSet & {
      fullSetId: string;
      title: string;
      module1: ReadingFullSet["module1"] & {
        pattern: ReadingFullSetPattern;
        timeLimitSeconds: number;
      };
    } => Boolean(
      fullSet.validation.valid
      && fullSet.fullSetId
      && fullSet.title
      && fullSet.module1.pattern
      && fullSet.module1.timeLimitSeconds
    ))
    .sort(compareReadingFullSetsNewestFirst)
    .map((fullSet) => ({
      fullSetId: fullSet.fullSetId,
      title: fullSet.title,
      occurrenceDate: fullSet.occurrenceDate,
      sourceLabel: fullSet.sourceLabel,
      module1Pattern: fullSet.module1.pattern,
      module1TimeLimitSeconds: fullSet.module1.timeLimitSeconds,
      module2TimeLimitSeconds: fullSet.module2.timeLimitSeconds,
      studentState: stateByFullSet.get(fullSet.fullSetId) ?? {
        activeAttemptId: null,
        latestCompletedAttemptId: null,
        hasCompleted: false,
        status: "unstarted"
      }
    }));
}

export function buildReadingFullSetCatalogStates(attempts: ReadingFullSetCatalogAttemptRow[]) {
  const byFullSet = new Map<string, ReadingFullSetCatalogAttemptRow[]>();
  for (const attempt of attempts) {
    byFullSet.set(attempt.full_set_id, [...(byFullSet.get(attempt.full_set_id) ?? []), attempt]);
  }
  return new Map(Array.from(byFullSet, ([fullSetId, rows]) => {
    const active = rows
      .filter((row) => row.status === "in_progress")
      .sort(compareFullSetAttemptRows)[0] ?? null;
    const completed = rows
      .filter((row) => row.status === "completed" && row.completed_at)
      .sort(compareFullSetAttemptRows)[0] ?? null;
    return [fullSetId, {
      activeAttemptId: active?.attempt_id ?? null,
      latestCompletedAttemptId: completed?.attempt_id ?? null,
      hasCompleted: Boolean(completed),
      status: active ? "in_progress" as const : completed ? "completed" as const : "unstarted" as const
    }];
  }));
}

function compareFullSetAttemptRows(
  left: ReadingFullSetCatalogAttemptRow,
  right: ReadingFullSetCatalogAttemptRow
) {
  const leftTime = Date.parse(left.completed_at ?? left.created_at);
  const rightTime = Date.parse(right.completed_at ?? right.created_at);
  return rightTime - leftTime || right.attempt_id.localeCompare(left.attempt_id);
}

export function findValidReadingFullSet(fullSets: ReadingFullSet[], fullSetId: string) {
  return fullSets.find((fullSet) => fullSet.validation.valid && fullSet.fullSetId === fullSetId) ?? null;
}

function buildReadingFullSet(inputs: ReadingFullSetOccurrenceInput[]): ReadingFullSet {
  const first = inputs[0];
  let identity: ReturnType<typeof readingFullSetIdentity> | null = null;
  const reasons: ReadingFullSetValidationCode[] = [];
  try {
    identity = readingFullSetIdentity({
      occurrenceDate: first.occurrenceDate,
      sourceLabel: first.sourceLabel
    });
  } catch (error) {
    if (!(error instanceof ReadingFullSetIdentityError)) throw error;
    addReason(reasons, error.code);
  }

  const occurrenceIds = new Set<string>();
  for (const input of inputs) {
    if (occurrenceIds.has(input.occurrenceId)) addReason(reasons, "DUPLICATE_OCCURRENCE_ID");
    occurrenceIds.add(input.occurrenceId);
  }
  const occurrences = inputs.map((input): ReadingFullSetOccurrence => ({
    ...input,
    rdlLength: input.taskType === "rdl"
      ? input.scoringPointCount === 2
        ? "short"
        : input.scoringPointCount === 3
          ? "long"
          : null
      : null
  }));
  for (const occurrence of occurrences) validateOccurrenceShape(occurrence, reasons);

  const module1Occurrences = occurrences
    .filter((occurrence) => occurrence.sourceModule === "m1")
    .sort(compareReadingFullSetOccurrences);
  const module2Occurrences = occurrences
    .filter((occurrence) => occurrence.sourceModule === "m2")
    .sort(compareReadingFullSetOccurrences);
  const module1Sequence = validateModuleSequence(module1Occurrences, 35, "m1", reasons);
  const module2Sequence = validateModuleSequence(module2Occurrences, 15, "m2", reasons);
  const module1ScoringPointCount = scoringPoints(module1Occurrences);
  const module2ScoringPointCount = scoringPoints(module2Occurrences);
  const pattern = detectModule1Pattern(module1Occurrences, module1ScoringPointCount);
  const patternValid = pattern !== null && module1Sequence.coverageValid;
  if (!patternValid) addReason(reasons, "M1_INVALID_PATTERN");

  const module2StructureValid = countType(module2Occurrences, "ctw") === 1
    && countType(module2Occurrences, "rap") === 1
    && countType(module2Occurrences, "rdl") === 0
    && module2ScoringPointCount === 15;
  if (!module2StructureValid) addReason(reasons, "M2_INVALID_STRUCTURE");

  const module1ShapeValid = module1Occurrences.every(isOccurrenceShapeValid);
  const module2ShapeValid = module2Occurrences.every(isOccurrenceShapeValid);
  const identityValid = identity !== null;
  const module1Valid = patternValid && module1Sequence.valid && module1ShapeValid;
  const module2Valid = module2StructureValid && module2Sequence.valid && module2ShapeValid;
  const questionCoverageValid = module1Sequence.coverageValid && module2Sequence.coverageValid;
  const valid = identityValid && module1Valid && module2Valid && reasons.length === 0;

  return {
    fullSetId: identity?.fullSetId ?? null,
    title: identity?.title ?? null,
    occurrenceDate: first.occurrenceDate,
    sourceLabel: first.sourceLabel,
    module1: {
      pattern,
      timeLimitSeconds: pattern === "pattern_1"
        ? READING_FULL_SET_MODULE_1_PATTERN_1_SECONDS
        : pattern === "pattern_2"
          ? READING_FULL_SET_MODULE_1_PATTERN_2_SECONDS
          : null,
      scoringPointCount: module1ScoringPointCount,
      occurrences: module1Occurrences
    },
    module2: {
      timeLimitSeconds: READING_FULL_SET_MODULE_2_SECONDS,
      scoringPointCount: module2ScoringPointCount,
      occurrences: module2Occurrences
    },
    validation: {
      valid,
      identityValid,
      module1Valid,
      module2Valid,
      questionCoverageValid,
      patternValid,
      reasons
    }
  };
}

function validateOccurrenceShape(
  occurrence: ReadingFullSetOccurrence,
  reasons: ReadingFullSetValidationCode[]
) {
  if (!isOccurrenceShapeValid(occurrence)) {
    addReason(reasons, occurrence.taskType === "rdl"
      ? "INVALID_RDL_LENGTH"
      : "INVALID_OCCURRENCE_SCORING_POINTS");
  }
  if (occurrence.sourceQuestionEnd - occurrence.sourceQuestionStart + 1 !== occurrence.scoringPointCount) {
    addReason(reasons, "INVALID_OCCURRENCE_SCORING_POINTS");
  }
}

function isOccurrenceShapeValid(occurrence: ReadingFullSetOccurrence) {
  return Number.isInteger(occurrence.scoringPointCount)
    && (occurrence.taskType === "ctw"
      ? occurrence.scoringPointCount === 10
      : occurrence.taskType === "rap"
        ? occurrence.scoringPointCount === 5
        : occurrence.rdlLength !== null);
}

function validateModuleSequence(
  occurrences: ReadingFullSetOccurrence[],
  expectedQuestions: number,
  module: ReadingTestModule,
  reasons: ReadingFullSetValidationCode[]
) {
  const sourceOrders = new Set<number>();
  let orderValid = true;
  for (const occurrence of occurrences) {
    if (sourceOrders.has(occurrence.sourceOrder)) {
      orderValid = false;
      addReason(reasons, "DUPLICATE_SOURCE_ORDER");
    }
    sourceOrders.add(occurrence.sourceOrder);
  }

  let previous: ReadingFullSetOccurrence | null = null;
  const covered = new Set<number>();
  let rangeValid = true;
  for (const occurrence of occurrences) {
    if (
      !Number.isInteger(occurrence.sourceQuestionStart)
      || !Number.isInteger(occurrence.sourceQuestionEnd)
      || occurrence.sourceQuestionStart < 1
      || occurrence.sourceQuestionEnd > expectedQuestions
      || occurrence.sourceQuestionEnd < occurrence.sourceQuestionStart
    ) {
      rangeValid = false;
      addReason(reasons, "SOURCE_RANGE_OUT_OF_BOUNDS");
      continue;
    }
    if (previous && occurrence.sourceQuestionStart <= previous.sourceQuestionEnd) {
      rangeValid = false;
      addReason(reasons, "SOURCE_RANGE_OVERLAP");
    }
    if (previous && occurrence.sourceQuestionStart <= previous.sourceQuestionStart) {
      orderValid = false;
      addReason(reasons, "SOURCE_ORDER_RANGE_MISMATCH");
    }
    for (let question = occurrence.sourceQuestionStart; question <= occurrence.sourceQuestionEnd; question += 1) {
      if (covered.has(question)) {
        rangeValid = false;
        addReason(reasons, "SOURCE_RANGE_OVERLAP");
      }
      covered.add(question);
    }
    previous = occurrence;
  }
  const coverageValid = rangeValid
    && covered.size === expectedQuestions
    && Array.from({ length: expectedQuestions }, (_, index) => index + 1).every((question) => covered.has(question));
  if (!coverageValid) addReason(reasons, module === "m1" ? "M1_MISSING_QUESTIONS" : "M2_MISSING_QUESTIONS");
  return { valid: orderValid && coverageValid, coverageValid };
}

function detectModule1Pattern(
  occurrences: ReadingFullSetOccurrence[],
  scoringPointCount: number
): ReadingFullSetPattern | null {
  if (scoringPointCount !== 35 || countType(occurrences, "ctw") !== 2) return null;
  const shortRdl = occurrences.filter((occurrence) => occurrence.rdlLength === "short").length;
  const longRdl = occurrences.filter((occurrence) => occurrence.rdlLength === "long").length;
  const rap = countType(occurrences, "rap");
  if (shortRdl === 1 && longRdl === 1 && rap === 2) return "pattern_1";
  if (shortRdl === 2 && longRdl === 2 && rap === 1) return "pattern_2";
  return null;
}

function countType(occurrences: ReadingFullSetOccurrence[], type: ReadingModule) {
  return occurrences.filter((occurrence) => occurrence.taskType === type).length;
}

function scoringPoints(occurrences: ReadingFullSetOccurrence[]) {
  return occurrences.reduce((count, occurrence) => count + occurrence.scoringPointCount, 0);
}

function compareReadingFullSetOccurrences(left: ReadingFullSetOccurrence, right: ReadingFullSetOccurrence) {
  return left.sourceOrder - right.sourceOrder || left.occurrenceId.localeCompare(right.occurrenceId);
}

function compareReadingFullSetsOldestFirst(left: ReadingFullSet, right: ReadingFullSet) {
  return left.occurrenceDate.localeCompare(right.occurrenceDate)
    || compareReadingSourceLabels(left.sourceLabel, right.sourceLabel);
}

function compareReadingFullSetsNewestFirst(left: ReadingFullSet, right: ReadingFullSet) {
  return right.occurrenceDate.localeCompare(left.occurrenceDate)
    || compareReadingSourceLabels(left.sourceLabel, right.sourceLabel);
}

function withValidationReason(
  fullSet: ReadingFullSet,
  reason: ReadingFullSetValidationCode,
  changes: Partial<Pick<ReadingFullSetValidation, "identityValid" | "module1Valid" | "module2Valid">>
): ReadingFullSet {
  const reasons = [...fullSet.validation.reasons];
  addReason(reasons, reason);
  return {
    ...fullSet,
    validation: {
      ...fullSet.validation,
      ...changes,
      valid: false,
      reasons
    }
  };
}

function addReason(reasons: ReadingFullSetValidationCode[], reason: ReadingFullSetValidationCode) {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function isRealIsoDate(value: string) {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}
