import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { bearerToken } from "@/lib/auth";
import { parseGrammarTags } from "@/lib/grammarPractice";
import {
  isOfficialPracticeSetId,
  type PracticeHistoryAnswer
} from "@/lib/practiceHistory";
import { readingCatalogDisplayNumber } from "@/lib/reading/catalog";
import { loadBuildSentenceHistoricalPracticeDisplayResolver } from "@/lib/historicalPracticeDisplay";
import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { buildWrongQuestionsOverview } from "@/lib/wrongQuestions";

type AttemptRow = {
  attempt_id: string;
  set_id: string;
  submitted_at: string | null;
  created_at: string | null;
};

type AnswerRow = {
  attempt_id: string;
  question_id: string;
  is_correct: boolean | null;
  answered_at: string | null;
  created_at: string | null;
};

type QuestionRow = {
  question_id: string;
  set_id: string;
  set_title: string | null;
  question_order: number | null;
  prompt: string | null;
  sentence_template: string | null;
  blank_count: number | null;
  options_text: string | null;
  correct_order_text: string | null;
  distractors_text: string | null;
  final_sentence: string | null;
  grammar_tags_text: string | null;
};

function jsonError(message: string, status = 500) {
  return NextResponse.json({ error: message, questions: [], count: 0 }, { status });
}

function questionTime(answer: AnswerRow, attemptById: Map<string, AttemptRow>) {
  const attempt = attemptById.get(String(answer.attempt_id));
  return new Date(attempt?.submitted_at ?? attempt?.created_at ?? 0).getTime();
}

function attemptTime(attempt: AttemptRow) {
  return new Date(attempt.submitted_at ?? attempt.created_at ?? 0).getTime();
}

function answerEventTime(answer: AnswerRow, attemptById: Map<string, AttemptRow>) {
  const answerTime = new Date(answer.answered_at ?? answer.created_at ?? 0).getTime();
  return Number.isFinite(answerTime) && answerTime > 0
    ? answerTime
    : questionTime(answer, attemptById);
}

function isWrongBookAttempt(attempt: AttemptRow | undefined) {
  return Boolean(attempt?.set_id?.startsWith("wrongbook-"));
}

function isTodayWrongBookAttempt(attempt: AttemptRow | undefined) {
  return Boolean(attempt?.set_id?.startsWith("wrongbook-today-"));
}

function isHistoryWrongBookAttempt(attempt: AttemptRow | undefined) {
  return Boolean(
    attempt?.set_id?.startsWith("wrongbook-all-") ||
      attempt?.set_id?.startsWith("wrongbook-random-")
  );
}

function isNormalPracticeAttempt(attempt: AttemptRow | undefined) {
  return Boolean(attempt) && !isWrongBookAttempt(attempt);
}

function uniqueQuestionIds(ids: string[]) {
  return Array.from(new Set(ids.filter(Boolean)));
}

function normalizeQuestion(question: QuestionRow) {
  return {
    blank_count: question.blank_count ?? 0,
    correct_order_text: question.correct_order_text ?? "",
    distractors_text: question.distractors_text ?? "",
    final_sentence: question.final_sentence ?? "",
    grammar_tags_text: question.grammar_tags_text ?? "",
    options_text: question.options_text ?? "",
    prompt: question.prompt ?? "",
    question_id: String(question.question_id),
    question_order: question.question_order ?? 0,
    sentence_template: question.sentence_template ?? "",
    set_id: String(question.set_id),
    set_title: question.set_title ?? String(question.set_id)
  };
}

