import type { WritingTaskType } from "./writing";

/**
 * Version of the idea-pool prompt/validator contract. It is stored with every
 * pool for diagnostics only: an existing ready pool is never regenerated just
 * because this constant changes.
 */
export const WRITING_IDEA_PROMPT_VERSION = "writing_idea_pool_v1_2026_11_22";

export const WRITING_IDEA_MIN_REASONS = 10;
export const WRITING_IDEA_MAX_REASONS = 12;
export const WRITING_IDEA_MIN_DETAILS = 8;
export const WRITING_IDEA_MAX_DETAILS = 12;
export const WRITING_IDEA_AD_DISPLAY_COUNT = 3;
export const WRITING_IDEA_WE_MIN_DISPLAY = 2;
export const WRITING_IDEA_WE_MAX_DISPLAY = 3;

/**
 * Fixed, deterministic categories for WE details. Slots are used only to
 * prevent incompatible values (for example two different interview dates)
 * from being shown together; they are never shown to students.
 */
export const WRITING_IDEA_SLOTS = [
  "current_deadline",
  "proposed_date",
  "proposed_time",
  "proposed_datetime",
  "duration",
  "location",
  "interview_method",
  "participant",
  "topic",
  "background",
  "reason",
  "purpose",
  "general"
] as const;

export type WritingIdeaSlot = (typeof WRITING_IDEA_SLOTS)[number];

export type AcademicDiscussionIdeaPool = {
  schema_version: 1;
  task_type: "academic_discussion";
  side_a_reasons: string[];
  side_b_reasons: string[];
};

export type EmailIdeaPoolDetail = {
  text: string;
  slot: WritingIdeaSlot;
};

export type EmailIdeaPoolRequirement = {
  index: number;
  requirement: string;
  details: EmailIdeaPoolDetail[];
};

export type EmailIdeaPool = {
  schema_version: 1;
  task_type: "email";
  requirements: EmailIdeaPoolRequirement[];
};

export type WritingIdeaPool = AcademicDiscussionIdeaPool | EmailIdeaPool;

export type AcademicDiscussionIdeaSelection = {
  schema_version: 1;
  task_type: "academic_discussion";
  sides: [
    { key: "a"; reasons: string[] },
    { key: "b"; reasons: string[] }
  ];
};

export type EmailIdeaSelectionRequirement = {
  index: number;
  requirement: string;
  details: string[];
};

export type EmailIdeaSelection = {
  schema_version: 1;
  task_type: "email";
  requirements: EmailIdeaSelectionRequirement[];
};

export type WritingIdeaSelection =
  | AcademicDiscussionIdeaSelection
  | EmailIdeaSelection;

export type WritingIdeaGenerationInput = {
  taskType: WritingTaskType;
  question: import("./writing").WritingQuestion;
  attemptNumber: number;
};

export type WritingIdeaReadyResult = {
  status: "ready";
  selection: WritingIdeaSelection;
  generated: boolean;
};

export type WritingIdeaGeneratingResult = {
  status: "generating";
  retryAfterMs: number;
};

export type WritingIdeaAssistantResult =
  | WritingIdeaReadyResult
  | WritingIdeaGeneratingResult;

export type WritingIdeaPoolIdentity = {
  taskType: WritingTaskType;
  questionId: string;
  questionSource: "question_bank" | "custom";
  promptVersion: string;
};

export type WritingIdeaClaim =
  | { kind: "ready"; poolId: string; content: unknown }
  | { kind: "claimed"; poolId: string; token: string }
  | { kind: "busy"; retryAfterMs: number };
