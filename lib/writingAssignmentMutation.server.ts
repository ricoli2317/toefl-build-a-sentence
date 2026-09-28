import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isWritingTaskType,
  WRITING_TASK_CONFIG,
  type WritingQuestion,
  type WritingTaskType
} from "./writing.ts";
import {
  assignmentItemSubject,
  buildAssignmentItemSnapshot,
  isAssignmentItemType,
  type AssignmentCatalogEntry,
  type AssignmentItemType,
  type AssignmentSubject
} from "./assignmentCatalog.ts";
import {
  loadAssignmentCatalogEntryMap,
  resolveTeacherAssignmentCatalogEntry
} from "./assignmentCatalog.server.ts";
import {
  buildCustomWritingQuestionSnapshot,
  isWritingAssignmentQuestionSource,
  isWritingQuestionSnapshot,
  type WritingAssignmentQuestionSource
} from "./writingAssignments.ts";
import { listVisibleStudentIds, type AccountActor } from "./accountAccess.ts";

/**
 * The Assignment mutation core: one 题库 question preparation, the recipient
 * checks and the withdrawn group edit payload. It is kept free of route-only
 * imports so the identity / validation contract can be exercised directly
 * (see tests/teacherAssignmentWritingIdentity.test.js and
 * tests/teacherWithdrawnAssignmentEdit.test.js).
 */

export const WRITING_ASSIGNMENT_QUERY_FIELDS = {
  email:
    "question_id,set_id,set_title,year_month,source_labels,scenario,task_instruction,requirement_1,requirement_2,requirement_3,closing_instruction,recipient,subject",
  academic_discussion:
    "question_id,set_id,set_title,year_month,source_labels,professor_name,professor_prompt,student_1_name,student_1_response,student_2_name,student_2_response"
} satisfies Record<WritingTaskType, string>;

export const WRITING_ASSIGNMENT_SEARCH_FIELDS = {
  email: [
    "set_title",
    "scenario",
    "requirement_1",
    "requirement_2",
    "requirement_3",
    "recipient",
    "subject"
  ],
  academic_discussion: [
    "set_title",
    "professor_name",
    "professor_prompt",
    "student_1_name",
    "student_1_response",
    "student_2_name",
    "student_2_response"
  ]
} satisfies Record<WritingTaskType, string[]>;

export async function prepareWritingAssignmentQuestion(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
  options: {
    canonicalizeQuestionBank?: boolean;
    catalogEntries?: ReadonlyMap<string, AssignmentCatalogEntry>;
  } = {}
) {
  const taskType = readAssignmentItemType(body);
  if (!taskType) throw new Error("请选择有效的题型。");
  if (!isWritingAssignmentQuestionSource(body.questionSource)) {
    throw new Error("请选择有效的题目来源。");
  }
  const dueAt = validOptionalDueAt(body.dueAt);
  const questionSource = body.questionSource;

  // BAS / CTW / RDL / RAP / Full Set reuse the assignment item abstraction with
  // a catalog item identity: the stable item id is stored in question_id and
  // the snapshot only keeps lightweight catalog metadata.
  if (!isWritingTaskType(taskType)) {
    if (questionSource !== "question_bank") throw new Error("该题型只能从题库选择。");
    const questionId = typeof body.questionId === "string" ? body.questionId.trim() : "";
    if (!questionId) throw new Error("请选择一道题库题目。");
    const entry = options.catalogEntries?.get(`${taskType}:${questionId}`)
      ?? await resolveTeacherAssignmentCatalogEntry(supabase, taskType, questionId);
    if (!entry) throw new Error("所选题目不存在或已下线。");
    return {
      dueAt,
      questionId,
      questionSnapshot: buildAssignmentItemSnapshot(entry) as unknown as WritingQuestion,
      questionSource: questionSource satisfies WritingAssignmentQuestionSource,
      taskType
    };
  }

  let questionId: string | null = null;
  let questionSnapshot: WritingQuestion;

  if (questionSource === "question_bank") {
    questionId = typeof body.questionId === "string" ? body.questionId.trim() : "";
    if (!questionId) throw new Error("请选择一道题库题目。");
    if (options.canonicalizeQuestionBank) {
      questionId = await resolveCanonicalWritingAssignmentQuestionId(
        supabase,
        taskType,
        questionId
      );
    }
    const { data, error } = await supabase
      .from(WRITING_TASK_CONFIG[taskType].questionTable)
      .select(WRITING_ASSIGNMENT_QUERY_FIELDS[taskType])
      .eq("question_id", questionId)
      .maybeSingle();
    if (error) throw error;
    if (!data || !isWritingQuestionSnapshot(taskType, data)) {
      throw new Error("所选题目不存在，或与当前题型不匹配。");
    }
    questionSnapshot = data;
  } else {
    questionSnapshot = buildCustomWritingQuestionSnapshot({
      taskType,
      fields: isRecord(body.customQuestion) ? body.customQuestion : {},
      id: crypto.randomUUID()
    });
  }

  return {
    dueAt,
    questionId,
    questionSnapshot,
    questionSource: questionSource satisfies WritingAssignmentQuestionSource,
    taskType
  };
}

