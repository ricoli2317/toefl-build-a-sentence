import type {
  EmailQuestion,
  WritingAttempt,
  WritingQuestion,
  WritingTaskType
} from "./writing";
import {
  WRITING_IDEA_AD_DISPLAY_COUNT,
  WRITING_IDEA_MAX_DETAILS,
  WRITING_IDEA_MAX_REASONS,
  WRITING_IDEA_MIN_DETAILS,
  WRITING_IDEA_MIN_REASONS,
  WRITING_IDEA_PROMPT_VERSION,
  WRITING_IDEA_SLOTS,
  WRITING_IDEA_WE_MAX_DISPLAY,
  WRITING_IDEA_WE_MIN_DISPLAY,
  type AcademicDiscussionIdeaPool,
  type AcademicDiscussionIdeaSelection,
  type EmailIdeaPool,
  type EmailIdeaPoolDetail,
  type EmailIdeaPoolRequirement,
  type EmailIdeaSelection,
  type EmailIdeaSelectionRequirement,
  type WritingIdeaAssistantResult,
  type WritingIdeaClaim,
  type WritingIdeaGenerationInput,
  type WritingIdeaPool,
  type WritingIdeaPoolIdentity,
  type WritingIdeaSelection,
  type WritingIdeaSlot
} from "./writingIdeaAssistantTypes.ts";

const MAX_IDEA_TEXT_LENGTH = 80;
const MAX_IDEA_LATIN_WORDS = 4;
const MIN_IDEA_HAN_CHARS = 6;
const MAX_IDEA_HAN_CHARS = 24;
const MAX_SELECTION_SOLVER_NODES = 50_000;

const EXCLUSIVE_SLOT_FAMILY: Partial<Record<WritingIdeaSlot, string>> = {
  current_deadline: "current_deadline",
  proposed_date: "schedule",
  proposed_time: "schedule",
  proposed_datetime: "schedule",
  duration: "duration",
  location: "place_mode",
  interview_method: "place_mode",
  participant: "participant"
};

const SLOT_SET = new Set<string>(WRITING_IDEA_SLOTS);

export type WritingIdeaAttemptContext = Pick<
  WritingAttempt,
  | "attempt_id"
  | "user_id"
  | "task_type"
  | "question_id"
  | "writing_mode"
  | "status"
  | "attempt_kind"
  | "assignment_id"
>;

export type WritingIdeaRepository = {
  loadSelection(attemptId: string): Promise<unknown | null>;
  saveSelection(input: {
    attemptId: string;
    poolId: string;
    studentId: string;
    taskType: WritingTaskType;
    questionId: string;
    selection: WritingIdeaSelection;
  }): Promise<unknown>;
  claimPool(identity: WritingIdeaPoolIdentity): Promise<WritingIdeaClaim>;
  completePool(input: {
    poolId: string;
    token: string;
    content: WritingIdeaPool;
    model: string;
  }): Promise<boolean>;
  failPool(input: {
    poolId: string;
    token: string;
    error: string;
  }): Promise<boolean>;
};

export type WritingIdeaAssistantDependencies = {
  repository: WritingIdeaRepository;
  generatePool(input: WritingIdeaGenerationInput): Promise<{
    raw: unknown;
    model: string;
  }>;
  rng?: () => number;
  onDiagnostic?: (
    event: string,
    detail: Record<string, string | number | boolean | null>
  ) => void;
};

export type WritingIdeaAssistantInput = {
  attempt: WritingIdeaAttemptContext;
  question: WritingQuestion;
  questionSource: "question_bank" | "custom";
  assignmentAvailable?: boolean;
};

export type WritingIdeaAssistantErrorCode =
  | "INVALID_ATTEMPT"
  | "EXAM_MODE"
  | "ASSIGNMENT_UNAVAILABLE"
  | "QUESTION_MISMATCH"
  | "GENERATION_FAILED"
  | "CACHE_INVALID"
  | "STORAGE_FAILED"
  | "NOT_INSTALLED";

export class WritingIdeaAssistantError extends Error {
  code: WritingIdeaAssistantErrorCode;
  status: number;

  constructor(
    message: string,
    code: WritingIdeaAssistantErrorCode,
    status: number
  ) {
    super(message);
    this.name = "WritingIdeaAssistantError";
    this.code = code;
    this.status = status;
  }
}

