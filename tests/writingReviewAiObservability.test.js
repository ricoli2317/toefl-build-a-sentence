const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  classifyWritingReviewAiFailure,
  persistWritingReviewAiLogBestEffort,
  writingReviewAiLogDatabaseRow
} = require("../lib/writingReviewAiLog.ts");
const {
  OpenRouterWritingReviewError,
  WRITING_REVIEW_PROMPT_VERSION
} = require("../lib/openrouterWritingReview.ts");
const { AIReviewValidationError } = require("../lib/writingReviewSchema.ts");
const {
  WRITING_FEEDBACK_REGEN_PROMPT_VERSION,
  WRITING_FEEDBACK_REGEN_SCHEMA_VERSION
} = require("../lib/writingReviewFeedbackRegeneration.ts");

const root = process.cwd();

function entry(overrides = {}) {
  return {
    request_id: "11111111-1111-4111-8111-111111111111",
    attempt_id: "22222222-2222-4222-8222-222222222222",
    task_type: "email",
    operation: "generate_ai",
    model: "moonshotai/kimi-k3",
    prompt_version: WRITING_REVIEW_PROMPT_VERSION,
    schema_version: "2.2",
    status: "success",
    pipeline_stage: "review_persistence",
    elapsed_ms: 100,
    ...overrides
  };
}

test("stable classifier separates timeout, provider, parse, schema, localization, overlap, and persistence", () => {
  assert.deepEqual(
    pick(classifyWritingReviewAiFailure(new OpenRouterWritingReviewError(
      "AI_REQUEST_TIMEOUT", "timeout", 504
    ))),
    ["provider_request", "timeout", "AI_REQUEST_TIMEOUT"]
  );
  assert.deepEqual(
    pick(classifyWritingReviewAiFailure(new OpenRouterWritingReviewError(
      "OPENROUTER_REQUEST_FAILED", "provider", 502
    ))),
    ["provider_request", "provider_error", "PROVIDER_REQUEST_FAILED"]
  );
  assert.deepEqual(
    pick(classifyWritingReviewAiFailure(new OpenRouterWritingReviewError(
      "OPENROUTER_API_KEY_MISSING", "missing", 500
    ))),
    ["request_preparation", "configuration_error", "AI_CONFIGURATION_MISSING"]
  );
  assert.deepEqual(
    pick(classifyWritingReviewAiFailure(Object.assign(new Error("missing"), {
      code: "ATTEMPT_NOT_FOUND"
    }))),
    ["request_preparation", "request_preparation_error", "ATTEMPT_NOT_FOUND"]
  );
  const parse = Object.assign(new Error("invalid response", {
    cause: new SyntaxError("Unexpected token")
  }), { code: "AI_RESPONSE_INVALID" });
  assert.deepEqual(pick(classifyWritingReviewAiFailure(parse)), [
    "response_parsing", "response_parse_error", "INVALID_STRUCTURED_RESPONSE"
  ]);
  assert.deepEqual(
    pick(classifyWritingReviewAiFailure(new AIReviewValidationError([
      { path: "$.scores", message: "is required" }
    ]))),
    ["schema_validation", "schema_validation_error", "INVALID_AI_RESPONSE_SCHEMA"]
  );
  assert.deepEqual(
    pick(classifyWritingReviewAiFailure(new AIReviewValidationError([
      { path: "$.language_edits[0].original_text", message: "must occur exactly in response_text" }
    ]))),
    ["localization", "localization_error", "ORIGINAL_TEXT_NOT_FOUND"]
  );
  assert.deepEqual(
    pick(classifyWritingReviewAiFailure(new AIReviewValidationError([
      { path: "$.language_edits[0].original_text", message: "must occur exactly once in response_text" }
    ]))),
    ["localization", "localization_error", "ORIGINAL_TEXT_NOT_UNIQUE"]
  );
  assert.deepEqual(
    pick(classifyWritingReviewAiFailure(new AIReviewValidationError([
      { path: "$.language_edits[1].start", message: "must not overlap language_edits[0]" }
    ]))),
    ["final_validation", "language_edit_overlap", "LANGUAGE_EDIT_OVERLAP"]
  );
  assert.deepEqual(
    pick(classifyWritingReviewAiFailure(Object.assign(new Error("save"), {
      code: "REVIEW_SAVE_FAILED"
    }))),
    ["review_persistence", "persistence_error", "REVIEW_SAVE_FAILED"]
  );
});

test("database projection keeps core observability fields and sanitizes forbidden payloads", () => {
  const row = writingReviewAiLogDatabaseRow(entry({
    status: "recovered",
    pipeline_stage: "normalization",
    error_type: "language_edit_overlap",
    error_code: "LANGUAGE_EDIT_OVERLAP",
    normalization_applied: true,
    validation_issues: [{ path: "$.language_edits[1].start", message: "must not overlap" }],
    diagnostics: {
      language_edit_overlap: { group_count: 1, groups: [{ action: "suppressed_conflict" }] },
      future_unknown_diagnostic: { useful: true },
      response_text: "complete essay must not persist",
      nested: { Authorization: "Bearer secret", prompt: "full prompt" }
    }
  }));
  assert.equal(row.status, "recovered");
  assert.equal(row.normalization_applied, true);
  assert.equal(row.diagnostics.language_edit_overlap.group_count, 1);
  assert.equal(row.diagnostics.future_unknown_diagnostic.useful, true);
  assert.equal("response_text" in row.diagnostics, false);
  assert.deepEqual(row.diagnostics.nested, {});
  assert.equal(row.validation_issues[0].path, "$.language_edits[1].start");
  assert.doesNotMatch(JSON.stringify(row), /complete essay|Bearer secret|full prompt/);
});

