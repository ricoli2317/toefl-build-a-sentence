const assert = require("node:assert/strict");
const { createSign, generateKeyPairSync } = require("node:crypto");
const { createClient } = require("@supabase/supabase-js");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { runStudentCatalogCriticalPath } = require("../lib/studentCatalogCriticalPath.server.ts");
const {
  createStudentPerformanceTrace,
  settleParallelResult,
  STUDENT_CATALOG_TIMING_PHASES
} = require("../lib/studentPerformance.server.ts");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function serverTimingEntries(trace) {
  const header = trace.finishHeaders().get("Server-Timing") ?? "";
  return header.split(/,\s*/).map((entry) => {
    const name = entry.slice(0, entry.indexOf(";"));
    const durationMs = Number(/(?:^|;)dur=([0-9.]+)/.exec(entry)?.[1] ?? Number.NaN);
    const description = /(?:^|;)desc="([^"]*)"/.exec(entry)?.[1] ?? "";
    return { description, durationMs, name };
  });
}

test("named catalog phases emit stable Server-Timing fields with real parallel durations", async () => {
  const trace = createStudentPerformanceTrace("/api/practice-catalog");

  const identity = trace.startPhase(STUDENT_CATALOG_TIMING_PHASES.authClaims, "auth");
  await delay(10);
  trace.recordPhase(identity);

  // The three phase blocks overlap exactly like the orchestrator: all started,
  // then awaited, so the header shows per-phase wall-clock time, not a sum.
  const publicCatalog = trace.startPhase(STUDENT_CATALOG_TIMING_PHASES.publicCatalog, "cache");
  const studentState = trace.startPhase(STUDENT_CATALOG_TIMING_PHASES.studentState, "database");
  const profile = trace.startPhase(STUDENT_CATALOG_TIMING_PHASES.profile, "database");
  const startedAt = performance.now();
  await Promise.all([
    delay(60).then(() => trace.recordPhase(publicCatalog)),
    delay(60).then(() => trace.recordPhase(studentState)),
    delay(60).then(() => trace.recordPhase(profile))
  ]);
  const parallelElapsedMs = performance.now() - startedAt;

  const merge = trace.startPhase(STUDENT_CATALOG_TIMING_PHASES.merge, "processing");
  await delay(2);
  trace.recordPhase(merge);

  const entries = serverTimingEntries(trace);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  for (const name of [
    STUDENT_CATALOG_TIMING_PHASES.authClaims,
    STUDENT_CATALOG_TIMING_PHASES.merge,
    STUDENT_CATALOG_TIMING_PHASES.profile,
    STUDENT_CATALOG_TIMING_PHASES.publicCatalog,
    STUDENT_CATALOG_TIMING_PHASES.studentState
  ]) {
    assert.ok(byName.has(name), `Server-Timing must expose ${name}`);
    assert.ok(byName.get(name).durationMs >= 0, `${name} duration must be real`);
  }
  assert.ok(byName.has("api_total"), "api_total stays present");
  assert.equal(entries.filter((entry) => entry.name === STUDENT_CATALOG_TIMING_PHASES.merge).length, 1);

  const total = byName.get("api_total").durationMs;
  assert.ok(
    parallelElapsedMs < 200,
    `three parallel 60ms phases must not serialize (took ${round(parallelElapsedMs)}ms)`
  );
  assert.ok(
    total < byName.get(STUDENT_CATALOG_TIMING_PHASES.publicCatalog).durationMs * 2.5,
    "total must be a wall-clock total, not a sum of the parallel phases"
  );
  for (const entry of entries) assert.match(entry.name, /^[a-zA-Z0-9_-]+$/);

  const header = trace.finishHeaders().get("Server-Timing") ?? "";
  for (const forbidden of ["student-1", "token", "email", "@", "Bearer"]) {
    assert.equal(header.includes(forbidden), false, `Server-Timing must not leak ${forbidden}`);
  }
});

