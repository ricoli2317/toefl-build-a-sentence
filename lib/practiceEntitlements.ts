/**
 * Shared student practice entitlement model (client + server safe).
 *
 * The eight kinds and their display labels live here. Initial remaining values
 * deliberately do NOT live here: the database table
 * public.practice_entitlement_defaults is the single authoritative source, and
 * API responses always carry both `remaining` and `defaultRemaining`.
 */

export const PRACTICE_ENTITLEMENT_KINDS = [
  "build_sentence",
  "email",
  "academic_discussion",
  "ctw",
  "rdl",
  "rap",
  "bas_category",
  "rap_category"
] as const;

export type PracticeEntitlementKind = (typeof PRACTICE_ENTITLEMENT_KINDS)[number];

/**
 * The six ordinary task types now gated by the phase-2 entitlement rules.
 * Category practice and Full Set are intentionally outside this list.
 */
export const PRACTICE_GATED_TASK_TYPES = [
  "build_sentence",
  "email",
  "academic_discussion",
  "ctw",
  "rdl",
  "rap"
] as const;

export type PracticeGatedTaskType = (typeof PRACTICE_GATED_TASK_TYPES)[number];

const PRACTICE_GATED_TASK_TYPE_SET: ReadonlySet<string> = new Set(
  PRACTICE_GATED_TASK_TYPES
);

export function isPracticeGatedTaskType(
  value: unknown
): value is PracticeGatedTaskType {
  return typeof value === "string" && PRACTICE_GATED_TASK_TYPE_SET.has(value);
}

const PRACTICE_ENTITLEMENT_KIND_SET: ReadonlySet<string> = new Set(
  PRACTICE_ENTITLEMENT_KINDS
);

export const PRACTICE_ENTITLEMENT_LABELS: Record<PracticeEntitlementKind, string> = {
  build_sentence: "Build a Sentence",
  email: "Write an Email",
  academic_discussion: "Academic Discussion",
  ctw: "Complete the Words",
  rdl: "Read in Daily Life",
  rap: "Read an Academic Passage",
  bas_category: "Build a Sentence 分类练习",
  rap_category: "Read an Academic Passage 分类练习"
};

export const PRACTICE_ENTITLEMENT_SHORT_LABELS: Record<PracticeEntitlementKind, string> = {
  build_sentence: "BAS",
  email: "WE",
  academic_discussion: "AD",
  ctw: "CTW",
  rdl: "RDL",
  rap: "RAP",
  bas_category: "BAS 分类",
  rap_category: "RAP 分类"
};

export const PRACTICE_ENTITLEMENT_GROUPS: ReadonlyArray<{
  title: string;
  kinds: readonly PracticeEntitlementKind[];
}> = [
  {
    title: "普通题型",
    kinds: ["build_sentence", "email", "academic_discussion", "ctw", "rdl", "rap"]
  },
  {
    title: "分类练习",
    kinds: ["bas_category", "rap_category"]
  }
];

/** PostgreSQL integer upper bound. Admin may set any non-negative integer. */
export const MAX_PRACTICE_ENTITLEMENT_REMAINING = 2147483647;

/** One shared StudentDataCache key for the eight entitlement values. */
export const STUDENT_PRACTICE_ENTITLEMENTS_CACHE_KEY =
  "student-practice-entitlements";

export type PracticeEntitlementValues = Partial<Record<PracticeEntitlementKind, number>>;

export type PracticeEntitlementSnapshotItem = {
  kind: PracticeEntitlementKind;
  remaining: number;
  defaultRemaining: number;
  isExplicit: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type PracticeEntitlementValidation =
  | { ok: true; values: PracticeEntitlementValues }
  | { ok: false; error: string };

export type PracticeEntitlementFailure = {
  status: number;
  message: string;
};

export function isPracticeEntitlementKind(
  value: unknown
): value is PracticeEntitlementKind {
  return typeof value === "string" && PRACTICE_ENTITLEMENT_KIND_SET.has(value);
}

export function isValidPracticeEntitlementRemaining(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_PRACTICE_ENTITLEMENT_REMAINING
  );
}