test("best-effort insert writes success/failure rows and never rejects the AI operation", async () => {
  const inserted = [];
  const info = console.info;
  const error = console.error;
  console.info = () => {};
  console.error = () => {};
  try {
    await persistWritingReviewAiLogBestEffort({
      from(table) {
        assert.equal(table, "writing_review_ai_logs");
        return { insert(row) { inserted.push(row); return Promise.resolve({ error: null }); } };
      }
    }, entry());
    await assert.doesNotReject(() => persistWritingReviewAiLogBestEffort({
      from() {
        return { insert() { return Promise.resolve({ error: { message: "table unavailable" } }); } };
      }
    }, entry({ status: "failed", error_code: "PROVIDER_HTTP_ERROR" })));
  } finally {
    console.info = info;
    console.error = error;
  }
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].request_id, entry().request_id);
});

test("all Writing AI operations share request identity, versions, persistence, and safe diagnostics", () => {
  const sources = {
    generate_ai: read("app/api/teacher/writing/reviews/[attemptId]/generate-ai/route.ts"),
    full_regenerate: read("app/api/teacher/writing/reviews/[attemptId]/regenerate-ai/route.ts"),
    feedback_regenerate: read("app/api/teacher/writing/reviews/[attemptId]/feedback/[feedbackId]/regenerate/route.ts")
  };
  for (const [operation, source] of Object.entries(sources)) {
    assert.match(source, new RegExp(`operation: "${operation}"`));
    assert.match(source, /const requestId = crypto\.randomUUID\(\)/);
    assert.match(source, /operationStartedAt === null/);
    assert.match(source, /persistWritingReviewAiLogBestEffort/);
    assert.match(source, /prompt_version:/);
    assert.match(source, /schema_version:/);
    assert.doesNotMatch(source, /diagnostics:[\s\S]{0,100}response_text/);
  }
  assert.match(sources.generate_ai, /overlapDiagnosticsByBranch/);
  assert.match(sources.generate_ai, /requestId/);
  assert.match(sources.full_regenerate, /overlapDiagnosticsByBranch/);
  assert.equal(WRITING_FEEDBACK_REGEN_SCHEMA_VERSION, "writing_feedback_regeneration_v1");
  assert.match(WRITING_FEEDBACK_REGEN_PROMPT_VERSION, /^writing_feedback_regeneration_prompt_v/);
  assert.match(WRITING_REVIEW_PROMPT_VERSION, /^writing_review_prompt_v/);
});

test("teacher log API enforces teacher auth, all filters, DESC pagination, and detail lookup", () => {
  const list = read("app/api/teacher/writing/reviews/ai-logs/route.ts");
  const detail = read("app/api/teacher/writing/reviews/ai-logs/[logId]/route.ts");
  for (const source of [list, detail]) {
    assert.match(source, /requireUserWithRole\(bearerToken\(request\), "teacher"\)/);
    assert.match(source, /auth\.error === "Unauthorized" \? 403 : 401/);
    assert.match(source, /Cache-Control": "no-store"/);
  }
  for (const filter of [
    "attempt_id", "status", "pipeline_stage", "error_type", "error_code",
    "operation", "task_type", "model", "prompt_version"
  ]) {
    assert.match(list, new RegExp(`"${filter}"`));
  }
  assert.match(list, /order\("created_at", \{ ascending: false \}\)/);
  assert.match(list, /\.range\(from, from \+ pageSize - 1\)/);
  assert.match(list, /Math\.min[\s\S]*100/);
  assert.match(detail, /\.eq\("id", params\.logId\)/);
});

test("teacher UI exposes list, filters, friendly status/detail, overlap actions, and attempt links", () => {
  const list = read("components/teacher/TeacherWritingReviewList.tsx");
  const page = read("app/teacher/writing/reviews/page.tsx");
  const workspace = read("components/teacher/TeacherWritingReviewWorkspace.tsx");
  const logs = read("components/teacher/TeacherWritingAiLogs.tsx");
  assert.match(page, />\s*AI 调用日志\s*</);
  assert.match(list, /reviews\/\$\{encodeURIComponent\(attempt\.attemptId\)\}/);
  assert.match(list, />\s*查看\s*</);
  assert.doesNotMatch(list, /generate-ai/);
  assert.match(workspace, /查看 AI 日志/);
  assert.match(workspace, /logs\?attempt_id=/);
  assert.match(logs, /成功 · 已自动修复/);
  assert.match(logs, /pipeline_stage/);
  assert.match(logs, /error_code/);
  assert.match(logs, /validation_issues/);
  assert.match(logs, /suppressed_conflict: "冲突项已抑制"/);
  assert.match(logs, /查看原始诊断 JSON/);
  assert.match(logs, /page_size/);
});

test("SQL defines constrained general-purpose logs, indexes, RLS, and service-role writes", () => {
  const sql = read("supabase/writing_review_ai_logs.sql");
  assert.match(sql, /create table if not exists public\.writing_review_ai_logs/i);
  assert.match(sql, /validation_issues jsonb/i);
  assert.match(sql, /diagnostics jsonb/i);
  assert.match(sql, /create policy "Teachers can read writing AI logs"/i);
  assert.match(sql, /using \(public\.is_teacher\(\)\)/i);
  assert.match(sql, /grant all on table public\.writing_review_ai_logs to service_role/i);
  assert.match(sql, /attempt_id, created_at desc/i);
  assert.match(sql, /error_type, error_code, created_at desc/i);
});

function pick(value) {
  return [value.pipeline_stage, value.error_type, value.error_code];
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}
