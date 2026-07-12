import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { bearerToken } from "@/lib/auth";
import { getPreferredUserDisplayName } from "@/lib/userDisplayName";

type AttemptRow = {
  attempt_id: string;
  student_id: string;
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
  student_id: string;
  set_id: string;
  question_order: number | null;
  prompt: string | null;
  submitted_order_text: string | null;
  correct_order_text: string | null;
  is_correct: boolean | null;
  question_time_seconds: number | null;
};

type ProfileRow = {
  id: string;
  email: string | null;
  full_name: string | null;
  role: string | null;
};

type AuthUserRow = {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
};

type QuestionRow = {
  question_id: string;
  set_id: string;
  set_title: string | null;
  question_order: number | null;
  prompt: string | null;
  sentence_template: string | null;
  correct_order_text: string | null;
  final_sentence: string | null;
};

type SetSummary = {
  setId: string;
  setTitle: string;
  questionCount: number;
  totalAttemptCount: number;
  completedStudentCount: number;
  correctCount: number;
  totalQuestions: number;
  averageAccuracy: number;
};

type QuestionSummary = {
  questionId: string;
  setId: string;
  setTitle: string;
  questionOrder: number;
  prompt: string;
  sentenceTemplate: string;
  correctOrderText: string;
  finalSentence: string;
  answerCount: number;
  correctCount: number;
  accuracy: number;
};

function jsonError(message: string, status = 500) {
  return NextResponse.json({ error: message }, { status });
}

function ratio(correct: number, total: number) {
  return total === 0 ? 0 : correct / total;
}

function parseSetSortKey(setId: string) {
  const parts = setId.split("-");
  const datePart = Number(parts[1] ?? 0);
  const setNumber = Number(parts[2] ?? 1);

  return {
    datePart: Number.isFinite(datePart) ? datePart : 0,
    setNumber: Number.isFinite(setNumber) ? setNumber : 1
  };
}

function compareSetIds(a: string, b: string) {
  const ak = parseSetSortKey(a);
  const bk = parseSetSortKey(b);

  return ak.datePart - bk.datePart || ak.setNumber - bk.setNumber || a.localeCompare(b);
}

