import { NextResponse } from "next/server";
import { bearerToken, requireUserWithRole } from "@/lib/auth";
import {
  getLogicalPracticeCatalog,
  isLogicalPracticeTaskType,
  parseLogicalPracticePage
} from "@/lib/practiceLogicalCatalog";
import { loadPracticePublicUniverse } from "@/lib/practicePublicUniverse";
import { buildAcademicDiscussionAvatarMap } from "@/lib/academicDiscussionAvatars";
import { WRITING_ASSIGNMENT_QUERY_FIELDS } from "@/lib/writingAssignmentsServer";
import { WRITING_TASK_CONFIG, type WritingQuestion } from "@/lib/writing";
import { createServiceSupabase } from "@/lib/supabase/server";
import { readAllSupabaseRows } from "@/lib/supabasePagination";

type BasQuestionRow = {
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

type AvatarRow = {
  participant_name: string;
  participant_type: string;
  avatar_path: string;
};

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const auth = await requireUserWithRole(bearerToken(request), "teacher");
    if (auth.error) {
      return jsonError(auth.error, auth.error === "Unauthorized" ? 401 : 403);
    }

    const params = new URL(request.url).searchParams;
    const itemId = params.get("itemId")?.trim();
    const supabase = createServiceSupabase();

    if (itemId) {
      const detail = await loadLogicalItemDetail(supabase, itemId);
      return detail ? json(detail) : jsonError("Logical item not found.", 404);
    }

    const taskType = params.get("taskType") ?? "build_sentence";
    const page = parseLogicalPracticePage(params.get("page"));
    if (!isLogicalPracticeTaskType(taskType)) {
      return jsonError("Invalid practice task type.", 400);
    }
    if (page === null) {
      return jsonError("page must be a positive integer.", 400);
    }

    return json(await getLogicalPracticeCatalog({ supabase, taskType, page }));
  } catch (error) {
    console.error("[teacher-question-bank] logical_item_load_failed", error);
    return jsonError("Could not load the teacher question bank.");
  }
}

async function loadLogicalItemDetail(
  supabase: ReturnType<typeof createServiceSupabase>,
  itemId: string
) {
  const universe = await loadPracticePublicUniverse(supabase);
  const item = universe.getPublicCanonicalSource(itemId);
  if (!item) return null;

  const logicalItem = {
    item_id: item.itemId,
    task_type: item.taskType,
    display_number: item.displayNumber,
    display_title: item.displayTitle,
    first_seen_date: item.firstSeenDate,
    question_count: item.taskType === "build_sentence" ? 10 : 1
  };

  if (item.taskType === "build_sentence") {
    const questionMap = item.canonicalQuestions ?? [];
    const questionIds = questionMap.map(({ questionId }) => questionId);
    const result = await readAllSupabaseRows<BasQuestionRow>((from, to) =>
      supabase
        .from("questions")
        .select(
          "question_id,set_id,set_title,question_order,prompt,sentence_template,blank_count,options_text,correct_order_text,distractors_text,final_sentence,grammar_tags_text"
        )
        .in("question_id", questionIds)
        .order("question_id", { ascending: true })
        .range(from, to)
    );
    if (result.error) throw result.error;
    const questionsById = new Map(
      (result.data ?? []).map((question) => [String(question.question_id), question])
    );
    const questions = questionMap.flatMap(({ logicalQuestionOrder, questionId }) => {
      const question = questionsById.get(questionId);
      return question
        ? [{
            blank_count: question.blank_count ?? 0,
            correct_order_text: question.correct_order_text ?? "",
            distractors_text: question.distractors_text ?? "",
            final_sentence: question.final_sentence ?? "",
            grammar_tags_text: question.grammar_tags_text ?? "",
            options_text: question.options_text ?? "",
            prompt: question.prompt ?? "",
            question_id: String(question.question_id),
            question_order: logicalQuestionOrder,
            sentence_template: question.sentence_template ?? "",
            set_id: String(question.set_id),
            set_title: question.set_title ?? ""
          }]
        : [];
    });
    if (questions.length !== 10) {
      throw new Error("Logical BAS item does not contain a complete Q1-Q10 detail.");
    }
    return { item: logicalItem, questions };
  }

  const questionId = item.sourceQuestionId;
  if (!questionId) return null;
  const questionResult = await supabase
    .from(WRITING_TASK_CONFIG[item.taskType].questionTable)
    .select(WRITING_ASSIGNMENT_QUERY_FIELDS[item.taskType])
    .eq("question_id", questionId)
    .maybeSingle();
  if (questionResult.error) throw questionResult.error;
  if (!questionResult.data) return null;

  if (item.taskType === "email") {
    return {
      item: logicalItem,
      question: questionResult.data as unknown as WritingQuestion
    };
  }

  const avatarResult = await readAllSupabaseRows<AvatarRow>((from, to) =>
    supabase
      .from("academic_discussion_avatars")
      .select("participant_name,participant_type,avatar_path")
      .order("participant_type", { ascending: true })
      .order("participant_name", { ascending: true })
      .range(from, to)
  );
  if (avatarResult.error) throw avatarResult.error;
  return {
    avatars: buildAcademicDiscussionAvatarMap(avatarResult.data ?? []),
    item: logicalItem,
    question: questionResult.data as unknown as WritingQuestion
  };
}

function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });
}

function jsonError(error: string, status = 500) {
  return json({ error }, { status });
}
