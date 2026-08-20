import type {
  AcademicDiscussionQuestion,
  AcademicDiscussionProfessorAvatarType,
  AcademicDiscussionStudentAvatarType,
  EmailQuestion,
  WritingQuestion,
  WritingTaskType
} from "./writing.ts";
import {
  isProfessorAvatarType,
  isStudentAvatarType
} from "./academicDiscussionAvatars.ts";

export type WritingAssignmentQuestionSource = "question_bank" | "custom";
export type WritingAssignmentPracticeResolution = {
  questionSource: WritingAssignmentQuestionSource;
  rawQuestionId: string | null;
  historicalPracticeItemId: string | null;
  publicPracticeItemId: string | null;
  publicMappingAvailable: boolean;
};
export type WritingAssignmentLifecycleStatus = "active" | "withdrawn";
export type WritingAssignmentStudentStatus =
  | "pending"
  | "completed"
  | "overdue"
  | "late_completed";

export type WritingAssignmentSummary = {
  assignment_id: string;
  group_id: string | null;
  group_position: number | null;
  task_type: WritingTaskType;
  question_source: WritingAssignmentQuestionSource;
  question_id: string | null;
  question_snapshot: WritingQuestion;
  display_name?: string;
  status: WritingAssignmentLifecycleStatus;
  due_at: string | null;
  created_at: string;
  assigned_count: number;
  completed_count: number;
  published_count: number;
  has_attempts: boolean;
  single_student_latest_submitted_attempt_id: string | null;
  single_student_latest_review_status: "reviewing" | "published" | null;
  has_overdue_students: boolean;
};

export type WritingAssignmentStudentDetail = {
  student_id: string;
  student_name: string;
  student_email: string;
  assigned_at: string;
  first_submitted_at: string | null;
  has_attempt: boolean;
  latest_submitted_attempt_id: string | null;
  latest_review_status: "reviewing" | "published" | null;
  status: WritingAssignmentStudentStatus;
};

export type StudentWritingAssignmentSummary = {
  assignment_id: string;
  group_id: string | null;
  group_position: number | null;
  assigned_at: string;
  created_at: string;
  draft_attempt_id: string | null;
  draft_writing_mode: "exam" | "practice" | null;
  due_at: string | null;
  first_submitted_at: string | null;
  latest_submitted_attempt_id: string | null;
  published_review_attempt_id: string | null;
  question_id: string;
  question_snapshot: WritingQuestion;
  question_source: WritingAssignmentQuestionSource;
  status: WritingAssignmentLifecycleStatus;
  student_status: WritingAssignmentStudentStatus;
  submitted_attempt_count: number;
  task_type: WritingTaskType;
};

export type StudentWritingAssignmentsPayload = {
  assignments: StudentWritingAssignmentSummary[];
  error?: string;
};

export type StudentWritingAssignmentDisplayStatus =
  | "not_started"
  | "in_progress"
  | "submitted"
  | "completed"
  | "overdue";

export type StudentWritingAssignmentListEntry =
  | {
      kind: "assignment";
      assignment: StudentWritingAssignmentSummary;
    }
  | {
      kind: "collection";
      collection_id: string;
      assignments: StudentWritingAssignmentSummary[];
    };

export type TeacherWritingAssignmentListEntry =
  | {
      kind: "assignment";
      assignment: WritingAssignmentSummary;
    }
  | {
      kind: "collection";
      collection_id: string;
      assignments: WritingAssignmentSummary[];
      assigned_count: number;
      completed_count: number;
      created_at: string;
      has_overdue_students: boolean;
      pending_review_count: number;
      published_count: number;
      total_count: number;
    };

export type WritingAssignmentCollectionDetail = {
  collection_id: string;
  assignments: Array<WritingAssignmentDetail & {
    group_position: number;
  }>;
  assigned_count: number;
  completed_count: number;
  created_at: string;
  pending_review_count: number;
  published_count: number;
  total_count: number;
};

