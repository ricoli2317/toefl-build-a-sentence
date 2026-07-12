import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { bearerToken } from "@/lib/auth";

type AttemptRow = {
  attempt_id: string;
  student_id: string;
  set_id: string;
  set_title: string;
  correct_count: number;
  total_questions: number;
  time_spent_seconds: number;
  submitted_at: string;
};

type AnswerRow = {
  attempt_answer_id: string;
  question_id: string;
  question_order: number;
  prompt: string;
  submitted_order_text: string;
  correct_order_text: string;
  is_correct: boolean;
  grammar_tags_text: string | null;
};

type QuestionRow = {
  question_id: string;
  sentence_template: string;
  final_sentence: string;
};

function jsonError(message: string, status = 500) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(
  request: Request,
  { params }: { params: { attemptId: string } }
) {
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

    const { data: attempt, error: attemptError } = await db
      .from("attempts")
      .select(
        "attempt_id,student_id,set_id,set_title,correct_count,total_questions,time_spent_seconds,submitted_at"
      )
      .eq("attempt_id", params.attemptId)
      .eq("student_id", user.id)
      .single();

    if (attemptError || !attempt) {
      return jsonError(
        `Failed to read attempt: ${attemptError?.message ?? "Attempt not found"}`,
        404
      );
    }

    const attemptRow = attempt as AttemptRow;
    const { data: answers, error: answersError } = await db
      .from("attempt_answers")
      .select(
        "attempt_answer_id,question_id,question_order,prompt,submitted_order_text,correct_order_text,is_correct,grammar_tags_text"
      )
      .eq("attempt_id", params.attemptId)
      .order("question_order", { ascending: true });

    if (answersError) {
      return jsonError(`Failed to read attempt answers: ${answersError.message}`);
    }

    const answerRows = (answers ?? []) as AnswerRow[];
    const questionIds = answerRows.map((answer) => String(answer.question_id));
    const { data: questions, error: questionsError } =
      questionIds.length > 0
        ? await db
            .from("questions")
            .select("question_id,sentence_template,final_sentence")
            .in("question_id", questionIds)
        : { data: [], error: null };

    if (questionsError) {
      return jsonError(`Failed to read final sentences: ${questionsError.message}`);
    }

    const finalSentenceByQuestion = new Map(
      ((questions ?? []) as QuestionRow[]).map((question) => [
        String(question.question_id),
        question.final_sentence
      ])
    );
    const sentenceTemplateByQuestion = new Map(
      ((questions ?? []) as QuestionRow[]).map((question) => [
        String(question.question_id),
        question.sentence_template
      ])
    );

    const totalCount = attemptRow.total_questions;
    const correctCount = attemptRow.correct_count;
    const accuracy = totalCount === 0 ? 0 : correctCount / totalCount;

    return NextResponse.json({
      attempt: {
        ...attemptRow,
        accuracy
      },
      answers: answerRows.map((answer) => ({
        ...answer,
        question_id: String(answer.question_id),
        sentence_template: sentenceTemplateByQuestion.get(String(answer.question_id)) ?? "",
        final_sentence: finalSentenceByQuestion.get(String(answer.question_id)) ?? ""
      })),
      total_count: totalCount,
      correct_count: correctCount,
      accuracy
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not load result.");
  }
}