test("a failed named phase is recorded once with its failure visible", async () => {
  const trace = createStudentPerformanceTrace("/api/reading/catalog");
  await assert.rejects(
    trace.phase(STUDENT_CATALOG_TIMING_PHASES.profile, async () => {
      await delay(2);
      throw new Error("profile query failed");
    }),
    /profile query failed/
  );

  const header = trace.finishHeaders({}, false).get("Server-Timing") ?? "";
  assert.equal((header.match(/(?:^|,\s*)profile;/g) ?? []).length, 1, "failure must not duplicate the phase row");
  assert.match(header, /api_total/);
});

test("settleParallelResult converts rejection into a value without unhandled rejection", async () => {
  const value = await settleParallelResult(Promise.resolve("catalog"));
  assert.deepEqual(value, { ok: true, value: "catalog" });

  const failure = await settleParallelResult(Promise.reject(new Error("state down")));
  assert.equal(failure.ok, false);
  assert.match(failure.error.message, /state down/);

  const settled = settleParallelResult(delay(10).then(() => {
    throw new Error("late data failure");
  }));
  await delay(40);
  const late = await settled;
  assert.equal(late.ok, false);
});

test("catalog critical path runs identity -> [catalog | state | profile] -> merge, not serially", async () => {
  const events = [];
  const trace = createStudentPerformanceTrace("/api/practice-catalog");
  const startedAt = performance.now();

  const result = await runStudentCatalogCriticalPath({
    timing: trace,
    identity: async () => {
      events.push("identity_start");
      await delay(10);
      events.push("identity_end");
      return { ok: true, userId: "student-1" };
    },
    loadCatalog: async () => {
      events.push("catalog_start");
      await delay(60);
      events.push("catalog_end");
      return { items: ["bas-1"] };
    },
    loadState: async () => {
      events.push("state_start");
      await delay(60);
      events.push("state_end");
      return { available: true, rows: [{ item_id: "bas-1", status: "completed" }] };
    },
    authorization: async () => {
      events.push("profile_start");
      await delay(60);
      events.push("profile_end");
      return { ok: true };
    },
    merge: async (catalog, state, userId) => {
      events.push("merge");
      assert.deepEqual(userId, "student-1");
      assert.deepEqual(catalog.value.items, ["bas-1"]);
      assert.equal(state.value.rows.length, 1);
      return { items: catalog.value.items, merged: true };
    }
  });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(result.forbidden, false);
  const data = result.data;
  assert.deepEqual(data, { items: ["bas-1"], merged: true });
  assert.deepEqual(events.slice(0, 2), ["identity_start", "identity_end"]);
  assert.ok(
    events.indexOf("identity_end") < events.indexOf("catalog_start"),
    "data loads must not start before identity verification"
  );
  for (const event of ["catalog_start", "state_start", "profile_start"]) {
    assert.ok(events.indexOf(event) < events.indexOf("catalog_end"), `${event} runs concurrently`);
    assert.ok(events.indexOf(event) < events.indexOf("state_end"), `${event} runs concurrently`);
  }
  assert.equal(events[events.length - 1], "merge");
  assert.ok(
    elapsedMs < 160,
    `critical path must be ~max(60ms) instead of 10 + 60 + 60 + 60 serial (took ${round(elapsedMs)}ms)`
  );

  const entries = serverTimingEntries(trace);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  assert.ok(byName.get(STUDENT_CATALOG_TIMING_PHASES.authClaims).durationMs >= 8);
  assert.ok(byName.get(STUDENT_CATALOG_TIMING_PHASES.profile).durationMs >= 50);
  assert.ok(byName.get(STUDENT_CATALOG_TIMING_PHASES.merge).durationMs < 50);
});

