import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { bearerToken } from "@/lib/auth";
import { normalizeChunkForCompare, splitTextItems } from "@/lib/questionText";
import { loadResultPeerComparison } from "@/lib/resultPeerComparison.server";
import { isVirtualPracticeSetId } from "@/lib/studentNavigation";
import {
  createStudentPerformanceTrace,
  type StudentPerformanceTrace
} from "@/lib/studentPerformance.server";

export const dynamic = "force-dynamic";

type SubmittedAnswer = {
  questionId: string;
  submittedOrderText: string;
  question_time_seconds?: number;
  questionTimeSeconds?: number;
};

type QuestionForScoring = {
  question_id: string;
  set_id: string;
  set_title: string;
  question_order: number;
  prompt: string;
  sentence_template: string;
  options_text: string;
  correct_order_text: string;
  final_sentence: string;
  grammar_tags_text: string | null;
};

function submissionJson(
  data: unknown,
  init?: ResponseInit,
  timing?: StudentPerformanceTrace
) {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return NextResponse.json(data, {
    ...init,
    headers: timing ? timing.finishHeaders(headers) : headers
  });
}

function isCorrectOrder(submittedOrderText: string, correctOrderText: string) {
  const submitted = splitTextItems(submittedOrderText);
  const correct = splitTextItems(correctOrderText);

  return (
    submitted.length === correct.length &&
    submitted.every(
      (item, index) =>
        normalizeChunkForCompare(item) === normalizeChunkForCompare(correct[index] ?? "")
    )
  );
}

