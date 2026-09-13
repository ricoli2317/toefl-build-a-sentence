export type ReadingLogicalItemAction = "reuse_existing" | "create_new";

export type ReadingLogicalReuseKind = "exact_fingerprint" | "semantic" | "manual" | null;

export type ReadingImportExecution = {
  logicalItemAction: ReadingLogicalItemAction;
  logicalReuseKind: ReadingLogicalReuseKind;
  insertedOccurrenceCount: number;
  existingOccurrenceCount: number;
};

export function summarizeReadingImportExecutions(executions: ReadingImportExecution[]) {
  let logicalNewItemCount = 0;
  let logicalReusedItemCount = 0;
  let exactFingerprintReuseCount = 0;
  let semanticReuseCount = 0;
  let manualReuseCount = 0;
  let occurrenceInsertedCount = 0;
  let existingOccurrenceCount = 0;

  for (const execution of executions) {
    if (execution.logicalItemAction === "create_new") {
      logicalNewItemCount += 1;
    } else {
      logicalReusedItemCount += 1;
      if (execution.logicalReuseKind === "exact_fingerprint") exactFingerprintReuseCount += 1;
      if (execution.logicalReuseKind === "semantic") semanticReuseCount += 1;
      if (execution.logicalReuseKind === "manual") manualReuseCount += 1;
    }
    occurrenceInsertedCount += execution.insertedOccurrenceCount;
    existingOccurrenceCount += execution.existingOccurrenceCount;
  }

  return {
    logicalNewItemCount,
    logicalReusedItemCount,
    exactFingerprintReuseCount,
    semanticReuseCount,
    manualReuseCount,
    occurrenceInsertedCount,
    existingOccurrenceCount
  };
}
