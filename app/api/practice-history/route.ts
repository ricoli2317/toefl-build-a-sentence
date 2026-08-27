import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { bearerToken } from "@/lib/auth";
import {
  buildPracticeHistoryPayload,
  isOfficialPracticeSetId,
  isVirtualSetId
} from "@/lib/practiceHistory";
import { readAllSupabaseRows } from "@/lib/supabasePagination";
import {
  enrichBuildSentenceHistoricalAttempts,
  loadBuildSentenceHistoricalPracticeDisplayResolver
} from "@/lib/historicalPracticeDisplay";
import { createStudentPerformanceTrace } from "@/lib/studentPerformance.server";

type AttemptRow = {
  attempt_id: string;
  set_id: string;
  set_title: string | null;
  correct_count: number | null;
  total_questions: number | null;
  time_spent_seconds: number | null;
  submitted_at: string | null;
  created_at: string | null;
};

type AnswerRow = {
  attempt_answer_id: string;
  attempt_id: string;
  question_id: string;
  question_order: number | null;
  prompt: string | null;
  submitted_order_text: string | null;
  is_correct: boolean | null;
  question_time_seconds: number | null;
  answered_at: string | null;
  created_at: string | null;
};

type QuestionRow = {
  question_id: string;
  question_order: number | null;
  prompt: string | null;
  sentence_template: string | null;
  options_text: string | null;
  final_sentence: string | null;
  grammar_tags_text: string | null;
};

type QuestionSetRow = {
  set_id: string;
};

export const dynamic = "force-dynamic";

function json(
  data: unknown,
  init: ResponseInit | undefined,
  timing: ReturnType<typeof createStudentPerformanceTrace>
) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(data, {
    ...init,
    headers: timing.finishHeaders(headers)
  });
}

