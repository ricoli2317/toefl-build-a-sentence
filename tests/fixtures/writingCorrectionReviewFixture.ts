import type { WritingTaskType } from "../../lib/writing.ts";
import { initializeWritingRevision } from "../../lib/writingRevisionState.ts";
import type {
  CorrectionReviewState,
  CorrectionSourceIssue,
  CorrectionTeacherOverrides,
  CorrectionWorkspace
} from "../../lib/writingCorrectionReview.ts";
import {
  buildCorrectionPublishedSnapshot,
  correctionOriginalScore,
  correctionReviewState,
  correctionSourceIssues
} from "../../lib/writingCorrectionReview.ts";

/**
 * Synthetic Phase 4 fixture. No real student text, no database, no network.
 * Synthetic inputs for correction review regression tests, never production routes.
 */

export const REVIEW_FIXTURE_ATTEMPT_ID = "77777777-7777-4777-8777-777777777777";
export const REVIEW_FIXTURE_ORIGINAL_ID = "22222222-2222-4222-8222-222222222222";

const WE_QUESTION = {
  question_id: "fixture-review-email",
  set_id: "fixture-review-set",
  set_title: "Phase 4 fixture question",
  year_month: "202611",
  source_labels: "fixture",
  scenario: "Your school library is planning new weekend activities.",
  task_instruction: "Write an email to the library team.",
  requirement_1: "Suggest one weekend activity.",
  requirement_2: "Explain how students would benefit.",
  requirement_3: "Offer to help organize it.",
  closing_instruction: "Write as much as you can and in complete sentences.",
  recipient: "Library Team",
  subject: "Weekend workshop suggestion"
};

const WE_ORIGINAL = `Dear Library Team,

I am writing to suggest a weekend workshop. Students need more opportunity to learn together. The library is quiet but it can be more lively. I think a workshop would be useful.

Thank you for your time.

Best,
Sam`;

const WE_CORRECTED = `Dear Library Team,

I am writing to suggest a weekend workshop on Saturday mornings. Students need more opportunities to learn together. The library is quiet but it can be livelier and more welcoming. A workshop would give students a chance to practise together.

Thank you for considering my suggestion.

Best,
Sam`;

const WE_EDITS = [
  {
    issue_id: "fixture-le-1",
    issue_type: "language_edit" as const,
    category: "grammar",
    severity: "major",
    original_text: "opportunity",
    replacement_text: "opportunities",
    original_sentence: null,
    issue: null,
    suggestion: null,
    weight: 1
  },
  {
    issue_id: "fixture-le-2",
    issue_type: "language_edit" as const,
    category: "word_form",
    severity: "minor",
    original_text: "more lively",
    replacement_text: "livelier",
    original_sentence: null,
    issue: null,
    suggestion: null,
    weight: 1
  },
  {
    issue_id: "fixture-le-3",
    issue_type: "language_edit" as const,
    category: "word_choice",
    severity: "moderate",
    original_text: "I think a workshop would be useful.",
    replacement_text: "A workshop would give students a chance to practise together.",
    original_sentence: null,
    issue: null,
    suggestion: null,
    weight: 1
  },
  {
    issue_id: "fixture-le-4",
    issue_type: "language_edit" as const,
    category: "usage",
    severity: "minor",
    original_text: "Thank you for your time.",
    replacement_text: "Thank you for considering my suggestion.",
    original_sentence: null,
    issue: null,
    suggestion: null,
    weight: 1
  },
  {
    issue_id: "fixture-f-1",
    issue_type: "content_feedback" as const,
    category: "elaboration",
    severity: null,
    original_text: null,
    replacement_text: null,
    original_sentence: "The library is quiet but it can be more lively.",
    issue: "没有说明学生会得到什么具体收益。",
    suggestion: "补充一个具体的活动收益。",
    weight: 3
  },
  {
    issue_id: "fixture-f-2",
    issue_type: "content_feedback" as const,
    category: "communicative_purpose",
    severity: null,
    original_text: null,
    replacement_text: null,
    original_sentence: "Thank you for your time.",
    issue: "题目要求主动提出可以协助组织活动，但正文没有对应动作。",
    suggestion: "明确表示愿意帮忙组织。",
    weight: 3
  }
];


