import type { SupabaseClient } from "@supabase/supabase-js";
import {
  compareReadingCatalogIdentityOrder,
  type ReadingCatalogItemRow
} from "./reading/catalog.ts";
import { readingItemDisplayName } from "./reading/teacherStats.ts";
import {
  loadBuildSentenceHistoricalPracticeDisplayResolver,
  loadWritingHistoricalPracticeDisplayResolver
} from "./historicalPracticeDisplay.ts";
import { mapWithConcurrency } from "./mapWithConcurrency.ts";
import { standardizeOrderTextCasing } from "./questionText.ts";
import { readAllSupabaseRows } from "./supabasePagination.ts";
import {
  buildTeacherStudentReadingPractice,
  buildTeacherStudentWritingPractice,
  isBasWrongbookSetId,
  normalizeBasGroupId,
  resolveTeacherWritingAttemptDisplayName,
  WRONGBOOK_HISTORY_GROUP_ID,
  WRONGBOOK_TODAY_GROUP_ID,
  type TeacherBasAttemptRow,
  type TeacherFullSetAnswerRow,
  type TeacherFullSetAttemptRow,
  type TeacherFullSetModuleRow,
  type TeacherReadingAttemptRow,
  type TeacherReadingItemMeta,
  type TeacherReadingWrongbookAttemptRow,
  type TeacherStudentReadingPractice,
  type TeacherStudentWritingPractice,
  type TeacherWritingAttemptRow
} from "./teacherStudentPractice.ts";

const READING_MODULES = ["ctw", "rdl", "rap"] as const;

type ReadingItemRow = ReadingCatalogItemRow;

type WritingAssignmentRow = {
  assignment_id: string;
  question_source: "custom" | "question_bank";
  set_title: string | null;
};

type WritingQuestionTitleRow = {
  question_id: string;
  set_title: string | null;
};

type WritingReviewScoreRow = {
  attempt_id: string;
  status: string | null;
  published_at: string | null;
  official_score: string | number | null;
};

type BasAttemptTitleRow = {
  set_id: string;
  set_title: string | null;
};

export async function loadTeacherReadingItemMeta(
  db: SupabaseClient,
  itemIds: string[]
): Promise<Map<string, TeacherReadingItemMeta>> {
  const ids = distinct(itemIds);
  const meta = new Map<string, TeacherReadingItemMeta>();
  if (ids.length === 0) return meta;

  const visibleResult = await readAllSupabaseRows<ReadingItemRow>((from, to) =>
    db
      .from("reading_logical_items")
      .select(
        "logical_item_id,module,title,first_seen_date,first_seen_source_label,first_seen_source_order,question_count,scored_item_count"
      )
      .in("logical_item_id", ids)
      .range(from, to)
  );
  if (visibleResult.error) {
    throw new Error(`Failed to load scoped Reading item metadata: ${visibleResult.error.message}`);
  }
  const visibleItems = visibleResult.data ?? [];
  const ranks = await loadReadingItemDisplayRanks(db, visibleItems);

  for (const item of visibleItems) {
    meta.set(item.logical_item_id, {
      logical_item_id: item.logical_item_id,
      module: item.module,
      displayName: readingItemDisplayName(item, ranks),
      scoringPointCount: Math.max(0, Number(item.scored_item_count) || 0)
    });
  }

  return meta;
}

/**
 * Module display numbers are computed in two parallel waves for every module
 * at once (base counts by date + same-date siblings) instead of walking each
 * module's count/sibling chain one round trip at a time. Rank semantics are
 * unchanged: global position inside the module ordered by first-seen date and
 * canonical identity.
 */
