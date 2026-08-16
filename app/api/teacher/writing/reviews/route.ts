import { NextResponse } from "next/server";
import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { getPreferredUserDisplayName } from "@/lib/userDisplayName";
import { isWritingTaskType, type WritingTaskType } from "@/lib/writing";

export const dynamic = "force-dynamic";

type AttemptRow = {
  attempt_id: string;
  user_id: string;
  task_type: string;
  question_id: string;
  set_id: string;
  word_count: number | null;
  submitted_at: string | null;
};

type ProfileRow = {
  id: string;
  email: string | null;
  full_name: string | null;
};

type QuestionRow = {
  question_id: string;
  set_title: string | null;
};

type ReviewRow = {
  attempt_id: string;
  status: string | null;
};

type PageError = { message: string };
type ReviewListStatus = "pending" | "reviewing" | "published";

const QUERY_BATCH_SIZE = 100;

function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });
}

export async function GET(request: Request) {
  try {
    const auth = await requireUserWithRole(bearerToken(request), "teacher");
    if (auth.error || !auth.userId) {
      const status = auth.error === "Unauthorized" ? 403 : 401;
      return json(
        { code: "UNAUTHORIZED", message: auth.error ?? "Unauthorized" },
        { status }
      );
    }

    const requestedAttemptId = new URL(request.url).searchParams.get("attemptId")?.trim();
    const supabase = createServiceSupabase();
    const attemptsResult = await readAllSupabaseRows<AttemptRow>((from, to) => {
      let query = supabase
        .from("writing_attempts")
        .select(
          "attempt_id,user_id,task_type,question_id,set_id,word_count,submitted_at"
        )
        .eq("status", "submitted");
      if (requestedAttemptId) query = query.eq("attempt_id", requestedAttemptId);
      return query
        .order("submitted_at", { ascending: false, nullsFirst: false })
        .order("attempt_id", { ascending: false })
        .range(from, to);
    });

    if (attemptsResult.error) {
      return json(
        { code: "WRITING_REVIEWS_LOAD_FAILED", message: "无法加载写作提交。" },
        { status: 500 }
      );
    }

    const attempts = (attemptsResult.data ?? []).filter((attempt) =>
      isWritingTaskType(attempt.task_type)
    );
    if (attempts.length === 0) return json({ attempts: [] });

    const attemptIds = unique(attempts.map((attempt) => String(attempt.attempt_id)));
    const userIds = unique(attempts.map((attempt) => String(attempt.user_id)));
    const emailQuestionIds = unique(
      attempts
        .filter((attempt) => attempt.task_type === "email")
        .map((attempt) => String(attempt.question_id))
    );
    const discussionQuestionIds = unique(
      attempts
        .filter((attempt) => attempt.task_type === "academic_discussion")
        .map((attempt) => String(attempt.question_id))
    );

    const [profiles, emailQuestions, discussionQuestions, reviews] = await Promise.all([
      readRowsByIds<ProfileRow>(userIds, (batch, from, to) =>
        supabase
          .from("profiles")
          .select("id,email,full_name")
          .in("id", batch)
          .order("id", { ascending: true })
          .range(from, to)
      ),
      readRowsByIds<QuestionRow>(emailQuestionIds, (batch, from, to) =>
        supabase
          .from("email_questions")
          .select("question_id,set_title")
          .in("question_id", batch)
          .order("question_id", { ascending: true })
          .range(from, to)
      ),
      readRowsByIds<QuestionRow>(discussionQuestionIds, (batch, from, to) =>
        supabase
          .from("academic_discussion_questions")
          .select("question_id,set_title")
          .in("question_id", batch)
          .order("question_id", { ascending: true })
          .range(from, to)
      ),
      readRowsByIds<ReviewRow>(attemptIds, (batch, from, to) =>
        supabase
          .from("writing_reviews")
          .select("attempt_id,status")
          .in("attempt_id", batch)
          .order("attempt_id", { ascending: true })
          .range(from, to)
      )
    ]);

    const relatedError =
      profiles.error ?? emailQuestions.error ?? discussionQuestions.error ?? reviews.error;
    if (relatedError) {
      return json(
        { code: "WRITING_REVIEWS_LOAD_FAILED", message: "无法加载写作批改列表。" },
        { status: 500 }
      );
    }

    const profileById = new Map(
      (profiles.data ?? []).map((profile) => [String(profile.id), profile])
    );
    const emailQuestionById = new Map(
      (emailQuestions.data ?? []).map((question) => [String(question.question_id), question])
    );
    const discussionQuestionById = new Map(
      (discussionQuestions.data ?? []).map((question) => [
        String(question.question_id),
        question
      ])
    );
    const reviewByAttemptId = new Map(
      (reviews.data ?? []).map((review) => [String(review.attempt_id), review])
    );

    return json({
      attempts: attempts.map((attempt) => {
        const taskType = attempt.task_type as WritingTaskType;
        const profile = profileById.get(String(attempt.user_id));
        const question =
          taskType === "email"
            ? emailQuestionById.get(String(attempt.question_id))
            : discussionQuestionById.get(String(attempt.question_id));
        const review = reviewByAttemptId.get(String(attempt.attempt_id));

        return {
          attemptId: String(attempt.attempt_id),
          studentId: String(attempt.user_id),
          studentName: getPreferredUserDisplayName({
            email: profile?.email,
            profileFullName: profile?.full_name
          }),
          taskType,
          setId: String(attempt.set_id),
          setTitle: question?.set_title?.trim() || String(attempt.set_id),
          wordCount: Math.max(0, Number(attempt.word_count) || 0),
          submittedAt: attempt.submitted_at,
          reviewStatus: toReviewStatus(review)
        };
      })
    });
  } catch (error) {
    console.error("Unexpected writing review list error", {
      error: error instanceof Error ? error.message : "Unknown error"
    });
    return json(
      { code: "WRITING_REVIEWS_LOAD_FAILED", message: "无法加载写作批改列表。" },
      { status: 500 }
    );
  }
}

function toReviewStatus(review: ReviewRow | undefined): ReviewListStatus {
  if (!review) return "pending";
  if (review.status === "published") return "published";
  return "reviewing";
}

async function readRowsByIds<T>(
  ids: string[],
  readPage: (
    ids: string[],
    from: number,
    to: number
  ) => PromiseLike<{ data: T[] | null; error: PageError | null }>
) {
  const rows: T[] = [];
  for (let index = 0; index < ids.length; index += QUERY_BATCH_SIZE) {
    const batch = ids.slice(index, index + QUERY_BATCH_SIZE);
    const result = await readAllSupabaseRows<T>((from, to) =>
      readPage(batch, from, to)
    );
    if (result.error) return { data: null, error: result.error };
    rows.push(...(result.data ?? []));
  }
  return { data: rows, error: null };
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}
