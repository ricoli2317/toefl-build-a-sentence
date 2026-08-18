import { isLaterOfficialAttempt, normalizeSetId } from "./studentSetStatus.ts";
import { isVirtualPracticeSetId } from "./studentNavigation.ts";
import type { PracticeTaskType } from "./practiceImporter/types.ts";
import type { FormalPracticeItemSource } from "./practicePublicUniverse.ts";
import { compareWritingSubmittedAttempts } from "./writingSubmissionHistory.ts";

export type LogicalPracticeStudentStatus = "unstarted" | "in_progress" | "completed";

export type LogicalPracticeStudentState = {
  status: LogicalPracticeStudentStatus;
  resume_attempt_id: string | null;
  latest_attempt_id: string | null;
  latest_completed_attempt_id: string | null;
  can_start: boolean;
  can_resume: boolean;
  can_retake: boolean;
  can_view_result: boolean;
};

export type LogicalPracticeSourceAction = {
  source_id: string;
  source_set_id: string | null;
  source_question_id: string | null;
};

export type LogicalPracticeAttemptAction = {
  attempt_id: string;
  source_set_id: string | null;
  source_question_id: string | null;
};

export type LogicalPracticeActions = {
  start: LogicalPracticeSourceAction | null;
  resume: LogicalPracticeAttemptAction | null;
  view_result: LogicalPracticeAttemptAction | null;
  retake: LogicalPracticeSourceAction | null;
};

export type BuildSentenceLogicalAttemptRow = {
  attempt_id: string;
  set_id: string;
  submitted_at: string | null;
  created_at: string | null;
};