/**
 * Strict server-side validation for a partial Admin save payload. Unknown
 * kinds, negative/fractional numbers, strings, booleans, null, NaN and values
 * outside the PostgreSQL integer range are rejected before any RPC call.
 */
export function validatePracticeEntitlementValues(
  input: unknown
): PracticeEntitlementValidation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "请至少提交一项有效的练习额度。" };
  }

  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) {
    return { ok: false, error: "请至少提交一项有效的练习额度。" };
  }

  const values: PracticeEntitlementValues = {};
  for (const [kind, value] of entries) {
    if (!isPracticeEntitlementKind(kind)) {
      return { ok: false, error: "包含未知的练习额度类型。" };
    }
    if (!isValidPracticeEntitlementRemaining(value)) {
      return {
        ok: false,
        error: `${PRACTICE_ENTITLEMENT_LABELS[kind]}的额度必须是 0 或正整数。`
      };
    }
    values[kind] = value;
  }

  return { ok: true, values };
}

/**
 * Admin bulk action form validation. It accepts 0 and every other non-negative
 * integer exactly like the individual fields, and never calls the database.
 */
export function parsePracticeEntitlementBulkValue(input: unknown):
  | { ok: true; value: number; text: string }
  | { ok: false; error: string } {
  if (typeof input !== "string" || !/^\d+$/.test(input.trim())) {
    return { ok: false, error: "统一额度必须是 0 或正整数。" };
  }
  const value = Number(input.trim());
  if (!isValidPracticeEntitlementRemaining(value)) {
    return { ok: false, error: "统一额度必须是 0 或正整数。" };
  }
  return { ok: true, value, text: String(value) };
}

/**
 * UI form validation. The Admin panel always submits all eight values, so a
 * missing kind is invalid here even though the RPC accepts partial updates for
 * future reuse.
 */
export function validatePracticeEntitlementFormValues(
  input: unknown
): PracticeEntitlementValidation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "练习额度表单无效。" };
  }

  const source = input as Record<string, unknown>;
  const values: PracticeEntitlementValues = {};

  for (const kind of PRACTICE_ENTITLEMENT_KINDS) {
    const raw = source[kind];
    if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) {
      return {
        ok: false,
        error: `${PRACTICE_ENTITLEMENT_LABELS[kind]}的额度必须是 0 或正整数。`
      };
    }
    const parsed = Number(raw.trim());
    if (!isValidPracticeEntitlementRemaining(parsed)) {
      return {
        ok: false,
        error: `${PRACTICE_ENTITLEMENT_LABELS[kind]}的额度必须是 0 或正整数。`
      };
    }
    values[kind] = parsed;
  }

  return { ok: true, values };
}

/**
 * Maps the RPC snapshot rows to the stable eight-kind order used by both the
 * Admin panel and the Student self-read endpoint. Missing or duplicate kinds
 * are treated as an installation/data error rather than silently defaulted.
 */
export function mapPracticeEntitlementRows(
  data: unknown
): PracticeEntitlementSnapshotItem[] {
  if (!Array.isArray(data)) {
    throw new Error("Practice entitlement snapshot is not an array");
  }

  const byKind = new Map<PracticeEntitlementKind, PracticeEntitlementSnapshotItem>();

  for (const raw of data) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Practice entitlement snapshot row is invalid");
    }
    const row = raw as Record<string, unknown>;
    const kind = row.entitlement_kind;
    if (!isPracticeEntitlementKind(kind) || byKind.has(kind)) {
      throw new Error("Practice entitlement snapshot kind is invalid");
    }
    if (
      !isValidPracticeEntitlementRemaining(row.remaining) ||
      !isValidPracticeEntitlementRemaining(row.default_remaining) ||
      typeof row.is_explicit !== "boolean"
    ) {
      throw new Error("Practice entitlement snapshot value is invalid");
    }

    byKind.set(kind, {
      kind,
      remaining: row.remaining,
      defaultRemaining: row.default_remaining,
      isExplicit: row.is_explicit,
      updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
      updatedBy: typeof row.updated_by === "string" ? row.updated_by : null
    });
  }

  return PRACTICE_ENTITLEMENT_KINDS.map((kind) => {
    const row = byKind.get(kind);
    if (!row) throw new Error("Practice entitlement snapshot is incomplete");
    return row;
  });
}