export function getEmailRequirements(question: EmailQuestion) {
  const source = question as unknown as Record<string, unknown>;
  const requirements: Array<{ index: number; text: string }> = [];
  for (let index = 1; index <= 8; index += 1) {
    const value = source[`requirement_${index}`];
    if (typeof value === "string" && value.trim()) {
      requirements.push({ index: requirements.length + 1, text: value.trim() });
    }
  }
  return requirements;
}

/** Removes harmless trailing sentence punctuation, then accepts only short,
 * independent Chinese idea phrases. Anything that reads like an explanation,
 * a full English sentence, or a restated instruction is rejected. */
export function normalizeIdeaText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (/[\r\n]/.test(value)) return null;
  let text = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || text.length > MAX_IDEA_TEXT_LENGTH) return null;
  text = text.replace(/[。．.!！?？]+$/g, "").trim();
  if (!text || text.length > MAX_IDEA_TEXT_LENGTH) return null;
  if (/[。！？!?]/.test(text)) return null;

  const hanCount = countHanCharacters(text);
  if (hanCount < MIN_IDEA_HAN_CHARS || hanCount > MAX_IDEA_HAN_CHARS) {
    return null;
  }
  if (countLatinWords(text) > MAX_IDEA_LATIN_WORDS) return null;
  if (/(?:[：:])(?!\d)|(?<!\d)[：:]/.test(text)) return null;
  if (/[；;]/.test(text)) return null;
  if (/例如|比如|譬如|举例来说|比方说|也就是说|即指/.test(text)) return null;
  if (
    /^(说明|解释|描述|介绍|请求|提出|建议|表达|分享|告诉|谈谈|讨论|概述|列举).{0,18}(原因|理由|情况|内容|细节|目的|观点|安排|日期和时间|具体时间|具体地点|一次面谈|一次采访|一次会面)$/.test(
      text
    )
  ) {
    return null;
  }
  return text;
}

export function countHanCharacters(text: string) {
  return text.match(/[\u3400-\u4DBF\u4E00-\u9FFF]/g)?.length ?? 0;
}

function countLatinWords(text: string) {
  return text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)?.length ?? 0;
}