async function loadReadingItemDisplayRanks(
  db: SupabaseClient,
  visibleItems: ReadingItemRow[]
): Promise<Map<string, string>> {
  const ranks = new Map<string, string>();
  if (visibleItems.length === 0) return ranks;

  const modules = distinct(visibleItems.map((item) => item.module)).filter(
    (module): module is (typeof READING_MODULES)[number] =>
      (READING_MODULES as readonly string[]).includes(module)
  );

  await Promise.all(
    modules.map(async (readingModule) => {
      const moduleItems = visibleItems.filter((item) => item.module === readingModule);
      if (moduleItems.length === 0) return;
      const dates = distinct(moduleItems.map((item) => item.first_seen_date));

      const [baseRankEntries, siblingsResult] = await Promise.all([
        Promise.all(
          dates.map(async (date) => {
            const countResult = await db
              .from("reading_logical_items")
              .select("logical_item_id", { count: "exact", head: true })
              .eq("module", readingModule)
              .lt("first_seen_date", date);
            if (countResult.error) {
              throw new Error(`Failed to rank scoped Reading items: ${countResult.error.message}`);
            }
            return [date, Math.max(0, countResult.count ?? 0)] as const;
          })
        ),
        readAllSupabaseRows<ReadingItemRow>((from, to) =>
          db
            .from("reading_logical_items")
            .select(
              "logical_item_id,module,title,first_seen_date,first_seen_source_label,first_seen_source_order,question_count,scored_item_count"
            )
            .eq("module", readingModule)
            .in("first_seen_date", dates)
            .range(from, to)
        )
      ]);
      if (siblingsResult.error) {
        throw new Error(`Failed to load scoped Reading item ranks: ${siblingsResult.error.message}`);
      }
      const baseRankByDate = new Map(baseRankEntries);
      for (const date of dates) {
        const sameDateItems = (siblingsResult.data ?? [])
          .filter((item) => item.first_seen_date === date)
          .sort(compareReadingCatalogIdentityOrder);
        const baseRank = baseRankByDate.get(date) ?? 0;
        sameDateItems.forEach((item, index) => {
          ranks.set(item.logical_item_id, String(baseRank + index + 1).padStart(3, "0"));
        });
      }
    })
  );

  return ranks;
}

export async function loadTeacherBasSetDisplayTitles(
  db: SupabaseClient,
  attempts: BasAttemptTitleRow[]
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const officialAttempts = attempts.filter((attempt) => !isBasWrongbookSetId(String(attempt.set_id)));
  const setIds = distinct(officialAttempts.map((attempt) => String(attempt.set_id)));
  if (setIds.length === 0) return titles;

  const resolver = await loadBuildSentenceHistoricalPracticeDisplayResolver(db, setIds);
  for (const setId of setIds) {
    const fallback =
      officialAttempts.find((attempt) => String(attempt.set_id) === setId)?.set_title?.trim()
      || setId;
    titles.set(
      setId,
      resolver.resolveBuildSentence({
        fallbackDisplayName: fallback,
        rawSetId: setId
      }).displayName
    );
  }
  return titles;
}