const AD_QUESTION = {
  question_id: "fixture-review-ad",
  set_id: "fixture-review-set",
  set_title: "Phase 4 fixture question",
  year_month: "202611",
  source_labels: "fixture",
  professor_name: "Professor Lee",
  professor_prompt: "Should schools spend more on practical skills than on the arts?",
  student_1_name: "Andrew",
  student_1_response: "Practical skills help students find jobs.",
  student_2_name: "Kelly",
  student_2_response: "The arts teach creativity and confidence."
};

const AD_ORIGINAL = `I agree with Andrew that schools should focus on practical skills. However, I think art classes are also important. Students need creativity. Art helps them express ideas.`;

const AD_CORRECTED = `I agree with Andrew that schools should focus on practical skills. However, I think art classes are equally important. Students need creativity and confidence. Art helps them express ideas and work with others.`;

const AD_EDITS: CorrectionSourceIssue[] = [
  {
    issue_id: "fixture-ad-le-1",
    issue_type: "language_edit",
    category: "word_choice",
    severity: "moderate",
    original_text: "also important",
    replacement_text: "equally important",
    original_sentence: null,
    issue: null,
    suggestion: null,
    weight: 1
  },
  {
    issue_id: "fixture-ad-le-2",
    issue_type: "language_edit",
    category: "word_form",
    severity: "minor",
    original_text: "express ideas",
    replacement_text: "express ideas and work with others",
    original_sentence: null,
    issue: null,
    suggestion: null,
    weight: 1
  },
  {
    issue_id: "fixture-ad-f-1",
    issue_type: "content_feedback",
    category: "elaboration",
    severity: null,
    original_text: null,
    replacement_text: null,
    original_sentence: "Students need creativity.",
    issue: "没有说明创造力为什么重要。",
    suggestion: "补充创造力对学生的具体作用。",
    weight: 3
  }
];

/** Deterministic AI review derived from the fixture's own issues. */
function buildFixtureAi(
  issues: CorrectionSourceIssue[],
  taskType: WritingTaskType
) {
  const resolutions = issues.map((issue, index) => ({
    issue_id: issue.issue_id,
    issue_type: issue.issue_type,
    status:
      issue.issue_type === "content_feedback"
        ? ("unresolved" as const)
        : index === 0
          ? ("resolved" as const)
          : ("partially_resolved" as const),
    deletion_based: false,
    evidence: issue.issue_type === "content_feedback" ? "" : issue.replacement_text ?? "",
    explanation:
      issue.issue_type === "content_feedback"
        ? "内容问题仍未真正处理。"
        : index === 0
          ? "该处已经改正。"
          : "部分改善，但仍未完全解决。"
  }));
  return {
    task_type: taskType,
    issue_resolutions: resolutions,
    new_issues: [
      {
        type: "organization" as const,
        severity: "minor" as const,
        evidence: issues[0].issue_id,
        explanation: "段落合并后层次感下降。",
        score_impact: "small" as const
      }
    ],
    correction_score: 3,
    score_rationale: "语言有改善，但内容要求仍未落实，整体仍处于部分成功的 3 分档。",
    resolution_summary: "语言问题部分解决，内容反馈未解决，并带来轻微的段落组织问题。",
    score_change_explanation: "语言改善与内容不足相互抵消，因此综合评分与原文持平。"
  };
}

