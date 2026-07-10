import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { bearerToken } from "@/lib/auth";
import { normalizeChunkForCompare, splitTextItems } from "@/lib/questionText";

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
  correct_order_text: string;
  final_sentence: string;
  grammar_tags_text: string | null;
};

function jsonError(message: string, status = 500) {
  return NextResponse.json({ error: message }, { status });
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

    const body = (await request.json()) as {
      setId?: string;
      setTitle?: string;
      questionIds?: string[];
      answers?: SubmittedAnswer[];
      timeSpentSeconds?: number;
    };

    if (!body.setId || !Array.isArray(body.answers)) {
      return jsonError("Invalid submission payload", 400);
    }

    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const db = createClient(supabaseUrl, serviceRoleKey || supabaseAnonKey, {
      auth: { persistSession: false },
      global: {
        headers: serviceRoleKey ? {} : { Authorization: `Bearer ${token}` }
      }
    });

    const questionIds = Array.isArray(body.questionIds)
      ? body.questionIds.map((questionId) => String(questionId)).filter(Boolean)
      : [];
    const questionQuery = db
      .from("questions")
      .select(
        "question_id,set_id,set_title,question_order,prompt,sentence_template,correct_order_text,final_sentence,grammar_tags_text"
      );
    const { data: questions, error: questionsError } =
      questionIds.length > 0
        ? await questionQuery.in("question_id", questionIds)
        : await questionQuery.eq("set_id", body.setId).order("question_order", { ascending: true });

    if (questionsError) {
      return jsonError(`Failed to read questions: ${questionsError.message}`);
    }

    const questionOrder = new Map(questionIds.map((questionId, index) => [questionId, index]));
    const questionRows = ((questions ?? []) as QuestionForScoring[]).sort((left, right) => {
      if (questionIds.length > 0) {
        return (
          (questionOrder.get(String(left.question_id)) ?? 0) -
          (questionOrder.get(String(right.question_id)) ?? 0)
        );
      }

      return left.question_order - right.question_order;
    });
    if (questionRows.length === 0) {
      return jsonError("No questions found for this set.", 404);
    }

    const answerByQuestion = new Map(
      body.answers.map((answer) => [String(answer.questionId), answer])
    );

    const usesExplicitQuestionOrder = questionIds.length > 0;
    const results = questionRows.map((question, index) => {
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

    const correctCount = results.filter((item) => item.isCorrect).length;
    const totalQuestions = questionRows.length;
    const accuracy = totalQuestions === 0 ? 0 : correctCount / totalQuestions;
    const timeSpentSeconds =
      Number.isFinite(body.timeSpentSeconds) && body.timeSpentSeconds
        ? Math.max(0, Math.round(body.timeSpentSeconds))
        : 0;
    const setTitle = body.setTitle ?? questionRows[0]?.set_title ?? body.setId;
    const submittedAt = new Date().toISOString();

    const { data: attempt, error: attemptError } = await db
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
      .single();

    if (attemptError || !attempt) {
      return jsonError(`Failed to save attempt: ${attemptError?.message ?? "No attempt returned"}`);
    }

    const answerRows = results.map((result) => ({
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
    }));

    const { error: answerError } = await db.from("attempt_answers").insert(answerRows);

    if (answerError) {
      return jsonError(`Failed to save attempt answers: ${answerError.message}`);
    }

    const resultAnswers = results.map((result) => ({
      attempt_answer_id: `${attempt.attempt_id}-${result.questionId}`,
      question_id: String(result.questionId),
      question_order: result.displayQuestionOrder,
      prompt: result.question.prompt,
      submitted_order_text: result.submittedOrderText,
      correct_order_text: result.correctOrderText,
      sentence_template: result.question.sentence_template,
      final_sentence: result.question.final_sentence,
      is_correct: result.isCorrect,
      grammar_tags_text: result.question.grammar_tags_text
    }));

    return NextResponse.json({
      attemptId: attempt.attempt_id,
      correctCount,
      total: totalQuestions,
      accuracy,
      timeSpentSeconds,
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
      answers: resultAnswers,
      results: results.map(({ questionId, submittedOrderText, isCorrect }) => ({
        questionId,
        submittedOrderText,
        isCorrect
      }))
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Submit failed.");
  }
}