function normalizeForDedupe(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function questionDedupeKey(question: ReturnType<typeof normalizeQuestion>) {
  return [
    question.prompt,
    question.sentence_template,
    question.final_sentence,
    question.correct_order_text
  ]
    .map(normalizeForDedupe)
    .join("|");
}

function dedupeQuestionsByContent(
  questions: ReturnType<typeof normalizeQuestion>[],
  orderById: Map<string, number>
) {
  const bestByKey = new Map<string, ReturnType<typeof normalizeQuestion>>();

  for (const question of questions) {
    const key = questionDedupeKey(question);
    const existing = bestByKey.get(key);
    const questionOrder = orderById.get(question.question_id) ?? Number.MAX_SAFE_INTEGER;
    const existingOrder = existing
      ? orderById.get(existing.question_id) ?? Number.MAX_SAFE_INTEGER
      : Number.MAX_SAFE_INTEGER;

    if (!existing || questionOrder < existingOrder) {
      bestByKey.set(key, question);
    }
  }

  return Array.from(bestByKey.values());
}

function shuffle<T>(items: T[]) {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

export async function GET(request: Request) {
  try {
    const token = bearerToken(request);
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      return jsonError("Missing Supabase environment variables.");
    }

    if (!token) {
      return jsonError("Missing access token", 401);
    }

    const authClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false },
      global: {
        headers: { Authorization: `Bearer ${token}` }
      }
    });

    const {
      data: { user },
      error: userError
    } = await authClient.auth.getUser(token);

    if (userError || !user) {
      return jsonError(userError?.message ?? "Invalid session", 401);
    }

    const { data: profile, error: profileError } = await authClient
      .from("profiles")
      .select("role,is_active")
      .eq("id", user.id)
      .single();

    if (profileError || profile?.is_active === false || !["student", "admin"].includes(profile?.role ?? "")) {
      return jsonError(profileError?.message ?? "Unauthorized", 401);
    }

    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const db = createClient(supabaseUrl, serviceRoleKey || supabaseAnonKey, {
      auth: { persistSession: false },
      global: {
        headers: serviceRoleKey ? {} : { Authorization: `Bearer ${token}` }
      }
    });

    const { searchParams } = new URL(request.url);
    if (searchParams.get("view") === "overview") {
      return loadWrongQuestionsOverview(db, user.id, searchParams);
    }
    const scope = searchParams.get("scope") ?? "today";
    const randomLimit = Number(searchParams.get("randomLimit") ?? 0);
    const todayStart = searchParams.get("todayStart");
    const todayEnd = searchParams.get("todayEnd");

    const [
      { data: attempts, error: attemptsError },
      { data: answers, error: answersError }
    ] = await Promise.all([
      db
        .from("attempts")
        .select("attempt_id,set_id,submitted_at,created_at")
        .eq("student_id", user.id),
      db
        .from("attempt_answers")
        .select("attempt_id,question_id,is_correct,answered_at,created_at")
        .eq("student_id", user.id)
    ]);

    if (attemptsError) return jsonError(`Failed to load attempts: ${attemptsError.message}`);
    if (answersError) return jsonError(`Failed to load wrong answers: ${answersError.message}`);

    const attemptRows = ((attempts ?? []) as AttemptRow[]).map((attempt) => ({
      ...attempt,
      attempt_id: String(attempt.attempt_id),
      set_id: String(attempt.set_id)
    }));
    const answerRows = ((answers ?? []) as AnswerRow[]).map((answer) => ({
      ...answer,
      attempt_id: String(answer.attempt_id),
      question_id: String(answer.question_id)
    }));
    const attemptById = new Map(attemptRows.map((attempt) => [attempt.attempt_id, attempt]));

    const wrongIds = uniqueQuestionIds(
      answerRows.filter((answer) => !answer.is_correct).map((answer) => answer.question_id)
    );

    const latestByQuestion = new Map<string, AnswerRow>();
    for (const answer of answerRows) {
      const existing = latestByQuestion.get(answer.question_id);
      if (!existing || questionTime(answer, attemptById) > questionTime(existing, attemptById)) {
        latestByQuestion.set(answer.question_id, answer);
      }
    }
    const unresolvedIds = uniqueQuestionIds(
      wrongIds.filter((questionId) => latestByQuestion.get(questionId)?.is_correct !== true)
    );

    let selectedIds = wrongIds;
    if (scope === "today") {
      const startTime = todayStart ? new Date(todayStart).getTime() : startOfLocalDay().getTime();
      const endTime = todayEnd ? new Date(todayEnd).getTime() : startTime + 24 * 60 * 60 * 1000;
      const todayAttemptIds = new Set(
        attemptRows
          .filter((attempt) => {
            const time = attemptTime(attempt);
            return (
              time >= startTime &&
              time < endTime &&
              (isNormalPracticeAttempt(attempt) ||
                isTodayWrongBookAttempt(attempt) ||
                isHistoryWrongBookAttempt(attempt))
            );
          })
          .map((attempt) => attempt.attempt_id)
      );
      const todayWrongState = new Map<string, boolean>();
      const todayAnswers = answerRows
        .filter((answer) => todayAttemptIds.has(answer.attempt_id))
        .sort((left, right) => questionTime(left, attemptById) - questionTime(right, attemptById));

      for (const answer of todayAnswers) {
        const attempt = attemptById.get(answer.attempt_id);

        if (isNormalPracticeAttempt(attempt)) {
          if (!answer.is_correct) {
            todayWrongState.set(answer.question_id, true);
          }
          continue;
        }

        if (isHistoryWrongBookAttempt(attempt)) {
          if (!answer.is_correct) {
            todayWrongState.set(answer.question_id, true);
          }
          continue;
        }

        if (isTodayWrongBookAttempt(attempt)) {
          todayWrongState.set(answer.question_id, !answer.is_correct);
        }
      }

      selectedIds = Array.from(todayWrongState.entries())
        .filter(([, needsReview]) => needsReview)
        .map(([questionId]) => questionId);
    } else if (scope === "unresolved") {
      selectedIds = unresolvedIds;
    } else {
      selectedIds = wrongIds;
    }

    if (randomLimit > 0) {
      selectedIds = shuffle(selectedIds).slice(0, randomLimit);
    }

    const selectedIdSet = new Set(selectedIds);
    const statsStartTime = scope === "today"
      ? todayStart
        ? new Date(todayStart).getTime()
        : startOfLocalDay().getTime()
      : Number.NEGATIVE_INFINITY;
    const statsEndTime = scope === "today"
      ? todayEnd
        ? new Date(todayEnd).getTime()
        : statsStartTime + 24 * 60 * 60 * 1000
      : Number.POSITIVE_INFINITY;
    const relevantWrongAnswers = answerRows.filter((answer) => {
      if (answer.is_correct || !selectedIdSet.has(answer.question_id)) return false;
      const time = answerEventTime(answer, attemptById);
      return time >= statsStartTime && time < statsEndTime;
    });
    const latestWrongTime = relevantWrongAnswers.reduce(
      (latest, answer) => Math.max(latest, answerEventTime(answer, attemptById)),
      0
    );
    const masteryQuestionIds = scope === "history" ? wrongIds : selectedIds;
    const masteredQuestionCount = masteryQuestionIds.filter(
      (questionId) => latestByQuestion.get(questionId)?.is_correct === true
    ).length;
    const baseStats = {
      knowledgePointCount: 0,
      latestWrongAt: latestWrongTime > 0 ? new Date(latestWrongTime).toISOString() : null,
      masteredQuestionCount,
      masteryRate:
        masteryQuestionIds.length > 0
          ? Math.round((masteredQuestionCount / masteryQuestionIds.length) * 100)
          : null,
      totalWrongOccurrences: relevantWrongAnswers.length
    };

    if (selectedIds.length === 0) {
      return NextResponse.json({ count: 0, questions: [], stats: baseStats });
    }

    const { data: questions, error: questionsError } = await db
      .from("questions")
      .select(
        "question_id,set_id,set_title,question_order,prompt,sentence_template,blank_count,options_text,correct_order_text,distractors_text,final_sentence,grammar_tags_text"
      )
      .in("question_id", selectedIds);

    if (questionsError) {
      return jsonError(`Failed to load questions: ${questionsError.message}`);
    }

    const orderById = new Map(selectedIds.map((questionId, index) => [questionId, index]));
    const normalizedQuestions = dedupeQuestionsByContent(
      ((questions ?? []) as QuestionRow[])
      .map(normalizeQuestion)
      .sort((left, right) => {
        const orderCompare =
          (orderById.get(left.question_id) ?? 0) - (orderById.get(right.question_id) ?? 0);
        return orderCompare || left.question_order - right.question_order;
      }),
      orderById
    );

    return NextResponse.json({
      count: normalizedQuestions.length,
      questions: normalizedQuestions,
      stats: {
        ...baseStats,
        knowledgePointCount: new Set(
          normalizedQuestions.flatMap((question) =>
            parseGrammarTags(question.grammar_tags_text)
          )
        ).size
      }
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not load wrong questions.");
  }
}