function submittedTime(attempt: AttemptRow) {
  return attempt.submitted_at ?? attempt.created_at ?? null;
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

    const { data: teacherProfile, error: profileError } = await authClient
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    if (profileError || teacherProfile?.role !== "teacher") {
      return jsonError(profileError?.message ?? "Unauthorized", 401);
    }

    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const db = createClient(supabaseUrl, serviceRoleKey || supabaseAnonKey, {
      auth: { persistSession: false },
      global: {
        headers: serviceRoleKey ? {} : { Authorization: `Bearer ${token}` }
      }
    });

    const [
      { data: attempts, error: attemptsError },
      { data: answers, error: answersError },
      { data: profiles, error: profilesError },
      { data: questions, error: questionsError }
    ] = await Promise.all([
      db
        .from("attempts")
        .select(
          "attempt_id,student_id,set_id,set_title,correct_count,total_questions,time_spent_seconds,submitted_at,created_at"
        ),
      db
        .from("attempt_answers")
        .select(
          "attempt_answer_id,attempt_id,question_id,student_id,set_id,question_order,prompt,submitted_order_text,correct_order_text,is_correct,question_time_seconds"
        ),
      db.from("profiles").select("id,email,full_name,role"),
      db
        .from("questions")
        .select(
          "question_id,set_id,set_title,question_order,prompt,sentence_template,correct_order_text,final_sentence"
        )
    ]);

    const queryError = attemptsError ?? answersError ?? profilesError ?? questionsError;
    if (queryError) {
      return jsonError(`Failed to load teacher stats: ${queryError.message}`);
    }

    const attemptRows = ((attempts ?? []) as AttemptRow[]).map((attempt) => ({
      ...attempt,
      attempt_id: String(attempt.attempt_id),
      student_id: String(attempt.student_id),
      set_id: String(attempt.set_id)
    }));
    const answerRows = ((answers ?? []) as AnswerRow[]).map((answer) => ({
      ...answer,
      attempt_answer_id: String(answer.attempt_answer_id),
      attempt_id: String(answer.attempt_id),
      student_id: String(answer.student_id),
      set_id: String(answer.set_id),
      question_id: String(answer.question_id)
    }));
    const profileRows = ((profiles ?? []) as ProfileRow[]).map((profile) => ({
      ...profile,
      id: String(profile.id)
    }));
    const authUserById = new Map<string, AuthUserRow>();
    if (serviceRoleKey) {
      const { data: authUsers, error: authUsersError } = await db.auth.admin.listUsers({
        page: 1,
        perPage: 1000
      });
      if (authUsersError) {
        console.error("Failed to load auth users for display names", authUsersError);
      } else {
        for (const authUser of authUsers.users as AuthUserRow[]) {
          authUserById.set(String(authUser.id), authUser);
        }
      }
    }
    const questionRows = ((questions ?? []) as QuestionRow[]).map((question) => ({
      ...question,
      question_id: String(question.question_id),
      set_id: String(question.set_id)
    }));

    const attemptById = new Map(attemptRows.map((attempt) => [attempt.attempt_id, attempt]));
    const questionById = new Map(questionRows.map((question) => [question.question_id, question]));
    const setTitles = new Map<string, string>();
    const questionsBySet = new Map<string, QuestionRow[]>();

    for (const question of questionRows) {
      const setTitle = question.set_title ?? question.set_id;
      setTitles.set(question.set_id, setTitle);
      const list = questionsBySet.get(question.set_id) ?? [];
      list.push(question);
      questionsBySet.set(question.set_id, list);
    }

    for (const attempt of attemptRows) {
      if (!setTitles.has(attempt.set_id)) {
        setTitles.set(attempt.set_id, attempt.set_title ?? attempt.set_id);
      }
    }

    const studentProfiles = profileRows.filter((profile) => profile.role === "student");
    const studentIds = new Set<string>([
      ...studentProfiles.map((profile) => profile.id),
      ...attemptRows.map((attempt) => attempt.student_id)
    ]);

    const studentSummaries = Array.from(studentIds).map((studentId) => {
      const profile = profileRows.find((item) => item.id === studentId);
      const authUser = authUserById.get(studentId);
      const studentEmail = authUser?.email ?? profile?.email ?? null;
      const studentDisplayName = getPreferredUserDisplayName({
        email: studentEmail,
        metadata: authUser?.user_metadata ?? null,
        profileFullName: profile?.full_name
      });
      const studentAttempts = attemptRows.filter((attempt) => attempt.student_id === studentId);
      const studentAnswers = answerRows.filter((answer) => answer.student_id === studentId);
      const uniqueAnsweredQuestions = new Set(
        studentAnswers.map((answer) => `${answer.set_id}::${answer.question_id}`)
      );
      const completedSets = new Set(studentAttempts.map((attempt) => attempt.set_id));
      const totalQuestions = studentAttempts.reduce(
        (sum, attempt) => sum + (attempt.total_questions ?? 0),
        0
      );
      const correctCount = studentAttempts.reduce(
        (sum, attempt) => sum + (attempt.correct_count ?? 0),
        0
      );

      return {
        studentId,
        studentEmail: studentEmail ?? "Unknown email",
        studentName: studentDisplayName,
        studentDisplayName,
        completedSetCount: completedSets.size,
        totalAttemptCount: studentAttempts.length,
        answeredQuestionCount: uniqueAnsweredQuestions.size,
        correctCount,
        averageAccuracy: ratio(correctCount, totalQuestions)
      };
    });

    const setSummaries = Array.from(setTitles.entries()).map(([setId, setTitle]) => {
      const setAttempts = attemptRows.filter((attempt) => attempt.set_id === setId);
      const questionCount = questionsBySet.get(setId)?.length ?? 0;
      const totalQuestions = setAttempts.reduce(
        (sum, attempt) => sum + (attempt.total_questions ?? 0),
        0
      );
      const correctCount = setAttempts.reduce(
        (sum, attempt) => sum + (attempt.correct_count ?? 0),
        0
      );

      return {
        setId,
        setTitle,
        questionCount,
        totalAttemptCount: setAttempts.length,
        completedStudentCount: new Set(setAttempts.map((attempt) => attempt.student_id)).size,
        correctCount,
        totalQuestions,
        averageAccuracy: ratio(correctCount, totalQuestions)
      };
    });

    const questionSummaries = questionRows.map((question) => {
      const relatedAnswers = answerRows.filter((answer) => answer.question_id === question.question_id);
      const correctCount = relatedAnswers.filter((answer) => answer.is_correct).length;
      const setTitle = question.set_title ?? setTitles.get(question.set_id) ?? question.set_id;

      return {
        questionId: question.question_id,
        setId: question.set_id,
        setTitle,
        questionOrder: question.question_order ?? 0,
        prompt: question.prompt ?? "",
        sentenceTemplate: question.sentence_template ?? "",
        correctOrderText: question.correct_order_text ?? "",
        finalSentence: question.final_sentence ?? "",
        answerCount: relatedAnswers.length,
        correctCount,
        accuracy: ratio(correctCount, relatedAnswers.length)
      };
    });

    const totalQuestions = attemptRows.reduce(
      (sum, attempt) => sum + (attempt.total_questions ?? 0),
      0
    );
    const correctCount = attemptRows.reduce(
      (sum, attempt) => sum + (attempt.correct_count ?? 0),
      0
    );

    return NextResponse.json({
      overview: {
        studentCount: studentSummaries.length,
        totalAttemptCount: attemptRows.length,
        answeredQuestionCount: answerRows.length,
        averageAccuracy: ratio(correctCount, totalQuestions)
      },
      students: studentSummaries.sort((a, b) => a.studentDisplayName.localeCompare(b.studentDisplayName)),
      sets: setSummaries.sort((a, b) => compareSetIds(a.setId, b.setId)),
      attempts: attemptRows
        .map((attempt) => ({
          attemptId: attempt.attempt_id,
          studentId: attempt.student_id,
          setId: attempt.set_id,
          setTitle: attempt.set_title ?? setTitles.get(attempt.set_id) ?? attempt.set_id,
          correctCount: attempt.correct_count ?? 0,
          totalQuestions: attempt.total_questions ?? 0,
          accuracy: ratio(attempt.correct_count ?? 0, attempt.total_questions ?? 0),
          timeSpentSeconds: attempt.time_spent_seconds ?? 0,
          submittedAt: submittedTime(attempt)
        }))
        .sort((a, b) => {
          const left = new Date(a.submittedAt ?? 0).getTime();
          const right = new Date(b.submittedAt ?? 0).getTime();
          return right - left;
        }),
      answers: answerRows
        .map((answer) => {
          const question = questionById.get(answer.question_id);
          const attempt = attemptById.get(answer.attempt_id);
          return {
            attemptAnswerId: answer.attempt_answer_id,
            attemptId: answer.attempt_id,
            studentId: answer.student_id,
            setId: answer.set_id,
            setTitle:
              question?.set_title ??
              attempt?.set_title ??
              setTitles.get(answer.set_id) ??
              answer.set_id,
            questionId: answer.question_id,
            questionOrder: answer.question_order ?? question?.question_order ?? 0,
            prompt: answer.prompt ?? question?.prompt ?? "",
            sentenceTemplate: question?.sentence_template ?? "",
            finalSentence: question?.final_sentence ?? "",
            submittedOrderText: answer.submitted_order_text ?? "",
            correctOrderText: answer.correct_order_text ?? "",
            isCorrect: Boolean(answer.is_correct),
            questionTimeSeconds: answer.question_time_seconds
          };
        })
        .sort((a, b) => a.questionOrder - b.questionOrder),
      questions: questionSummaries.sort(
        (a, b) => compareSetIds(a.setId, b.setId) || a.questionOrder - b.questionOrder
      ),
      setQuestionStats: questionSummaries.reduce<Record<string, QuestionSummary[]>>(
        (groups, question) => {
          groups[question.setId] = [...(groups[question.setId] ?? []), question];
          return groups;
        },
        {}
      ),
      setStats: setSummaries
        .map((set): SetSummary => set)
        .sort((a, b) => compareSetIds(a.setId, b.setId))
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not load teacher stats.");
  }
}
