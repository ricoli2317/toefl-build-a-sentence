const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getOpenRouterErrorDiagnostic,
  parseOpenRouterErrorDiagnostic,
  requestOpenRouterWritingReview
} = require("../lib/openrouterWritingReview.ts");
const {
  classifyWritingReviewAiError,
  writingReviewAiLogDatabaseRow,
  writingReviewAiProviderDiagnostic
} = require("../lib/writingReviewAiLog.ts");

function requestWithResponse(response) {
  return requestOpenRouterWritingReview(
    { taskType: "email", question: {}, responseText: "Student essay sentinel." },
    {
      env: {
        OPENROUTER_API_KEY: "private-test-key",
        OPENROUTER_WRITING_MODEL: "test/model"
      },
      jsonSchema: {},
      async fetchImpl() {
        return response;
      }
    }
  );
}

test("standard OpenRouter 403 exposes only whitelisted diagnostics", async () => {
  const rawBody = {
    error: {
      code: 403,
      message: "Forbidden",
      metadata: {
        error_type: "permission_denied",
        provider_code: "some_provider_code",
        provider_name: "Google",
        private_debug: "must not be retained"
      }
    },
    request: { messages: ["must not be retained"] }
  };
  await assert.rejects(
    requestWithResponse(Response.json(rawBody, { status: 403 })),
    (error) => {
      assert.equal(error.code, "OPENROUTER_REQUEST_FAILED");
      assert.equal(error.status, 502);
      assert.equal(error.httpStatus, 403);
      assert.equal(error.openRouterErrorCode, 403);
      assert.equal(error.openRouterErrorType, "permission_denied");
      assert.equal(error.providerCode, "some_provider_code");
      assert.equal(error.providerName, "Google");
      assert.equal(error.safeProviderMessage, "Forbidden");
      assert.equal(
        error.message,
        "OpenRouter HTTP 403 [permission_denied]: Forbidden"
      );
      const diagnostic = getOpenRouterErrorDiagnostic(error);
      assert.deepEqual(diagnostic, {
        http_status: 403,
        error_code: 403,
        error_message: "Forbidden",
        error_type: "permission_denied",
        provider_code: "some_provider_code",
        provider_name: "Google"
      });
      assert.doesNotMatch(JSON.stringify(error), /private_debug|messages/);
      return true;
    }
  );
});

test("metadata is optional and provider fields remain null", () => {
  assert.deepEqual(
    parseOpenRouterErrorDiagnostic(
      403,
      JSON.stringify({ error: { code: 403, message: "Forbidden" } })
    ),
    {
      http_status: 403,
      error_code: 403,
      error_message: "Forbidden",
      error_type: null,
      provider_code: null,
      provider_name: null
    }
  );
});

test("non-JSON and empty error bodies retain HTTP status without retaining body", async () => {
  for (const [status, body] of [[403, "Forbidden"], [500, ""]]) {
    await assert.rejects(
      requestWithResponse(new Response(body, { status })),
      (error) => {
        assert.equal(error.httpStatus, status);
        assert.equal(error.openRouterErrorCode, null);
        assert.equal(error.openRouterErrorType, null);
        assert.equal(error.providerCode, null);
        assert.equal(error.providerName, null);
        assert.equal(error.safeProviderMessage, null);
        assert.equal(error.message, `OpenRouter returned HTTP ${status}.`);
        if (body) assert.doesNotMatch(error.message, new RegExp(body));
        return true;
      }
    );
  }
});

test("provider message is capped at 500 characters including ellipsis", () => {
  const message = "x".repeat(900);
  const diagnostic = parseOpenRouterErrorDiagnostic(
    400,
    JSON.stringify({ error: { message } })
  );
  assert.equal(diagnostic.error_message.length, 500);
  assert.equal(diagnostic.error_message.endsWith("..."), true);
  assert.equal(diagnostic.error_message, `${"x".repeat(497)}...`);
});

test("provider_code accepts number or string and provider_name is never inferred", () => {
  const numeric = parseOpenRouterErrorDiagnostic(
    403,
    JSON.stringify({
      error: {
        metadata: { provider_code: 40301, provider_name: "Google" }
      }
    })
  );
  const string = parseOpenRouterErrorDiagnostic(
    403,
    JSON.stringify({ error: { metadata: { provider_code: "policy_block" } } })
  );
  assert.equal(numeric.provider_code, 40301);
  assert.equal(numeric.provider_name, "Google");
  assert.equal(string.provider_code, "policy_block");
  assert.equal(string.provider_name, null);
});

test("diagnostics never retain raw body, request messages, headers, essay, or API key", async () => {
  const sensitive = {
    error: {
      code: "forbidden",
      message: "Safe reason",
      metadata: { error_type: "permission_denied" }
    },
    raw_body: "private-test-key Authorization Student essay sentinel.",
    messages: [{ content: "full prompt" }]
  };
  await assert.rejects(
    requestWithResponse(Response.json(sensitive, { status: 403 })),
    (error) => {
      const serialized = JSON.stringify({
        message: error.message,
        diagnostic: getOpenRouterErrorDiagnostic(error)
      });
      assert.doesNotMatch(
        serialized,
        /private-test-key|Authorization|Student essay sentinel|full prompt|raw_body|messages/
      );
      return true;
    }
  );
});

test("writing-review-ai log records provider diagnostics through wrapped causes", async () => {
  let providerError;
  try {
    await requestWithResponse(
      Response.json(
        {
          error: {
            code: 403,
            message: "Forbidden",
            metadata: {
              error_type: "permission_denied",
              provider_code: "workspace_restricted",
              provider_name: "Google"
            }
          }
        },
        { status: 403 }
      )
    );
  } catch (error) {
    providerError = error;
  }
  const wrapped = new Error("AI service unavailable", { cause: providerError });
  assert.equal(classifyWritingReviewAiError(wrapped), "openrouter_error");
  assert.deepEqual(writingReviewAiProviderDiagnostic(wrapped), {
    http_status: 403,
    provider_error_type: "permission_denied",
    provider_error_code: "workspace_restricted",
    provider_name: "Google"
  });

  const row = writingReviewAiLogDatabaseRow({
    request_id: "11111111-1111-4111-8111-111111111111",
    operation: "generate_ai",
    attempt_id: "attempt-1",
    task_type: "academic_discussion",
    model: "google/gemini-3.7-flash",
    prompt_version: "writing_review_prompt_test",
    schema_version: "2.2",
    status: "failed",
    pipeline_stage: "provider_request",
    error_type: "provider_error",
    error_code: "PROVIDER_HTTP_ERROR",
    elapsed_ms: 518,
    ...writingReviewAiProviderDiagnostic(wrapped)
  });
  assert.equal(row.http_status, 403);
  assert.equal(row.provider_error_type, "permission_denied");
  assert.equal(row.provider_error_code, "workspace_restricted");
  assert.equal(row.provider_name, "Google");
  assert.doesNotMatch(JSON.stringify(row), /Forbidden|private-test-key|Authorization/);
});