export function correctionReviewWorkspaceFixture(
  options: { adjusted?: boolean; taskType?: WritingTaskType; assignment?: boolean } = {}
): CorrectionWorkspace {
  const taskType = options.taskType ?? "email";
  const assignment = options.assignment === true;
  const isAd = taskType === "academic_discussion";
  const issues: CorrectionSourceIssue[] = isAd ? AD_EDITS : WE_EDITS;
  const originalText = isAd ? AD_ORIGINAL : WE_ORIGINAL;
  const correctedText = isAd ? AD_CORRECTED : WE_CORRECTED;
  const question = isAd ? AD_QUESTION : WE_QUESTION;
  const adjusted = options.adjusted === true;
  const ai = adjusted ? buildFixtureAi(issues, taskType) : null;
  const teacher = adjusted
    ? {
        issue_statuses: {
          [isAd ? "fixture-ad-le-2" : "fixture-le-4"]: "resolved" as const
        },
        correction_score: 4,
        score_rationale:
          "教师复核：该处已经改正，语言整体明显改善，综合调整为 4 分。",
        new_issue_reviews: { "0": { status: "dismissed" as const, note: "" } }
      }
    : emptyTeacher();
  const state = correctionReviewState({
    issues,
    originalScore: 3,
    ai,
    teacher
  });
  return {
    attempt: {
      attempt_id: REVIEW_FIXTURE_ATTEMPT_ID,
      original_attempt_id: REVIEW_FIXTURE_ORIGINAL_ID,
      user_id: "11111111-1111-4111-8111-111111111111",
      assignment_id: assignment ? "33333333-3333-4333-8333-333333333333" : null,
      task_type: taskType,
      student_name: "Mock Student",
      word_count: 64,
      submitted_at: "2026-11-03T09:00:00Z"
    },
    question,
    question_source: assignment ? "custom" : "question_bank",
    source: {
      original_response_text: originalText,
      original_score: 3,
      published_at: "2026-11-02T12:00:00Z",
      review_id: "88888888-8888-4888-8888-888888888888"
    },
    corrected_response_text: correctedText,
    corrected_word_count: 66,
    review: {
      review_id: adjusted ? "99999999-9999-4999-8999-999999999999" : null,
      status: "reviewing",
      prompt_version: "writing_correction_prompt_v1",
      schema_version: "writing_correction_review_v1",
      ai_model: adjusted ? "fixture-model" : null,
      ai_generated_at: adjusted ? "2026-11-03T09:05:00Z" : null,
      published_at: null,
      teacher,
      ai,
      state,
      published: null
    }
  };
}

function emptyTeacher(): CorrectionTeacherOverrides {
  return {
    issue_statuses: {},
    correction_score: null,
    score_rationale: null,
    new_issue_reviews: {}
  };
}

/** Builds a Phase 4 workspace from any Phase 3 fixture attempt snapshot. */
export function correctionReviewWorkspaceFromAttempt(
  attempt: import("../../lib/writing.ts").WritingAttempt
): CorrectionWorkspace {
  const snapshot = attempt.correction_source_snapshot!;
  const issues = correctionSourceIssues(snapshot);
  const originalScore = correctionOriginalScore(snapshot);
  const teacher = emptyTeacher();
  return {
    attempt: {
      attempt_id: attempt.attempt_id,
      original_attempt_id: attempt.original_attempt_id ?? "",
      user_id: attempt.user_id,
      assignment_id: attempt.assignment_id ?? null,
      task_type: attempt.task_type,
      student_name: "Mock Student",
      word_count: attempt.word_count,
      submitted_at: attempt.submitted_at
    },
    question: snapshot.question as CorrectionWorkspace["question"],
    question_source: snapshot.question_source,
    source: {
      original_response_text: snapshot.original_response_text,
      original_score: originalScore,
      published_at: snapshot.published_review.published_at,
      review_id: snapshot.published_review.review_id
    },
    corrected_response_text: attempt.response_text,
    corrected_word_count: attempt.word_count,
    revision_state: initializeWritingRevision(snapshot.original_response_text, attempt.response_text, attempt.revision_state),
    review: {
      review_id: null,
      status: "reviewing",
      prompt_version: "writing_correction_prompt_v1",
      schema_version: "writing_correction_review_v1",
      ai_model: null,
      ai_generated_at: null,
      published_at: null,
      teacher,
      ai: null,
      state: correctionReviewState({ issues, originalScore, ai: null, teacher }),
      published: null
    }
  };
}