export async function loadTeacherWritingAttemptDisplayNames(
  db: SupabaseClient,
  attempts: TeacherWritingAttemptRow[]
): Promise<Map<string, string>> {
  const displayNames = new Map<string, string>();
  if (attempts.length === 0) return displayNames;

  const emailAttempts = attempts.filter((attempt) => attempt.task_type === "email");
  const discussionAttempts = attempts.filter(
    (attempt) => attempt.task_type === "academic_discussion"
  );
  const assignmentIds = distinct(
    attempts.flatMap((attempt) => attempt.assignment_id ? [String(attempt.assignment_id)] : [])
  );
  const emailQuestionIds = distinct(emailAttempts.map((attempt) => String(attempt.question_id)));
  const discussionQuestionIds = distinct(
    discussionAttempts.map((attempt) => String(attempt.question_id))
  );

  const [assignments, emailQuestions, discussionQuestions, emailResolver, discussionResolver] =
    await Promise.all([
      readRowsInBatches<WritingAssignmentRow>(
        db,
        "writing_assignments",
        "assignment_id,question_source,set_title:question_snapshot->>set_title",
        "assignment_id",
        assignmentIds
      ),
      readRowsInBatches<WritingQuestionTitleRow>(
        db,
        "email_questions",
        "question_id,set_title",
        "question_id",
        emailQuestionIds
      ),
      readRowsInBatches<WritingQuestionTitleRow>(
        db,
        "academic_discussion_questions",
        "question_id,set_title",
        "question_id",
        discussionQuestionIds
      ),
      loadWritingHistoricalPracticeDisplayResolver(db, "email", emailQuestionIds),
      loadWritingHistoricalPracticeDisplayResolver(
        db,
        "academic_discussion",
        discussionQuestionIds
      )
    ]);

  const assignmentById = new Map(
    assignments.map((assignment) => [String(assignment.assignment_id), assignment])
  );
  const emailTitleById = new Map(
    emailQuestions.map((question) => [String(question.question_id), question.set_title])
  );
  const discussionTitleById = new Map(
    discussionQuestions.map((question) => [String(question.question_id), question.set_title])
  );

  for (const attempt of attempts) {
    const taskType = attempt.task_type;
    const assignment = attempt.assignment_id
      ? assignmentById.get(String(attempt.assignment_id))
      : undefined;
    const assignmentTitle = assignment?.set_title?.trim() || null;
    const rawTitle = taskType === "email"
      ? emailTitleById.get(String(attempt.question_id))
      : discussionTitleById.get(String(attempt.question_id));
    displayNames.set(
      String(attempt.attempt_id),
      resolveTeacherWritingAttemptDisplayName({
        assignmentId: attempt.assignment_id ? String(attempt.assignment_id) : null,
        assignmentTitle,
        assignmentQuestionSource: assignment?.question_source ?? null,
        fallbackTitle: assignmentTitle || rawTitle?.trim() || String(attempt.question_id),
        questionId: String(attempt.question_id),
        resolver: taskType === "email" ? emailResolver : discussionResolver,
        taskType
      })
    );
  }

  return displayNames;
}

export async function loadTeacherWritingReviewScores(
  db: SupabaseClient,
  attemptIds: string[]
): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  const rows = await readRowsInBatches<WritingReviewScoreRow>(
    db,
    "writing_reviews",
    "attempt_id,status,published_at,official_score:published_scores->official_score->>teacher_score",
    "attempt_id",
    distinct(attemptIds)
  );
  for (const row of rows) {
    const score = Number(row.official_score);
    if (
      row.status === "published"
      && row.published_at
      && Number.isFinite(score)
      && score >= 0
      && score <= 5
    ) {
      scores.set(String(row.attempt_id), score);
    }
  }
  return scores;
}

