import { countEnglishWords, type WritingAttempt, type WritingTaskType } from "../../lib/writing.ts";
import {
  applyFixtureTeacher,
  correctionReviewWorkspaceFromAttempt
} from "./writingCorrectionReviewFixture.ts";
import type { CorrectionWorkspace } from "../../lib/writingCorrectionReview.ts";
import { createWritingCorrectionClient, type CorrectionSend } from "../../lib/writingCorrectionUi.ts";
import { initializeWritingRevision } from "../../lib/writingRevisionState.ts";
import { nextRevisionId } from "../../lib/writingRevisionLedger.ts";

// Synthetic prose and UUIDs only. No database/session/authentication dependency.
export const FIXTURE_ORIGINAL_ID = "22222222-2222-4222-8222-222222222222";
export const FIXTURE_CORRECTION_ID = "44444444-4444-4444-8444-444444444444";
export function writingCorrectionFixture(taskType: WritingTaskType, assignment: boolean): WritingAttempt {
  const text = taskType === "email"
    ? "Dear Library Team,\n\nI is writing to suggest a weekend workshop. Students need more opportunities to learn together.\n\nThank you for considering my idea.\nBest,\nAlex"
    : "I believes that community gardens benefit students. They provide a place to learn together. For example, students can grow vegetables and share their experiences.";
  const wrong = taskType === "email" ? "I is" : "I believes";
  const sentence = "Students need more opportunities to learn together.";
  const feedbackStart = taskType === "email" ? text.indexOf(sentence) : text.indexOf("They provide");
  const feedbackText = taskType === "email" ? sentence : "They provide a place to learn together.";
  const context = { task_type: taskType, question_id: "fixture-question", set_id: "fixture-set",
    assignment_id: assignment ? "33333333-3333-4333-8333-333333333333" : null,
    word_count: countEnglishWords(text), writing_mode: "exam" as const, elapsed_seconds: 120,
    overtime_ranges: [], time_limit_seconds: taskType === "email" ? 420 : 600,
    remaining_seconds: 100, submitted_at: "2026-11-01T12:00:00Z" };
  const commonQuestion = { question_id: context.question_id, set_id: context.set_id, set_title: "Synthetic frozen question", year_month: "202611", source_labels: assignment ? "custom" : "fixture" };
  return {
    ...context, attempt_id: FIXTURE_CORRECTION_ID, user_id: "11111111-1111-4111-8111-111111111111",
    attempt_kind: "correction", original_attempt_id: FIXTURE_ORIGINAL_ID, status: "draft", draft_version: 0,
    response_text: text, writing_mode: null, elapsed_seconds: 0,
    remaining_seconds: context.time_limit_seconds, submitted_at: null, saved_at: null,
    started_at: "2026-11-02T12:00:00Z", created_at: "2026-11-02T12:00:00Z", updated_at: "2026-11-02T12:00:00Z",
    correction_source_snapshot: { schema_version: 1, original_response_text: text, original_context: context,
      question_source: assignment ? "custom" : "question_bank",
      question: taskType === "email" ? { ...commonQuestion, scenario: "Your school library is planning new weekend activities.",
        task_instruction: "Write an email to the library team.", requirement_1: "Suggest a weekend workshop.", requirement_2: "Explain how students would benefit.", requirement_3: "Offer to help organize it.",
        closing_instruction: "Write as much as you can and in complete sentences.", recipient: "Library Team", subject: "Weekend workshop suggestion" }
        : { ...commonQuestion, professor_name: "Professor Lee", professor_prompt: "Should schools invest in community gardens? Explain your view with an example.",
          student_1_name: "Jordan", student_1_response: "Gardens offer practical learning opportunities.", student_2_name: "Sam", student_2_response: "I think the funds should support indoor facilities instead." },
      published_review: { review_id: "55555555-5555-4555-8555-555555555555", published_at: "2026-11-01T13:00:00Z",
        language_edits: [{ edit_id: "fixture-le", start: text.indexOf(wrong), end: text.indexOf(wrong) + wrong.length,
          original_text: wrong, replacement_text: taskType === "email" ? "I am" : "I believe", category: "grammar", severity: "major", explanation: "第一人称主语需要匹配正确的动词形式。" }],
        content_feedback: { overall_feedback: "HIDDEN OVERALL FEEDBACK", items: [{ feedback_id: "fixture-f", category: "elaboration", start: feedbackStart, end: feedbackStart + feedbackText.length, original_sentence: feedbackText,
          issue: "这一观点缺少具体说明。", suggestion: "请补充活动实例及其对学生的具体帮助。", proposed_revision: "A workshop could help students collaborate on a practical project." }] },
        scores: { official_score: { teacher_score: 3, ai_score: 3, rationale: "HIDDEN SCORE" }, dimension_scores: null }, teacher_comment: "HIDDEN TEACHER COMMENT" }
    }
  };
}