export type WritingAssignmentDetail = Omit<
  WritingAssignmentSummary,
  | "has_overdue_students"
  | "single_student_latest_submitted_attempt_id"
  | "single_student_latest_review_status"
> & {
  has_submitted_attempts: boolean;
  updated_at: string;
  students: WritingAssignmentStudentDetail[];
};

export type WritingAssignmentProgress =
  | "ongoing"
  | "submitted"
  | "partial_submitted"
  | "all_submitted"
  | "completed"
  | "withdrawn";

export const CUSTOM_EMAIL_CLOSING_INSTRUCTION =
  "Write as much as you can and in complete sentences.";
export const EMAIL_REQUIREMENTS_VALIDATION_MESSAGE = "请输入 3 个邮件要点";

export type ParsedCustomEmailPrompt = {
  recipient: string;
  requirements: string[];
  scenario: string;
};

const COMMON_MALE_NAMES = new Set([
  "alexander", "andrew", "anthony", "benjamin", "charles", "daniel", "david",
  "edward", "ethan", "henry", "jack", "james", "john", "joseph", "liam",
  "lucas", "matthew", "michael", "noah", "oliver", "paul", "peter", "robert",
  "samuel", "thomas", "william"
]);
const COMMON_FEMALE_NAMES = new Set([
  "alice", "amelia", "anna", "ava", "charlotte", "claire", "elizabeth", "ella",
  "emily", "emma", "grace", "hannah", "isabella", "jennifer", "jessica", "kelly",
  "lily", "mia", "natalie", "olivia", "rachel", "sarah", "sophia", "victoria"
]);

const EMAIL_FIELDS = [
  "question_id",
  "set_id",
  "set_title",
  "year_month",
  "source_labels",
  "scenario",
  "task_instruction",
  "requirement_1",
  "requirement_2",
  "requirement_3",
  "closing_instruction",
  "recipient",
  "subject"
] as const;

const ACADEMIC_DISCUSSION_FIELDS = [
  "question_id",
  "set_id",
  "set_title",
  "year_month",
  "source_labels",
  "professor_name",
  "professor_prompt",
  "student_1_name",
  "student_1_response",
  "student_2_name",
  "student_2_response"
] as const;

export function isWritingAssignmentQuestionSource(
  value: unknown
): value is WritingAssignmentQuestionSource {
  return value === "question_bank" || value === "custom";
}

export function toggleWritingAssignmentQuestionSelection<T extends { question_id: string }>(
  current: ReadonlyMap<string, T>,
  question: T
) {
  const next = new Map(current);
  if (next.has(question.question_id)) next.delete(question.question_id);
  else next.set(question.question_id, question);
  return next;
}

export function resolveWritingAssignmentQuestionIsolation(input: {
  questionSource: WritingAssignmentQuestionSource;
  questionId: string | null;
  resolvedHistoricalPracticeItemId: string | null;
  resolvedPublicPracticeItemId: string | null;
}): WritingAssignmentPracticeResolution {
  if (input.questionSource === "custom") {
    return {
      questionSource: "custom",
      rawQuestionId: null,
      historicalPracticeItemId: null,
      publicPracticeItemId: null,
      publicMappingAvailable: false
    };
  }
  return {
    questionSource: "question_bank",
    rawQuestionId: input.questionId,
    historicalPracticeItemId: input.resolvedHistoricalPracticeItemId,
    publicPracticeItemId: input.resolvedPublicPracticeItemId,
    publicMappingAvailable: Boolean(input.resolvedPublicPracticeItemId)
  };
}

export function isWritingAssignmentLifecycleStatus(
  value: unknown
): value is WritingAssignmentLifecycleStatus {
  return value === "active" || value === "withdrawn";
}