test("disabled student is rejected before any catalog or state data is returned", async () => {
  const events = [];
  const trace = createStudentPerformanceTrace("/api/reading/catalog");
  const result = await runStudentCatalogCriticalPath({
    timing: trace,
    identity: async () => ({ ok: true, userId: "student-disabled" }),
    loadCatalog: async () => {
      events.push("catalog_start");
      await delay(80);
      events.push("catalog_end");
      return { classified: "CLASSIFIED_CATALOG_PAYLOAD" };
    },
    loadState: async () => {
      events.push("state_start");
      await delay(80);
      events.push("state_end");
      return { classifiedState: "CLASSIFIED_STATE_PAYLOAD" };
    },
    authorization: async () => {
      events.push("profile_start");
      await delay(10);
      return { ok: false, status: 403, error: "Account disabled" };
    },
    merge: async () => {
      events.push("merge");
      return { leaked: true };
    }
  });

  assert.equal(result.forbidden, true);
  assert.equal(result.status, 403);
  assert.equal(result.error, "Account disabled");
  assert.equal("data" in result, false, "rejection must not carry a data payload");
  assert.equal(events.includes("merge"), false, "merge must not run for a rejected profile");
  assert.deepEqual(events.slice(0, 3), ["catalog_start", "state_start", "profile_start"]);
  // The preloads were still running when the rejection was produced, then
  // settled in the background without changing the outcome.
  await delay(120);
  assert.deepEqual(events.slice(-2), ["catalog_end", "state_end"]);
});