/**
 * Phase-2 practice-start errors shared by BAS, Reading and Writing entry
 * points. Unknown database details stay server-side; the UI receives a stable
 * product message.
 */
export function mapPracticeAccessError(
  error: { message?: string; code?: string | null } | null | undefined,
  fallback: string
): PracticeEntitlementFailure {
  const message = error?.message ?? "";
  if (message.includes("PRACTICE_ENTITLEMENT_CATEGORY_EXHAUSTED")) {
    return {
      status: 403,
      message: "该分类练习的自主练习额度已用完。已有练习仍可继续完成。"
    };
  }
  if (message.includes("PRACTICE_ENTITLEMENT_EXHAUSTED")) {
    return {
      status: 403,
      message: "本题型的自主练习额度已用完。已解锁的题目仍可继续练习。"
    };
  }
  if (
    message.includes("CATEGORY_REQUEST_ID_CONFLICT")
    || message.includes("BAS_GRAMMAR_REQUEST_ID_CONFLICT")
  ) {
    return {
      status: 409,
      message: "本次练习请求与已有记录不一致，请重新开始。"
    };
  }
  if (
    message.includes("CATEGORY_PRACTICE_ORIGIN_NOT_AVAILABLE")
    || message.includes("BAS_GRAMMAR_ORIGIN_NOT_AVAILABLE")
  ) {
    return { status: 400, message: "当前暂不支持这种分类练习来源。" };
  }
  if (message.includes("BAS_GRAMMAR_SESSION_NOT_FOUND")) {
    return { status: 404, message: "没有找到这次语法练习记录。" };
  }
  if (message.includes("BAS_GRAMMAR_SESSION_COMPLETED")) {
    return { status: 409, message: "这次语法练习已经提交，不能重复提交。" };
  }
  if (
    message.includes("BAS_GRAMMAR_INVALID_")
    || message.includes("BAS_GRAMMAR_ATTEMPT_MISMATCH")
    || message.includes("READING_INVALID_CATEGORY_START")
  ) {
    return { status: 400, message: "本次分类练习请求无效，请重新开始。" };
  }
  if (message.includes("PRACTICE_ENTITLEMENT_NOT_UNLOCKED")) {
    return {
      status: 403,
      message: "这道题尚未获得练习授权，请从题目目录重新开始。"
    };
  }
  if (message.includes("PRACTICE_ITEM_NOT_FOUND")) {
    return { status: 404, message: "没有找到这道练习题。" };
  }
  if (message.includes("PRACTICE_ASSIGNMENT_NOT_AVAILABLE")) {
    return { status: 409, message: "这项作业已撤回或不再可用。" };
  }
  if (
    message.includes("BAS_GRAMMAR_ASSIGNMENT_NOT_AVAILABLE")
    || message.includes("READING_CATEGORY_ASSIGNMENT_NOT_AVAILABLE")
    || message.includes("READING_ASSIGNMENT_NOT_AVAILABLE")
  ) {
    return { status: 409, message: "这项分类练习作业已撤回或不再可用。" };
  }
  if (
    message.includes("BAS_GRAMMAR_ASSIGNMENT_NOT_ASSIGNED")
    || message.includes("READING_CATEGORY_ASSIGNMENT_NOT_ASSIGNED")
  ) {
    return { status: 403, message: "这项分类练习作业不属于当前学生。" };
  }
  if (
    message.includes("INVALID_CATEGORY_ASSIGNMENT_MANIFEST")
    || message.includes("CATEGORY_ASSIGNMENT_")
  ) {
    return { status: 400, message: "分类练习作业的题目配置无效，请重新选择。" };
  }
  if (message.includes("PRACTICE_QUESTION_NOT_IN_SET")) {
    return { status: 400, message: "提交的题目不属于当前套题。" };
  }
  if (
    message.includes("INVALID_PRACTICE_SET")
    || message.includes("INVALID_PRACTICE_TASK_TYPE")
    || message.includes("INVALID_READING_TASK_TYPE")
  ) {
    return { status: 400, message: "无效的练习请求。" };
  }
  if (message.includes("WRITING_ASSIGNMENT_NOT_ACTIVE")) {
    return { status: 409, message: "这项作业已撤回，不能继续作答。" };
  }
  if (message.includes("WRITING_ASSIGNMENT_NOT_ASSIGNED")) {
    return { status: 403, message: "这项作业不属于当前学生。" };
  }
  if (
    message.includes("STUDENT_REQUIRED")
    || message.includes("ACTOR_MISMATCH")
    || message.includes("BAS_GRAMMAR_UNAUTHORIZED")
  ) {
    return { status: 403, message: "无权开始这次练习。" };
  }
  if (
    error?.code === "PGRST202" ||
    message.includes("Could not find the function") ||
    message.includes("schema cache")
  ) {
    return {
      status: 503,
      message: "练习权限数据库尚未安装，请先执行本次迁移 SQL。"
    };
  }
  return { status: 500, message: fallback };
}

