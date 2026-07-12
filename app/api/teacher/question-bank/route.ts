import { NextResponse } from "next/server";
import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { createAnonSupabase } from "@/lib/supabase/server";

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

type MonthSummary = {
  month_key: string;
  month_label: string;
  question_count: number;
  set_count: number;
};

type SetSummary = {
  month_key: string;
  month_label: string;
  set_id: string;
  set_title: string;
  question_count: number;
};

function jsonError(message: string, status = 500) {
  return NextResponse.json(
    {
      error: message,
      months: [],
      sets: [],
      questions: []
    },
    { status }
  );
}

function parseSetId(setId: string) {
  const [yearMonthRaw, datePartRaw, setNumberRaw] = setId.split("-");
  const yearMonth = Number(yearMonthRaw);
  const datePart = Number(datePartRaw ?? 0);
  const setNumber = Number(setNumberRaw ?? 1);

  return {
    datePart: Number.isFinite(datePart) ? datePart : 0,
    monthKey: /^\d{6}$/.test(yearMonthRaw ?? "") ? yearMonthRaw : "unknown",
    setNumber: Number.isFinite(setNumber) ? setNumber : 1,
    yearMonth: Number.isFinite(yearMonth) ? yearMonth : 0
  };
}

function formatMonthLabel(monthKey: string) {
  if (!/^\d{6}$/.test(monthKey)) return "Unknown Month";

  const year = Number(monthKey.slice(0, 4));
  const monthIndex = Number(monthKey.slice(4, 6)) - 1;
  const date = new Date(Date.UTC(year, monthIndex, 1));

  return new Intl.DateTimeFormat("en", {
    month: "long",
    timeZone: "UTC",
    year: "numeric"
  }).format(date);
}

function compareSetIds(left: string, right: string) {
  const leftKey = parseSetId(left);
  const rightKey = parseSetId(right);

  return (
    leftKey.yearMonth - rightKey.yearMonth ||
    leftKey.datePart - rightKey.datePart ||
    leftKey.setNumber - rightKey.setNumber ||
    left.localeCompare(right)
  );
}

function buildQuestionBank(questionRows: QuestionRow[]) {
  const setMap = new Map<string, SetSummary>();
  const monthSetIds = new Map<string, Set<string>>();
  const monthQuestionCounts = new Map<string, number>();

  const questions = questionRows
    .map((question) => {
      const setId = String(question.set_id);
      const monthKey = parseSetId(setId).monthKey;
      const monthLabel = formatMonthLabel(monthKey);
      const setTitle = question.set_title ?? setId;

      monthQuestionCounts.set(monthKey, (monthQuestionCounts.get(monthKey) ?? 0) + 1);
      const setIds = monthSetIds.get(monthKey) ?? new Set<string>();
      setIds.add(setId);
      monthSetIds.set(monthKey, setIds);

      const currentSet = setMap.get(setId);
      setMap.set(setId, {
        month_key: monthKey,
        month_label: monthLabel,
        question_count: (currentSet?.question_count ?? 0) + 1,
        set_id: setId,
        set_title: currentSet?.set_title ?? setTitle
      });

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
        set_id: setId,
        set_title: setTitle
      };
    })
    .sort((left, right) => {
      const setCompare = compareSetIds(left.set_id, right.set_id);
      return setCompare || left.question_order - right.question_order;
    });

  const sets = Array.from(setMap.values()).sort((left, right) =>
    compareSetIds(left.set_id, right.set_id)
  );

  const months: MonthSummary[] = Array.from(monthSetIds.entries())
    .map(([monthKey, setIds]) => ({
      month_key: monthKey,
      month_label: formatMonthLabel(monthKey),
      question_count: monthQuestionCounts.get(monthKey) ?? 0,
      set_count: setIds.size
    }))
    .sort((left, right) => Number(left.month_key) - Number(right.month_key));

  return { months, questions, sets };
}

export async function GET(request: Request) {
  try {
    const token = bearerToken(request);
    const auth = await requireUserWithRole(token, "teacher");
    if (auth.error) {
      return jsonError(auth.error, auth.error === "Unauthorized" ? 403 : 401);
    }

    const { searchParams } = new URL(request.url);
    const month = searchParams.get("month");
    const setId = searchParams.get("setId");

    const supabase = createAnonSupabase(token);
    const { data, error } = await supabase
      .from("questions")
      .select(
        "question_id,set_id,set_title,question_order,prompt,sentence_template,blank_count,options_text,correct_order_text,distractors_text,final_sentence,grammar_tags_text"
      );

    if (error) {
      return jsonError(`Failed to load question bank: ${error.message}`);
    }

    const allRows = ((data ?? []) as QuestionRow[]).map((question) => ({
      ...question,
      question_id: String(question.question_id),
      set_id: String(question.set_id)
    }));
    const allBank = buildQuestionBank(allRows);
    const filteredRows = allRows.filter((question) => {
      if (setId) return question.set_id === setId;
      if (month) return parseSetId(question.set_id).monthKey === month;
      return true;
    });
    const filteredBank = buildQuestionBank(filteredRows);

    return NextResponse.json({
      months: allBank.months,
      questions: filteredBank.questions,
      sets: filteredBank.sets
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Failed to load question bank.");
  }
}
