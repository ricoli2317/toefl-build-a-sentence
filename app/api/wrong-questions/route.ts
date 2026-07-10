import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { bearerToken } from "@/lib/auth";

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
      .select("role")
      .eq("id", user.id)
      .single();

    if (profileError || profile?.role !== "student") {
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
        .select("attempt_id,question_id,is_correct")
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

    if (selectedIds.length === 0) {
      return NextResponse.json({ count: 0, questions: [] });
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
      questions: normalizedQuestions
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
