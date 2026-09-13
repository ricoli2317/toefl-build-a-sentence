export type WritingReviewDatabaseErrorCode =
  | "DATABASE_READ_FAILED"
  | "REVIEW_SAVE_FAILED"
  | "EXISTING_REVIEW_INVALID";

export type WritingReviewDatabaseOperation = "read" | "insert" | "update";

export type SupabaseDatabaseError = {
  code?: string | null;
  message: string;
  details?: string | null;
  hint?: string | null;
};

export class WritingReviewDatabaseError extends Error {
  code: WritingReviewDatabaseErrorCode;
  status = 500;
  operation: WritingReviewDatabaseOperation;
  cause?: unknown;

  constructor(
    code: WritingReviewDatabaseErrorCode,
    message: string,
    operation: WritingReviewDatabaseOperation,
    cause?: unknown
  ) {
    super(message);
    this.name = "WritingReviewDatabaseError";
    this.code = code;
    this.operation = operation;
    this.cause = cause;
  }
}

/**
 * PostgreSQL json/jsonb cannot store U+0000, while JSON.parse accepts the
 * escaped form and JavaScript strings can also contain unpaired surrogates.
 * Normalize only those database-incompatible code units at the persistence
 * boundary; all review structure and ordinary text stay untouched.
 */
export function prepareWritingReviewForPersistence<T>(value: T): T {
  return normalizeJsonValue(value) as T;
}

export function writingReviewDatabaseDiagnostic(error: unknown) {
  const wrapper = findDatabaseWrapper(error);
  const databaseError = findSupabaseError(wrapper?.cause ?? error);
  if (!wrapper && !databaseError) return null;
  return {
    operation: wrapper?.operation ?? null,
    code: databaseError?.code ?? null,
    message: databaseError?.message ?? null,
    details: databaseError?.details ?? null,
    hint: databaseError?.hint ?? null
  };
}

function normalizeJsonValue(value: unknown): unknown {
  if (typeof value === "string") return normalizePostgresText(value);
  if (Array.isArray(value)) return value.map(normalizeJsonValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeJsonValue(item)])
    );
  }
  return value;
}

function normalizePostgresText(value: string) {
  let normalized = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) continue;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        normalized += value[index] + value[index + 1];
        index += 1;
      } else {
        normalized += "\ufffd";
      }
      continue;
    }
    normalized += code >= 0xdc00 && code <= 0xdfff ? "\ufffd" : value[index];
  }
  return normalized;
}

function findDatabaseWrapper(error: unknown) {
  return errorChain(error).find(
    (item): item is WritingReviewDatabaseError =>
      item instanceof WritingReviewDatabaseError
  );
}

function findSupabaseError(error: unknown): SupabaseDatabaseError | null {
  for (const item of errorChain(error)) {
    if (!isRecord(item) || typeof item.message !== "string") continue;
    const code = optionalString(item.code);
    if (code === "REVIEW_SAVE_FAILED" || code === "DATABASE_READ_FAILED") {
      continue;
    }
    return {
      code,
      message: boundedText(item.message),
      details: optionalBoundedText(item.details),
      hint: optionalBoundedText(item.hint)
    };
  }
  return null;
}

function errorChain(error: unknown) {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8 && current !== null; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    chain.push(current);
    current = isRecord(current) ? current.cause : null;
  }
  return chain;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function optionalBoundedText(value: unknown) {
  return typeof value === "string" ? boundedText(value) : null;
}

function boundedText(value: string) {
  const normalized = normalizePostgresText(value);
  return normalized.length <= 2000
    ? normalized
    : `${normalized.slice(0, 1997)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