function startOfLocalDay() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

type OverviewBasAttemptRow = AttemptRow & {
  correct_count: number | null;
  set_title: string | null;
  time_spent_seconds: number | null;
  total_questions: number | null;
};

type OverviewBasAnswerRow = AnswerRow & {
  attempt_answer_id: string;
  question_order: number | null;
  prompt: string | null;
  submitted_order_text: string | null;
  question_time_seconds: number | null;
};

type OverviewQuestionRow = QuestionRow;

type OverviewReadingAttemptRow = {
  attempt_id: string;
  logical_item_id: string;
  task_type: "ctw" | "rdl" | "rap";
  submitted_at: string;
};

type OverviewReadingAnswerRow = {
  attempt_id: string;
  is_correct: boolean;
  question_id: string;
  slot_id: string | null;
};

type OverviewReadingItemRow = {
  first_seen_date: string;
  first_seen_source_label: string;
  first_seen_source_order: number;
  logical_item_id: string;
  module: "ctw" | "rdl" | "rap";
  title: string | null;
};

type OverviewReadingCorrectionAttemptRow = OverviewReadingAttemptRow & {
  scope: "history" | "today";
};

async function loadWrongQuestionsOverview(
  db: SupabaseClient,
  studentId: string,
  searchParams: URLSearchParams
) {
  const [
    basAttemptResult,
    basAnswerResult,
    readingAttemptResult,
    readingCorrectionAttemptResult
  ] = await Promise.all([
    readAllSupabaseRows<OverviewBasAttemptRow>((from, to) =>
      db
        .from("attempts")
        .select("attempt_id,set_id,set_title,correct_count,total_questions,time_spent_seconds,submitted_at,created_at")
        .eq("student_id", studentId)
        .order("attempt_id", { ascending: true })
        .range(from, to)
    ),
    readAllSupabaseRows<OverviewBasAnswerRow>((from, to) =>
      db
        .from("attempt_answers")
        .select("attempt_answer_id,attempt_id,question_id,question_order,prompt,submitted_order_text,is_correct,question_time_seconds,answered_at,created_at")
        .eq("student_id", studentId)
        .order("attempt_answer_id", { ascending: true })
        .range(from, to)
    ),
    readAllSupabaseRows<OverviewReadingAttemptRow>((from, to) =>
      db
        .from("reading_attempts")
        .select("attempt_id,logical_item_id,task_type,submitted_at")
        .eq("student_id", studentId)
        .eq("status", "submitted")
        .order("attempt_id", { ascending: true })
        .range(from, to)
    ),
    readAllSupabaseRows<OverviewReadingCorrectionAttemptRow>((from, to) =>
      db
        .from("reading_wrongbook_attempts")
        .select("attempt_id,logical_item_id,task_type,scope,submitted_at")
        .eq("student_id", studentId)
        .eq("status", "submitted")
        .order("attempt_id", { ascending: true })
        .range(from, to)
    )
  ]);
  const initialError = basAttemptResult.error ?? basAnswerResult.error ?? readingAttemptResult.error
    ?? readingCorrectionAttemptResult.error;
  if (initialError) return jsonError(`Failed to load wrong-question overview: ${initialError.message}`);

  const allBasAttempts = (basAttemptResult.data ?? []).map((attempt) => ({
    ...attempt,
    attempt_id: String(attempt.attempt_id),
    set_id: String(attempt.set_id).trim()
  }));
  const allBasAnswers = (basAnswerResult.data ?? []).map((answer) => ({
    ...answer,
    attempt_answer_id: String(answer.attempt_answer_id),
    attempt_id: String(answer.attempt_id),
    question_id: String(answer.question_id)
  }));
  const questionIds = uniqueQuestionIds(allBasAnswers.map((answer) => answer.question_id));
  const questionResult = await readRowsInBatches<OverviewQuestionRow>(
    db,
    "questions",
    "question_id,set_id,set_title,question_order,prompt,sentence_template,blank_count,options_text,correct_order_text,distractors_text,final_sentence,grammar_tags_text",
    "question_id",
    questionIds
  );
  if (questionResult.error) return jsonError(`Failed to load BAS wrong questions: ${questionResult.error.message}`);

  const questionRows = questionResult.data ?? [];
  const questionById = new Map(questionRows.map((question) => [String(question.question_id), question]));
  const realSetIds = new Set(questionRows.map((question) => String(question.set_id)));
  const officialAttempts = allBasAttempts.filter((attempt) =>
    isOfficialPracticeSetId(attempt.set_id, realSetIds)
  );
  const officialAttemptIds = new Set(officialAttempts.map((attempt) => attempt.attempt_id));
  const correctionAttemptIds = new Set(
    allBasAttempts
      .filter((attempt) => attempt.set_id.startsWith("wrongbook-"))
      .map((attempt) => attempt.attempt_id)
  );
  const attemptById = new Map(allBasAttempts.map((attempt) => [attempt.attempt_id, attempt]));
  const normalizeBasAnswer = (answer: OverviewBasAnswerRow): PracticeHistoryAnswer => {
    const question = questionById.get(answer.question_id);
    const attempt = attemptById.get(answer.attempt_id);
    return {
      answeredAt: answer.answered_at ?? answer.created_at ?? attempt?.submitted_at ?? attempt?.created_at ?? null,
      attemptAnswerId: answer.attempt_answer_id,
      attemptId: answer.attempt_id,
      finalSentence: question?.final_sentence ?? "",
      grammarTag: question?.grammar_tags_text ?? "",
      isCorrect: Boolean(answer.is_correct),
      optionsText: question?.options_text ?? "",
      prompt: question?.prompt ?? answer.prompt ?? "",
      questionId: answer.question_id,
      questionOrder: answer.question_order ?? question?.question_order ?? 0,
      questionTimeSeconds: answer.question_time_seconds,
      sentenceTemplate: question?.sentence_template ?? "",
      submittedOrderText: answer.submitted_order_text ?? ""
    };
  };
  const basAnswers = allBasAnswers
    .filter((answer) => officialAttemptIds.has(answer.attempt_id))
    .map(normalizeBasAnswer);
  const basCorrectionAnswers = allBasAnswers
    .filter((answer) => correctionAttemptIds.has(answer.attempt_id) && Boolean(answer.is_correct))
    .map(normalizeBasAnswer);
  const basAttempts = officialAttempts.map((attempt) => ({
    attemptId: attempt.attempt_id,
    correctCount: attempt.correct_count ?? 0,
    setId: attempt.set_id,
    setTitle: attempt.set_title?.trim() || attempt.set_id,
    submittedAt: attempt.submitted_at ?? attempt.created_at ?? null,
    timeSpentSeconds: attempt.time_spent_seconds ?? 0,
    totalQuestions: attempt.total_questions ?? 0
  }));
  const basSetIds = Array.from(new Set(officialAttempts.map((attempt) => attempt.set_id)));
  const displayResolver = await loadBuildSentenceHistoricalPracticeDisplayResolver(db, basSetIds);
  const basGroupsBySet = new Map(basSetIds.map((setId) => {
    const attempt = officialAttempts.find((candidate) => candidate.set_id === setId);
    const display = displayResolver.resolveBuildSentence({
      fallbackDisplayName: attempt?.set_title?.trim() || setId,
      rawSetId: setId
    });
    return [setId, {
      groupId: display.itemId ?? setId,
      title: display.displayName
    }];
  }));

  const readingAttempts = (readingAttemptResult.data ?? []).map((attempt) => ({
    attemptId: String(attempt.attempt_id),
    logicalItemId: String(attempt.logical_item_id),
    submittedAt: attempt.submitted_at,
    taskType: attempt.task_type
  }));
  const readingAttemptIds = readingAttempts.map((attempt) => attempt.attemptId);
  const readingCorrectionAttempts = (readingCorrectionAttemptResult.data ?? []).map((attempt) => ({
    attemptId: String(attempt.attempt_id),
    logicalItemId: String(attempt.logical_item_id),
    scope: attempt.scope,
    submittedAt: attempt.submitted_at,
    taskType: attempt.task_type
  }));
  const [readingAnswerResult, readingCorrectionAnswerResult, readingItemResult] = await Promise.all([
    readRowsInBatches<OverviewReadingAnswerRow>(
      db,
      "reading_attempt_answers",
      "attempt_id,question_id,slot_id,is_correct",
      "attempt_id",
      readingAttemptIds,
      ["attempt_id", "question_id", "slot_id"]
    ),
    readRowsInBatches<OverviewReadingAnswerRow>(
      db,
      "reading_wrongbook_attempt_answers",
      "attempt_id,question_id,slot_id,is_correct",
      "attempt_id",
      readingCorrectionAttempts.map((attempt) => attempt.attemptId),
      ["attempt_id", "question_id", "slot_id"]
    ),
    readAllSupabaseRows<OverviewReadingItemRow>((from, to) =>
      db
        .from("reading_logical_items")
        .select("logical_item_id,module,title,first_seen_date,first_seen_source_label,first_seen_source_order")
        .order("logical_item_id", { ascending: true })
        .range(from, to)
    )
  ]);
  const readingError = readingAnswerResult.error ?? readingCorrectionAnswerResult.error
    ?? readingItemResult.error;
  if (readingError) return jsonError(`Failed to load Reading wrong questions: ${readingError.message}`);

  const requestedStart = Date.parse(searchParams.get("todayStart") ?? "");
  const requestedEnd = Date.parse(searchParams.get("todayEnd") ?? "");
  const fallbackStart = startOfLocalDay().getTime();
  const todayStart = Number.isFinite(requestedStart) ? requestedStart : fallbackStart;
  const todayEnd = Number.isFinite(requestedEnd)
    ? requestedEnd
    : fallbackStart + 24 * 60 * 60 * 1000;
  const payload = buildWrongQuestionsOverview({
    basAnswers,
    basAttempts,
    basCorrectionAnswers,
    basGroupsBySet,
    readingAnswers: (readingAnswerResult.data ?? []).map((answer) => ({
      attemptId: String(answer.attempt_id),
      isCorrect: Boolean(answer.is_correct),
      questionId: String(answer.question_id),
      slotId: answer.slot_id ? String(answer.slot_id) : null
    })),
    readingAttempts,
    readingCorrectionAnswers: (readingCorrectionAnswerResult.data ?? []).map((answer) => ({
      attemptId: String(answer.attempt_id),
      isCorrect: Boolean(answer.is_correct),
      questionId: String(answer.question_id),
      slotId: answer.slot_id ? String(answer.slot_id) : null
    })),
    readingCorrectionAttempts,
    readingTitles: buildReadingWrongQuestionTitles(readingItemResult.data ?? []),
    todayEnd,
    todayStart
  });
  return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
}