export async function loadTeacherStudentReadingPractice(
  db: SupabaseClient,
  studentId: string,
  startAt: string,
  endAt: string
): Promise<TeacherStudentReadingPractice> {
  const [attemptsResult, wrongbookResult, fullSetResult] = await Promise.all([
    readAllSupabaseRows<TeacherReadingAttemptRow>((from, to) =>
      db
        .from("reading_attempts")
        .select(
          "attempt_id,student_id,logical_item_id,task_type,status,elapsed_seconds,total_points,correct_points,submitted_at"
        )
        .eq("student_id", studentId)
        .eq("status", "submitted")
        .gte("submitted_at", startAt)
        .lt("submitted_at", endAt)
        .order("submitted_at", { ascending: false })
        .order("attempt_id", { ascending: false })
        .range(from, to)
    ),
    readAllSupabaseRows<TeacherReadingWrongbookAttemptRow>((from, to) =>
      db
        .from("reading_wrongbook_attempts")
        .select(
          "attempt_id,student_id,logical_item_id,task_type,scope,status,elapsed_seconds,total_points,correct_points,submitted_at"
        )
        .eq("student_id", studentId)
        .eq("status", "submitted")
        .gte("submitted_at", startAt)
        .lt("submitted_at", endAt)
        .order("submitted_at", { ascending: false })
        .order("attempt_id", { ascending: false })
        .range(from, to)
    ),
    readAllSupabaseRows<TeacherFullSetAttemptRow>((from, to) =>
      db
        .from("reading_full_set_attempts")
        .select("attempt_id,full_set_id,completed_at")
        .eq("student_id", studentId)
        .eq("status", "completed")
        .gte("completed_at", startAt)
        .lt("completed_at", endAt)
        .order("completed_at", { ascending: false })
        .order("attempt_id", { ascending: false })
        .range(from, to)
    )
  ]);
  const queryError = attemptsResult.error ?? wrongbookResult.error ?? fullSetResult.error;
  if (queryError) throw new Error(queryError.message);

  const fullSetAttempts = fullSetResult.data ?? [];
  const fullSetAttemptIds = fullSetAttempts.map((attempt) => String(attempt.attempt_id));
  const modulesResult = fullSetAttemptIds.length
    ? await readAllSupabaseRows<TeacherFullSetModuleRow>((from, to) =>
        db
          .from("reading_full_set_module_attempts")
          .select(
            "attempt_id,module_attempt_id,module_number,started_at,submitted_at,time_limit_seconds"
          )
          .in("attempt_id", fullSetAttemptIds)
          .eq("status", "submitted")
          .range(from, to)
      )
    : { data: [] as TeacherFullSetModuleRow[], error: null };
  if (modulesResult.error) throw new Error(modulesResult.error.message);
  const moduleIds = (modulesResult.data ?? []).map((module) => String(module.module_attempt_id));
  const answersResult = moduleIds.length
    ? await readAllSupabaseRows<TeacherFullSetAnswerRow>((from, to) =>
        db
          .from("reading_full_set_answers")
          .select("module_attempt_id,occurrence_id,logical_item_id,is_correct")
          .in("module_attempt_id", moduleIds)
          .range(from, to)
      )
    : { data: [] as TeacherFullSetAnswerRow[], error: null };
  if (answersResult.error) throw new Error(answersResult.error.message);

  const itemIds = [
    ...(attemptsResult.data ?? []).map((attempt) => String(attempt.logical_item_id)),
    ...(wrongbookResult.data ?? []).map((attempt) => String(attempt.logical_item_id)),
    ...(answersResult.data ?? []).map((answer) => String(answer.logical_item_id))
  ];
  const itemMeta = await loadTeacherReadingItemMeta(db, itemIds);

  return buildTeacherStudentReadingPractice({
    attempts: attemptsResult.data ?? [],
    wrongbookAttempts: wrongbookResult.data ?? [],
    fullSetAttempts,
    fullSetModules: modulesResult.data ?? [],
    fullSetAnswers: answersResult.data ?? [],
    itemMeta,
    studentId
  });
}

export async function loadTeacherStudentWritingPractice(
  db: SupabaseClient,
  studentId: string,
  startAt: string,
  endAt: string
): Promise<TeacherStudentWritingPractice> {
  const [basResult, writingResult] = await Promise.all([
    readAllSupabaseRows<TeacherBasAttemptRow>((from, to) =>
      db
        .from("attempts")
        .select(
          "attempt_id,set_id,set_title,correct_count,total_questions,time_spent_seconds,submitted_at"
        )
        .eq("student_id", studentId)
        .gte("submitted_at", startAt)
        .lt("submitted_at", endAt)
        .order("submitted_at", { ascending: false })
        .order("attempt_id", { ascending: false })
        .range(from, to)
    ),
    readAllSupabaseRows<TeacherWritingAttemptRow>((from, to) =>
      db
        .from("writing_attempts")
        .select(
          "attempt_id,assignment_id,task_type,question_id,word_count,elapsed_seconds,submitted_at"
        )
        .eq("user_id", studentId)
        .eq("status", "submitted")
        .gte("submitted_at", startAt)
        .lt("submitted_at", endAt)
        .order("submitted_at", { ascending: false })
        .order("attempt_id", { ascending: false })
        .range(from, to)
    )
  ]);
  const queryError = basResult.error ?? writingResult.error;
  if (queryError) throw new Error(queryError.message);

  const basAttempts = basResult.data ?? [];
  const writingAttempts = writingResult.data ?? [];
  const [basTitles, writingDisplayNames, reviewScores] = await Promise.all([
    loadTeacherBasSetDisplayTitles(db, basAttempts),
    loadTeacherWritingAttemptDisplayNames(db, writingAttempts),
    loadTeacherWritingReviewScores(
      db,
      writingAttempts.map((attempt) => String(attempt.attempt_id))
    )
  ]);

  return buildTeacherStudentWritingPractice({
    basAttempts,
    basTitles,
    studentId,
    writingAttempts,
    writingDisplayNames,
    reviewScores
  });
}