function safeQuestionTimeSeconds(answer: SubmittedAnswer | undefined) {
  const value = answer?.question_time_seconds ?? answer?.questionTimeSeconds ?? 0;
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

export async function POST(request: Request) {
  const timing = createStudentPerformanceTrace("/api/submissions");
  const respond = (data: unknown, init?: ResponseInit) => submissionJson(data, init, timing);
  const fail = (message: string, status = 500) => respond({ error: message }, { status });
  try {
    const token = bearerToken(request);
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      return fail("Missing Supabase environment variables.");
    }

    if (!token) {
      return fail("Missing access token", 401);
    }

    const authClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false },
      global: {
        headers: { Authorization: `Bearer ${token}` },
        fetch: (input, init) => fetch(input, { ...init, cache: "no-store" })
      }
    });

    const {
      data: { user },
      error: userError
    } = await timing.measure("auth", "supabase_auth_get_user", () =>
      authClient.auth.getUser(token)
    );

    if (userError || !user) {
      return fail(userError?.message ?? "Invalid session", 401);
    }

    const { data: profile, error: profileError } = await timing.measure(
      "database",
      "profiles_role",
      () => authClient.from("profiles").select("role").eq("id", user.id).single()
    );

    if (profileError || profile?.role !== "student") {
      return fail(profileError?.message ?? "Unauthorized", 401);
    }

    const body = await timing.measure("processing", "parse_submission_payload", () =>
      request.json() as Promise<{
        setId?: string;
        setTitle?: string;
        questionIds?: string[];
        answers?: SubmittedAnswer[];
        timeSpentSeconds?: number;
      }>
    );

    if (!body.setId || !Array.isArray(body.answers)) {
      return fail("Invalid submission payload", 400);
    }

    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const db = createClient(supabaseUrl, serviceRoleKey || supabaseAnonKey, {
      auth: { persistSession: false },
      global: {
        headers: serviceRoleKey ? {} : { Authorization: `Bearer ${token}` },
        fetch: (input, init) => fetch(input, { ...init, cache: "no-store" })
      }
    });

    const questionIds = Array.isArray(body.questionIds)
      ? body.questionIds.map((questionId) => String(questionId)).filter(Boolean)
      : [];
    const questionQuery = db
      .from("questions")
      .select(
        "question_id,set_id,set_title,question_order,prompt,sentence_template,options_text,correct_order_text,final_sentence,grammar_tags_text"
      );
    const { data: questions, error: questionsError } = await timing.measure(
      "database",
      "questions_with_correct_answers",
      () =>
        questionIds.length > 0
          ? questionQuery.in("question_id", questionIds)
          : questionQuery.eq("set_id", body.setId!).order("question_order", { ascending: true })
    );

    if (questionsError) {
      return fail(`Failed to read questions: ${questionsError.message}`);
    }

    const questionRows = timing.measureSync("processing", "order_submission_questions", () => {
      const questionOrder = new Map(questionIds.map((questionId, index) => [questionId, index]));
      return ((questions ?? []) as QuestionForScoring[]).sort((left, right) => {
        if (questionIds.length > 0) {
          return (
            (questionOrder.get(String(left.question_id)) ?? 0) -
            (questionOrder.get(String(right.question_id)) ?? 0)
          );
        }

        return left.question_order - right.question_order;
      });
    });
    if (questionRows.length === 0) {
      return fail("No questions found for this set.", 404);
    }

    const usesExplicitQuestionOrder = questionIds.length > 0;
    const results = timing.measureSync("processing", "compare_submission_answers", () => {
      const answerByQuestion = new Map(
        body.answers!.map((answer) => [String(answer.questionId), answer])
      );
      return questionRows.map((question, index) => {
        const questionId = String(question.question_id);
        const submittedAnswer = answerByQuestion.get(questionId);
        const submittedOrderText = submittedAnswer?.submittedOrderText ?? "";
        return {
          questionId,
          displayQuestionOrder: usesExplicitQuestionOrder ? index + 1 : question.question_order,
          submittedOrderText,
          questionTimeSeconds: safeQuestionTimeSeconds(submittedAnswer),
          correctOrderText: question.correct_order_text,
          isCorrect: isCorrectOrder(submittedOrderText, question.correct_order_text),
          question
        };
      });
    });

    const summary = timing.measureSync("processing", "calculate_submission_summary", () => {
      const correctCount = results.filter((item) => item.isCorrect).length;
      const totalQuestions = questionRows.length;
      return {
        correctCount,
        totalQuestions,
        accuracy: totalQuestions === 0 ? 0 : correctCount / totalQuestions,
        timeSpentSeconds:
          Number.isFinite(body.timeSpentSeconds) && body.timeSpentSeconds
            ? Math.max(0, Math.round(body.timeSpentSeconds))
            : 0,
        setTitle: body.setTitle ?? questionRows[0]?.set_title ?? body.setId,
        submittedAt: new Date().toISOString()
      };
    });
    const { accuracy, correctCount, setTitle, submittedAt, timeSpentSeconds, totalQuestions } = summary;

    const { data: attempt, error: attemptError } = await timing.measure(
      "database",
      "attempts_insert",
      () =>
        db
          .from("attempts")
          .insert({
            student_id: user.id,
            set_id: String(body.setId),
            set_title: setTitle,
            correct_count: correctCount,
            total_questions: totalQuestions,
            time_spent_seconds: timeSpentSeconds,
            submitted_at: submittedAt
          })
          .select("attempt_id")
          .single()
    );

    if (attemptError || !attempt) {
      return fail(`Failed to save attempt: ${attemptError?.message ?? "No attempt returned"}`);
    }

    const answerRows = timing.measureSync("processing", "build_attempt_answer_rows", () =>
      results.map((result) => ({
        attempt_id: attempt.attempt_id,
        question_id: String(result.questionId),
        student_id: user.id,
        set_id: String(result.question.set_id),
        question_order: result.displayQuestionOrder,
        prompt: result.question.prompt,
        submitted_order_text: result.submittedOrderText,
        correct_order_text: result.correctOrderText,
        is_correct: result.isCorrect,
        question_time_seconds: result.questionTimeSeconds,
        grammar_tags_text: result.question.grammar_tags_text
      }))
    );

    const { error: answerError } = await timing.measure(
      "database",
      "attempt_answers_insert",
      () => db.from("attempt_answers").insert(answerRows)
    );

    if (answerError) {
      const { error: cleanupError } = await timing.measure(
        "database",
        "attempts_cleanup_delete",
        () =>
          db
            .from("attempts")
            .delete()
            .eq("attempt_id", attempt.attempt_id)
            .eq("student_id", user.id)
      );
      const cleanupMessage = cleanupError
        ? ` Cleanup of the incomplete attempt also failed: ${cleanupError.message}`
        : " The incomplete attempt was removed.";

      return fail(`Failed to save attempt answers: ${answerError.message}.${cleanupMessage}`);
    }

    const normalizedSetId = String(body.setId);
    const comparableOfficialSet =
      !isVirtualPracticeSetId(normalizedSetId) &&
      questionRows.every((question) => String(question.set_id) === normalizedSetId);
    const peerComparison = await loadResultPeerComparison({
      comparable: comparableOfficialSet,
      currentAttempt: {
        attemptId: String(attempt.attempt_id),
        correctCount,
        totalQuestions,
        timeSpentSeconds
      },
      db,
      setId: normalizedSetId,
      studentId: user.id,
      timing
    });

    const payload = timing.measureSync("processing", "build_submission_response", () => ({
        attemptId: attempt.attempt_id,
        correctCount,
        total: totalQuestions,
        accuracy,
        timeSpentSeconds,
        peer_comparison: peerComparison,
        attempt: {
          attempt_id: attempt.attempt_id,
          set_id: String(body.setId),
          set_title: setTitle,
          correct_count: correctCount,
          total_questions: totalQuestions,
          accuracy,
          time_spent_seconds: timeSpentSeconds,
          submitted_at: submittedAt
        },
        total_count: totalQuestions,
        correct_count: correctCount,
        time_spent_seconds: timeSpentSeconds,
        answers: results.map((result) => ({
          attempt_answer_id: `${attempt.attempt_id}-${result.questionId}`,
          question_id: String(result.questionId),
          question_order: result.displayQuestionOrder,
          prompt: result.question.prompt,
          submitted_order_text: result.submittedOrderText,
          correct_order_text: result.correctOrderText,
          sentence_template: result.question.sentence_template,
          options_text: result.question.options_text,
          final_sentence: result.question.final_sentence,
          is_correct: result.isCorrect,
          grammar_tags_text: result.question.grammar_tags_text,
          question_time_seconds: result.questionTimeSeconds
        })),
        results: results.map(({ questionId, submittedOrderText, isCorrect }) => ({
          questionId,
          submittedOrderText,
          isCorrect
        }))
      }));
    return respond(payload);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Submit failed.");
  }
}