export function isWritingQuestionSnapshot(
  taskType: WritingTaskType,
  value: unknown
): value is WritingQuestion {
  if (!isRecord(value)) return false;
  const fields = taskType === "email"
    ? EMAIL_FIELDS
    : ACADEMIC_DISCUSSION_FIELDS;
  const hasRequiredFields = fields.every(
    (field) => typeof value[field] === "string" && value[field].trim().length > 0
  );
  if (!hasRequiredFields || taskType === "email") return hasRequiredFields;
  return (value.professor_avatar_type === undefined || isProfessorAvatarType(value.professor_avatar_type))
    && (value.student_1_avatar_type === undefined || isStudentAvatarType(value.student_1_avatar_type))
    && (value.student_2_avatar_type === undefined || isStudentAvatarType(value.student_2_avatar_type));
}

export function buildCustomWritingQuestionSnapshot(input: {
  taskType: WritingTaskType;
  fields: Record<string, unknown>;
  id?: string;
  now?: Date;
}): WritingQuestion {
  const id = input.id ?? crypto.randomUUID();
  const now = input.now ?? new Date();
  const yearMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const questionId = `custom:${id}`;
  const title = requiredNormalizedText(input.fields.title, "请填写标题。");
  const metadata = {
    question_id: questionId,
    set_id: questionId,
    set_title: title,
    year_month: yearMonth,
    source_labels: "custom"
  };

  if (input.taskType === "email") {
    const recipient = requiredNormalizedText(input.fields.recipient, "请填写收件人。");
    const parsedEmail = input.fields.parsed_email === true;
    const requirements = parsedEmail
      ? ([1, 2, 3].map((index) => requiredPreservedText(
          input.fields[`requirement_${index}`],
          EMAIL_REQUIREMENTS_VALIDATION_MESSAGE
        )) as [string, string, string])
      : parseEmailRequirements(
          typeof input.fields.requirements === "string"
            ? input.fields.requirements
            : [
                input.fields.requirement_1,
                input.fields.requirement_2,
                input.fields.requirement_3
              ].filter((value): value is string => typeof value === "string").join("\n")
        );
    return {
      ...metadata,
      scenario: parsedEmail
        ? requiredPreservedText(input.fields.scenario, "请填写 Scenario。")
        : requiredNormalizedText(input.fields.scenario, "请填写 Scenario。"),
      task_instruction: buildCustomEmailTaskInstruction(recipient),
      requirement_1: requirements[0],
      requirement_2: requirements[1],
      requirement_3: requirements[2],
      closing_instruction: CUSTOM_EMAIL_CLOSING_INSTRUCTION,
      recipient,
      subject: requiredNormalizedText(input.fields.subject, "请填写邮件主题。")
    } satisfies EmailQuestion;
  }

  const professorName = requiredNormalizedText(input.fields.professor_name, "请填写 Professor Name。");
  const student1Name = requiredNormalizedText(input.fields.student_1_name, "请填写 Student 1 Name。");
  const student2Name = requiredNormalizedText(input.fields.student_2_name, "请填写 Student 2 Name。");
  return {
    ...metadata,
    professor_name: professorName,
    professor_prompt: requiredNormalizedText(input.fields.professor_prompt, "请填写 Professor Prompt。"),
    student_1_name: student1Name,
    student_1_response: requiredNormalizedText(
      input.fields.student_1_response,
      "请填写 Student 1 Response。"
    ),
    student_2_name: student2Name,
    student_2_response: requiredNormalizedText(
      input.fields.student_2_response,
      "请填写 Student 2 Response。"
    ),
    professor_avatar_type: isProfessorAvatarType(input.fields.professor_avatar_type)
      ? input.fields.professor_avatar_type
      : suggestAcademicDiscussionAvatarType(professorName, "professor", "male_professor"),
    student_1_avatar_type: isStudentAvatarType(input.fields.student_1_avatar_type)
      ? input.fields.student_1_avatar_type
      : suggestAcademicDiscussionAvatarType(student1Name, "student", "male_student"),
    student_2_avatar_type: isStudentAvatarType(input.fields.student_2_avatar_type)
      ? input.fields.student_2_avatar_type
      : suggestAcademicDiscussionAvatarType(student2Name, "student", "female_student")
  } satisfies AcademicDiscussionQuestion;
}