export type TeacherStudentBasSetAttempt = {
  attemptId: string;
  correctCount: number;
  totalQuestions: number;
  accuracy: number;
  timeSpentSeconds: number;
  submittedAt: string | null;
};

export type TeacherStudentBasSetAnswer = {
  attemptAnswerId: string;
  attemptId: string;
  questionId: string;
  questionOrder: number;
  isCorrect: boolean;
  questionTimeSeconds: number | null;
};

export type TeacherStudentBasSetPayload = {
  setId: string;
  setTitle: string;
  attempts: TeacherStudentBasSetAttempt[];
  answers: TeacherStudentBasSetAnswer[];
  missingAnswerAttemptIds: string[];
};

type BasSetAttemptRow = {
  attempt_id: string;
  set_id: string;
  set_title: string | null;
  correct_count: number | null;
  total_questions: number | null;
  time_spent_seconds: number | null;
  submitted_at: string | null;
};

type BasSetAnswerRow = {
  attempt_answer_id: string;
  attempt_id: string;
  question_id: string;
  question_order: number | null;
  is_correct: boolean | null;
  question_time_seconds: number | null;
};

export async function loadTeacherStudentBasSet(
  db: SupabaseClient,
  studentId: string,
  requestedSetId: string
): Promise<TeacherStudentBasSetPayload> {
  const groupId = normalizeBasGroupId(requestedSetId);
  const attemptsResult = await readAllSupabaseRows<BasSetAttemptRow>((from, to) => {
    let query = db
      .from("attempts")
      .select(
        "attempt_id,set_id,set_title,correct_count,total_questions,time_spent_seconds,submitted_at"
      )
      .eq("student_id", studentId);
    if (groupId === WRONGBOOK_TODAY_GROUP_ID) {
      query = query.like("set_id", "wrongbook-today%");
    } else if (groupId === WRONGBOOK_HISTORY_GROUP_ID) {
      query = query.or("set_id.like.wrongbook-all-%,set_id.like.wrongbook-random-%");
    } else {
      query = query.eq("set_id", groupId);
    }
    return query
      .order("submitted_at", { ascending: false })
      .order("attempt_id", { ascending: false })
      .range(from, to);
  });
  if (attemptsResult.error) throw new Error(attemptsResult.error.message);
  const attempts = (attemptsResult.data ?? []).sort((left, right) =>
    compareDatesDesc(left.submitted_at, right.submitted_at)
    || right.attempt_id.localeCompare(left.attempt_id)
  );
  const attemptIds = attempts.map((attempt) => String(attempt.attempt_id));

  const answersResult = attemptIds.length
    ? await readAllSupabaseRows<BasSetAnswerRow>((from, to) =>
        db
          .from("attempt_answers")
          .select(
            "attempt_answer_id,attempt_id,question_id,question_order,is_correct,question_time_seconds"
          )
          .eq("student_id", studentId)
          .in("attempt_id", attemptIds)
          .order("question_order", { ascending: true })
          .range(from, to)
      )
    : { data: [] as BasSetAnswerRow[], error: null };
  if (answersResult.error) throw new Error(answersResult.error.message);
  const answers = answersResult.data ?? [];
  const attemptIdsWithAnswers = new Set(answers.map((answer) => String(answer.attempt_id)));

  const setTitle = groupId === WRONGBOOK_TODAY_GROUP_ID
    ? "今日错题"
    : groupId === WRONGBOOK_HISTORY_GROUP_ID
      ? "历史错题"
      : await resolveOfficialBasSetTitle(db, attempts, groupId);

  return {
    setId: groupId,
    setTitle,
    attempts: attempts.map((attempt) => ({
      attemptId: String(attempt.attempt_id),
      correctCount: nonNegativeNumber(attempt.correct_count),
      totalQuestions: nonNegativeNumber(attempt.total_questions),
      accuracy: ratio(
        nonNegativeNumber(attempt.correct_count),
        nonNegativeNumber(attempt.total_questions)
      ),
      timeSpentSeconds: nonNegativeNumber(attempt.time_spent_seconds),
      submittedAt: attempt.submitted_at
    })),
    answers: answers.map((answer) => ({
      attemptAnswerId: String(answer.attempt_answer_id),
      attemptId: String(answer.attempt_id),
      questionId: String(answer.question_id),
      questionOrder: nonNegativeNumber(answer.question_order),
      isCorrect: answer.is_correct === true,
      questionTimeSeconds: answer.question_time_seconds
    })),
    missingAnswerAttemptIds: attemptIds.filter(
      (attemptId) => !attemptIdsWithAnswers.has(attemptId)
    )
  };
}

