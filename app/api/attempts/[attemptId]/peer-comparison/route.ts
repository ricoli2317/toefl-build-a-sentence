import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { loadResultPeerComparison } from "@/lib/resultPeerComparison.server";
import { isVirtualPracticeSetId } from "@/lib/studentNavigation";
import { createStudentPerformanceTrace } from "@/lib/studentPerformance.server";

export const dynamic = "force-dynamic";

type AttemptRow = {
  attempt_id: string;
  set_id: string;
  correct_count: number;
  total_questions: number;
  time_spent_seconds: number;
};

type AttemptAnswerRow = { question_id: string };
type QuestionRow = { question_id: string; set_id: string };

export async function GET(
  request: Request,
  { params }: { params: { attemptId: string } }
) {
  const timing = createStudentPerformanceTrace("/api/attempts/[attemptId]/peer-comparison");
  const respond = (data: unknown, init?: ResponseInit) => {
    const headers = new Headers(init?.headers);
    headers.set("Cache-Control", "no-store");
    return NextResponse.json(data, { ...init, headers: timing.finishHeaders(headers) });
  };

  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseAnonKey) {
      return respond({ error: "Missing Supabase environment variables." }, { status: 500 });
    }

    const auth = await requireUserWithRole(bearerToken(request), "student", timing);
    if (auth.error || !auth.userId) {
      return respond({ error: auth.error ?? "Unauthorized" }, { status: 401 });
    }

    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const db = createClient(supabaseUrl, serviceRoleKey || supabaseAnonKey, {
      auth: { persistSession: false },
      global: {
        headers: serviceRoleKey ? {} : { Authorization: request.headers.get("authorization") ?? "" },
        fetch: (input, init) => fetch(input, { ...init, cache: "no-store" })
      }
    });

    const { data: attempt, error: attemptError } = await timing.measure(
      "database",
      "attempt_for_peer_comparison",
      () =>
        db
          .from("attempts")
          .select("attempt_id,set_id,correct_count,total_questions,time_spent_seconds")
          .eq("attempt_id", params.attemptId)
          .eq("student_id", auth.userId!)
          .single()
    );
    if (attemptError || !attempt) {
      return respond(
        { error: `Failed to read attempt: ${attemptError?.message ?? "Attempt not found"}` },
        { status: 404 }
      );
    }
    const attemptRow = attempt as AttemptRow;

    const { data: answers, error: answersError } = await timing.measure(
      "database",
      "attempt_answers_for_peer_comparison",
      () =>
        db
          .from("attempt_answers")
          .select("question_id")
          .eq("attempt_id", attemptRow.attempt_id)
          .order("question_order", { ascending: true })
    );
    if (answersError) {
      return respond({ error: `Failed to read attempt answers: ${answersError.message}` }, { status: 500 });
    }
    const questionIds = (answers ?? []).map((answer) => String((answer as AttemptAnswerRow).question_id));
    const { data: questions, error: questionsError } = questionIds.length > 0
      ? await timing.measure("database", "questions_for_peer_comparison", () =>
          db.from("questions").select("question_id,set_id").in("question_id", questionIds)
        )
      : { data: [], error: null };
    if (questionsError) {
      return respond({ error: `Failed to read current questions: ${questionsError.message}` }, { status: 500 });
    }
    const questionRows = (questions ?? []) as QuestionRow[];
    const comparable =
      !isVirtualPracticeSetId(attemptRow.set_id) &&
      questionRows.length > 0 &&
      questionRows.every((question) => String(question.set_id) === attemptRow.set_id);
    const peerComparison = await loadResultPeerComparison({
      comparable,
      currentAttempt: {
        attemptId: attemptRow.attempt_id,
        correctCount: attemptRow.correct_count,
        totalQuestions: attemptRow.total_questions,
        timeSpentSeconds: attemptRow.time_spent_seconds
      },
      db,
      setId: attemptRow.set_id,
      studentId: auth.userId,
      timing
    });

    return respond({ peer_comparison: peerComparison });
  } catch (error) {
    return respond(
      { error: error instanceof Error ? error.message : "Could not load peer comparison." },
      { status: 500 }
    );
  }
}