export function calculateWritingAssignmentStudentStatus(input: {
  dueAt: string | null;
  firstSubmittedAt: string | null;
  now?: Date;
}): WritingAssignmentStudentStatus {
  if (input.firstSubmittedAt) {
    if (!input.dueAt) return "completed";
    return Date.parse(input.firstSubmittedAt) <= Date.parse(input.dueAt)
      ? "completed"
      : "late_completed";
  }
  if (input.dueAt && (input.now ?? new Date()).getTime() > Date.parse(input.dueAt)) {
    return "overdue";
  }
  return "pending";
}

export function earliestWritingAssignmentSubmission(
  submittedAtValues: Array<string | null | undefined>
) {
  return submittedAtValues
    .filter((value): value is string => Boolean(value) && !Number.isNaN(Date.parse(value!)))
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;
}

export function writingAssignmentStatusLabel(status: WritingAssignmentStudentStatus) {
  return status === "completed"
    ? "已完成"
    : status === "late_completed"
      ? "已完成 · 逾期提交"
      : status === "overdue"
        ? "已逾期未完成"
        : "未完成";
}

export function getWritingAssignmentProgress(input: {
  assignedCount: number;
  lifecycleStatus: WritingAssignmentLifecycleStatus;
  publishedCount: number;
  submittedCount: number;
}): { label: string; progress: WritingAssignmentProgress } {
  if (input.lifecycleStatus === "withdrawn") {
    return { label: "已撤回", progress: "withdrawn" };
  }
  if (input.assignedCount > 0 && input.publishedCount >= input.assignedCount) {
    return { label: "已完成", progress: "completed" };
  }
  if (input.assignedCount === 1 && input.submittedCount >= 1) {
    return { label: "已提交", progress: "submitted" };
  }
  if (input.assignedCount > 1 && input.submittedCount >= input.assignedCount) {
    return { label: "全部已提交", progress: "all_submitted" };
  }
  if (input.submittedCount > 0) {
    return {
      label: `${input.submittedCount} 人已提交`,
      progress: "partial_submitted"
    };
  }
  return { label: "进行中", progress: "ongoing" };
}

export function writingAssignmentWithdrawBlockedMessage(input: {
  hasAttempts: boolean;
  submittedCount: number;
}) {
  if (!input.hasAttempts) return null;
  return input.submittedCount > 0
    ? "已有学生提交，不能撤回"
    : "已有学生开始作答，不能撤回";
}

export function getWritingAssignmentReviewAction(input: {
  latestSubmittedAttemptId: string | null;
  latestReviewStatus: "reviewing" | "published" | null;
}) {
  if (!input.latestSubmittedAttemptId) return null;
  return {
    attemptId: input.latestSubmittedAttemptId,
    label: input.latestReviewStatus === "published"
      ? "查看批改"
      : input.latestReviewStatus === "reviewing"
        ? "继续批改"
        : "批改"
  };
}

export function isLaterWritingAssignmentSubmission(
  candidate: { attempt_id: string; submitted_at: string | null },
  current: { attempt_id: string; submitted_at: string | null }
) {
  const candidateTime = Date.parse(candidate.submitted_at ?? "");
  const currentTime = Date.parse(current.submitted_at ?? "");
  return candidateTime > currentTime ||
    (candidateTime === currentTime && candidate.attempt_id > current.attempt_id);
}

export function compareStudentWritingAssignments(
  left: Pick<StudentWritingAssignmentSummary, "assigned_at" | "created_at" | "student_status">,
  right: Pick<StudentWritingAssignmentSummary, "assigned_at" | "created_at" | "student_status">
) {
  const rank = (status: WritingAssignmentStudentStatus) =>
    status === "overdue" ? 0 : status === "pending" ? 1 : 2;
  return (
    rank(left.student_status) - rank(right.student_status) ||
    Date.parse(right.assigned_at || right.created_at) -
      Date.parse(left.assigned_at || left.created_at)
  );
}