async function resolveOfficialBasSetTitle(
  db: SupabaseClient,
  attempts: BasSetAttemptRow[],
  groupId: string
) {
  if (attempts.some((attempt) => !isBasWrongbookSetId(String(attempt.set_id)))) {
    const titles = await loadTeacherBasSetDisplayTitles(
      db,
      attempts.map((attempt) => ({
        set_id: String(attempt.set_id),
        set_title: attempt.set_title
      }))
    );
    const resolved = titles.get(groupId);
    if (resolved) return resolved;
  }
  return attempts[0]?.set_title?.trim() || groupId;
}

export type TeacherStudentBasAnswerDetail = {
  attempt: {
    attemptId: string;
    setId: string;
    setTitle: string;
    correctCount: number;
    totalQuestions: number;
    accuracy: number;
    timeSpentSeconds: number;
    submittedAt: string;
  };
  initialQuestionId: string;
  answers: Array<{
    attemptAnswerId: string;
    questionId: string;
    questionOrder: number;
    prompt: string;
    submittedOrderText: string;
    displaySubmittedOrderText: string;
    correctOrderText: string;
    sentenceTemplate: string;
    optionsText: string;
    finalSentence: string;
    isCorrect: boolean;
    questionTimeSeconds: number | null;
  }>;
};

type BasAttemptRow = {
  attempt_id: string;
  set_id: string;
  set_title: string | null;
  correct_count: number | null;
  total_questions: number | null;
  time_spent_seconds: number | null;
  submitted_at: string | null;
};

type BasAnswerRow = {
  attempt_answer_id: string;
  question_id: string;
  question_order: number | null;
  submitted_order_text: string | null;
  correct_order_text: string | null;
  is_correct: boolean | null;
  question_time_seconds: number | null;
};

type BasQuestionRow = {
  question_id: string;
  prompt: string | null;
  sentence_template: string | null;
  options_text: string | null;
  correct_order_text: string | null;
  final_sentence: string | null;
};