function canonicalIdeaKey(text: string) {
  return text
    .toLowerCase()
    .replace(/[\s，,、。.!！?？:：;；"'“”‘’()（）]/g, "");
}

function isNegatedPair(left: string, right: string) {
  const prefixes = ["不", "没有", "无需", "并不", "未必", "不应", "不能", "不会"];
  return prefixes.some((prefix) => {
    if (left.startsWith(prefix) && left.slice(prefix.length) === right) return true;
    if (right.startsWith(prefix) && right.slice(prefix.length) === left) return true;
    return false;
  });
}

function bigramSimilarity(left: string, right: string) {
  if (left.length < 2 || right.length < 2) return left === right ? 1 : 0;
  const leftBigrams = new Map<string, number>();
  for (let index = 0; index < left.length - 1; index += 1) {
    const gram = left.slice(index, index + 2);
    leftBigrams.set(gram, (leftBigrams.get(gram) ?? 0) + 1);
  }
  let overlap = 0;
  for (let index = 0; index < right.length - 1; index += 1) {
    const gram = right.slice(index, index + 2);
    const count = leftBigrams.get(gram) ?? 0;
    if (count > 0) {
      overlap += 1;
      leftBigrams.set(gram, count - 1);
    }
  }
  return (2 * overlap) / (left.length + right.length - 2);
}

/** Detects details that merely repeat the requirement instead of supplying
 * concrete writing material. */
export function isRequirementEcho(detail: string, requirement: string) {
  const detailKey = canonicalIdeaKey(detail);
  const requirementKey = canonicalIdeaKey(requirement);
  if (!detailKey || !requirementKey) return false;
  if (detailKey === requirementKey) return true;

  const shorter = detailKey.length <= requirementKey.length ? detailKey : requirementKey;
  const longer = shorter === detailKey ? requirementKey : detailKey;
  if (shorter.length >= 6 && longer.includes(shorter)) return true;
  if (requirementKey.length >= 8 && bigramSimilarity(detailKey, requirementKey) >= 0.72) {
    return true;
  }

  const directive = /^(说明|解释|描述|介绍|请求|提出|建议|表达|分享|告诉|谈谈|讨论|概述|列举)/;
  const strippedDetail = detailKey.replace(directive, "");
  const strippedRequirement = requirementKey.replace(directive, "");
  if (
    strippedDetail.length >= 6 &&
    strippedRequirement.length >= 6 &&
    (strippedDetail === strippedRequirement ||
      strippedDetail.includes(strippedRequirement) ||
      strippedRequirement.includes(strippedDetail))
  ) {
    return true;
  }
  return false;
}

export function writingIdeaSlotsConflict(
  left: WritingIdeaSlot,
  right: WritingIdeaSlot
) {
  if (left === right) {
    return Boolean(EXCLUSIVE_SLOT_FAMILY[left]);
  }
  const leftFamily = EXCLUSIVE_SLOT_FAMILY[left];
  const rightFamily = EXCLUSIVE_SLOT_FAMILY[right];
  if (!leftFamily || !rightFamily) return false;
  if (leftFamily !== rightFamily) return false;
  // A date and a time can be combined; a self-contained date+time cannot be
  // combined with either part.
  if (leftFamily === "schedule") {
    return left === "proposed_datetime" || right === "proposed_datetime";
  }
  return true;
}

function normalizeReasonList(value: unknown, label: string) {
  if (!Array.isArray(value)) {
    throw invalidPool(`${label} must be an array.`);
  }
  if (value.length < WRITING_IDEA_MIN_REASONS || value.length > WRITING_IDEA_MAX_REASONS) {
    throw invalidPool(`${label} must contain ${WRITING_IDEA_MIN_REASONS}-${WRITING_IDEA_MAX_REASONS} items.`);
  }
  const reasons = value.map((item) => normalizeIdeaText(item));
  if (reasons.some((item) => !item)) {
    throw invalidPool(`${label} contains an invalid concise reason.`);
  }
  const normalized = reasons as string[];
  const seen = new Set<string>();
  for (const reason of normalized) {
    const key = canonicalIdeaKey(reason);
    if (seen.has(key)) throw invalidPool(`${label} contains a duplicate reason.`);
    seen.add(key);
  }
  return normalized;
}

function normalizeAcademicDiscussionPool(value: unknown): AcademicDiscussionIdeaPool {
  if (!isRecord(value)) throw invalidPool("Idea pool must be an object.");
  if (value.schema_version !== undefined && value.schema_version !== 1) {
    throw invalidPool("Unsupported idea pool schema.");
  }
  if (value.task_type !== undefined && value.task_type !== "academic_discussion") {
    throw invalidPool("Idea pool task type mismatch.");
  }
  const sideA = normalizeReasonList(value.side_a_reasons, "side_a_reasons");
  const sideB = normalizeReasonList(value.side_b_reasons, "side_b_reasons");
  const sideAKeys = new Set(sideA.map(canonicalIdeaKey));
  if (sideB.some((reason) => sideAKeys.has(canonicalIdeaKey(reason)))) {
    throw invalidPool("The two stances contain the same reason.");
  }
  let negatedPairs = 0;
  for (const left of sideA) {
    for (const right of sideB) {
      if (isNegatedPair(canonicalIdeaKey(left), canonicalIdeaKey(right))) {
        negatedPairs += 1;
      }
    }
  }
  if (negatedPairs >= 5) {
    throw invalidPool("The two stances are mechanical negations of each other.");
  }
  return {
    schema_version: 1,
    task_type: "academic_discussion",
    side_a_reasons: sideA,
    side_b_reasons: sideB
  };
}

function normalizeEmailPoolDetail(value: unknown): EmailIdeaPoolDetail {
  if (!isRecord(value)) throw invalidPool("Email detail must be an object.");
  const text = normalizeIdeaText(value.text);
  if (!text) throw invalidPool("Email detail contains an invalid concise phrase.");
  if (typeof value.slot !== "string" || !SLOT_SET.has(value.slot)) {
    throw invalidPool("Email detail has an unknown slot.");
  }
  return { text, slot: value.slot as WritingIdeaSlot };
}

function normalizeEmailPool(
  value: unknown,
  question: EmailQuestion | null,
  preserveStoredRequirements: boolean
): EmailIdeaPool {
  if (!isRecord(value)) throw invalidPool("Idea pool must be an object.");
  if (value.schema_version !== undefined && value.schema_version !== 1) {
    throw invalidPool("Unsupported idea pool schema.");
  }
  if (value.task_type !== undefined && value.task_type !== "email") {
    throw invalidPool("Idea pool task type mismatch.");
  }
  if (!Array.isArray(value.requirements)) {
    throw invalidPool("Email idea pool must contain requirement groups.");
  }

  const actualRequirements = question ? getEmailRequirements(question) : [];
  if (!preserveStoredRequirements) {
    if (actualRequirements.length === 0) {
      throw invalidPool("The email question has no requirements.");
    }
    if (value.requirements.length !== actualRequirements.length) {
      throw invalidPool("Email idea pool must contain exactly one group per requirement.");
    }
  }
  if (value.requirements.length === 0 || value.requirements.length > 8) {
    throw invalidPool("Email idea pool requirement count is invalid.");
  }

  const actualByIndex = new Map(actualRequirements.map((item) => [item.index, item.text]));
  const groups: EmailIdeaPoolRequirement[] = [];
  const seenIndexes = new Set<number>();
  const allDetailKeys = new Set<string>();

  for (const rawGroup of value.requirements) {
    if (!isRecord(rawGroup)) throw invalidPool("Email requirement group must be an object.");
    const index = Number(rawGroup.index);
    if (!Number.isInteger(index) || index < 1 || index > 8 || seenIndexes.has(index)) {
      throw invalidPool("Email requirement group index is invalid.");
    }
    seenIndexes.add(index);

    const requirement = preserveStoredRequirements && typeof rawGroup.requirement === "string" && rawGroup.requirement.trim()
      ? rawGroup.requirement.trim()
      : actualByIndex.get(index);
    if (!requirement) {
      throw invalidPool("Email requirement text is missing.");
    }

    if (!Array.isArray(rawGroup.details)) {
      throw invalidPool("Email requirement details must be an array.");
    }
    if (
      rawGroup.details.length < WRITING_IDEA_MIN_DETAILS ||
      rawGroup.details.length > WRITING_IDEA_MAX_DETAILS
    ) {
      throw invalidPool(
        `Email requirement details must contain ${WRITING_IDEA_MIN_DETAILS}-${WRITING_IDEA_MAX_DETAILS} items.`
      );
    }

    const details = rawGroup.details.map((detail) => {
      const normalized = normalizeEmailPoolDetail(detail);
      if (
        !preserveStoredRequirements &&
        isRequirementEcho(normalized.text, requirement)
      ) {
        throw invalidPool("Email detail repeats the requirement.");
      }
      const key = canonicalIdeaKey(normalized.text);
      if (allDetailKeys.has(key)) {
        throw invalidPool("Email idea pool contains a duplicate detail.");
      }
      allDetailKeys.add(key);
      return normalized;
    });

    groups.push({ index, requirement, details });
  }

  groups.sort((left, right) => left.index - right.index);
  const pool: EmailIdeaPool = {
    schema_version: 1,
    task_type: "email",
    requirements: groups
  };
  if (!selectEmailIdeaDetails(pool, () => 0.37)) {
    throw invalidPool("Email idea pool cannot produce a conflict-free combination.");
  }
  return pool;
}

export function normalizeWritingIdeaPool(input: {
  raw: unknown;
  taskType: WritingTaskType;
  question: WritingQuestion;
  preserveStoredRequirements?: boolean;
}): WritingIdeaPool {
  if (input.taskType === "academic_discussion") {
    return normalizeAcademicDiscussionPool(input.raw);
  }
  return normalizeEmailPool(
    input.raw,
    input.question as EmailQuestion,
    input.preserveStoredRequirements === true
  );
}

function shuffledCopy<T>(items: readonly T[], rng: () => number) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const value = Number(rng());
    const normalized = Number.isFinite(value) ? Math.min(Math.max(value, 0), 0.999999) : 0;
    const target = Math.floor(normalized * (index + 1));
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}

function combinations<T>(items: readonly T[], size: number) {
  if (size <= 0 || size > items.length) return [] as T[][];
  const result: T[][] = [];
  const current: T[] = [];
  function visit(start: number) {
    if (current.length === size) {
      result.push([...current]);
      return;
    }
    const remaining = size - current.length;
    for (let index = start; index <= items.length - remaining; index += 1) {
      current.push(items[index]);
      visit(index + 1);
      current.pop();
    }
  }
  visit(0);
  return result;
}

function detailsAreCompatible(details: readonly EmailIdeaPoolDetail[]) {
  for (let left = 0; left < details.length; left += 1) {
    for (let right = left + 1; right < details.length; right += 1) {
      if (writingIdeaSlotsConflict(details[left].slot, details[right].slot)) {
        return false;
      }
    }
  }
  return true;
}

function detailsFitUsedSlots(
  details: readonly EmailIdeaPoolDetail[],
  usedSlots: readonly WritingIdeaSlot[]
) {
  return details.every((detail) =>
    usedSlots.every((slot) => !writingIdeaSlotsConflict(detail.slot, slot))
  );
}

/** Chooses 2-3 details per requirement with deterministic slot constraints.
 * A small bounded backtracker guarantees that the returned combination has no
 * contradictory dates, places, interview modes, durations or participants. */
export function selectEmailIdeaDetails(
  pool: EmailIdeaPool,
  rng: () => number = Math.random
): EmailIdeaSelection | null {
  const requirements = [...pool.requirements].sort(
    (left, right) => left.index - right.index
  );
  if (requirements.length === 0) return null;

  const shuffledDetails = requirements.map((requirement) =>
    shuffledCopy(requirement.details, rng)
  );
  const budget = { nodes: 0 };

  for (let pass = 0; pass < 2; pass += 1) {
    const targets = requirements.map(() =>
      pass === 0
        ? (Number(rng()) < 0.5 ? WRITING_IDEA_WE_MIN_DISPLAY : WRITING_IDEA_WE_MAX_DISPLAY)
        : WRITING_IDEA_WE_MIN_DISPLAY
    );
    const chosen: EmailIdeaSelectionRequirement[] = [];
    const result = solveEmailSelection({
      requirements,
      shuffledDetails,
      targets,
      index: 0,
      usedSlots: [],
      chosen,
      budget
    });
    if (result) {
      return {
        schema_version: 1,
        task_type: "email",
        requirements: result
      };
    }
    if (budget.nodes > MAX_SELECTION_SOLVER_NODES) return null;
  }
  return null;
}

function solveEmailSelection(input: {
  requirements: EmailIdeaPoolRequirement[];
  shuffledDetails: EmailIdeaPoolDetail[][];
  targets: number[];
  index: number;
  usedSlots: WritingIdeaSlot[];
  chosen: EmailIdeaSelectionRequirement[];
  budget: { nodes: number };
}): EmailIdeaSelectionRequirement[] | null {
  if (input.index >= input.requirements.length) return input.chosen;
  if (input.budget.nodes > MAX_SELECTION_SOLVER_NODES) return null;

  const requirement = input.requirements[input.index];
  const target = input.targets[input.index];
  const candidates = input.shuffledDetails[input.index];
  const options = combinations(candidates, target);

  for (const option of options) {
    input.budget.nodes += 1;
    if (input.budget.nodes > MAX_SELECTION_SOLVER_NODES) return null;
    if (!detailsAreCompatible(option)) continue;
    if (!detailsFitUsedSlots(option, input.usedSlots)) continue;

    const next = [
      ...input.chosen,
      {
        index: requirement.index,
        requirement: requirement.requirement,
        details: option.map((detail) => detail.text)
      }
    ];
    const solved = solveEmailSelection({
      ...input,
      index: input.index + 1,
      usedSlots: [...input.usedSlots, ...option.map((detail) => detail.slot)],
      chosen: next
    });
    if (solved) return solved;
  }
  return null;
}

export function buildWritingIdeaSelection(
  pool: WritingIdeaPool,
  rng: () => number = Math.random
): WritingIdeaSelection {
  if (pool.task_type === "academic_discussion") {
    const sideA = shuffledCopy(pool.side_a_reasons, rng).slice(
      0,
      WRITING_IDEA_AD_DISPLAY_COUNT
    );
    const sideB = shuffledCopy(pool.side_b_reasons, rng).slice(
      0,
      WRITING_IDEA_AD_DISPLAY_COUNT
    );
    return {
      schema_version: 1,
      task_type: "academic_discussion",
      sides: [
        { key: "a", reasons: sideA },
        { key: "b", reasons: sideB }
      ]
    };
  }

  const selection = selectEmailIdeaDetails(pool, rng);
  if (!selection) {
    throw invalidPool("Email idea pool cannot produce a conflict-free combination.");
  }
  return selection;
}

export function assertWritingIdeaAttemptAllowed(
  attempt: WritingIdeaAttemptContext
) {
  if (attempt.task_type !== "email" && attempt.task_type !== "academic_discussion") {
    throw new WritingIdeaAssistantError(
      "当前写作记录不能使用写作思路助手。",
      "INVALID_ATTEMPT",
      409
    );
  }
  if (attempt.attempt_kind !== "original") {
    throw new WritingIdeaAssistantError(
      "当前写作记录不能使用写作思路助手。",
      "INVALID_ATTEMPT",
      409
    );
  }
  if (attempt.status !== "draft") {
    throw new WritingIdeaAssistantError(
      "只有作答中的写作草稿可以使用写作思路助手。",
      "INVALID_ATTEMPT",
      409
    );
  }
  if (attempt.writing_mode === "exam") {
    throw new WritingIdeaAssistantError(
      "模考模式不能使用写作思路助手。",
      "EXAM_MODE",
      403
    );
  }
  if (attempt.writing_mode !== "practice") {
    throw new WritingIdeaAssistantError(
      "只有练习模式可以使用写作思路助手。",
      "INVALID_ATTEMPT",
      409
    );
  }
}

function assertQuestionMatchesAttempt(
  attempt: WritingIdeaAttemptContext,
  question: WritingQuestion
) {
  if (
    !question ||
    typeof question.question_id !== "string" ||
    question.question_id !== attempt.question_id
  ) {
    throw new WritingIdeaAssistantError(
      "写作题目与当前记录不匹配。",
      "QUESTION_MISMATCH",
      409
    );
  }
  if (attempt.task_type === "email") {
    const email = question as EmailQuestion;
    if (getEmailRequirements(email).length === 0) {
      throw new WritingIdeaAssistantError(
        "写作题目缺少写作要求。",
        "QUESTION_MISMATCH",
        409
      );
    }
    return;
  }
  const academic = question as WritingQuestion & {
    professor_prompt?: unknown;
    student_1_response?: unknown;
    student_2_response?: unknown;
  };
  if (
    typeof academic.professor_prompt !== "string" ||
    !academic.professor_prompt.trim() ||
    typeof academic.student_1_response !== "string" ||
    typeof academic.student_2_response !== "string"
  ) {
    throw new WritingIdeaAssistantError(
      "写作题目内容不完整。",
      "QUESTION_MISMATCH",
      409
    );
  }
}

export function assertWritingIdeaSelection(
  value: unknown,
  taskType: WritingTaskType
): WritingIdeaSelection {
  if (!isRecord(value) || value.task_type !== taskType) {
    throw invalidCache();
  }
  if (taskType === "academic_discussion") {
    if (!Array.isArray(value.sides) || value.sides.length !== 2) {
      throw invalidCache();
    }
    const sides = value.sides.map((side, index) => {
      if (!isRecord(side) || side.key !== (index === 0 ? "a" : "b")) {
        throw invalidCache();
      }
      if (!Array.isArray(side.reasons) || side.reasons.length !== WRITING_IDEA_AD_DISPLAY_COUNT) {
        throw invalidCache();
      }
      const reasons = side.reasons.map((reason) => normalizeIdeaText(reason));
      if (reasons.some((reason) => !reason)) throw invalidCache();
      return {
        key: (index === 0 ? "a" : "b") as "a" | "b",
        reasons: reasons as string[]
      };
    });
    return {
      schema_version: 1,
      task_type: "academic_discussion",
      sides: [sides[0], sides[1]] as AcademicDiscussionIdeaSelection["sides"]
    };
  }

  if (!Array.isArray(value.requirements) || value.requirements.length === 0) {
    throw invalidCache();
  }
  if (value.requirements.length > 8) throw invalidCache();
  const requirements: EmailIdeaSelectionRequirement[] = [];
  const seen = new Set<string>();
  const seenIndexes = new Set<number>();
  for (const rawRequirement of value.requirements) {
    if (!isRecord(rawRequirement)) throw invalidCache();
    const index = Number(rawRequirement.index);
    if (!Number.isInteger(index) || index < 1 || index > 8) throw invalidCache();
    if (seenIndexes.has(index)) throw invalidCache();
    seenIndexes.add(index);
    if (typeof rawRequirement.requirement !== "string" || !rawRequirement.requirement.trim()) {
      throw invalidCache();
    }
    if (!Array.isArray(rawRequirement.details)) throw invalidCache();
    if (
      rawRequirement.details.length < WRITING_IDEA_WE_MIN_DISPLAY ||
      rawRequirement.details.length > WRITING_IDEA_WE_MAX_DISPLAY
    ) {
      throw invalidCache();
    }
    const details: string[] = [];
    for (const rawDetail of rawRequirement.details) {
      const detail = normalizeIdeaText(rawDetail);
      if (!detail) throw invalidCache();
      const key = canonicalIdeaKey(detail);
      if (seen.has(key)) throw invalidCache();
      seen.add(key);
      details.push(detail);
    }
    requirements.push({
      index,
      requirement: rawRequirement.requirement.trim(),
      details
    });
  }
  requirements.sort((left, right) => left.index - right.index);
  return {
    schema_version: 1,
    task_type: "email",
    requirements
  } satisfies EmailIdeaSelection;
}

export async function getWritingIdeaAssistantResult(
  input: WritingIdeaAssistantInput,
  dependencies: WritingIdeaAssistantDependencies
): Promise<WritingIdeaAssistantResult> {
  const { attempt, question, questionSource } = input;
  assertWritingIdeaAttemptAllowed(attempt);

  if (attempt.assignment_id && input.assignmentAvailable === false) {
    throw new WritingIdeaAssistantError(
      "这项作业已撤回，不能继续作答。",
      "ASSIGNMENT_UNAVAILABLE",
      409
    );
  }
  assertQuestionMatchesAttempt(attempt, question);

  const rng = dependencies.rng ?? Math.random;
  const log = dependencies.onDiagnostic ?? (() => undefined);

  let existingSelection: unknown | null;
  try {
    existingSelection = await dependencies.repository.loadSelection(
      attempt.attempt_id
    );
  } catch (error) {
    throw normalizeStorageError(error);
  }
  if (existingSelection) {
    return {
      status: "ready",
      selection: assertWritingIdeaSelection(existingSelection, attempt.task_type),
      generated: false
    };
  }

  const identity: WritingIdeaPoolIdentity = {
    taskType: attempt.task_type,
    questionId: question.question_id,
    questionSource,
    promptVersion: WRITING_IDEA_PROMPT_VERSION
  };

  let claim: WritingIdeaClaim;
  try {
    claim = await dependencies.repository.claimPool(identity);
  } catch (error) {
    throw normalizeStorageError(error);
  }
  if (claim.kind === "busy") {
    return {
      status: "generating",
      retryAfterMs: clampRetryAfter(claim.retryAfterMs)
    };
  }

  let pool: WritingIdeaPool;
  let poolId = claim.poolId;
  let generated = false;

  if (claim.kind === "ready") {
    pool = normalizeCachedPool(claim.content, attempt.task_type, question);
  } else {
    let normalized: WritingIdeaPool | null = null;
    let model = "unknown";
    let lastError: unknown = null;

    for (let attemptNumber = 1; attemptNumber <= 2; attemptNumber += 1) {
      try {
        const result = await dependencies.generatePool({
          taskType: attempt.task_type,
          question,
          attemptNumber
        });
        model = result.model;
        normalized = normalizeWritingIdeaPool({
          raw: result.raw,
          taskType: attempt.task_type,
          question
        });
        break;
      } catch (error) {
        lastError = error;
        log("generation_attempt_failed", {
          attempt: attemptNumber,
          error: error instanceof Error ? error.name : "unknown"
        });
      }
    }

    if (!normalized) {
      await safeFailPool(dependencies, claim.poolId, claim.token, "generation_failed", log);
      log("generation_failed", {
        error: lastError instanceof Error ? lastError.name : "unknown"
      });
      throw new WritingIdeaAssistantError(
        "思路生成失败，请稍后重试。",
        "GENERATION_FAILED",
        502
      );
    }

    // Validate that a renderable selection exists before the pool is marked
    // ready. This guarantees that an invalid pool can never be cached.
    try {
      buildWritingIdeaSelection(normalized, rng);
    } catch {
      await safeFailPool(dependencies, claim.poolId, claim.token, "selection_invalid", log);
      throw new WritingIdeaAssistantError(
        "思路生成失败，请稍后重试。",
        "GENERATION_FAILED",
        502
      );
    }
    pool = normalized;

    let completed: boolean;
    try {
      completed = await dependencies.repository.completePool({
        poolId: claim.poolId,
        token: claim.token,
        content: normalized,
        model
      });
    } catch (error) {
      await safeFailPool(dependencies, claim.poolId, claim.token, "pool_save_failed", log);
      throw normalizeStorageError(error);
    }

    if (completed) {
      generated = true;
    } else {
      // A slow worker lost its lease or another instance finished first.
      let recheck: WritingIdeaClaim;
      try {
        recheck = await dependencies.repository.claimPool(identity);
      } catch (error) {
        throw normalizeStorageError(error);
      }
      if (recheck.kind === "busy") {
        return {
          status: "generating",
          retryAfterMs: clampRetryAfter(recheck.retryAfterMs)
        };
      }
      if (recheck.kind === "ready") {
        pool = normalizeCachedPool(recheck.content, attempt.task_type, question);
        poolId = recheck.poolId;
      } else {
        poolId = recheck.poolId;
        const savedAgain = await dependencies.repository.completePool({
          poolId: recheck.poolId,
          token: recheck.token,
          content: normalized,
          model
        });
        if (!savedAgain) {
          throw new WritingIdeaAssistantError(
            "写作思路暂时无法保存，请稍后重试。",
            "STORAGE_FAILED",
            503
          );
        }
        generated = true;
      }
    }
  }

  const selection = (() => {
    try {
      return buildWritingIdeaSelection(pool, rng);
    } catch {
      throw generated
        ? new WritingIdeaAssistantError(
            "思路生成失败，请稍后重试。",
            "GENERATION_FAILED",
            502
          )
        : invalidCache();
    }
  })();
  let savedSelection: unknown;
  try {
    savedSelection = await dependencies.repository.saveSelection({
      attemptId: attempt.attempt_id,
      poolId,
      studentId: attempt.user_id,
      taskType: attempt.task_type,
      questionId: question.question_id,
      selection
    });
  } catch (error) {
    throw normalizeStorageError(error);
  }

  return {
    status: "ready",
    selection: assertWritingIdeaSelection(savedSelection, attempt.task_type),
    generated
  };
}

function normalizeCachedPool(
  content: unknown,
  taskType: WritingTaskType,
  question: WritingQuestion
) {
  try {
    return normalizeWritingIdeaPool({
      raw: content,
      taskType,
      question,
      preserveStoredRequirements: true
    });
  } catch {
    throw invalidCache();
  }
}

async function safeFailPool(
  dependencies: WritingIdeaAssistantDependencies,
  poolId: string,
  token: string,
  error: string,
  log: NonNullable<WritingIdeaAssistantDependencies["onDiagnostic"]>
) {
  try {
    await dependencies.repository.failPool({ poolId, token, error });
  } catch (failure) {
    log("pool_fail_mark_failed", {
      error: failure instanceof Error ? failure.name : "unknown"
    });
  }
}

function normalizeStorageError(error: unknown) {
  if (error instanceof WritingIdeaAssistantError) return error;
  return new WritingIdeaAssistantError(
    "写作思路暂时不可用，请稍后重试。",
    "STORAGE_FAILED",
    500
  );
}

function clampRetryAfter(value: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1200;
  return Math.max(750, Math.min(5000, Math.round(number)));
}

function invalidPool(message: string) {
  return new WritingIdeaAssistantError(
    `思路内容校验失败：${message}`,
    "GENERATION_FAILED",
    502
  );
}

function invalidCache() {
  return new WritingIdeaAssistantError(
    "写作思路缓存异常，请稍后重试。",
    "CACHE_INVALID",
    502
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