export function getStudentWritingAssignmentDisplayStatus(
  assignment: Pick<
    StudentWritingAssignmentSummary,
    | "draft_attempt_id"
    | "due_at"
    | "latest_submitted_attempt_id"
    | "published_review_attempt_id"
  >,
  now = new Date()
): StudentWritingAssignmentDisplayStatus {
  if (assignment.published_review_attempt_id) return "completed";
  if (assignment.latest_submitted_attempt_id) return "submitted";
  if (assignment.draft_attempt_id) return "in_progress";
  if (assignment.due_at && now.getTime() > Date.parse(assignment.due_at)) {
    return "overdue";
  }
  return "not_started";
}

export function studentWritingAssignmentDisplayStatusLabel(
  status: StudentWritingAssignmentDisplayStatus
) {
  return status === "not_started"
    ? "未开始"
    : status === "in_progress"
      ? "进行中"
      : status === "submitted"
        ? "已提交"
        : status === "completed"
          ? "已完成"
          : "已逾期";
}

export function groupStudentWritingAssignments(
  assignments: StudentWritingAssignmentSummary[]
): StudentWritingAssignmentListEntry[] {
  const grouped = groupAssignmentsByCollection(assignments);
  const entries: StudentWritingAssignmentListEntry[] = [];
  for (const assignment of assignments) {
    if (!assignment.group_id) {
      entries.push({ kind: "assignment", assignment });
      continue;
    }
    const collection = grouped.get(assignment.group_id) ?? [];
    if (collection[0] !== assignment) continue;
    if (collection.length === 1) {
      entries.push({ kind: "assignment", assignment });
      continue;
    }
    entries.push({
      kind: "collection",
      collection_id: assignment.group_id,
      assignments: collection
    });
  }
  return entries;
}

export function groupTeacherWritingAssignments(
  assignments: WritingAssignmentSummary[]
): TeacherWritingAssignmentListEntry[] {
  const grouped = groupAssignmentsByCollection(assignments);
  const entries: TeacherWritingAssignmentListEntry[] = [];
  for (const assignment of assignments) {
    if (!assignment.group_id) {
      entries.push({ kind: "assignment", assignment });
      continue;
    }
    const collection = grouped.get(assignment.group_id) ?? [];
    if (collection[0] !== assignment) continue;
    if (collection.length === 1) {
      entries.push({ kind: "assignment", assignment });
      continue;
    }
    const assignedCount = Math.max(
      0,
      ...collection.map((item) => item.assigned_count)
    );
    const completedCount = collection.reduce(
      (count, item) => count + item.completed_count,
      0
    );
    const publishedCount = collection.reduce(
      (count, item) => count + item.published_count,
      0
    );
    entries.push({
      kind: "collection",
      collection_id: assignment.group_id,
      assignments: collection,
      assigned_count: assignedCount,
      completed_count: completedCount,
      created_at: collection.reduce(
        (latest, item) => Date.parse(item.created_at) > Date.parse(latest)
          ? item.created_at
          : latest,
        collection[0].created_at
      ),
      has_overdue_students: collection.some((item) => item.has_overdue_students),
      pending_review_count: Math.max(0, completedCount - publishedCount),
      published_count: publishedCount,
      total_count: collection.reduce(
        (count, item) => count + item.assigned_count,
        0
      )
    });
  }
  return entries;
}

function groupAssignmentsByCollection<T extends {
  assignment_id: string;
  group_id: string | null;
  group_position: number | null;
}>(assignments: T[]) {
  const grouped = new Map<string, T[]>();
  for (const assignment of assignments) {
    if (!assignment.group_id) continue;
    grouped.set(assignment.group_id, [
      ...(grouped.get(assignment.group_id) ?? []),
      assignment
    ]);
  }
  for (const collection of Array.from(grouped.values())) {
    collection.sort((left, right) =>
      (left.group_position ?? Number.MAX_SAFE_INTEGER) -
        (right.group_position ?? Number.MAX_SAFE_INTEGER) ||
      left.assignment_id.localeCompare(right.assignment_id)
    );
  }
  return grouped;
}