export async function loadTeacherStudentBasAnswerDetail(
  db: SupabaseClient,
  studentId: string,
  attemptAnswerId: string
): Promise<TeacherStudentBasAnswerDetail | null> {
  const initialAnswerResult = await db
    .from("attempt_answers")
    .select("attempt_answer_id,attempt_id,student_id,question_id,question_order")
    .eq("attempt_answer_id", attemptAnswerId)
    .eq("student_id", studentId)
    .maybeSingle();
  if (initialAnswerResult.error) throw new Error(initialAnswerResult.error.message);
  const initialAnswer = initialAnswerResult.data as {
    attempt_id: string;
    question_id: string;
  } | null;
  if (!initialAnswer) return null;

  const attemptId = String(initialAnswer.attempt_id);
  const [attemptResult, answersResult] = await Promise.all([
    db
      .from("attempts")
      .select(
        "attempt_id,set_id,set_title,correct_count,total_questions,time_spent_seconds,submitted_at"
      )
      .eq("attempt_id", attemptId)
      .eq("student_id", studentId)
      .maybeSingle(),
    readAllSupabaseRows<BasAnswerRow>((from, to) =>
      db
        .from("attempt_answers")
        .select(
          "attempt_answer_id,question_id,question_order,submitted_order_text,correct_order_text,is_correct,question_time_seconds"
        )
        .eq("attempt_id", attemptId)
        .eq("student_id", studentId)
        .order("question_order", { ascending: true })
        .range(from, to)
    )
  ]);
  if (attemptResult.error) throw new Error(attemptResult.error.message);
  if (answersResult.error) throw new Error(answersResult.error.message);
  const attempt = attemptResult.data as BasAttemptRow | null;
  if (!attempt) return null;

  const answers = answersResult.data ?? [];
  const questionIds = Array.from(new Set(answers.map((answer) => String(answer.question_id))));
  const questionsResult = questionIds.length
    ? await readAllSupabaseRows<BasQuestionRow>((from, to) =>
        db
          .from("questions")
          .select("question_id,prompt,sentence_template,options_text,correct_order_text,final_sentence")
          .in("question_id", questionIds)
          .range(from, to)
      )
    : { data: [] as BasQuestionRow[], error: null };
  if (questionsResult.error) throw new Error(questionsResult.error.message);
  const questionById = new Map(
    (questionsResult.data ?? []).map((question) => [String(question.question_id), question])
  );

  const setId = String(attempt.set_id);
  const setTitle = isBasWrongbookSetId(setId)
    ? setId.toLocaleLowerCase().startsWith("wrongbook-today")
      ? "今日错题"
      : "历史错题"
    : (await loadTeacherBasSetDisplayTitles(db, [
        { set_id: setId, set_title: attempt.set_title }
      ])).get(setId) ?? attempt.set_title?.trim() ?? setId;

  return {
    attempt: {
      attemptId: String(attempt.attempt_id),
      setId,
      setTitle,
      correctCount: nonNegativeNumber(attempt.correct_count),
      totalQuestions: nonNegativeNumber(attempt.total_questions),
      accuracy: ratio(
        nonNegativeNumber(attempt.correct_count),
        nonNegativeNumber(attempt.total_questions)
      ),
      timeSpentSeconds: nonNegativeNumber(attempt.time_spent_seconds),
      submittedAt: attempt.submitted_at ?? ""
    },
    initialQuestionId: String(initialAnswer.question_id),
    answers: answers.map((answer) => {
      const question = questionById.get(String(answer.question_id));
      return {
        attemptAnswerId: String(answer.attempt_answer_id),
        questionId: String(answer.question_id),
        questionOrder: nonNegativeNumber(answer.question_order),
        prompt: question?.prompt ?? "",
        submittedOrderText: answer.submitted_order_text ?? "",
        displaySubmittedOrderText: standardizeOrderTextCasing(
          answer.submitted_order_text,
          question?.options_text,
          question?.correct_order_text
        ),
        correctOrderText: question?.correct_order_text ?? answer.correct_order_text ?? "",
        sentenceTemplate: question?.sentence_template ?? "",
        optionsText: question?.options_text ?? "",
        finalSentence: question?.final_sentence ?? "",
        isCorrect: answer.is_correct === true,
        questionTimeSeconds: answer.question_time_seconds
      };
    })
  };
}

async function readRowsInBatches<T>(
  db: SupabaseClient,
  table: string,
  fields: string,
  idField: string,
  ids: string[]
): Promise<T[]> {
  if (ids.length === 0) return [];
  const results = await mapWithConcurrency(chunk(ids), 4, (batch) =>
    readAllSupabaseRows<T>((from, to) =>
      db.from(table).select(fields).in(idField, batch).range(from, to) as unknown as PromiseLike<{
        data: T[] | null;
        error: { message: string } | null;
      }>
    )
  );
  const error = results.find((result) => result.error)?.error;
  if (error) {
    throw new Error(`Failed to load scoped ${table}: ${error.message}`);
  }
  return results.flatMap((result) => result.data ?? []);
}

function chunk<T>(values: T[], size = 100) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function distinct(values: string[]) {
  return Array.from(new Set(values.map((value) => String(value).trim()).filter(Boolean)));
}

function nonNegativeNumber(value: number | null | undefined) {
  return Number.isFinite(value) ? Math.max(0, Math.round(value as number)) : 0;
}

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : 0;
}

function compareDatesDesc(left: string | null, right: string | null) {
  return new Date(right ?? 0).getTime() - new Date(left ?? 0).getTime();
}
