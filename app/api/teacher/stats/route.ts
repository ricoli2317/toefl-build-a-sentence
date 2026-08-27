import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { standardizeOrderTextCasing } from "@/lib/questionText";
import { getPreferredUserDisplayName } from "@/lib/userDisplayName";
import {
  buildTeacherLogicalSetSummaries,
  type TeacherLogicalPracticeItemRow,
  type TeacherLogicalPracticeOccurrenceRow,
  type TeacherLogicalPracticeSourceRow
} from "@/lib/teacherLogicalSetStats";
import {
  buildTeacherLogicalQuestionStats,
  type TeacherLogicalQuestionMapRow
} from "@/lib/teacherLogicalQuestionStats";
import {
  createHistoricalPracticeDisplayResolver,
  logHistoricalPracticeDisplayWarnings
} from "@/lib/historicalPracticeDisplay";
import { listVisibleStudentIds } from "@/lib/accountAccess";

export const dynamic = "force-dynamic";

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
  owner_id: string | null;
  is_active: boolean | null;
};

type QuestionRow = {
  question_id: string;
  set_id: string;
  set_title: string | null;
  question_order: number | null;
  prompt: string | null;
  sentence_template: string | null;
  options_text: string | null;
  correct_order_text: string | null;
  final_sentence: string | null;
};

type RawSetSummary = {
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

type PracticeType = "official" | "wrongbook-today" | "wrongbook-history";

const DATABASE_PAGE_SIZE = 500;

type PageError = { message: string };

async function fetchAllRows<T>(
  loadPage: (
    from: number,
    to: number
  ) => PromiseLike<{ data: unknown[] | null; error: PageError | null }>
) {
  const rows: T[] = [];

  for (let from = 0; ; from += DATABASE_PAGE_SIZE) {
    const { data, error } = await loadPage(from, from + DATABASE_PAGE_SIZE - 1);
    if (error) return { data: null, error };

    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < DATABASE_PAGE_SIZE) return { data: rows, error: null };
  }
}

async function fetchRowsForStudentIds<T>(
  studentIds: string[],
  loadPage: (
    batch: string[],
    from: number,
    to: number
  ) => PromiseLike<{ data: unknown[] | null; error: PageError | null }>
) {
  const rows: T[] = [];
  for (let index = 0; index < studentIds.length; index += 100) {
    const batch = studentIds.slice(index, index + 100);
    const result = await fetchAllRows<T>((from, to) => loadPage(batch, from, to));
    if (result.error) return { data: null, error: result.error };
    rows.push(...(result.data ?? []));
  }
  return { data: rows, error: null };
}

function jsonError(message: string, status = 500) {
  return teacherStatsJson({ error: message }, { status });
}

function teacherStatsJson(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });
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

