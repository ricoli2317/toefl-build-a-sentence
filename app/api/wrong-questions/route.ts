import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { bearerToken } from "@/lib/auth";
import { parseGrammarTags } from "@/lib/grammarPractice";
import {
  isOfficialPracticeSetId,
  wrongAnswerDedupeKey,
  type PracticeHistoryAnswer
} from "@/lib/practiceHistory";
import { loadReadingFullSetWrongbookData } from "@/lib/reading/fullSetWrongbook.server";
import { loadReadingWrongbookData } from "@/lib/reading/wrongbook.server";
import { loadBuildSentenceHistoricalPracticeDisplayResolver } from "@/lib/historicalPracticeDisplay";
import { mapWithConcurrency } from "@/lib/mapWithConcurrency";
import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { createSupabaseFetch } from "@/lib/supabase/fetch";
import {
  buildBasWrongbookEntryQuestionIds,
  buildBasWrongbookPracticeQuestionIds,
  buildWrongQuestionsOverview
} from "@/lib/wrongQuestions";

export const dynamic = "force-dynamic";

type AttemptRow = {
  attempt_id: string;
  correct_count: number | null;
  time_spent_seconds: number | null;
  total_questions: number | null;
  set_id: string;
  set_title: string | null;
  submitted_at: string | null;
  created_at: string | null;
};