export function writingAssignmentTitle(question: WritingQuestion) {
  return question.set_title.trim() || "自定义题目";
}

export function normalizeAssignmentText(value: unknown) {
  if (typeof value !== "string") return "";
  return normalizeAssignmentCharacters(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function suggestAcademicDiscussionAvatarType(
  name: unknown,
  participantType: "professor",
  fallback?: AcademicDiscussionProfessorAvatarType
): AcademicDiscussionProfessorAvatarType;
export function suggestAcademicDiscussionAvatarType(
  name: unknown,
  participantType: "student",
  fallback?: AcademicDiscussionStudentAvatarType
): AcademicDiscussionStudentAvatarType;
export function suggestAcademicDiscussionAvatarType(
  name: unknown,
  participantType: "professor" | "student",
  fallback?: AcademicDiscussionProfessorAvatarType | AcademicDiscussionStudentAvatarType
) {
  const firstName = normalizeAssignmentText(name)
    .replace(/^(?:professor|prof\.?|doctor|dr\.?)\s+/i, "")
    .split(/[^A-Za-z]+/)[0]
    .toLowerCase();
  const gender = COMMON_FEMALE_NAMES.has(firstName)
    ? "female"
    : COMMON_MALE_NAMES.has(firstName)
      ? "male"
      : null;
  if (participantType === "professor") {
    return gender === "female"
      ? "female_professor"
      : gender === "male"
        ? "male_professor"
        : isProfessorAvatarType(fallback) ? fallback : "male_professor";
  }
  return gender === "female"
    ? "female_student"
    : gender === "male"
      ? "male_student"
      : isStudentAvatarType(fallback) ? fallback : "male_student";
}

export function parseEmailRequirements(value: unknown): [string, string, string] {
  if (typeof value !== "string") throw new Error(EMAIL_REQUIREMENTS_VALIDATION_MESSAGE);
  const source = value.replace(/\r\n?/g, "\n").trim();
  const nonEmptyLines = source
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const markerPattern = /^(?:[•●▪◦]|[-–—]|\d+[.)])\s*/;
  const hasMarkers = nonEmptyLines.some((line) => markerPattern.test(line));
  let items: string[];

  if (hasMarkers) {
    items = [];
    let current = "";
    for (const line of nonEmptyLines) {
      const marked = markerPattern.test(line);
      const content = normalizeAssignmentText(line.replace(markerPattern, ""));
      if (!content) continue;
      if (marked) {
        if (current) items.push(current);
        current = content;
      } else if (current) {
        current = normalizeAssignmentText(`${current} ${content}`);
      } else {
        current = content;
      }
    }
    if (current) items.push(current);
  } else {
    const blocks = source
      .split(/\n\s*\n+/)
      .map(normalizeAssignmentText)
      .filter(Boolean);
    items = blocks.length === 3
      ? blocks
      : nonEmptyLines.map(normalizeAssignmentText).filter(Boolean);
  }

  if (items.length !== 3) throw new Error(EMAIL_REQUIREMENTS_VALIDATION_MESSAGE);
  return [items[0], items[1], items[2]];
}

export function normalizeEmailRequirementsInput(value: unknown) {
  if (typeof value !== "string") return "";
  try {
    return parseEmailRequirements(value).join("\n");
  } catch {
    return normalizeAssignmentCharacters(value)
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => normalizeAssignmentText(line))
      .filter(Boolean)
      .join("\n");
  }
}