function getPracticeType(setId: string): PracticeType {
  if (setId.startsWith("wrongbook-today-")) return "wrongbook-today";
  if (setId.startsWith("wrongbook-all-") || setId.startsWith("wrongbook-random-")) {
    return "wrongbook-history";
  }
  return "official";
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
        headers: { Authorization: `Bearer ${token}` },
        fetch: (input, init) => fetch(input, { ...init, cache: "no-store" })
      }
    });

    const {
      data: { user },
      error: userError
    } = await authClient.auth.getUser(token);

    if (userError || !user) {
      return jsonError(userError?.message ?? "Invalid session", 401);
    }

    const auth = await requireUserWithRole(token, "teacher");
    if (auth.error || !auth.userId || !auth.role) return jsonError(auth.error ?? "Unauthorized", 401);

    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const db = createClient(supabaseUrl, serviceRoleKey || supabaseAnonKey, {
      auth: { persistSession: false },
      global: {
        headers: serviceRoleKey ? {} : { Authorization: `Bearer ${token}` },
        fetch: (input, init) => fetch(input, { ...init, cache: "no-store" })
      }
    });
    const scopedStudentIds = await listVisibleStudentIds(db, {
      userId: auth.userId,
      role: auth.role
    });

    const [
      { data: attempts, error: attemptsError },
      { data: answers, error: answersError },
      { data: profiles, error: profilesError },
      { data: questions, error: questionsError },
      { data: logicalItems, error: logicalItemsError },
      { data: logicalSources, error: logicalSourcesError },
      { data: logicalOccurrences, error: logicalOccurrencesError },
      { data: logicalQuestionMaps, error: logicalQuestionMapsError }
    ] = await Promise.all([
      fetchRowsForStudentIds<AttemptRow>(scopedStudentIds, (batch, from, to) =>
        db
          .from("attempts")
          .select(
            "attempt_id,student_id,set_id,set_title,correct_count,total_questions,time_spent_seconds,submitted_at,created_at"
          )
          .in("student_id", batch)
          .order("attempt_id", { ascending: true })
          .range(from, to)
      ),
      fetchRowsForStudentIds<AnswerRow>(scopedStudentIds, (batch, from, to) =>
        db
          .from("attempt_answers")
          .select(
            "attempt_answer_id,attempt_id,question_id,student_id,set_id,question_order,prompt,submitted_order_text,correct_order_text,is_correct,question_time_seconds"
          )
          .in("student_id", batch)
          .order("attempt_answer_id", { ascending: true })
          .range(from, to)
      ),
      fetchRowsForStudentIds<ProfileRow>(scopedStudentIds, (batch, from, to) =>
        db
          .from("profiles")
          .select("id,email,full_name,role,owner_id,is_active")
          .in("id", batch)
          .order("id", { ascending: true })
          .range(from, to)
      ),
      fetchAllRows<QuestionRow>((from, to) =>
        db
          .from("questions")
          .select(
            "question_id,set_id,set_title,question_order,prompt,sentence_template,options_text,correct_order_text,final_sentence"
          )
          .order("question_id", { ascending: true })
          .range(from, to)
      ),
      fetchAllRows<TeacherLogicalPracticeItemRow>((from, to) =>
        db
          .from("practice_items")
          .select("item_id,task_type,display_number,first_seen_date,is_active")
          .eq("task_type", "build_sentence")
          .order("item_id", { ascending: true })
          .range(from, to)
      ),
      fetchAllRows<TeacherLogicalPracticeSourceRow>((from, to) =>
        db
          .from("practice_item_sources")
          .select("source_id,item_id,task_type,source_set_id,is_canonical")
          .eq("task_type", "build_sentence")
          .not("source_set_id", "is", null)
          .order("source_id", { ascending: true })
          .range(from, to)
      ),
      fetchAllRows<TeacherLogicalPracticeOccurrenceRow>((from, to) =>
        db
          .from("practice_item_occurrences")
          .select("source_id,occurred_on")
          .order("source_id", { ascending: true })
          .order("occurred_on", { ascending: false })
          .range(from, to)
      ),
      fetchAllRows<TeacherLogicalQuestionMapRow>((from, to) =>
        db
          .from("practice_item_question_map")
          .select("source_id,source_question_id,source_question_order,logical_question_order")
          .order("source_id", { ascending: true })
          .order("logical_question_order", { ascending: true })
          .range(from, to)
      )
    ]);

    const queryError = attemptsError ?? answersError ?? profilesError ?? questionsError ??
      logicalItemsError ?? logicalSourcesError ?? logicalOccurrencesError ?? logicalQuestionMapsError;
    if (queryError) {
      return jsonError(`Failed to load teacher stats: ${queryError.message}`);
    }

    const rawAttemptRows = ((attempts ?? []) as AttemptRow[]).map((attempt) => ({
      ...attempt,
      attempt_id: String(attempt.attempt_id),
      student_id: String(attempt.student_id),
      set_id: String(attempt.set_id)
    }));
    const rawAnswerRows = ((answers ?? []) as AnswerRow[]).map((answer) => ({
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
    const visibleStudentIds = new Set(
      profileRows
        .filter((profile) =>
          profile.role === "student" &&
          profile.is_active !== false &&
          (auth.role === "admin" || profile.owner_id === auth.userId)
        )
        .map((profile) => profile.id)
    );
    if (auth.role === "admin") visibleStudentIds.add(auth.userId);
    const attemptRows = rawAttemptRows.filter((attempt) => visibleStudentIds.has(attempt.student_id));
    const answerRows = rawAnswerRows.filter((answer) => visibleStudentIds.has(answer.student_id));
    const questionRows = ((questions ?? []) as QuestionRow[]).map((question) => ({
      ...question,
      question_id: String(question.question_id),
      set_id: String(question.set_id)
    }));
    const logicalItemRows = ((logicalItems ?? []) as TeacherLogicalPracticeItemRow[]).map(
      (item) => ({ ...item, item_id: String(item.item_id) })
    );
    const logicalSourceRows = ((logicalSources ?? []) as TeacherLogicalPracticeSourceRow[]).map(
      (source) => ({
        ...source,
        source_id: String(source.source_id),
        item_id: String(source.item_id),
        source_set_id: source.source_set_id === null ? null : String(source.source_set_id)
      })
    );
    const logicalOccurrenceRows = (
      (logicalOccurrences ?? []) as TeacherLogicalPracticeOccurrenceRow[]
    ).map((occurrence) => ({
      source_id: String(occurrence.source_id),
      occurred_on: String(occurrence.occurred_on)
    }));
    const logicalQuestionMapRows = (
      (logicalQuestionMaps ?? []) as TeacherLogicalQuestionMapRow[]
    ).map((mapping) => ({
      source_id: String(mapping.source_id),
      source_question_id: String(mapping.source_question_id),
      source_question_order: Number(mapping.source_question_order),
      logical_question_order: Number(mapping.logical_question_order)
    }));

    const attemptById = new Map(attemptRows.map((attempt) => [attempt.attempt_id, attempt]));
    const attemptIdsWithAnswers = new Set(answerRows.map((answer) => answer.attempt_id));
    const missingAnswerAttemptIds = attemptRows
      .filter((attempt) => !attemptIdsWithAnswers.has(attempt.attempt_id))
      .map((attempt) => attempt.attempt_id);
    const officialAttemptIds = new Set(
      attemptRows
        .filter((attempt) => getPracticeType(attempt.set_id) === "official")
        .map((attempt) => attempt.attempt_id)
    );
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

    const studentProfiles = profileRows.filter((profile) => visibleStudentIds.has(profile.id));
    const studentIds = new Set<string>(studentProfiles.map((profile) => profile.id));

    const studentSummaries = Array.from(studentIds).map((studentId) => {
      const profile = profileRows.find((item) => item.id === studentId);
      const studentEmail = profile?.email ?? null;
      const studentDisplayName = getPreferredUserDisplayName({
        email: studentEmail,
        profileFullName: profile?.full_name
      });
      const studentAttempts = attemptRows.filter((attempt) => attempt.student_id === studentId);
      const studentAnswers = answerRows.filter((answer) => answer.student_id === studentId);
      const uniqueAnsweredQuestions = new Set(
        studentAnswers.map((answer) => `${answer.set_id}::${answer.question_id}`)
      );
      const completedSets = new Set(
        studentAttempts
          .filter(
            (attempt) =>
              getPracticeType(attempt.set_id) === "official" && setTitles.has(attempt.set_id)
          )
          .map((attempt) => attempt.set_id)
      );
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

    const rawSetSummaries = Array.from(setTitles.entries()).map(([setId, setTitle]) => {
      const setAttempts = attemptRows.filter(
        (attempt) =>
          getPracticeType(attempt.set_id) === "official" && attempt.set_id === setId
      );
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
    const logicalSetSummaries = buildTeacherLogicalSetSummaries({
      items: logicalItemRows,
      sources: logicalSourceRows,
      occurrences: logicalOccurrenceRows,
      attempts: attemptRows,
      questions: questionRows
    });
    const logicalQuestionStats = buildTeacherLogicalQuestionStats({
      items: logicalItemRows,
      sources: logicalSourceRows,
      questionMaps: logicalQuestionMapRows,
      questions: questionRows,
      attempts: attemptRows,
      answers: answerRows
    });
    for (const warning of logicalQuestionStats.warnings) {
      console.warn("[teacher-logical-question-stats] mapping_warning", warning);
    }
    const historicalDisplayResolver = createHistoricalPracticeDisplayResolver({
      items: logicalItemRows.map((item) => ({
        ...item,
        task_type: "build_sentence" as const,
        display_title: null
      })),
      sources: logicalSourceRows.map((source) => ({
        ...source,
        task_type: "build_sentence" as const,
        source_question_id: null
      }))
    });
    const historicalDisplayBySetId = new Map(
      Array.from(new Set(attemptRows.map((attempt) => attempt.set_id))).map((setId) => {
        const fallbackDisplayName =
          attemptRows.find((attempt) => attempt.set_id === setId)?.set_title ??
          setTitles.get(setId) ??
          setId;
        return [
          setId,
          historicalDisplayResolver.resolveBuildSentence({
            fallbackDisplayName,
            rawSetId: setId
          })
        ] as const;
      })
    );
    logHistoricalPracticeDisplayWarnings(Array.from(historicalDisplayBySetId.values()));

    const questionSummaries = questionRows.map((question) => {
      const relatedAnswers = answerRows.filter(
        (answer) =>
          officialAttemptIds.has(answer.attempt_id) &&
          answer.question_id === question.question_id
      );
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

    return teacherStatsJson({
      overview: {
        studentCount: studentSummaries.length,
        totalAttemptCount: attemptRows.length,
        answeredQuestionCount: answerRows.length,
        averageAccuracy: ratio(correctCount, totalQuestions)
      },
      missingAnswerAttemptIds,
      students: studentSummaries.sort((a, b) => a.studentDisplayName.localeCompare(b.studentDisplayName)),
      sets: logicalSetSummaries,
      logicalQuestionStats: logicalQuestionStats.items,
      rawSets: rawSetSummaries.sort((a, b) => compareSetIds(a.setId, b.setId)),
      attempts: attemptRows
        .map((attempt) => ({
          attemptId: attempt.attempt_id,
          studentId: attempt.student_id,
          setId: attempt.set_id,
          setTitle:
            historicalDisplayBySetId.get(attempt.set_id)?.displayName ??
            attempt.set_title ??
            setTitles.get(attempt.set_id) ??
            attempt.set_id,
          practiceType: getPracticeType(attempt.set_id),
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
              historicalDisplayBySetId.get(attempt?.set_id ?? answer.set_id)?.displayName ??
              question?.set_title ??
              attempt?.set_title ??
              setTitles.get(answer.set_id) ??
              answer.set_id,
            questionId: answer.question_id,
            questionOrder: answer.question_order ?? question?.question_order ?? 0,
            prompt: question?.prompt ?? answer.prompt ?? "",
            sentenceTemplate: question?.sentence_template ?? "",
            optionsText: question?.options_text ?? "",
            finalSentence: question?.final_sentence ?? "",
            submittedOrderText: answer.submitted_order_text ?? "",
            displaySubmittedOrderText: standardizeOrderTextCasing(
              answer.submitted_order_text,
              question?.options_text,
              question?.correct_order_text
            ),
            correctOrderText: question?.correct_order_text ?? answer.correct_order_text ?? "",
            isCorrect: Boolean(answer.is_correct),
            practiceType: attempt ? getPracticeType(attempt.set_id) : "unknown",
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
      setStats: logicalSetSummaries,
      rawSetStats: rawSetSummaries
        .map((set): RawSetSummary => set)
        .sort((a, b) => compareSetIds(a.setId, b.setId))
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Could not load teacher stats.");
  }
}
