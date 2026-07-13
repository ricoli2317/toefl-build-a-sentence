import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type QuestionTextModule = typeof import("../lib/questionText");

let questionText: QuestionTextModule | null = null;

type QuestionRow = {
  question_id: string;
  prompt: string | null;
  options_text: string | null;
  correct_order_text: string | null;
};

type AnswerRow = {
  attempt_answer_id: string;
  attempt_id: string;
  student_id: string;
  question_id: string;
  submitted_order_text: string | null;
  is_correct: boolean;
};

type AttemptRow = Record<string, unknown> & {
  attempt_id: string;
  correct_count: number | null;
  total_questions?: number | null;
};

type RegradedAnswer = AnswerRow & {
  recalculated_is_correct: boolean;
};

const TARGET_PROMPT = "Why did you choose that university?";
const TARGET_OPTIONS = [
  "interest",
  "the most",
  "that",
  "me",
  "suggested",
  "the school",
  "would"
];
const REPORT_PATH = resolve(process.cwd(), "regrade-corrected-questions-report.json");
const PAGE_SIZE = 1000;

function getQuestionText() {
  if (!questionText) throw new Error("Question text helpers are not loaded.");
  return questionText;
}

function normalizeText(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function normalizedChunkMultiset(value: string | null | undefined) {
  const { normalizeChunkForCompare, splitTextItems } = getQuestionText();
  return splitTextItems(value).map(normalizeChunkForCompare).sort();
}

function arraysEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function isTargetQuestion(question: QuestionRow) {
  return (
    normalizeText(question.prompt) === normalizeText(TARGET_PROMPT) &&
    arraysEqual(normalizedChunkMultiset(question.options_text), [...TARGET_OPTIONS].sort())
  );
}

function isCorrectOrder(submittedOrderText: string | null, correctOrderText: string | null) {
  const { normalizeChunkForCompare, splitTextItems } = getQuestionText();
  const submitted = splitTextItems(submittedOrderText);
  const correct = splitTextItems(correctOrderText);

  return (
    submitted.length === correct.length &&
    submitted.every(
      (chunk, index) =>
        normalizeChunkForCompare(chunk) === normalizeChunkForCompare(correct[index] ?? "")
    )
  );
}

async function readAllPages<T>(
  loadPage: (
    from: number,
    to: number
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
) {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await loadPage(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

async function loadTargetQuestions(db: SupabaseClient) {
  const questions = await readAllPages<QuestionRow>((from, to) =>
    db
      .from("questions")
      .select("question_id,prompt,options_text,correct_order_text")
      .range(from, to)
  );
  return questions.filter(isTargetQuestion);
}

async function loadAffectedAnswers(db: SupabaseClient, questionIds: string[]) {
  if (questionIds.length === 0) return [];
  return readAllPages<AnswerRow>((from, to) =>
    db
      .from("attempt_answers")
      .select(
        "attempt_answer_id,attempt_id,student_id,question_id,submitted_order_text,is_correct"
      )
      .in("question_id", questionIds)
      .range(from, to)
  );
}

async function loadAttempts(db: SupabaseClient, attemptIds: string[]) {
  if (attemptIds.length === 0) return [];
  return readAllPages<AttemptRow>((from, to) =>
    db.from("attempts").select("*").in("attempt_id", attemptIds).range(from, to)
  );
}

async function loadAttemptAnswers(db: SupabaseClient, attemptIds: string[]) {
  if (attemptIds.length === 0) return [];
  return readAllPages<Pick<AnswerRow, "attempt_id" | "attempt_answer_id" | "is_correct">>(
    (from, to) =>
      db
        .from("attempt_answers")
        .select("attempt_id,attempt_answer_id,is_correct")
        .in("attempt_id", attemptIds)
        .range(from, to)
  );
}

function sqlLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function buildTransactionSql(regraded: RegradedAnswer[], attemptIds: string[]) {
  const changed = regraded.filter(
    (answer) => answer.is_correct !== answer.recalculated_is_correct
  );
  const answerUpdate =
    changed.length === 0
      ? "-- No attempt_answers.is_correct values need changing."
      : `update public.attempt_answers as answer\nset is_correct = changes.is_correct\nfrom (values\n${changed
          .map(
            (answer) =>
              `  (${sqlLiteral(answer.attempt_answer_id)}, ${answer.recalculated_is_correct})`
          )
          .join(",\n")}\n) as changes(attempt_answer_id, is_correct)\nwhere answer.attempt_answer_id::text = changes.attempt_answer_id;`;

  const attemptIdList = attemptIds.map(sqlLiteral).join(", ");
  const attemptUpdate =
    attemptIds.length === 0
      ? "-- No attempts need recalculation."
      : `with totals as (\n  select attempt_id, count(*) filter (where is_correct)::integer as correct_count\n  from public.attempt_answers\n  where attempt_id::text in (${attemptIdList})\n  group by attempt_id\n)\nupdate public.attempts as attempt\nset correct_count = totals.correct_count\nfrom totals\nwhere attempt.attempt_id = totals.attempt_id;`;

  return `begin;\n\n${answerUpdate}\n\n${attemptUpdate}\n\n-- accuracy is not written directly: in this project it is database-generated\n-- from correct_count and total_questions.\n\ncommit;\n`;
}

function executeTransaction(sql: string) {
  const databaseUrl = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("Missing env: SUPABASE_DB_URL (or DATABASE_URL) is required with --apply.");
  }

  const result = spawnSync("psql", [databaseUrl, "-X", "-v", "ON_ERROR_STOP=1"], {
    encoding: "utf8",
    input: sql,
    stdio: ["pipe", "pipe", "pipe"]
  });
  if (result.error) {
    throw new Error(`Could not run psql: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "The regrade transaction failed.");
  }
  process.stdout.write(result.stdout);
}

async function main() {
  const questionTextModulePath = "../lib/questionText.ts";
  questionText = (await import(questionTextModulePath)) as QuestionTextModule;
  const apply = process.argv.includes("--apply");
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    const missing = [
      !supabaseUrl ? "NEXT_PUBLIC_SUPABASE_URL" : null,
      !serviceRoleKey ? "SUPABASE_SERVICE_ROLE_KEY" : null
    ].filter(Boolean);
    throw new Error(`Missing env: ${missing.join(", ")}`);
  }

  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const questions = await loadTargetQuestions(db);
  const questionById = new Map(questions.map((question) => [question.question_id, question]));
  const answers = await loadAffectedAnswers(db, questions.map((question) => question.question_id));
  const regraded = answers.map<RegradedAnswer>((answer) => ({
    ...answer,
    recalculated_is_correct: isCorrectOrder(
      answer.submitted_order_text,
      questionById.get(answer.question_id)?.correct_order_text ?? null
    )
  }));
  const attemptIds = Array.from(new Set(regraded.map((answer) => answer.attempt_id)));
  const [attempts, allAttemptAnswers] = await Promise.all([
    loadAttempts(db, attemptIds),
    loadAttemptAnswers(db, attemptIds)
  ]);
  const recalculatedByAnswerId = new Map(
    regraded.map((answer) => [answer.attempt_answer_id, answer.recalculated_is_correct])
  );
  const projectedCorrectCountByAttempt = new Map<string, number>();
  for (const answer of allAttemptAnswers) {
    const isCorrect = recalculatedByAnswerId.get(answer.attempt_answer_id) ?? answer.is_correct;
    if (isCorrect) {
      projectedCorrectCountByAttempt.set(
        answer.attempt_id,
        (projectedCorrectCountByAttempt.get(answer.attempt_id) ?? 0) + 1
      );
    }
  }

  const report = {
    mode: apply ? "apply" : "dry-run",
    target: { prompt: TARGET_PROMPT, options: TARGET_OPTIONS },
    matched_question_ids: questions.map((question) => question.question_id).sort(),
    matched_questions: questions
      .map((question) => ({
        question_id: question.question_id,
        options_text: question.options_text,
        current_correct_order_text: question.correct_order_text
      }))
      .sort((left, right) => left.question_id.localeCompare(right.question_id)),
    matched_question_count: questions.length,
    affected_attempt_answer_count: regraded.length,
    changed_attempt_answer_count: regraded.filter(
      (answer) => answer.is_correct !== answer.recalculated_is_correct
    ).length,
    affected_attempt_count: attemptIds.length,
    detected_attempt_fields: Array.from(
      new Set(attempts.flatMap((attempt) => Object.keys(attempt)))
    ).sort(),
    answers: regraded.map((answer) => ({
      attempt_id: answer.attempt_id,
      student_id: answer.student_id,
      question_id: answer.question_id,
      submitted_order_text: answer.submitted_order_text,
      original_is_correct: answer.is_correct,
      recalculated_is_correct: answer.recalculated_is_correct
    })),
    attempts: attempts.map((attempt) => ({
      attempt_id: attempt.attempt_id,
      original_correct_count: attempt.correct_count,
      recalculated_correct_count: projectedCorrectCountByAttempt.get(attempt.attempt_id) ?? 0,
      total_questions: attempt.total_questions ?? null
    }))
  };

  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Matched question IDs (${questions.length}):`);
  for (const question of questions) console.log(`- ${question.question_id}`);
  console.log(`Affected attempt_answers: ${regraded.length}`);
  console.log(`Rows whose is_correct would change: ${report.changed_attempt_answer_count}`);
  console.log(`Affected attempts: ${attemptIds.length}`);
  console.log(`Report: ${REPORT_PATH}`);

  if (!apply) {
    console.log("Dry-run only. No database rows were changed.");
    return;
  }

  executeTransaction(buildTransactionSql(regraded, attemptIds));
  console.log("Regrade transaction committed successfully.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