export function mapPracticeEntitlementError(
  error: { message?: string; code?: string } | null | undefined,
  fallback: string
): PracticeEntitlementFailure {
  const message = error?.message ?? "";
  if (message.includes("ADMIN_REQUIRED")) {
    return { status: 403, message: "仅管理员可以管理练习权限。" };
  }
  if (message.includes("STUDENT_NOT_FOUND")) {
    return { status: 404, message: "未找到该学生。" };
  }
  if (message.includes("INVALID_ENTITLEMENT_KIND")) {
    return { status: 400, message: "包含未知的练习额度类型。" };
  }
  if (message.includes("INVALID_ENTITLEMENT_VALUE")) {
    return { status: 400, message: "额度必须是 0 或正整数。" };
  }
  if (message.includes("INVALID_ENTITLEMENT_PAYLOAD")) {
    return { status: 400, message: "请至少提交一项有效的练习额度。" };
  }
  if (message.includes("UNAUTHENTICATED")) {
    return { status: 401, message: "请先登录。" };
  }
  if (message.includes("STUDENT_REQUIRED")) {
    return { status: 403, message: "仅学生可以查看自己的练习额度。" };
  }
  if (
    error?.code === "PGRST202" ||
    message.includes("Could not find the function") ||
    message.includes("schema cache")
  ) {
    return {
      status: 503,
      message: "练习额度数据库尚未安装，请先执行本次迁移 SQL。"
    };
  }
  if (error?.code === "42501" || message.includes("permission denied")) {
    return {
      status: 503,
      message: "练习额度数据库权限未配置，请先执行本次迁移 SQL。"
    };
  }
  return { status: 500, message: fallback };
}

export type StudentPracticeEntitlementsPayload = {
  entitlements: PracticeEntitlementSnapshotItem[];
  enforcementEnabled: boolean;
  viewerRole: "student" | "teacher" | "admin" | null;
};

export function isCategoryPracticeEntitlementKind(
  kind: PracticeEntitlementKind
) {
  return kind === "bas_category" || kind === "rap_category";
}

export function practiceEntitlementRemainingMap(
  entitlements: readonly PracticeEntitlementSnapshotItem[]
) {
  return new Map(entitlements.map((row) => [row.kind, row.remaining]));
}

/**
 * UI-only start decision. The database remains authoritative: this only
 * decides whether to render an enabled start action before the request.
 * Existing drafts, completed results and historical Retakes are never blocked
 * by a zero balance.
 */
export function canStartOrdinaryPractice(input: {
  enforcementEnabled: boolean;
  unlocked: boolean;
  remaining: number | null;
  status: "unstarted" | "in_progress" | "completed";
  viewerRole: "student" | "teacher" | "admin" | null;
}) {
  if (input.viewerRole !== "student" || !input.enforcementEnabled) return true;
  if (input.status !== "unstarted") return true;
  if (input.unlocked) return true;
  // Unknown balance must not disable a valid entry before the shared read
  // resolves; the database remains the authority for the actual Start.
  return input.remaining === null || input.remaining > 0;
}

export function practiceQuotaExhausted(input: {
  enforcementEnabled: boolean;
  remaining: number | null;
  viewerRole: "student" | "teacher" | "admin" | null;
}) {
  return input.viewerRole === "student"
    && input.enforcementEnabled
    && input.remaining !== null
    && input.remaining <= 0;
}