/**
 * One identity contract for a 题库 Writing item.
 *
 * The Assignment picker always submits the stable catalog item id (the
 * practice item id used by 查看题目 and every selection key). Historical
 * clients and stored rows still carry the raw source question id, so both
 * identities are accepted and both resolve to the canonical raw question id,
 * which is what `writing_assignments.question_id` has always stored. An id
 * that belongs to neither identity is rejected — the 题库 ownership check is
 * never skipped.
 */
export async function resolveCanonicalWritingAssignmentQuestionId(
  supabase: SupabaseClient,
  taskType: WritingTaskType,
  selectedQuestionId: string
) {
  // 1. Historical identity: the raw source question id itself. Checked first
  //    because `source_question_id` is a text column and therefore safe for
  //    any historical id format.
  const selectedSource = await supabase
    .from("practice_item_sources")
    .select("item_id")
    .eq("task_type", taskType)
    .eq("source_question_id", selectedQuestionId)
    .maybeSingle();
  if (selectedSource.error) throw selectedSource.error;
  if (selectedSource.data) {
    const canonicalSource = await supabase
      .from("practice_item_sources")
      .select("source_question_id")
      .eq("item_id", selectedSource.data.item_id)
      .eq("task_type", taskType)
      .eq("is_canonical", true)
      .maybeSingle();
    if (canonicalSource.error) throw canonicalSource.error;
    const canonicalQuestionId = canonicalSource.data?.source_question_id?.trim();
    if (!canonicalQuestionId) throw new Error("所选题目的当前版本不可用。");
    return canonicalQuestionId;
  }

  // 2. The stable picker identity: a practice item id of this task type. Only
  //    a UUID can name an item, so a non-UUID id skips the lookup instead of
  //    risking a uuid cast error.
  if (!UUID_PATTERN.test(selectedQuestionId)) {
    throw new Error("所选题目不属于当前练习题库。");
  }
  const itemCanonicalSource = await supabase
    .from("practice_item_sources")
    .select("source_question_id")
    .eq("task_type", taskType)
    .eq("item_id", selectedQuestionId)
    .eq("is_canonical", true)
    .maybeSingle();
  if (itemCanonicalSource.error) throw itemCanonicalSource.error;
  const itemCanonicalQuestionId = itemCanonicalSource.data?.source_question_id?.trim();
  if (!itemCanonicalQuestionId) throw new Error("所选题目不属于当前练习题库。");
  return itemCanonicalQuestionId;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shared with the mutation routes; kept here so the identity tests stay pure. */
export function validOptionalDueAt(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error("截止时间格式无效。");
  }
  return new Date(value).toISOString();
}