export function parseCustomEmailPrompt(value: unknown): ParsedCustomEmailPrompt {
  if (typeof value !== "string") return { recipient: "", requirements: [], scenario: "" };
  const source = normalizeAssignmentCharacters(value).replace(/\r\n?/g, "\n").trim();
  if (!source) return { recipient: "", requirements: [], scenario: "" };

  const recipient = detectEmailRecipient(source);
  const lines = source.split("\n");
  const markerPattern = /^\s*(?:[•●▪◦]|[-–—]|\d+[.)])\s*/;
  const markerIndexes = lines.flatMap((line, index) => markerPattern.test(line) ? [index] : []);
  let requirements: string[] = [];
  let scenarioLines: string[] = [];

  if (markerIndexes.length > 0) {
    scenarioLines = lines.slice(0, markerIndexes[0]);
    requirements = markerIndexes.map((start, index) => {
      const end = markerIndexes[index + 1] ?? lines.length;
      return lines.slice(start, end)
        .map((line, lineIndex) => lineIndex === 0 ? line.replace(markerPattern, "") : line)
        .join("\n")
        .replace(new RegExp(`\\n*${escapeRegExp(CUSTOM_EMAIL_CLOSING_INSTRUCTION)}\\s*$`, "i"), "")
        .trim();
    }).filter(Boolean);
  } else {
    const meaningful = lines.map((line) => line.trim()).filter(Boolean);
    const contentLines = meaningful.filter((line) =>
      !/^write\s+an?\s+email\s+to\b/i.test(line)
      && !/^in your email,?\s+do the following:?$/i.test(line)
      && line !== CUSTOM_EMAIL_CLOSING_INSTRUCTION
    );
    if (contentLines.length >= 4) {
      requirements = contentLines.slice(-3);
      scenarioLines = contentLines.slice(0, -3);
    } else {
      scenarioLines = contentLines;
    }
  }

  const scenario = stripFixedEmailInstructions(scenarioLines.join("\n")).trim();
  return { recipient, requirements, scenario };
}

function detectEmailRecipient(source: string) {
  const patterns = [
    /write\s+an?\s+email\s+to\s+([\s\S]+?)(?=\.\s*(?:in your email|$)|\n|,\s*in your email)/i,
    /(?:send|write)\s+(?:an?\s+)?email\s+to\s+([^.,;\n]+)/i
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern)?.[1]?.trim();
    if (match) return match;
  }
  return "";
}

function stripFixedEmailInstructions(value: string) {
  return value
    .replace(/write\s+an?\s+email\s+to\s+[\s\S]+?\.\s*in your email,?\s+do the following:?/gi, "")
    .replace(/\bin your email,?\s+do the following:?\s*$/gi, "")
    .replace(new RegExp(escapeRegExp(CUSTOM_EMAIL_CLOSING_INSTRUCTION), "gi"), "")
    .replace(/^\s+|\s+$/g, "");
}

function normalizeAssignmentCharacters(value: string) {
  return value
    .replace(/ﬁ/g, "fi")
    .replace(/ﬂ/g, "fl")
    .replace(/ﬀ/g, "ff")
    .replace(/ﬃ/g, "ffi")
    .replace(/ﬄ/g, "ffl")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ")
    .replace(/\b([A-Za-z]*fi)\s+(cial|cient|ciency|ciencies)\b/gi, "$1$2")
    .replace(/\bfi\s+(nance|nances|nancial|nancially|nancing)\b/gi, "fi$1");
}

export function buildCustomEmailTaskInstruction(recipient: unknown) {
  const normalizedRecipient = requiredNormalizedText(recipient, "请填写收件人。");
  return `Write an email to ${normalizedRecipient}. In your email, do the following:`;
}

function requiredNormalizedText(value: unknown, message: string) {
  const normalized = normalizeAssignmentText(value);
  if (!normalized) throw new Error(message);
  return normalized;
}

function requiredPreservedText(value: unknown, message: string) {
  if (typeof value !== "string") throw new Error(message);
  const preserved = value.replace(/\r\n?/g, "\n").trim();
  if (!preserved) throw new Error(message);
  return preserved;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