function buildReadingWrongQuestionTitles(items: OverviewReadingItemRow[]) {
  const byModule = new Map<"ctw" | "rdl" | "rap", OverviewReadingItemRow[]>();
  for (const item of items) {
    byModule.set(item.module, [...(byModule.get(item.module) ?? []), item]);
  }
  return new Map(items.map((item) => {
    const displayNumber = readingCatalogDisplayNumber(
      byModule.get(item.module) ?? [],
      item.logical_item_id
    );
    const fallback = `${item.module === "ctw" ? "套题" : "题目"}${displayNumber ?? ""}`;
    return [item.logical_item_id, item.module === "ctw" ? fallback : item.title?.trim() || fallback];
  }));
}

async function readRowsInBatches<T>(
  db: SupabaseClient,
  table: string,
  columns: string,
  filterColumn: string,
  values: string[],
  orderColumns = [filterColumn]
) {
  if (values.length === 0) return { data: [] as T[], error: null };
  const results = await Promise.all(chunkValues(values).map((batch) =>
    readAllSupabaseRows<T>((from, to) => {
      let query = db
        .from(table)
        .select(columns)
        .in(filterColumn, batch);
      for (const orderColumn of orderColumns) {
        query = query.order(orderColumn, { ascending: true });
      }
      return query.range(from, to) as unknown as PromiseLike<{
          data: T[] | null;
          error: { message: string } | null;
        }>;
    })
  ));
  const error = results.find((result) => result.error)?.error ?? null;
  return { data: error ? null : results.flatMap((result) => result.data ?? []), error };
}

function chunkValues<T>(values: T[], size = 100) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}