function readAssignmentItemType(value: Record<string, unknown>): AssignmentItemType | null {
  const raw = value.itemType ?? value.taskType;
  return isAssignmentItemType(raw) ? raw : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Prepare a withdrawn group edit. Every provided item may carry the
 * `assignment_id` it keeps, or none at all when it is a newly added item; the
 * RPC matches existing ids against the group, inserts new items and
 * soft-deletes the visible items that are no longer provided. 撤回 already
 * guarantees no attempt exists, so the item set stays fully editable.
 */
export async function prepareWritingAssignmentGroupEditMutation(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
  options: {
    canonicalizeQuestionBank?: boolean;
    actor?: AccountActor;
    subject?: AssignmentSubject;
  } = {}
) {
  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw new Error("请至少添加一道题目。");
  }
  if (body.items.length > 50) throw new Error("一次最多布置 50 道题目。");
  const itemValues = body.items.filter(isRecord);
  const subject = resolveAssignmentGroupSubject(itemValues, options.subject);
  const catalogEntries = await loadAssignmentCatalogEntryMap(
    supabase,
    itemValues.flatMap((value) => {
      const itemType = readAssignmentItemType(value);
      return itemType && !isWritingTaskType(itemType) ? [itemType] : [];
    })
  );
  // A withdrawn edit can re-target the group to a class (recipients are
  // resolved by the RPC at save time) or keep an explicit student list.
  const classId = typeof body.classId === "string" ? body.classId.trim() : "";
  const membership = classId
    ? { dueAt: validOptionalDueAt(body.dueAt), studentIds: [] as string[] }
    : await prepareWritingAssignmentMembership(supabase, body, {
        actor: options.actor,
        subject
      });
  const items = [];
  for (const value of body.items) {
    if (!isRecord(value)) throw new Error("请完整填写每道题目。");
    const assignmentId = typeof value.assignmentId === "string" ? value.assignmentId.trim() : "";
    items.push({
      assignmentId: assignmentId || null,
      // The wizard always submits the stable catalog item id for 题库 items,
      // so the withdrawn edit canonicalizes exactly like creation does.
      ...(await prepareWritingAssignmentQuestion(supabase, value, {
        ...options,
        canonicalizeQuestionBank: true,
        catalogEntries
      }))
    });
  }
  return { dueAt: membership.dueAt, items, studentIds: membership.studentIds, subject };
}


export async function prepareWritingAssignmentMembership(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
  options: { actor?: AccountActor; subject?: AssignmentSubject } = {}
) {
  const studentIds = uniqueStrings(body.studentIds);
  if (studentIds.length === 0) throw new Error("请至少选择一名学生。");
  const dueAt = validOptionalDueAt(body.dueAt);
  await assertWritingAssignmentStudentIds(
    supabase,
    studentIds,
    options.actor,
    options.subject ?? "writing"
  );
  return { dueAt, studentIds };
}

async function assertWritingAssignmentStudentIds(
  supabase: SupabaseClient,
  studentIds: string[],
  actor: AccountActor | undefined,
  subject: AssignmentSubject
) {
  if (actor?.role === "admin") {
    let count = 0;
    for (const batch of chunkValues(studentIds)) {
      let query = supabase
        .from("profiles")
        .select("id")
        .eq("is_active", true)
        .in("id", batch);
      if (actor) query = query.or(`role.eq.student,id.eq.${actor.userId}`);
      const { data, error } = await query;
      if (error) throw error;
      count += data?.length ?? 0;
    }
    if (count !== studentIds.length) throw new Error("所选学生中包含无效账号。");
    return;
  }
  const eligible = new Set(
    await listVisibleStudentIds(
      supabase,
      actor ?? { userId: "", role: "teacher" },
      subject
    )
  );
  for (const studentId of studentIds) {
    if (!eligible.has(studentId)) throw new Error("所选学生中包含无效账号。");
  }
}

/** One Assignment Group is single-subject; mixed writing + reading is rejected. */
export function resolveAssignmentGroupSubject(
  items: ReadonlyArray<Record<string, unknown>>,
  requested?: AssignmentSubject
): AssignmentSubject {
  const subjects = new Set<AssignmentSubject>();
  for (const item of items) {
    const itemType = readAssignmentItemType(item);
    if (!itemType) throw new Error("请选择有效的题型。");
    subjects.add(assignmentItemSubject(itemType));
  }
  if (subjects.size > 1) throw new Error("同一份作业不能同时包含写作和阅读题目。");
  const subject = Array.from(subjects)[0] ?? requested ?? "writing";
  if (requested && requested !== subject) throw new Error("作业科目与所选题目不匹配。");
  return subject;
}



export function uniqueStrings(values: unknown) {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).map((value) => value.trim())));
}

export function chunkValues<T>(values: T[], size = 100) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}