/** Applies teacher overrides, optionally freezing a publish snapshot. */
export function applyFixtureTeacher(
  workspace: CorrectionWorkspace,
  teacher: CorrectionTeacherOverrides,
  publish = false
): CorrectionWorkspace {
  const issues = workspace.review.state.issues.map(
    ({ ai_status, ai_explanation, ai_evidence, ai_deletion_based,
      teacher_status, effective_status, ...issue }) => issue
  );
  workspace.review.teacher = teacher;
  workspace.review.state = correctionReviewState({
    issues,
    originalScore: workspace.source.original_score,
    ai: workspace.review.ai,
    teacher
  });
  if (publish) {
    workspace.review.status = "published";
    workspace.review.published_at = new Date().toISOString();
    workspace.review.published = buildCorrectionPublishedSnapshot({
      state: workspace.review.state,
      aiModel: workspace.review.ai_model,
      aiGeneratedAt: workspace.review.ai_generated_at,
      publishedAt: workspace.review.published_at
    });
  }
  return workspace;
}

export function createCorrectionReviewFixtureTransport(initial: CorrectionWorkspace) {
  let workspace = structuredClone(initial);
  const sourceIssues = workspace.review.state.issues.map(
    ({ ai_status, ai_explanation, ai_evidence, ai_deletion_based,
      teacher_status, effective_status, ...issue }) => issue
  );

  const rebuild = (teacher: CorrectionTeacherOverrides) => {
    workspace.review.teacher = teacher;
    workspace.review.state = correctionReviewState({
      issues: sourceIssues,
      originalScore: workspace.source.original_score,
      ai: workspace.review.ai,
      teacher
    });
  };

  const send = async (path: string, init?: RequestInit) => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    if (path.endsWith("/correction-review") && (!init || !init.method || init.method === "GET")) {
      return Response.json({ workspace });
    }
    if (path.endsWith("/correction-review/generate-ai")) {
      workspace.review.ai = buildFixtureAi(sourceIssues, workspace.attempt.task_type);
      workspace.review.ai_model = "fixture-model";
      workspace.review.ai_generated_at = new Date().toISOString();
      rebuild(workspace.review.teacher);
      return Response.json({
        workspace,
        teacher_overrides_preserved:
          Object.keys(workspace.review.teacher.issue_statuses).length > 0 ||
          workspace.review.teacher.correction_score !== null,
        telemetry: {
          model: "fixture-model",
          end_to_end_elapsed_ms: 14200,
          hedge_triggered: false,
          requests_started: 1
        }
      });
    }
    if (path.endsWith("/correction-review") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        action: "save" | "publish";
        teacher: CorrectionTeacherOverrides;
      };
      rebuild(body.teacher);
      if (body.action === "publish") {
        workspace.review.status = "published";
        workspace.review.published_at = new Date().toISOString();
        workspace.review.published = buildCorrectionPublishedSnapshot({
          state: workspace.review.state,
          aiModel: workspace.review.ai_model,
          aiGeneratedAt: workspace.review.ai_generated_at,
          publishedAt: workspace.review.published_at
        });
      }
      return Response.json({ workspace });
    }
    if (path.endsWith("/moderate")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { attemptIds: string[] };
      return Response.json({
        results: [{ attemptId: body.attemptIds[0], outcome: "returned", reason: null }]
      });
    }
    return Response.json({ message: "Fixture 未实现该请求。" }, { status: 404 });
  };

  return {
    send,
    reset: () => {
      workspace = structuredClone(initial);
    }
  };
}