test("profile failure is fail-fast: the gate returns before the long catalog/state preloads settle", async () => {
  const events = [];
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const startedAt = performance.now();
    const result = await runStudentCatalogCriticalPath({
      timing: createStudentPerformanceTrace("/api/practice-catalog"),
      identity: async () => {
        events.push("identity");
        return { ok: true, userId: "student-disabled" };
      },
      loadCatalog: async () => {
        events.push("catalog_start");
        await delay(300);
        events.push("catalog_end");
        return { classified: "CLASSIFIED_CATALOG_PAYLOAD" };
      },
      loadState: async () => {
        events.push("state_start");
        await delay(300);
        events.push("state_end");
        throw new Error("late sparse state failure after the gate");
      },
      authorization: async () => {
        events.push("profile_start");
        await delay(5);
        return { ok: false, status: 403, error: "Account disabled" };
      },
      merge: async () => {
        events.push("merge");
        return { leaked: true };
      }
    });
    const elapsedMs = performance.now() - startedAt;

    assert.equal(result.forbidden, true);
    assert.equal(result.status, 403);
    assert.equal(result.error, "Account disabled");
    assert.equal("data" in result, false, "rejection must not carry a data payload");
    assert.equal(events.includes("merge"), false, "merge must not run when the profile gate fails");
    // The three loads were started together before the gate was awaited, and
    // the result arrived right after the 5ms profile failure.
    assert.deepEqual(events.slice(0, 4), ["identity", "catalog_start", "state_start", "profile_start"]);
    assert.ok(
      elapsedMs < 150,
      `fail-fast expected after ~5ms profile; got ${round(elapsedMs)}ms, so the gate awaited the 300ms preloads`
    );
    assert.equal(events.includes("catalog_end"), false, "catalog must still be in flight at response time");
    assert.equal(events.includes("state_end"), false, "state must still be in flight at response time");

    // The preloaded reads keep running in the background and settle later (the
    // state read even rejects) without blocking the response, changing the
    // outcome, or producing unhandled rejections.
    await delay(400);
    assert.deepEqual(
      events.filter((event) => event === "catalog_end" || event === "state_end").sort(),
      ["catalog_end", "state_end"]
    );
    assert.deepEqual(unhandled, [], "settled preloads must not produce unhandled rejections");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("invalid identity and wrong-role teacher never start the data loads", async () => {
  const events = [];
  const trace = createStudentPerformanceTrace("/api/reading/full-sets");
  const result = await runStudentCatalogCriticalPath({
    timing: trace,
    identity: async () => ({ ok: false, status: 401, error: "Invalid session" }),
    loadCatalog: async () => {
      events.push("catalog_start");
      return [];
    },
    loadState: async () => {
      events.push("state_start");
      return { available: true, rows: [] };
    },
    authorization: async () => {
      events.push("profile_start");
      return { ok: true };
    },
    merge: async () => {
      events.push("merge");
      return {};
    }
  });
  assert.equal(result.forbidden, true);
  assert.equal(result.status, 401);
  assert.deepEqual(events, [], "no profile or data read may start on an invalid JWT");

  const teacherResult = await runStudentCatalogCriticalPath({
    timing: createStudentPerformanceTrace("/api/practice-catalog"),
    identity: async () => ({ ok: true, userId: "teacher-1" }),
    loadCatalog: async () => {
      events.push("teacher_catalog_start");
      return [];
    },
    loadState: async () => {
      events.push("teacher_state_start");
      return { available: true, rows: [] };
    },
    authorization: async () => ({ ok: false, status: 403, error: "Unauthorized" }),
    merge: async () => {
      events.push("teacher_merge");
      return {};
    }
  });
  assert.equal(teacherResult.forbidden, true);
  assert.equal(teacherResult.status, 403);
  assert.equal(events.includes("teacher_merge"), false);
  // Parallel internal reads may start, but their data is never merged/returned.
  assert.equal("data" in teacherResult, false);
});

test("catalog and state failures keep their error semantics after the gate", async () => {
  const trace = createStudentPerformanceTrace("/api/practice-catalog");
  await assert.rejects(
    runStudentCatalogCriticalPath({
      timing: trace,
      identity: async () => ({ ok: true, userId: "student-1" }),
      loadCatalog: async () => {
        throw new Error("catalog read failed");
      },
      loadState: async () => ({ available: true, rows: [] }),
      authorization: async () => ({ ok: true }),
      merge: async (catalog, state) => {
        if (!catalog.ok) throw catalog.error;
        if (!state.ok) throw state.error;
        return {};
      }
    }),
    /catalog read failed/
  );

  // A rejected profile gate must hide the data failure instead.
  const hidden = await runStudentCatalogCriticalPath({
    timing: createStudentPerformanceTrace("/api/practice-catalog"),
    identity: async () => ({ ok: true, userId: "student-1" }),
    loadCatalog: async () => {
      throw new Error("classified catalog failure");
    },
    loadState: async () => ({ available: true, rows: [] }),
    authorization: async () => ({ ok: false, status: 401, error: "Account configuration error" }),
    merge: async () => ({ leaked: true })
  });
  assert.equal(hidden.forbidden, true);
  assert.equal(hidden.error, "Account configuration error");
  assert.equal("data" in hidden, false);
});

test("auth split keeps identity local and the catalog profile read minimal", () => {
  const auth = read("lib/auth.ts");

  // Stage 1 verifies locally against the cached JWKS and only then exposes sub.
  assert.match(auth, /export async function verifyAuthenticatedIdentity/);
  assert.match(auth, /getCachedSupabaseJwks/);
  assert.match(auth, /getClaims\(token, jwks \? \{ jwks \} : undefined\)/);
  const identity = auth.match(/export async function verifyAuthenticatedIdentity[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(identity.length > 0);
  assert.doesNotMatch(identity, /from\("profiles"\)/, "identity stage must not read profiles");

  // Stage 2 reads role/is_active from the database on every request.
  assert.match(auth, /select: "role,is_active"/);
  assert.match(auth, /profile\.is_active === false/);
  assert.match(auth, /roleCanAccess\(authorization\.role, "student"\)/);
  // No cross-request caching of the profile authorization.
  assert.doesNotMatch(auth, /unstable_cache/);
  assert.doesNotMatch(auth, /globalThis\.__/);

  // Existing callers keep their exact semantics.
  assert.match(auth, /select: "role,is_active,full_name,email"/);
  assert.match(auth, /account\.role !== "teacher"/);
  assert.match(auth, /Admin is a platform manager/);
  assert.match(auth, /export async function requireUserWithRole/);
  assert.match(auth, /export async function requireAuthenticatedAccount/);
  assert.match(auth, /export async function requireTeacherOnly/);
  assert.match(auth, /export async function requireAdmin/);
  // requireAuthenticatedAccount goes through the same two-stage helpers.
  const account = auth.match(/export async function requireAuthenticatedAccount[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(account, /verifyAuthenticatedIdentity/);
  assert.match(account, /loadAccountAuthorization/);
});

test("the three catalog routes share the orchestrator and keep the sparse state read", () => {
  const routes = {
    "/api/practice-catalog": "app/api/practice-catalog/route.ts",
    "/api/reading/catalog": "app/api/reading/catalog/route.ts",
    "/api/reading/full-sets": "app/api/reading/full-sets/route.ts"
  };
  for (const [route, file] of Object.entries(routes)) {
    const source = read(file);
    assert.match(source, /createStudentPerformanceTrace/, `${route} must create a trace`);
    assert.match(source, /runStudentCatalogCriticalPath\(/, `${route} must use the shared gate`);
    assert.match(source, /verifyAuthenticatedIdentity\(token, timing\)/, `${route} verifies identity first`);
    assert.match(source, /loadStudentCatalogAuthorization\(token, userId, timing\)/, `${route} gates on the database profile`);
    assert.match(source, /timing\.finishHeaders/, `${route} must emit Server-Timing on every response`);
    assert.match(source, /loadStudentPracticeItemStates/, `${route} must use the sparse state read`);
    assert.doesNotMatch(source, /\.from\("attempts"\)/, `${route} must not scan attempts`);
    const fallbackIndex = source.indexOf("Transitional fallback");
    const attemptScanIndex = source.indexOf('.from("reading_attempts")');
    if (attemptScanIndex >= 0) {
      assert.ok(fallbackIndex > 0, `${route} keeps the explicit transitional fallback`);
      assert.ok(attemptScanIndex > fallbackIndex, `${route} attempt scan is fallback-only`);
    }
  }

  // The shared helper is the only place that starts the parallel loads and
  // enforces the profile gate ordering.
  const helper = read("lib/studentCatalogCriticalPath.server.ts");
  assert.match(helper, /STUDENT_CATALOG_TIMING_PHASES\.authClaims/);
  assert.match(helper, /STUDENT_CATALOG_TIMING_PHASES\.publicCatalog/);
  assert.match(helper, /STUDENT_CATALOG_TIMING_PHASES\.studentState/);
  assert.match(helper, /STUDENT_CATALOG_TIMING_PHASES\.profile/);
  assert.match(helper, /STUDENT_CATALOG_TIMING_PHASES\.merge/);
  assert.ok(
    helper.indexOf("settleParallelResult") < helper.indexOf("STUDENT_CATALOG_TIMING_PHASES.profile"),
    "catalog/state must start before the profile gate is awaited"
  );
  assert.ok(
    helper.indexOf("if (!authorization.ok)") < helper.indexOf("input.merge("),
    "merge must run only after the profile gate"
  );
  assert.doesNotMatch(helper, /\[(studentId|token|email)\]/, "the shared helper never handles identity material");
});

test("JWT claims verification stays local when the cached JWKS carries the signing key", async () => {
  const keyPair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = keyPair.publicKey.export({ format: "jwk" });
  const kid = "test-key-1";
  const claims = {
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000) - 10,
    role: "authenticated",
    sub: "11111111-1111-1111-1111-111111111111"
  };
  const header = { alg: "ES256", kid, typ: "JWT" };
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode(header)}.${encode(claims)}`;
  const signature = createSign("sha256")
    .update(signingInput)
    .sign({ dsaEncoding: "ieee-p1363", key: keyPair.privateKey });
  const token = `${signingInput}.${signature.toString("base64url")}`;

  let fetchCalls = 0;
  const client = createClient("http://localhost:54321", "anon-key", {
    auth: { persistSession: false },
    global: {
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("network must not be used for cached-JWKS claim verification");
      }
    }
  });

  const result = await client.auth.getClaims(token, { jwks: { keys: [{ ...jwk, kid }] } });
  assert.equal(result.error, null);
  assert.equal(result.data.claims.sub, claims.sub);
  assert.equal(fetchCalls, 0, "cached JWKS verification must not hit the network");

  const invalid = await createClient("http://localhost:54321", "anon-key", {
    auth: { persistSession: false }
  }).auth.getClaims(`${token.slice(0, -2)}xx`, { jwks: { keys: [{ ...jwk, kid }] } });
  assert.ok(invalid.error, "a tampered signature must fail verification");
});
