import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { bearerToken } from "@/lib/auth";
import { parseGrammarTags } from "@/lib/grammarPractice";
import {
  isOfficialPracticeSetId,
  wrongAnswerDedupeKey,
  type PracticeHistoryAnswer
} from "@/lib/practiceHistory";
import {
  loadReadingFullSetWrongbookData,
  loadReadingFullSetWrongbookOverviewData
} from "@/lib/reading/fullSetWrongbook.server";
import { loadReadingWrongbookData } from "@/lib/reading/wrongbook.server";
import { loadBuildSentenceHistoricalPracticeDisplayResolver } from "@/lib/historicalPracticeDisplay";
import { mapWithConcurrency } from "@/lib/mapWithConcurrency";
import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { createSupabaseFetch } from "@/lib/supabase/fetch";
import {
  appendSupabaseDebugMetrics,
  createServerDebugTrace,
  instrumentSupabaseClient,
  profileSupabaseQuery,
  synchronizeServerDebugOrigins,
  wantsSupabaseDebugMetrics,
  type ServerDebugMetric,
  type ServerDebugTrace,
  type SupabaseQueryMetric
} from "@/lib/supabase/debugMetrics.server";
import {
  createStudentPerformanceTrace,
  type StudentPerformanceTrace
} from "@/lib/studentPerformance.server";
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
  const debugMetrics: SupabaseQueryMetric[] = [];
  const stageMetrics: ServerDebugMetric[] = [];
  synchronizeServerDebugOrigins(debugMetrics, stageMetrics);
  const debugEnabled = wantsSupabaseDebugMetrics(request);
  const profile = createServerDebugTrace(stageMetrics, debugEnabled);
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

    const baseAuthClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false },
      global: {
        fetch: createSupabaseFetch(),
        headers: { Authorization: `Bearer ${token}` }
      }
    });
    const authClient = debugEnabled
      ? instrumentSupabaseClient(baseAuthClient, debugMetrics)
      : baseAuthClient;

    const {
      data: { user },
      error: userError
    } = await profile.measure("auth/getUser", [], () => authClient.auth.getUser(token));

    if (userError || !user) {
      return jsonError(userError?.message ?? "Invalid session", 401);
    }

    const { data: studentProfile, error: profileError } = await profile.measure(
      "student/account validation",
      ["auth/getUser"],
      () => profileSupabaseQuery(
        { query: "student_profile_validation", dependsOn: ["auth/getUser"] },
        () => authClient
          .from("profiles")
          .select("role,is_active")
          .eq("id", user.id)
          .single()
      )
    );

    if (profileError || studentProfile?.is_active === false || !["student", "admin"].includes(studentProfile?.role ?? "")) {
      return jsonError(profileError?.message ?? "Unauthorized", 401);
    }

    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const baseDb = createClient(supabaseUrl, serviceRoleKey || supabaseAnonKey, {
      auth: { persistSession: false },
      global: {
        fetch: createSupabaseFetch(),
        headers: serviceRoleKey ? {} : { Authorization: `Bearer ${token}` }
      }
    });
    const db = debugEnabled
      ? instrumentSupabaseClient(baseDb, debugMetrics)
      : baseDb;

    const { searchParams } = new URL(request.url);
    if (
      debugEnabled
      && (
        process.env.TPS_PERFORMANCE_BASELINE === "1"
        || searchParams.get("performanceBaseline") === "1"
      )
    ) {
      const samples = [];
      for (let index = 0; index < 7; index += 1) {
        const query = `round_trip_baseline_${index + 1}`;
        const result = await profileSupabaseQuery(
          { query, dependsOn: index === 0 ? ["student/account validation"] : [`round_trip_baseline_${index}`] },
          () => db.from("profiles").select("id").eq("id", user.id).maybeSingle()
        );
        if (result.error) return jsonError(`Baseline query failed: ${result.error.message}`);
        samples.push(result.data?.id ?? null);
      }
      return appendSupabaseDebugMetrics(
        NextResponse.json({ samples: samples.length }, { headers: { "Cache-Control": "no-store" } }),
        debugMetrics,
        stageMetrics
      );
    }
    if (searchParams.get("view") === "overview") {
      const response = await loadWrongQuestionsOverview(db, user.id, searchParams, profile);
      return debugEnabled ? appendSupabaseDebugMetrics(response, debugMetrics, stageMetrics) : response;
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

    if (scope === "entry") {
      const response = await loadBasWrongbookEntryPractice({
        db,
        groupId,
        profile,
        studentId: user.id,
        todayEnd,
        todayStart
      });
      return debugEnabled ? appendSupabaseDebugMetrics(response, debugMetrics, stageMetrics) : response;
    }

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
    if (scope === "today") {
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
    const questionRows = questionsResult.data ?? [];

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

async function loadBasWrongbookEntryPractice(input: {
  db: SupabaseClient;
  groupId: string;
  profile: ServerDebugTrace;
  studentId: string;
  todayEnd: string | null;
  todayStart: string | null;
}) {
  const entryStartedAt = performance.now();
  const sourceResult = await profileSupabaseQuery(
    { query: "bas_source_group_lookup", dependsOn: ["student/account validation"] },
    () => readAllSupabaseRows<{
      source_set_id: string | null;
    }>((from, to) => input.db
      .from("practice_item_sources")
      .select("source_set_id")
      .eq("item_id", input.groupId)
      .eq("task_type", "build_sentence")
      .order("source_set_id", { ascending: true })
      .range(from, to))
  );
  if (sourceResult.error) {
    return jsonError(`Failed to resolve BAS wrong-question group: ${sourceResult.error.message}`);
  }
  const sourceSetIds = uniqueQuestionIds((sourceResult.data ?? [])
    .map((row) => row.source_set_id?.trim() ?? ""));
  if (sourceSetIds.length === 0) sourceSetIds.push(input.groupId);

  const officialAttemptResult = await profileSupabaseQuery(
    { query: "bas_formal_attempts_lookup", dependsOn: ["bas_source_group_lookup"] },
    () => readAllSupabaseRows<AttemptRow>((from, to) => input.db
      .from("attempts")
      .select("attempt_id,set_id,set_title,correct_count,total_questions,time_spent_seconds,submitted_at,created_at")
      .eq("student_id", input.studentId)
      .in("set_id", sourceSetIds)
      .order("attempt_id", { ascending: true })
      .range(from, to))
  );
  if (officialAttemptResult.error) {
    return jsonError(`Failed to load BAS attempts: ${officialAttemptResult.error.message}`);
  }
  const officialAttempts = (officialAttemptResult.data ?? []).map(normalizeAttemptRow);
  const officialAnswerResult = await profileSupabaseQuery(
    { query: "bas_wrong_answers_lookup", dependsOn: ["bas_formal_attempts_lookup"] },
    () => readAnswerRowsByAttemptIds(
      input.db,
      officialAttempts.map((attempt) => attempt.attempt_id)
    )
  );
  if (officialAnswerResult.error) {
    return jsonError(`Failed to load BAS group answers: ${officialAnswerResult.error.message}`);
  }
  const officialAnswers = (officialAnswerResult.data ?? []).map(normalizeAnswerRow);
  const allQuestionIds = uniqueQuestionIds(officialAnswers.map((answer) => answer.question_id));
  const officialAttemptIds = new Set(officialAttempts.map((attempt) => attempt.attempt_id));
  const questionPromise = profileSupabaseQuery(
    { query: "bas_question_metadata_lookup", dependsOn: ["bas_wrong_answers_lookup"] },
    () => readRowsInBatches<QuestionRow>(
      input.db,
      "questions",
      "question_id,set_id,set_title,question_order,prompt,sentence_template,blank_count,options_text,correct_order_text,distractors_text,final_sentence,grammar_tags_text",
      "question_id",
      allQuestionIds
    )
  );
  const candidateAnswerPromise = profileSupabaseQuery(
    { query: "bas_correction_answers_lookup", dependsOn: ["bas_wrong_answers_lookup"] },
    () => readAllSupabaseRows<AnswerRow>((from, to) => input.db
      .from("attempt_answers")
      .select("attempt_answer_id,attempt_id,question_id,is_correct,answered_at,created_at")
      .eq("student_id", input.studentId)
      .in("question_id", allQuestionIds)
      .order("attempt_answer_id", { ascending: true })
      .range(from, to))
  );
  const candidateAnswerResult = await candidateAnswerPromise;
  if (candidateAnswerResult.error) {
    await questionPromise;
    throw new Error(`Failed to load BAS wrong questions: ${candidateAnswerResult.error.message}`);
  }
  const candidateAnswers = (candidateAnswerResult.data ?? []).map(normalizeAnswerRow);
  const candidateAttemptPromise = profileSupabaseQuery(
    {
      query: "bas_candidate_attempts_lookup",
      dependsOn: ["bas_correction_answers_lookup"]
    },
    () => readRowsInBatches<AttemptRow>(
      input.db,
      "attempts",
      "attempt_id,set_id,set_title,correct_count,total_questions,time_spent_seconds,submitted_at,created_at",
      "attempt_id",
      uniqueQuestionIds(candidateAnswers
        .map((answer) => answer.attempt_id)
        .filter((attemptId) => !officialAttemptIds.has(attemptId)))
    )
  );
  const [questionResult, candidateAttemptResult] = await Promise.all([
    questionPromise,
    candidateAttemptPromise
  ]);
  const detailError = questionResult.error ?? candidateAttemptResult.error;
  if (detailError) {
    throw new Error(`Failed to load BAS wrong questions: ${detailError.message}`);
  }

  const questions = questionResult.data ?? [];
  const questionById = new Map(
    questions.map((question) => [String(question.question_id), question])
  );
  const computationStartedAt = performance.now();
  const correctionAttempts = (candidateAttemptResult.data ?? [])
    .map(normalizeAttemptRow)
    .filter(isWrongBookAttempt);
  const correctionAttemptIds = new Set(correctionAttempts.map((attempt) => attempt.attempt_id));
  const correctionAnswers = candidateAnswers.filter((answer) =>
    correctionAttemptIds.has(answer.attempt_id)
  );
  const allAttempts = [...officialAttempts, ...correctionAttempts];
  const allAnswers = [...officialAnswers, ...correctionAnswers];
  const attemptById = new Map(
    allAttempts.map((attempt) => [attempt.attempt_id, attempt])
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
  const basGroupsBySet = new Map(sourceSetIds.map((setId) => [setId, {
    groupId: input.groupId,
    title: officialAttempts.find((attempt) => attempt.set_id === setId)?.set_title?.trim() || setId
  }]));
  const fallbackStart = startOfLocalDay().getTime();
  const requestedStart = Date.parse(input.todayStart ?? "");
  const requestedEnd = Date.parse(input.todayEnd ?? "");
  const todayStart = Number.isFinite(requestedStart) ? requestedStart : fallbackStart;
  const todayEnd = Number.isFinite(requestedEnd)
    ? requestedEnd
    : fallbackStart + 24 * 60 * 60 * 1000;
  const questionIds = buildBasWrongbookEntryQuestionIds({
    basAnswers: officialAnswers.map(normalizeAnswer),
    basAttempts: officialAttempts.map((attempt) => ({
      attemptId: attempt.attempt_id,
      correctCount: attempt.correct_count ?? 0,
      setId: attempt.set_id,
      setTitle: attempt.set_title?.trim() || attempt.set_id,
      submittedAt: attempt.submitted_at ?? attempt.created_at ?? null,
      timeSpentSeconds: attempt.time_spent_seconds ?? 0,
      totalQuestions: attempt.total_questions ?? 0
    })),
    basCorrectionAnswers: correctionAnswers
      .filter((answer) => Boolean(answer.is_correct))
      .map(normalizeAnswer),
    basGroupsBySet,
    groupId: input.groupId,
    todayEnd,
    todayStart
  });
  const selectedSet = new Set(questionIds);
  const orderById = new Map(questionIds.map((questionId, index) => [questionId, index]));
  const selectedQuestions = questions.filter((question) => selectedSet.has(question.question_id));
  const relevantWrongAnswers = allAnswers.filter((answer) =>
    !answer.is_correct && selectedSet.has(answer.question_id)
  );
  const latestWrongTime = relevantWrongAnswers.reduce(
    (latest, answer) => Math.max(latest, answerEventTime(answer, attemptById)),
    0
  );
  const latestByQuestion = new Map<string, AnswerRow>();
  for (const answer of allAnswers) {
    const existing = latestByQuestion.get(answer.question_id);
    if (!existing || questionTime(answer, attemptById) > questionTime(existing, attemptById)) {
      latestByQuestion.set(answer.question_id, answer);
    }
  }
  const normalizedQuestions = dedupeQuestionsByContent(
    selectedQuestions
      .map(normalizeQuestion)
      .sort((left, right) => {
        const orderCompare =
          (orderById.get(left.question_id) ?? 0) - (orderById.get(right.question_id) ?? 0);
        return orderCompare || left.question_order - right.question_order;
      }),
    orderById
  );
  const masteredQuestionCount = questionIds.filter(
    (questionId) => latestByQuestion.get(questionId)?.is_correct === true
  ).length;
  input.profile.record(
    "bas canonical/group computation",
    performance.now() - computationStartedAt,
    ["bas_candidate_attempts_lookup"],
    normalizedQuestions.length
  );
  const response = input.profile.measureSync(
    "bas response serialization",
    ["bas canonical/group computation"],
    () => NextResponse.json({
      count: normalizedQuestions.length,
      questions: normalizedQuestions,
      stats: {
        knowledgePointCount: new Set(normalizedQuestions.flatMap((question) =>
          parseGrammarTags(question.grammar_tags_text)
        )).size,
        latestWrongAt: latestWrongTime > 0 ? new Date(latestWrongTime).toISOString() : null,
        masteredQuestionCount,
        masteryRate: questionIds.length > 0
          ? Math.round((masteredQuestionCount / questionIds.length) * 100)
          : null,
        totalWrongOccurrences: relevantWrongAnswers.length
      }
    }, { headers: { "Cache-Control": "no-store" } }),
    () => normalizedQuestions.length
  );
  input.profile.record(
    "BAS entry total",
    performance.now() - entryStartedAt,
    ["student/account validation"],
    (sourceResult.data?.length ?? 0)
      + officialAttempts.length
      + officialAnswers.length
      + questions.length
      + candidateAnswers.length
      + (candidateAttemptResult.data?.length ?? 0)
  );
  return response;
}

function normalizeAttemptRow(attempt: AttemptRow): AttemptRow {
  return {
    ...attempt,
    attempt_id: String(attempt.attempt_id),
    set_id: String(attempt.set_id)
  };
}

function normalizeAnswerRow(answer: AnswerRow): AnswerRow {
  return {
    ...answer,
    attempt_answer_id: String(answer.attempt_answer_id),
    attempt_id: String(answer.attempt_id),
    question_id: String(answer.question_id)
  };
}

async function readAnswerRowsByAttemptIds(
  db: SupabaseClient,
  attemptIds: string[],
  questionIds?: string[]
) {
  if (attemptIds.length === 0 || questionIds?.length === 0) {
    return { data: [] as AnswerRow[], error: null };
  }
  const results = await mapWithConcurrency(chunkValues(attemptIds), 4, (ids) =>
    readAllSupabaseRows<AnswerRow>((from, to) => {
      let query = db
        .from("attempt_answers")
        .select("attempt_answer_id,attempt_id,question_id,is_correct,answered_at,created_at")
        .in("attempt_id", ids);
      if (questionIds) query = query.in("question_id", questionIds);
      return query.order("attempt_answer_id", { ascending: true }).range(from, to);
    })
  );
  const error = results.find((result) => result.error)?.error ?? null;
  return { data: error ? null : results.flatMap((result) => result.data ?? []), error };
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
  searchParams: URLSearchParams,
  profile: ServerDebugTrace
) {
  const timing = createStudentPerformanceTrace("/api/wrong-questions?view=overview");
  const [basWrongbook, readingWrongbook, fullSetWrongbook] = await Promise.all([
    profile.measure(
      "BAS total",
      ["student/account validation"],
      () => loadBasWrongbookOverviewData(db, studentId, timing, profile),
      (value) => Object.values(value.rows).reduce((sum, rows) => sum + rows, 0)
    ),
    profile.measure(
      "ordinary Reading total",
      ["student/account validation"],
      () => timing.measure("database", "wrongbook_overview_reading", () =>
        loadOverviewReadingWrongbookData(db, studentId, profile)
      ),
      (value) => value.readingAnswers.length + value.readingAttempts.length
        + value.readingCorrectionAnswers.length + value.readingCorrectionAttempts.length
        + value.readingTitles.size
    ),
    profile.measure(
      "Full Set total",
      ["student/account validation"],
      () => timing.measure("database", "wrongbook_overview_full_set", () =>
        loadOverviewFullSetWrongbookData(db, studentId, profile)
      ),
      (value) => value.fullSetAnswers.length + value.fullSetAttempts.length
        + value.fullSetCorrectionAnswers.length + value.fullSetCorrectionAttempts.length
    )
  ]);

  const requestedStart = Date.parse(searchParams.get("todayStart") ?? "");
  const requestedEnd = Date.parse(searchParams.get("todayEnd") ?? "");
  const fallbackStart = startOfLocalDay().getTime();
  const todayStart = Number.isFinite(requestedStart) ? requestedStart : fallbackStart;
  const todayEnd = Number.isFinite(requestedEnd)
    ? requestedEnd
    : fallbackStart + 24 * 60 * 60 * 1000;
  const payload = profile.measureSync(
    "final merge / JS aggregation / dedup",
    ["BAS total", "ordinary Reading total", "Full Set total"],
    () => timing.measureSync("processing", "wrongbook_overview_build_payload", () => buildWrongQuestionsOverview({
      ...basWrongbook.data,
      ...readingWrongbook,
      ...fullSetWrongbook,
      todayEnd,
      todayStart
    })),
    (value) => value.groups.length
  );
  console.info("[wrongbook-perf]", JSON.stringify({
    bas: {
      ...basWrongbook.rows
    },
    fullSet: {
      answers: fullSetWrongbook.fullSetAnswers.length,
      attempts: fullSetWrongbook.fullSetAttempts.length,
      correctionAnswers: fullSetWrongbook.fullSetCorrectionAnswers.length,
      correctionAttempts: fullSetWrongbook.fullSetCorrectionAttempts.length
    },
    output: {
      groups: payload.groups.length,
      payloadBytes: Buffer.byteLength(JSON.stringify(payload)),
      wrongQuestions: payload.stats.total
    },
    reading: {
      answers: readingWrongbook.readingAnswers.length,
      attempts: readingWrongbook.readingAttempts.length,
      correctionAnswers: readingWrongbook.readingCorrectionAnswers.length,
      correctionAttempts: readingWrongbook.readingCorrectionAttempts.length,
      titles: readingWrongbook.readingTitles.size
    }
  }));
  return profile.measureSync(
    "final serialization",
    ["final merge / JS aggregation / dedup"],
    () => NextResponse.json(payload, { headers: timing.finishHeaders() }),
    () => payload.groups.length
  );
}

function loadOverviewReadingWrongbookData(
  db: SupabaseClient,
  studentId: string,
  profile?: ServerDebugTrace
) {
  return profile
    ? loadReadingWrongbookData(db, studentId, {}, profile)
    : loadReadingWrongbookData(db, studentId);
}

function loadOverviewFullSetWrongbookData(
  db: SupabaseClient,
  studentId: string,
  profile?: ServerDebugTrace
) {
  return profile
    ? loadReadingFullSetWrongbookOverviewData(db, studentId, profile)
    : loadReadingFullSetWrongbookOverviewData(db, studentId);
}

async function loadBasWrongbookOverviewData(
  db: SupabaseClient,
  studentId: string,
  timing: StudentPerformanceTrace,
  profile: ServerDebugTrace
) {
  const attemptResult = await timing.measure(
    "database",
    "wrongbook_overview_bas_attempts",
    () => profileSupabaseQuery(
      { query: "overview_bas_attempts", dependsOn: ["student/account validation"] },
      () => readAllSupabaseRows<OverviewBasAttemptRow>((from, to) => db
        .from("attempts")
        .select("attempt_id,set_id,set_title,correct_count,total_questions,time_spent_seconds,submitted_at,created_at")
        .eq("student_id", studentId)
        .order("attempt_id", { ascending: true })
        .range(from, to))
    )
  );
  if (attemptResult.error) {
    throw new Error(`Failed to load wrong-question overview: ${attemptResult.error.message}`);
  }

  const allAttempts = (attemptResult.data ?? []).map((attempt) => ({
    ...attempt,
    attempt_id: String(attempt.attempt_id),
    set_id: String(attempt.set_id).trim()
  }));
  const correctionAttemptIds = allAttempts
    .filter((attempt) => attempt.set_id.startsWith("wrongbook-"))
    .map((attempt) => attempt.attempt_id);
  const candidateSetIds = Array.from(new Set(allAttempts
    .filter((attempt) => !attempt.set_id.startsWith("wrongbook-"))
    .map((attempt) => attempt.set_id)));

  const wrongAnswerPromise = timing.measure("database", "wrongbook_overview_bas_wrong_answers", () =>
      profileSupabaseQuery(
        { query: "overview_bas_wrong_answers", dependsOn: ["overview_bas_attempts"] },
        () => readAllSupabaseRows<OverviewBasAnswerRow>((from, to) => db
          .from("attempt_answers")
          .select("attempt_answer_id,attempt_id,question_id,is_correct,answered_at,created_at")
          .eq("student_id", studentId)
          .eq("is_correct", false)
          .order("attempt_answer_id", { ascending: true })
          .range(from, to))
      )
    );
  const correctionAnswerPromise = timing.measure("database", "wrongbook_overview_bas_correction_answers", () =>
      profileSupabaseQuery(
        { query: "overview_bas_correction_answers", dependsOn: ["overview_bas_attempts"] },
        () => readBasCorrectionAnswers(db, correctionAttemptIds)
      )
    );
  const displayResolverPromise = timing.measure("database", "wrongbook_overview_bas_display", () =>
      loadBuildSentenceHistoricalPracticeDisplayResolver(db, candidateSetIds, undefined, profile)
    );
  const wrongAnswerResult = await wrongAnswerPromise;
  if (wrongAnswerResult.error) {
    await Promise.allSettled([correctionAnswerPromise, displayResolverPromise]);
    throw new Error(`Failed to load BAS wrong answers: ${wrongAnswerResult.error.message}`);
  }
  const questionPromise = timing.measure(
    "database",
    "wrongbook_overview_bas_questions",
    () => profileSupabaseQuery(
      {
        query: "overview_bas_questions",
        dependsOn: ["overview_bas_wrong_answers"]
      },
      () => readRowsInBatches<OverviewQuestionRow>(
        db,
        "questions",
        "question_id,set_id,question_order,final_sentence,grammar_tags_text",
        "question_id",
        uniqueQuestionIds((wrongAnswerResult.data ?? []).map((answer) => String(answer.question_id)))
      )
    )
  );
  const [correctionAnswerResult, displayResolver, questionResult] = await Promise.all([
    correctionAnswerPromise,
    displayResolverPromise,
    questionPromise
  ]);
  const answerError = correctionAnswerResult.error ?? questionResult.error;
  if (answerError) throw new Error(`Failed to load BAS wrong answers: ${answerError.message}`);

  const allAnswers = [
    ...(wrongAnswerResult.data ?? []),
    ...(correctionAnswerResult.data ?? [])
  ].map((answer) => ({
    ...answer,
    attempt_answer_id: String(answer.attempt_answer_id),
    attempt_id: String(answer.attempt_id),
    question_id: String(answer.question_id)
  }));
  const aggregationStartedAt = performance.now();
  const questions = questionResult.data ?? [];
  const questionById = new Map(
    questions.map((question) => [String(question.question_id), question])
  );
  const realSetIds = new Set(questions.map((question) => String(question.set_id)));
  const officialAttempts = allAttempts.filter((attempt) =>
    isOfficialPracticeSetId(attempt.set_id, realSetIds)
  );
  const officialAttemptIds = new Set(officialAttempts.map((attempt) => attempt.attempt_id));
  const correctionAttemptIdSet = new Set(correctionAttemptIds);
  const attemptById = new Map(allAttempts.map((attempt) => [attempt.attempt_id, attempt]));
  const normalizeAnswer = (answer: OverviewBasAnswerRow): PracticeHistoryAnswer => {
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
  const basSetIds = Array.from(new Set(officialAttempts.map((attempt) => attempt.set_id)));
  const result = {
    data: {
      basAnswers: allAnswers
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
      basCorrectionAnswers: allAnswers
        .filter((answer) => correctionAttemptIdSet.has(answer.attempt_id) && Boolean(answer.is_correct))
        .map(normalizeAnswer),
      basGroupsBySet: new Map(basSetIds.map((setId) => {
        const attempt = officialAttempts.find((candidate) => candidate.set_id === setId);
        const display = displayResolver.resolveBuildSentence({
          fallbackDisplayName: attempt?.set_title?.trim() || setId,
          rawSetId: setId
        });
        return [setId, {
          groupId: display.itemId ?? setId,
          title: display.displayName
        }];
      }))
    },
    rows: {
      attempts: allAttempts.length,
      correctionAnswers: correctionAnswerResult.data?.length ?? 0,
      questions: questions.length,
      wrongAnswers: wrongAnswerResult.data?.length ?? 0
    }
  };
  profile.record(
    "BAS JS aggregation / dedup",
    performance.now() - aggregationStartedAt,
    ["overview_bas_questions", "overview_bas_display"],
    result.data.basAnswers.length + result.data.basAttempts.length + result.data.basCorrectionAnswers.length
  );
  return result;
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
