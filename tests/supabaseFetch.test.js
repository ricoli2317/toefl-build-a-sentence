const test = require("node:test");
const assert = require("node:assert/strict");

async function loadModule() {
  return import("../lib/supabase/fetch.ts");
}

test("Supabase reads use no-store and recover after one transient response", async () => {
  const { createSupabaseFetch } = await loadModule();
  const calls = [];
  const responses = [new Response("temporary", { status: 503 }), new Response("ok")];
  const request = createSupabaseFetch({
    fetchImpl: async (_input, init) => {
      calls.push(init);
      return responses.shift();
    },
    retryDelayMs: 0,
    sleep: async () => {}
  });

  const response = await request("https://example.test/rest/v1/items");
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((init) => init.cache), ["no-store", "no-store"]);
});

test("Supabase retry does not replay writes or auth/permission/business errors", async () => {
  const { createSupabaseFetch } = await loadModule();
  for (const [method, status] of [["POST", 503], ["GET", 401], ["GET", 403], ["GET", 422]]) {
    let calls = 0;
    const request = createSupabaseFetch({
      fetchImpl: async () => {
        calls += 1;
        return new Response("failure", { status });
      },
      retryDelayMs: 0,
      sleep: async () => {}
    });
    const response = await request("https://example.test/rest/v1/items", { method });
    assert.equal(response.status, status);
    assert.equal(calls, 1, `${method} ${status} must not retry`);
  }
});

test("Supabase read retries one network failure but never retries an abort", async () => {
  const { createSupabaseFetch } = await loadModule();
  let networkCalls = 0;
  const recover = createSupabaseFetch({
    fetchImpl: async () => {
      networkCalls += 1;
      if (networkCalls === 1) throw new TypeError("network unavailable");
      return new Response("ok");
    },
    retryDelayMs: 0,
    sleep: async () => {}
  });
  assert.equal((await recover("https://example.test/rest/v1/items")).status, 200);
  assert.equal(networkCalls, 2);

  let abortCalls = 0;
  const aborted = createSupabaseFetch({
    fetchImpl: async () => {
      abortCalls += 1;
      throw new DOMException("aborted", "AbortError");
    },
    retryDelayMs: 0,
    sleep: async () => {}
  });
  await assert.rejects(aborted("https://example.test/rest/v1/items"), /aborted/);
  assert.equal(abortCalls, 1);
});