export type WritingLogicalAttemptRow = {
  attempt_id: string;
  assignment_id: string | null;
  task_type: "email" | "academic_discussion";
  question_id: string;
  status: "draft" | "submitted";
  saved_at: string | null;
  submitted_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type LogicalStateItem = {
  item_id: string;
  task_type: PracticeTaskType;
  canonical: {
    source_id: string;
    source_set_id: string | null;
    source_question_id: string | null;
  };
};

export function attachLogicalPracticeStudentState<TItem extends LogicalStateItem>(input: {
  items: TItem[];
  sources: FormalPracticeItemSource[];
  buildSentenceAttempts?: BuildSentenceLogicalAttemptRow[];
  writingAttempts?: WritingLogicalAttemptRow[];
}): Array<TItem & {
  student_state: LogicalPracticeStudentState;
  actions: LogicalPracticeActions;
}> {
  const itemsById = new Map(input.items.map((item) => [item.item_id, item]));
  const sourceBySetId = new Map<string, FormalPracticeItemSource>();
  const sourceByQuestionId = new Map<string, FormalPracticeItemSource>();

  for (const source of input.sources) {
    const item = itemsById.get(source.itemId);
    if (!item || item.task_type !== source.taskType) continue;
    if (source.taskType === "build_sentence" && source.sourceSetId) {
      const setId = normalizeSetId(source.sourceSetId);
      if (setId && !isVirtualPracticeSetId(setId)) {
        sourceBySetId.set(setId, source);
      }
    } else if (source.taskType !== "build_sentence" && source.sourceQuestionId) {
      sourceByQuestionId.set(writingQuestionKey(source.taskType, source.sourceQuestionId), source);
    }
  }

  const buildSentenceAttemptsByItem = new Map<string, BuildSentenceLogicalAttemptRow[]>();
  for (const attempt of input.buildSentenceAttempts ?? []) {
    const setId = normalizeSetId(attempt.set_id);
    if (!setId || isVirtualPracticeSetId(setId)) continue;
    const source = sourceBySetId.get(setId);
    if (!source) continue;
    append(buildSentenceAttemptsByItem, source.itemId, attempt);
  }

  const writingAttemptsByItem = new Map<string, WritingLogicalAttemptRow[]>();
  for (const attempt of input.writingAttempts ?? []) {
    if (attempt.assignment_id !== null) continue;
    const source = sourceByQuestionId.get(
      writingQuestionKey(attempt.task_type, attempt.question_id)
    );
    if (!source) continue;
    append(writingAttemptsByItem, source.itemId, attempt);
  }

  return input.items.map((item) => {
    const stateAndActions = item.task_type === "build_sentence"
      ? buildBuildSentenceState(
          item,
          buildSentenceAttemptsByItem.get(item.item_id) ?? []
        )
      : buildWritingState(item, writingAttemptsByItem.get(item.item_id) ?? []);
    return { ...item, ...stateAndActions };
  });
}

function buildBuildSentenceState(
  item: LogicalStateItem,
  attempts: BuildSentenceLogicalAttemptRow[]
) {
  const latest = attempts.reduce<BuildSentenceLogicalAttemptRow | null>(
    (current, attempt) =>
      !current || isLaterOfficialAttempt(attempt, current) ? attempt : current,
    null
  );
  const status: LogicalPracticeStudentStatus = latest ? "completed" : "unstarted";
  return buildStateAndActions({
    item,
    status,
    resume: null,
    latest,
    latestCompleted: latest,
    rawTarget: latest
      ? { source_set_id: latest.set_id, source_question_id: null }
      : null
  });
}

function buildWritingState(
  item: LogicalStateItem,
  attempts: WritingLogicalAttemptRow[]
) {
  const drafts = attempts
    .filter((attempt) => attempt.status === "draft")
    .sort(compareWritingDraftAttempts);
  const submitted = attempts
    .filter((attempt) => attempt.status === "submitted")
    .sort(compareWritingSubmittedAttempts);
  const resume = drafts[0] ?? null;
  const latestCompleted = submitted[0] ?? null;
  const latest = attempts.slice().sort(compareWritingAttempts)[0] ?? null;
  const status: LogicalPracticeStudentStatus = resume
    ? "in_progress"
    : latestCompleted
      ? "completed"
      : "unstarted";

  return buildStateAndActions({
    item,
    status,
    resume,
    latest,
    latestCompleted,
    rawTarget: latestCompleted
      ? { source_set_id: null, source_question_id: latestCompleted.question_id }
      : null
  });
}

function buildStateAndActions(input: {
  item: LogicalStateItem;
  status: LogicalPracticeStudentStatus;
  resume: { attempt_id: string; question_id: string } | null;
  latest: { attempt_id: string } | null;
  latestCompleted: { attempt_id: string } | null;
  rawTarget: Pick<LogicalPracticeAttemptAction, "source_set_id" | "source_question_id"> | null;
}) {
  const canonical: LogicalPracticeSourceAction = {
    source_id: input.item.canonical.source_id,
    source_set_id: input.item.canonical.source_set_id,
    source_question_id: input.item.canonical.source_question_id
  };
  const resume = input.resume
    ? {
        attempt_id: input.resume.attempt_id,
        source_set_id: null,
        source_question_id: input.resume.question_id
      }
    : null;
  const viewResult = input.latestCompleted && input.rawTarget
    ? {
        attempt_id: input.latestCompleted.attempt_id,
        ...input.rawTarget
      }
    : null;
  return {
    student_state: {
      status: input.status,
      resume_attempt_id: input.resume?.attempt_id ?? null,
      latest_attempt_id: input.latest?.attempt_id ?? null,
      latest_completed_attempt_id: input.latestCompleted?.attempt_id ?? null,
      can_start: input.status === "unstarted",
      can_resume: input.status === "in_progress" && Boolean(resume),
      can_retake: input.status === "completed",
      can_view_result: Boolean(viewResult)
    },
    actions: {
      start: input.status === "unstarted" ? canonical : null,
      resume,
      view_result: viewResult,
      retake: input.status === "completed" ? canonical : null
    }
  };
}

function compareWritingDraftAttempts(
  left: WritingLogicalAttemptRow,
  right: WritingLogicalAttemptRow
) {
  return compareAttemptEvents(left, right, draftTimestamp);
}

function compareWritingAttempts(
  left: WritingLogicalAttemptRow,
  right: WritingLogicalAttemptRow
) {
  return compareAttemptEvents(left, right, writingAttemptTimestamp);
}

function compareAttemptEvents(
  left: WritingLogicalAttemptRow,
  right: WritingLogicalAttemptRow,
  timestamp: (attempt: WritingLogicalAttemptRow) => number
) {
  return timestamp(right) - timestamp(left) || right.attempt_id.localeCompare(left.attempt_id);
}

function draftTimestamp(attempt: WritingLogicalAttemptRow) {
  return parseTimestamp(attempt.updated_at ?? attempt.saved_at ?? attempt.created_at);
}

function writingAttemptTimestamp(attempt: WritingLogicalAttemptRow) {
  return parseTimestamp(
    attempt.status === "submitted"
      ? attempt.submitted_at ?? attempt.updated_at ?? attempt.created_at
      : attempt.updated_at ?? attempt.saved_at ?? attempt.created_at
  );
}

function parseTimestamp(value: string | null) {
  const timestamp = value ? Date.parse(value) : Number.NEGATIVE_INFINITY;
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
}

function writingQuestionKey(taskType: PracticeTaskType, questionId: string) {
  return `${taskType}:${questionId}`;
}

function append<T>(map: Map<string, T[]>, key: string, value: T) {
  map.set(key, [...(map.get(key) ?? []), value]);
}