export async function GET(request: Request) {
  const timing = createStudentPerformanceTrace("/api/practice-history");
  const respond = (data: unknown, init?: ResponseInit) => json(data, init, timing);
  const respondError = (message: string, status = 500) =>
    respond({ error: message }, { status });
  try {
    const token = bearerToken(request);
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      return respondError("Missing Supabase environment variables.");
    }
    if (!token) return respondError("Missing access token", 401);

    const authClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } }
    });
    const {
      data: { user },
      error: userError
    } = await timing.measure("auth", "supabase_auth_get_user", () =>
      authClient.auth.getUser(token)
    );
    if (userError || !user) {
      return respondError(userError?.message ?? "Invalid session", 401);
    }

    const { data: profile, error: profileError } = await timing.measure(
      "database",
      "profiles_role",
      () => authClient.from("profiles").select("role,is_active").eq("id", user.id).single()
    );
    if (profileError || profile?.is_active === false || !["student", "admin"].includes(profile?.role ?? "")) {
      return respondError(profileError?.message ?? "Unauthorized", 401);
    }

    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const db = createClient(supabaseUrl, serviceRoleKey || supabaseAnonKey, {
      auth: { persistSession: false },
      global: {
        fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }),
        headers: serviceRoleKey ? {} : { Authorization: `Bearer ${token}` }
      }
    });

    const [attemptResult, answerResult] = await Promise.all([
      timing.measure("database", "attempts_student_history", () =>
        readAllSupabaseRows<AttemptRow>((from, to) =>
          db
            .from("attempts")
            .select(
              "attempt_id,set_id,set_title,correct_count,total_questions,time_spent_seconds,submitted_at,created_at"
            )
            .eq("student_id", user.id)
            .order("attempt_id", { ascending: true })
            .range(from, to)
        )
      ),
      timing.measure("database", "attempt_answers_student_history", () =>
        readAllSupabaseRows<AnswerRow>((from, to) =>
          db
            .from("attempt_answers")
            .select(
              "attempt_answer_id,attempt_id,question_id,question_order,prompt,submitted_order_text,is_correct,question_time_seconds,answered_at,created_at"
            )
            .eq("student_id", user.id)
            .order("attempt_answer_id", { ascending: true })
            .range(from, to)
        )
      )
    ]);
    const initialQueryError = attemptResult.error ?? answerResult.error;
    if (initialQueryError) {
      return respondError(`Failed to load practice history: ${initialQueryError.message}`);
    }

    const candidateSetIds = distinct(
      (attemptResult.data ?? []).flatMap((attempt) => {
        const setId = String(attempt.set_id).trim();
        return setId && !isVirtualSetId(setId) ? [setId] : [];
      })
    );
    const historyQuestionIds = distinct(
      (answerResult.data ?? []).map((answer) => String(answer.question_id))
    );
    // Detail rows only need questions referenced by this student's answers. The narrow
    // set lookup separately preserves official-set detection for attempts with no answers.
    const [questionResult, questionSetResult, historicalDisplayResolver] = await Promise.all([
      timing.measure("database", "questions_history_lookup", () =>
        loadHistoryQuestionRows(db, historyQuestionIds)
      ),
      timing.measure("database", "questions_history_set_lookup", () =>
        loadHistoryQuestionSetRows(db, candidateSetIds)
      ),
      loadBuildSentenceHistoricalPracticeDisplayResolver(db, candidateSetIds, timing)
    ]);
    const queryError = questionResult.error ?? questionSetResult.error;
    if (queryError) return respondError(`Failed to load practice history: ${queryError.message}`);

    const payload = timing.measureSync("processing", "build_practice_history_payload", () => {
    const questionRows = (questionResult.data ?? []).map((question) => ({
      ...question,
      question_id: String(question.question_id)
    }));
    const realSetIds = new Set(
      (questionSetResult.data ?? []).map((question) => String(question.set_id))
    );
    const questionById = new Map(
      questionRows.map((question) => [question.question_id, question])
    );
    const allAttempts = (attemptResult.data ?? [])
      .map((attempt) => ({
        ...attempt,
        attempt_id: String(attempt.attempt_id),
        set_id: String(attempt.set_id).trim()
      }));
    const attemptById = new Map(allAttempts.map((attempt) => [attempt.attempt_id, attempt]));
    const officialAttempts = allAttempts.filter((attempt) =>
      isOfficialPracticeSetId(attempt.set_id, realSetIds)
    );
    const officialAttemptIds = new Set(
      officialAttempts.map((attempt) => attempt.attempt_id)
    );
    const correctionAttemptIds = new Set(
      allAttempts
        .filter((attempt) => attempt.set_id.startsWith("wrongbook-"))
        .map((attempt) => attempt.attempt_id)
    );
    const attempts = enrichBuildSentenceHistoricalAttempts(
      officialAttempts.map((attempt) => ({
        attemptId: attempt.attempt_id,
        setId: attempt.set_id,
        setTitle: attempt.set_title?.trim() || attempt.set_id,
        correctCount: attempt.correct_count ?? 0,
        totalQuestions: attempt.total_questions ?? 0,
        timeSpentSeconds: attempt.time_spent_seconds ?? 0,
        submittedAt: attempt.submitted_at ?? attempt.created_at ?? null
      })),
      historicalDisplayResolver
    );
    const allAnswers = (answerResult.data ?? [])
      .map((answer) => ({
        ...answer,
        attempt_answer_id: String(answer.attempt_answer_id),
        attempt_id: String(answer.attempt_id),
        question_id: String(answer.question_id)
      }));
    const normalizeAnswer = (answer: (typeof allAnswers)[number]) => {
      const question = questionById.get(answer.question_id);
      const attempt = attemptById.get(answer.attempt_id);
      return {
        attemptAnswerId: answer.attempt_answer_id,
        attemptId: answer.attempt_id,
        questionId: answer.question_id,
        questionOrder: answer.question_order ?? question?.question_order ?? 0,
        prompt: question?.prompt ?? answer.prompt ?? "",
        sentenceTemplate: question?.sentence_template ?? "",
        optionsText: question?.options_text ?? "",
        finalSentence: question?.final_sentence ?? "",
        grammarTag: question?.grammar_tags_text ?? "",
        submittedOrderText: answer.submitted_order_text ?? "",
        isCorrect: Boolean(answer.is_correct),
        questionTimeSeconds: answer.question_time_seconds,
        answeredAt:
          answer.answered_at ??
          answer.created_at ??
          attempt?.submitted_at ??
          attempt?.created_at ??
          null
      };
    };
    const answers = allAnswers
      .filter((answer) => officialAttemptIds.has(answer.attempt_id))
      .map(normalizeAnswer);
    const correctionAnswers = allAnswers
      .filter(
        (answer) => correctionAttemptIds.has(answer.attempt_id) && Boolean(answer.is_correct)
      )
      .map(normalizeAnswer);

    const url = new URL(request.url);
    const requestedStart = Date.parse(url.searchParams.get("todayStart") ?? "");
    const requestedEnd = Date.parse(url.searchParams.get("todayEnd") ?? "");
    const fallbackStart = startOfServerLocalDay().getTime();
    const todayStart = Number.isFinite(requestedStart) ? requestedStart : fallbackStart;
    const todayEnd = Number.isFinite(requestedEnd)
      ? requestedEnd
      : fallbackStart + 24 * 60 * 60 * 1000;

    return buildPracticeHistoryPayload({
        answers,
        attempts,
        correctionAnswers,
        todayStart,
        todayEnd
      });
    });
    return respond(payload);
  } catch (error) {
    return respondError(error instanceof Error ? error.message : "Could not load practice history.");
  }
}

function loadHistoryQuestionRows(
  db: SupabaseClient,
  questionIds: string[]
) {
  return readRowsInBatches<QuestionRow>(questionIds, (batch, from, to) =>
    db
      .from("questions")
      .select(
        "question_id,question_order,prompt,sentence_template,options_text,final_sentence,grammar_tags_text"
      )
      .in("question_id", batch)
      .order("question_id", { ascending: true })
      .range(from, to)
  );
}

function loadHistoryQuestionSetRows(
  db: SupabaseClient,
  setIds: string[]
) {
  return readRowsInBatches<QuestionSetRow>(setIds, (batch, from, to) =>
    db
      .from("questions")
      .select("set_id")
      .in("set_id", batch)
      .order("set_id", { ascending: true })
      .range(from, to)
  );
}

async function readRowsInBatches<T>(
  values: string[],
  readPage: (
    batch: string[],
    from: number,
    to: number
  ) => PromiseLike<{
    data: T[] | null;
    error: { message: string } | null;
  }>
) {
  if (values.length === 0) {
    return { data: [] as T[], error: null };
  }
  const results = await Promise.all(
    chunkValues(values).map((batch) =>
      readAllSupabaseRows<T>((from, to) => readPage(batch, from, to))
    )
  );
  const error = results.find((result) => result.error)?.error ?? null;
  return {
    data: error ? null : results.flatMap((result) => result.data ?? []),
    error
  };
}

function chunkValues<T>(values: T[], size = 100) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function distinct(values: string[]) {
  return Array.from(new Set(values));
}

function startOfServerLocalDay() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}