type AnswerRow = {
  attempt_answer_id: string;
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
  return NextResponse.json(
    { error: message, questions: [], count: 0 },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

function questionTime(answer: AnswerRow, attemptById: Map<string, AttemptRow>) {
  const attempt = attemptById.get(String(answer.attempt_id));
  return new Date(attempt?.submitted_at ?? attempt?.created_at ?? 0).getTime();
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

function questionDedupeKey(question: ReturnType<typeof normalizeQuestion>) {
  return wrongAnswerDedupeKey({
    finalSentence: question.final_sentence,
    questionId: question.question_id
  });
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
        fetch: createSupabaseFetch(),
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
        fetch: createSupabaseFetch(),
        headers: serviceRoleKey ? {} : { Authorization: `Bearer ${token}` }
      }
    });

    const { searchParams } = new URL(request.url);
    if (searchParams.get("view") === "overview") {
      return loadWrongQuestionsOverview(db, user.id, searchParams);
    }
    const scope = searchParams.get("scope");
    if (scope !== "entry" && scope !== "today" && scope !== "history") {
      return jsonError("Invalid BAS correction scope.", 400);
    }
    const groupId = searchParams.get("groupId")?.trim() ?? "";
    if (scope === "entry" && !groupId) {
      return jsonError("Missing BAS correction group id.", 400);
    }
    const randomLimit = Number(searchParams.get("randomLimit") ?? 0);
    const todayStart = searchParams.get("todayStart");
    const todayEnd = searchParams.get("todayEnd");

    const [attemptResult, answerResult] = await Promise.all([
      readAllSupabaseRows<AttemptRow>((from, to) => db
        .from("attempts")
        .select("attempt_id,set_id,set_title,correct_count,total_questions,time_spent_seconds,submitted_at,created_at")
        .eq("student_id", user.id)
        .order("attempt_id", { ascending: true })
        .range(from, to)),
      readAllSupabaseRows<AnswerRow>((from, to) => db
        .from("attempt_answers")
        .select("attempt_answer_id,attempt_id,question_id,is_correct,answered_at,created_at")
        .eq("student_id", user.id)
        .order("attempt_answer_id", { ascending: true })
        .range(from, to))
    ]);

    if (attemptResult.error) return jsonError(`Failed to load attempts: ${attemptResult.error.message}`);
    if (answerResult.error) return jsonError(`Failed to load wrong answers: ${answerResult.error.message}`);

    const attemptRows = (attemptResult.data ?? []).map((attempt) => ({
      ...attempt,
      attempt_id: String(attempt.attempt_id),
      set_id: String(attempt.set_id)
    }));
    const answerRows = (answerResult.data ?? []).map((answer) => ({
      ...answer,
      attempt_id: String(answer.attempt_id),
      question_id: String(answer.question_id)
    }));
    const attemptById = new Map(attemptRows.map((attempt) => [attempt.attempt_id, attempt]));

    const practiceAttempts = attemptRows.map((attempt) => ({
      attemptId: attempt.attempt_id,
      createdAt: attempt.created_at,
      setId: attempt.set_id,
      submittedAt: attempt.submitted_at
    }));
    const practiceAnswers = answerRows.map((answer) => ({
      attemptId: answer.attempt_id,
      isCorrect: Boolean(answer.is_correct),
      questionId: answer.question_id
    }));
    const fallbackTodayStart = startOfLocalDay().getTime();
    const parsedTodayStart = Date.parse(todayStart ?? "");
    const parsedTodayEnd = Date.parse(todayEnd ?? "");
    const practiceTodayStart = Number.isFinite(parsedTodayStart)
      ? parsedTodayStart
      : fallbackTodayStart;
    const practiceTodayEnd = Number.isFinite(parsedTodayEnd)
      ? parsedTodayEnd
      : practiceTodayStart + 24 * 60 * 60 * 1000;
    const wrongIds = buildBasWrongbookPracticeQuestionIds({
      answers: practiceAnswers,
      attempts: practiceAttempts,
      scope: "history",
      todayEnd: practiceTodayEnd,
      todayStart: practiceTodayStart
    });

    const latestByQuestion = new Map<string, AnswerRow>();
    for (const answer of answerRows) {
      const existing = latestByQuestion.get(answer.question_id);
      if (!existing || questionTime(answer, attemptById) > questionTime(existing, attemptById)) {
        latestByQuestion.set(answer.question_id, answer);
      }
    }
    let selectedIds = wrongIds;
    let prefetchedQuestions: QuestionRow[] | null = null;
    if (scope === "entry") {
      const entrySelection = await loadBasWrongbookEntrySelection({
        answerRows,
        attemptRows,
        db,
        groupId,
        todayEnd,
        todayStart
      });
      selectedIds = entrySelection.questionIds;
      prefetchedQuestions = entrySelection.questions;
    } else if (scope === "today") {
      selectedIds = buildBasWrongbookPracticeQuestionIds({
        answers: practiceAnswers,
        attempts: practiceAttempts,
        scope: "today",
        todayEnd: practiceTodayEnd,
        todayStart: practiceTodayStart
      });
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
      return NextResponse.json(
        { count: 0, questions: [], stats: baseStats },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    let questionRows: QuestionRow[];
    if (prefetchedQuestions) {
      const selectedIdSet = new Set(selectedIds);
      questionRows = prefetchedQuestions.filter((question) =>
        selectedIdSet.has(String(question.question_id))
      );
    } else {
      const questionsResult = await readRowsInBatches<QuestionRow>(
        db,
        "questions",
        "question_id,set_id,set_title,question_order,prompt,sentence_template,blank_count,options_text,correct_order_text,distractors_text,final_sentence,grammar_tags_text",
        "question_id",
        selectedIds,
        ["question_id"]
      );
      if (questionsResult.error) {
        return jsonError(`Failed to load questions: ${questionsResult.error.message}`);
      }
      questionRows = questionsResult.data ?? [];
    }

    const orderById = new Map(selectedIds.map((questionId, index) => [questionId, index]));
    const normalizedQuestions = dedupeQuestionsByContent(
      questionRows
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
      }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not load wrong questions.");
  }
}

async function loadBasWrongbookEntrySelection(input: {
  answerRows: AnswerRow[];
  attemptRows: AttemptRow[];
  db: SupabaseClient;
  groupId: string;
  todayEnd: string | null;
  todayStart: string | null;
}) {
  const allQuestionIds = uniqueQuestionIds(
    input.answerRows.map((answer) => answer.question_id)
  );
  const questionResult = await readRowsInBatches<QuestionRow>(
    input.db,
    "questions",
    "question_id,set_id,set_title,question_order,prompt,sentence_template,blank_count,options_text,correct_order_text,distractors_text,final_sentence,grammar_tags_text",
    "question_id",
    allQuestionIds
  );
  if (questionResult.error) {
    throw new Error(`Failed to load BAS wrong questions: ${questionResult.error.message}`);
  }

  const questions = questionResult.data ?? [];
  const questionById = new Map(
    questions.map((question) => [String(question.question_id), question])
  );
  const realSetIds = new Set(questions.map((question) => String(question.set_id)));
  const officialAttempts = input.attemptRows.filter((attempt) =>
    isOfficialPracticeSetId(attempt.set_id, realSetIds)
  );
  const officialAttemptIds = new Set(
    officialAttempts.map((attempt) => attempt.attempt_id)
  );
  const correctionAttemptIds = new Set(
    input.attemptRows
      .filter((attempt) => isWrongBookAttempt(attempt))
      .map((attempt) => attempt.attempt_id)
  );
  const attemptById = new Map(
    input.attemptRows.map((attempt) => [attempt.attempt_id, attempt])
  );
  const normalizeAnswer = (answer: AnswerRow): PracticeHistoryAnswer => {
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
      prompt: question?.prompt ?? "",
      questionId: answer.question_id,
      questionOrder: question?.question_order ?? 0,
      questionTimeSeconds: null,
      sentenceTemplate: question?.sentence_template ?? "",
      submittedOrderText: ""
    };
  };
  const basSetIds = Array.from(new Set(officialAttempts.map((attempt) => attempt.set_id)));
  const displayResolver = await loadBuildSentenceHistoricalPracticeDisplayResolver(
    input.db,
    basSetIds
  );
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
  const fallbackStart = startOfLocalDay().getTime();
  const requestedStart = Date.parse(input.todayStart ?? "");
  const requestedEnd = Date.parse(input.todayEnd ?? "");
  const todayStart = Number.isFinite(requestedStart) ? requestedStart : fallbackStart;
  const todayEnd = Number.isFinite(requestedEnd)
    ? requestedEnd
    : fallbackStart + 24 * 60 * 60 * 1000;
  const questionIds = buildBasWrongbookEntryQuestionIds({
    basAnswers: input.answerRows
      .filter((answer) => officialAttemptIds.has(answer.attempt_id))
      .map(normalizeAnswer),
    basAttempts: officialAttempts.map((attempt) => ({
      attemptId: attempt.attempt_id,
      correctCount: attempt.correct_count ?? 0,
      setId: attempt.set_id,
      setTitle: attempt.set_title?.trim() || attempt.set_id,
      submittedAt: attempt.submitted_at ?? attempt.created_at ?? null,
      timeSpentSeconds: attempt.time_spent_seconds ?? 0,
      totalQuestions: attempt.total_questions ?? 0
    })),
    basCorrectionAnswers: input.answerRows
      .filter((answer) => correctionAttemptIds.has(answer.attempt_id) && Boolean(answer.is_correct))
      .map(normalizeAnswer),
    basGroupsBySet,
    groupId: input.groupId,
    todayEnd,
    todayStart
  });

  return { questionIds, questions };
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

type OverviewBasAnswerRow = AnswerRow;

type OverviewQuestionRow = Pick<
  QuestionRow,
  "question_id" | "set_id" | "question_order" | "final_sentence" | "grammar_tags_text"
>;

async function loadWrongQuestionsOverview(
  db: SupabaseClient,
  studentId: string,
  searchParams: URLSearchParams
) {
  const [basAttemptResult, readingWrongbook, fullSetWrongbook] = await Promise.all([
    readAllSupabaseRows<OverviewBasAttemptRow>((from, to) =>
      db
        .from("attempts")
        .select("attempt_id,set_id,set_title,correct_count,total_questions,time_spent_seconds,submitted_at,created_at")
        .eq("student_id", studentId)
        .order("attempt_id", { ascending: true })
        .range(from, to)
    ),
    loadReadingWrongbookData(db, studentId),
    loadReadingFullSetWrongbookData(db, studentId)
  ]);
  const initialError = basAttemptResult.error;
  if (initialError) return jsonError(`Failed to load wrong-question overview: ${initialError.message}`);

  const allBasAttempts = (basAttemptResult.data ?? []).map((attempt) => ({
    ...attempt,
    attempt_id: String(attempt.attempt_id),
    set_id: String(attempt.set_id).trim()
  }));
  const correctionAttemptIds = allBasAttempts
    .filter((attempt) => attempt.set_id.startsWith("wrongbook-"))
    .map((attempt) => attempt.attempt_id);
  const [wrongAnswerResult, correctionAnswerResult] = await Promise.all([
    readAllSupabaseRows<OverviewBasAnswerRow>((from, to) => db
      .from("attempt_answers")
      .select("attempt_answer_id,attempt_id,question_id,is_correct,answered_at,created_at")
      .eq("student_id", studentId)
      .eq("is_correct", false)
      .order("attempt_answer_id", { ascending: true })
      .range(from, to)),
    readBasCorrectionAnswers(db, correctionAttemptIds)
  ]);
  const basAnswerError = wrongAnswerResult.error ?? correctionAnswerResult.error;
  if (basAnswerError) return jsonError(`Failed to load BAS wrong answers: ${basAnswerError.message}`);
  const allBasAnswers = [
    ...(wrongAnswerResult.data ?? []),
    ...(correctionAnswerResult.data ?? [])
  ].map((answer) => ({
    ...answer,
    attempt_answer_id: String(answer.attempt_answer_id),
    attempt_id: String(answer.attempt_id),
    question_id: String(answer.question_id)
  }));
  const questionIds = uniqueQuestionIds(allBasAnswers.map((answer) => answer.question_id));
  const questionResult = await readRowsInBatches<OverviewQuestionRow>(
    db,
    "questions",
    "question_id,set_id,question_order,final_sentence,grammar_tags_text",
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
  const correctionAttemptIdSet = new Set(correctionAttemptIds);
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
      optionsText: "",
      prompt: "",
      questionId: answer.question_id,
      questionOrder: question?.question_order ?? 0,
      questionTimeSeconds: null,
      sentenceTemplate: "",
      submittedOrderText: ""
    };
  };
  const basAnswers = allBasAnswers
    .filter((answer) => officialAttemptIds.has(answer.attempt_id))
    .map(normalizeBasAnswer);
  const basCorrectionAnswers = allBasAnswers
    .filter((answer) => correctionAttemptIdSet.has(answer.attempt_id) && Boolean(answer.is_correct))
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
    ...readingWrongbook,
    ...fullSetWrongbook,
    todayEnd,
    todayStart
  });
  return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
}

async function readBasCorrectionAnswers(db: SupabaseClient, attemptIds: string[]) {
  if (attemptIds.length === 0) {
    return { data: [] as OverviewBasAnswerRow[], error: null };
  }
  const results = await mapWithConcurrency(chunkValues(attemptIds), 4, (ids) =>
    readAllSupabaseRows<OverviewBasAnswerRow>((from, to) => db
      .from("attempt_answers")
      .select("attempt_answer_id,attempt_id,question_id,is_correct,answered_at,created_at")
      .in("attempt_id", ids)
      .eq("is_correct", true)
      .order("attempt_answer_id", { ascending: true })
      .range(from, to))
  );
  const error = results.find((result) => result.error)?.error ?? null;
  return { data: error ? null : results.flatMap((result) => result.data ?? []), error };
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
  const results = await mapWithConcurrency(chunkValues(values), 4, (batch) =>
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
  );
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