export type FixtureStorage = Pick<Storage, "getItem" | "setItem">;
/** Network-free HTTP contract double. Persistence is scoped to the browser tab. */
export function createCorrectionFixtureTransport(storage: FixtureStorage, task: WritingTaskType, assignment: boolean) {
  const key = `tps-correction-fixture:${task}:${assignment}`;
  const readAll = (): WritingAttempt[] => {
    const value = storage.getItem(key);
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed : [parsed];
  };
  const read = () => readAll().find((row) => row.status === "draft") ?? readAll().at(-1) ?? null;
  const write = (attempt: WritingAttempt) => {
    const rows = readAll();
    const index = rows.findIndex((row) => row.attempt_id === attempt.attempt_id);
    if (index < 0) rows.push(attempt); else rows[index] = attempt;
    storage.setItem(key, JSON.stringify(rows));
  };
  let failure: "gate" | "conflict" | "network" | "lost-submit" | null = null;
  const send: CorrectionSend = async (path, init) => {
    if (failure && failure !== "lost-submit") {
      const kind = failure; failure = null;
      if (kind === "network") throw new Error("模拟网络故障：尚未保存，当前正文仍保留。");
      if (kind === "conflict") {
        const row = read();
        if (row) {
          const appended = "\nSaved in another tab.";
          const state = initializeWritingRevision(row.correction_source_snapshot!.original_response_text, row.response_text, row.revision_state);
          const ledger = state.ledger;
          const id = nextRevisionId('insert');
          write({ ...row, response_text: row.response_text + appended, revision_state: { schema_version: 1,
            ledger: { ...ledger, text: ledger.text + appended, sources: [...ledger.sources, ...Array.from({ length: appended.length }, () => id)] } }, draft_version: row.draft_version + 1 });
        }
      }
      return Response.json({ code: kind === "gate" ? "WRITING_CORRECTION_NOT_ENABLED" : "WRITING_CORRECTION_VERSION_CONFLICT", error: kind === "gate" ? "订正功能尚未开放。" : "草稿版本已变化，请重新读取后再保存。" }, { status: kind === "gate" ? 503 : 409 });
    }
    if (init.method === "POST" && path === "/api/writing/corrections") {
      const body = JSON.parse(String(init.body));
      if (body.originalAttemptId !== FIXTURE_ORIGINAL_ID) return Response.json({ error: "not found" }, { status: 404 });
      const existing = readAll().find((row) => row.status === "draft");
      const attempt = existing ?? { ...writingCorrectionFixture(task, assignment),
        attempt_id: readAll().length ? `44444444-4444-4444-8444-${String(444444444444 + readAll().length)}` : FIXTURE_CORRECTION_ID };
      write(attempt);
      return Response.json({ attempt, resumed: Boolean(existing) }, { status: existing ? 200 : 201 });
    }
    if (path.startsWith("/api/writing/corrections?")) return Response.json({ originalAttemptId: FIXTURE_ORIGINAL_ID,
      attempts: readAll().slice().reverse().map((row) => ({ ...row, reviewStatus: row.status === "submitted" ? "pending" : null })) });
    const attempt = readAll().find((row) => path === `/api/writing/corrections/${row.attempt_id}`);
    if (!attempt || path !== `/api/writing/corrections/${attempt.attempt_id}`) return Response.json({ error: "未找到草稿，请从模拟原稿入口创建。" }, { status: 404 });
    if (init.method === "GET") return Response.json({ attempt });
    const body = JSON.parse(String(init.body));
    if (init.method !== "PATCH") throw new Error("Fixture requires PATCH");
    if (body.action === "submit" && attempt.status === "submitted") return Response.json({ attempt, alreadySubmitted: true });
    if (attempt.status !== "draft") return Response.json({ code: "WRITING_CORRECTION_SUBMITTED_LOCKED", error: "订正已提交" }, { status: 409 });
    if (body.expectedDraftVersion !== attempt.draft_version) return Response.json({ code: "WRITING_CORRECTION_VERSION_CONFLICT", error: "版本冲突" }, { status: 409 });
    if (body.action === "submit") {
      const submitted: WritingAttempt = { ...attempt, status: "submitted", submitted_at: new Date().toISOString(), draft_version: attempt.draft_version + 1 };
      write(submitted);
      if (failure === "lost-submit") { failure = null; throw new Error("模拟提交成功但响应丢失，请重试同一条订正。"); }
      return Response.json({ attempt: submitted, alreadySubmitted: false, cacheInvalidation: { type: "WRITING_CORRECTION_UPDATED" } });
    }
    if (body.action !== "save") throw new Error("Unknown fixture action");
    const saved = { ...attempt, response_text: body.responseText, revision_state: body.revisionState ?? null, word_count: countEnglishWords(body.responseText), draft_version: attempt.draft_version + 1, saved_at: new Date().toISOString() };
    write(saved);
    return Response.json({ attempt: saved });
  };
  let teacherReview: CorrectionWorkspace | null = null;
  const teacherSend = async (path: string, init?: RequestInit) => {
    if (path.endsWith("/correction-review/generate-ai")) {
      return Response.json({ message: "Fixture 不生成 AI 评价。" }, { status: 501 });
    }
    if (path.includes("/correction-review")) {
      const reviewAttempt = readAll().find(
        (row) => path.includes(row.attempt_id) && row.status === "submitted"
      );
      if (!reviewAttempt) return Response.json({ message: "未找到订正稿" }, { status: 404 });
      const reviewKey = `${key}:review:${reviewAttempt.attempt_id}`;
      if (!teacherReview || teacherReview.attempt.attempt_id !== reviewAttempt.attempt_id) {
        const storedReview = storage.getItem(reviewKey);
        teacherReview = storedReview ? JSON.parse(storedReview) as CorrectionWorkspace : correctionReviewWorkspaceFromAttempt(reviewAttempt);
      }
      if (!init?.method || init.method === "GET") {
        return Response.json({ workspace: teacherReview });
      }
      if (teacherReview.review.status === "published") return Response.json({ message: "订正评价已发布并冻结。" }, { status: 409 });
      const reviewBody = JSON.parse(String(init.body)) as {
        action: "save" | "publish";
        teacher: import("../../lib/writingCorrectionReview.ts").CorrectionTeacherOverrides;
      };
      teacherReview = applyFixtureTeacher(
        teacherReview,
        reviewBody.teacher,
        reviewBody.action === "publish"
      );
      storage.setItem(reviewKey, JSON.stringify(teacherReview));
      return Response.json({ workspace: teacherReview });
    }
    if (path.endsWith("/correction-source")) {
      const attempt = readAll().find((row) => path.includes(row.attempt_id) && row.status === "submitted");
      return attempt ? Response.json({ attempt, frozen_source: attempt.correction_source_snapshot, studentName: "Mock Student" }) : Response.json({ error: "未找到订正稿" }, { status: 404 });
    }
    const body = JSON.parse(String(init?.body));
    const attempt = readAll().find((row) => row.attempt_id === body.attemptIds[0]);
    const reason = !attempt ? "not_found" : attempt.status !== "submitted" ? "not_submitted" : storage.getItem(`${key}:review:${attempt.attempt_id}`) ? "already_reviewed" : readAll().some((row) => row.status === "draft") ? "draft_exists" : null;
    if (attempt && !reason) write({ ...attempt, status: "draft", submitted_at: null, draft_version: attempt.draft_version + 1 });
    return Response.json({ results: [{ attemptId: body.attemptIds[0], outcome: reason ? "skipped" : "returned", reason }] });
  };
  return { client: createWritingCorrectionClient(send), teacherSend, failNext: (kind: typeof failure) => { failure = kind; } };
}
