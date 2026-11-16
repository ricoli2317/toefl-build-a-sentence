const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const shared = require("../lib/practiceEntitlements.ts");
const server = require("../lib/practiceEntitlements.server.ts");

const {
  MAX_PRACTICE_ENTITLEMENT_REMAINING,
  PRACTICE_ENTITLEMENT_GROUPS,
  PRACTICE_ENTITLEMENT_KINDS,
  PRACTICE_ENTITLEMENT_LABELS,
  mapPracticeEntitlementError,
  mapPracticeEntitlementRows,
  validatePracticeEntitlementFormValues,
  validatePracticeEntitlementValues
} = shared;

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

function snapshotRows(overrides = {}) {
  return PRACTICE_ENTITLEMENT_KINDS.map((kind, index) => {
    const defaultValue = index < 6 ? 5 : 3;
    const override = Object.hasOwn(overrides, kind) ? overrides[kind] : undefined;
    return {
      entitlement_kind: kind,
      remaining: override ?? defaultValue,
      default_remaining: defaultValue,
      is_explicit: override !== undefined,
      updated_at: override !== undefined ? "2026-11-14T00:00:00.000Z" : null,
      updated_by: override !== undefined ? "admin-id" : null
    };
  });
}

function rpcDb(responder) {
  const calls = [];
  return {
    calls,
    async rpc(name, args) {
      calls.push([name, args]);
      return responder(name, args);
    }
  };
}

test("exactly eight entitlement kinds are grouped and labelled; defaults stay database-only", () => {
  assert.deepEqual(PRACTICE_ENTITLEMENT_KINDS, [
    "build_sentence",
    "email",
    "academic_discussion",
    "ctw",
    "rdl",
    "rap",
    "bas_category",
    "rap_category"
  ]);
  assert.equal(Object.keys(PRACTICE_ENTITLEMENT_LABELS).length, 8);
  assert.deepEqual(
    PRACTICE_ENTITLEMENT_GROUPS.flatMap((group) => [...group.kinds]),
    [...PRACTICE_ENTITLEMENT_KINDS]
  );
  assert.equal(PRACTICE_ENTITLEMENT_GROUPS[0].kinds.length, 6);
  assert.equal(PRACTICE_ENTITLEMENT_GROUPS[1].kinds.length, 2);
  // No initial balance is duplicated in application code.
  assert.equal(Object.hasOwn(shared, "PRACTICE_ENTITLEMENT_DEFAULTS"), false);
  assert.doesNotMatch(read("lib/practiceEntitlements.ts"), /default_remaining\s*:\s*\d/);
});

test("server value validation accepts 0, defaults, larger values and partial saves", () => {
  assert.deepEqual(validatePracticeEntitlementValues({ build_sentence: 0 }), {
    ok: true,
    values: { build_sentence: 0 }
  });
  assert.deepEqual(validatePracticeEntitlementValues({ email: 5 }), {
    ok: true,
    values: { email: 5 }
  });
  assert.deepEqual(validatePracticeEntitlementValues({ ctw: 12 }), {
    ok: true,
    values: { ctw: 12 }
  });
  assert.deepEqual(
    validatePracticeEntitlementValues({
      build_sentence: 0,
      email: 9,
      academic_discussion: 1,
      ctw: 2,
      rdl: 3,
      rap: 4,
      bas_category: 3,
      rap_category: 7
    }).ok,
    true
  );
});

test("server value validation rejects negative, fractional, string, boolean and unknown values", () => {
  for (const values of [
    {},
    { build_sentence: -1 },
    { build_sentence: 1.5 },
    { build_sentence: "5" },
    { build_sentence: true },
    { build_sentence: null },
    { build_sentence: Number.NaN },
    { build_sentence: Number.POSITIVE_INFINITY },
    { build_sentence: MAX_PRACTICE_ENTITLEMENT_REMAINING + 1 },
    { full_set: 1 },
    { build_sentence: 1, unknown: 2 }
  ]) {
    assert.equal(validatePracticeEntitlementValues(values).ok, false, JSON.stringify(values));
  }
  assert.match(
    validatePracticeEntitlementValues({ full_set: 1 }).error,
    /未知的练习额度类型/
  );
  assert.match(
    validatePracticeEntitlementValues({ build_sentence: -1 }).error,
    /0 或正整数/
  );
});

test("Admin form validation parses all eight integer inputs and rejects invalid text", () => {
  const valid = Object.fromEntries(
    PRACTICE_ENTITLEMENT_KINDS.map((kind, index) => [kind, String(index)])
  );
  assert.equal(validatePracticeEntitlementFormValues(valid).ok, true);
  assert.deepEqual(validatePracticeEntitlementFormValues(valid).values, {
    build_sentence: 0,
    email: 1,
    academic_discussion: 2,
    ctw: 3,
    rdl: 4,
    rap: 5,
    bas_category: 6,
    rap_category: 7
  });
  for (const raw of ["", " ", "-1", "1.5", "1e3", "abc", "+1", "１"]) {
    const draft = { ...valid, build_sentence: raw };
    assert.equal(validatePracticeEntitlementFormValues(draft).ok, false, raw);
  }
  const missing = { ...valid };
  delete missing.rap_category;
  assert.equal(validatePracticeEntitlementFormValues(missing).ok, false);
  assert.equal(
    validatePracticeEntitlementFormValues({
      ...valid,
      build_sentence: String(MAX_PRACTICE_ENTITLEMENT_REMAINING + 1)
    }).ok,
    false
  );
});

test("snapshot mapping preserves canonical order and rejects missing/duplicate/bad rows", () => {
  const rows = mapPracticeEntitlementRows(snapshotRows({ build_sentence: 0, email: 8 }));
  assert.deepEqual(rows.map((row) => row.kind), [...PRACTICE_ENTITLEMENT_KINDS]);
  assert.equal(rows[0].remaining, 0);
  assert.equal(rows[0].isExplicit, true);
  assert.equal(rows[1].remaining, 8);
  assert.equal(rows[2].remaining, 5);
  assert.equal(rows[2].isExplicit, false);

  assert.throws(() => mapPracticeEntitlementRows(null));
  assert.throws(() => mapPracticeEntitlementRows(snapshotRows().slice(1)));
  assert.throws(() =>
    mapPracticeEntitlementRows([...snapshotRows(), snapshotRows()[0]])
  );
  assert.throws(() =>
    mapPracticeEntitlementRows(
      snapshotRows().map((row, index) =>
        index === 0 ? { ...row, remaining: -1 } : row
      )
    )
  );
  assert.throws(() =>
    mapPracticeEntitlementRows(
      snapshotRows().map((row, index) =>
        index === 0 ? { ...row, remaining: 1.5 } : row
      )
    )
  );
  assert.throws(() =>
    mapPracticeEntitlementRows(
      snapshotRows().map((row, index) =>
        index === 0 ? { ...row, is_explicit: "true" } : row
      )
    )
  );
});

test("RPC errors map to stable HTTP responses without leaking database text", () => {
  assert.equal(mapPracticeEntitlementError({ message: "ADMIN_REQUIRED" }, "fallback").status, 403);
  assert.equal(mapPracticeEntitlementError({ message: "STUDENT_NOT_FOUND" }, "fallback").status, 404);
  assert.equal(
    mapPracticeEntitlementError({ message: "INVALID_ENTITLEMENT_KIND" }, "fallback").status,
    400
  );
  assert.equal(
    mapPracticeEntitlementError({ message: "INVALID_ENTITLEMENT_VALUE" }, "fallback").status,
    400
  );
  assert.equal(
    mapPracticeEntitlementError({ message: "INVALID_ENTITLEMENT_PAYLOAD" }, "fallback").status,
    400
  );
  assert.equal(mapPracticeEntitlementError({ message: "UNAUTHENTICATED" }, "fallback").status, 401);
  assert.equal(mapPracticeEntitlementError({ message: "STUDENT_REQUIRED" }, "fallback").status, 403);
  assert.equal(
    mapPracticeEntitlementError({ code: "PGRST202", message: "Could not find the function" }, "fallback").status,
    503
  );
  assert.equal(mapPracticeEntitlementError({ code: "42501", message: "permission denied" }, "fallback").status, 503);
  const generic = mapPracticeEntitlementError({ message: "internal detail" }, "fallback");
  assert.deepEqual(generic, { status: 500, message: "fallback" });
  assert.doesNotMatch(generic.message, /internal detail/);
});

test("server helpers use the caller-token RPCs and return only mapped snapshots", async () => {
  const rows = snapshotRows({ build_sentence: 0 });
  const loadDb = rpcDb(() => ({ data: rows, error: null }));
  const loaded = await server.loadAdminStudentPracticeEntitlements(loadDb, "student-1");
  assert.equal(loaded.ok, true);
  assert.equal(loaded.entitlements[0].remaining, 0);
  assert.deepEqual(loadDb.calls, [
    ["admin_get_student_practice_entitlements", { p_student_id: "student-1" }]
  ]);

  const saveDb = rpcDb(() => ({ data: rows, error: null }));
  const saved = await server.saveAdminStudentPracticeEntitlements(
    saveDb,
    "student-1",
    { build_sentence: 0 },
    "manual"
  );
  assert.equal(saved.ok, true);
  assert.deepEqual(saveDb.calls, [
    [
      "admin_set_student_practice_entitlements",
      { p_student_id: "student-1", p_values: { build_sentence: 0 }, p_reason: "manual" }
    ]
  ]);

  const ownDb = rpcDb(() => ({ data: rows, error: null }));
  const own = await server.loadOwnStudentPracticeEntitlements(ownDb);
  assert.equal(own.ok, true);
  assert.equal(ownDb.calls[0][0], "student_practice_entitlements_self");
  assert.equal(ownDb.calls[0][1], undefined);

  const denied = await server.loadAdminStudentPracticeEntitlements(
    rpcDb(() => ({ data: null, error: { message: "ADMIN_REQUIRED" } })),
    "student-1"
  );
  assert.deepEqual(denied, {
    ok: false,
    status: 403,
    message: "仅管理员可以管理练习权限。"
  });

  const malformed = await server.loadAdminStudentPracticeEntitlements(
    rpcDb(() => ({ data: rows.slice(0, 7), error: null })),
    "student-1"
  );
  assert.equal(malformed.ok, false);
  assert.equal(malformed.status, 500);
});

function loadRoute(routePath, role, dbResponder) {
  const calls = { clients: [], rpc: [] };
  const db = {
    async rpc(name, args) {
      calls.rpc.push([name, args]);
      return dbResponder(name, args);
    }
  };
  const auth = {
    bearerToken(request) {
      const header = request.headers.get("authorization");
      return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
    },
    async requireAdmin(token) {
      if (!token || role !== "admin") {
        return { error: "Forbidden", userId: null, role };
      }
      return { error: null, userId: "admin-id", role: "admin" };
    },
    async requireAuthenticatedAccount(token) {
      if (!token) return { error: "Missing", userId: null, role: null };
      if (role === "admin" || role === "teacher" || role === "student") {
        return { error: null, userId: `${role}-id`, role };
      }
      return { error: "Invalid", userId: null, role: null };
    }
  };
  const modules = {
    "next/server": {
      NextResponse: { json: (body, init) => Response.json(body, init) }
    },
    "@/lib/auth": auth,
    "@/lib/supabase/server": {
      createAnonSupabase(token) {
        calls.clients.push(token);
        return db;
      },
      createServiceSupabase() {
        calls.clients.push("service");
        return {};
      }
    },
    "@/lib/practiceEntitlements": shared,
    "@/lib/practiceEntitlements.server": {
      ...server,
      async loadPracticeEntitlementEnforcementEnabled() {
        return false;
      }
    }
  };
  const compiled = ts.transpileModule(read(routePath), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  const loadedModule = { exports: {} };
  new Function("require", "module", "exports", compiled)((name) => {
    assert.ok(modules[name], `Unexpected dependency: ${name}`);
    return modules[name];
  }, loadedModule, loadedModule.exports);
  return { api: loadedModule.exports, calls };
}

function request(pathName, { method = "GET", body, token = "valid" } = {}) {
  return new Request(`https://local.test${pathName}`, {
    method,
    headers: token
      ? { authorization: `Bearer ${token}`, "content-type": "application/json" }
      : { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
}

const ADMIN_ROUTE = "app/api/admin/students/[studentId]/practice-entitlements/route.ts";
const STUDENT_ROUTE = "app/api/student/practice-entitlements/route.ts";
const STUDENT_ID = "20000000-0000-4000-8000-000000000001";

test("Admin entitlement API rejects non-admins before creating any database client", async () => {
  for (const role of ["student", "teacher"]) {
    const { api, calls } = loadRoute(ADMIN_ROUTE, role, () => ({
      data: snapshotRows(),
      error: null
    }));
    const getResponse = await api.GET(request(`/api/admin/students/${STUDENT_ID}/practice-entitlements`), {
      params: { studentId: STUDENT_ID }
    });
    const patchResponse = await api.PATCH(
      request(`/api/admin/students/${STUDENT_ID}/practice-entitlements`, {
        method: "PATCH",
        body: { entitlements: { build_sentence: 0 } }
      }),
      { params: { studentId: STUDENT_ID } }
    );
    assert.equal(getResponse.status, 403);
    assert.equal(patchResponse.status, 403);
    assert.equal(calls.clients.length, 0);
    assert.equal(calls.rpc.length, 0);
  }
});

test("Admin entitlement GET loads one student snapshot through the Admin RPC", async () => {
  const { api, calls } = loadRoute(ADMIN_ROUTE, "admin", () => ({
    data: snapshotRows({ build_sentence: 0 }),
    error: null
  }));
  const response = await api.GET(
    request(`/api/admin/students/${STUDENT_ID}/practice-entitlements`),
    { params: { studentId: STUDENT_ID } }
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  const payload = await response.json();
  assert.equal(payload.studentId, STUDENT_ID);
  assert.equal(payload.entitlements.length, 8);
  assert.equal(payload.entitlements[0].remaining, 0);
  assert.deepEqual(calls.rpc, [
    ["admin_get_student_practice_entitlements", { p_student_id: STUDENT_ID }]
  ]);
});

test("Admin entitlement PATCH validates locally and saves through the atomic RPC", async () => {
  const { api, calls } = loadRoute(ADMIN_ROUTE, "admin", () => ({
    data: snapshotRows({ build_sentence: 0, email: 8 }),
    error: null
  }));

  const invalid = await api.PATCH(
    request(`/api/admin/students/${STUDENT_ID}/practice-entitlements`, {
      method: "PATCH",
      body: { entitlements: { build_sentence: -1 } }
    }),
    { params: { studentId: STUDENT_ID } }
  );
  assert.equal(invalid.status, 400);
  assert.equal(calls.rpc.length, 0);

  const response = await api.PATCH(
    request(`/api/admin/students/${STUDENT_ID}/practice-entitlements`, {
      method: "PATCH",
      body: {
        entitlements: { build_sentence: 0, email: 8 },
        reason: "manual"
      }
    }),
    { params: { studentId: STUDENT_ID } }
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.deepEqual(calls.rpc, [
    [
      "admin_set_student_practice_entitlements",
      {
        p_student_id: STUDENT_ID,
        p_values: { build_sentence: 0, email: 8 },
        p_reason: "manual"
      }
    ]
  ]);
});

test("Admin entitlement API maps database role rejection and invalid ids", async () => {
  const denied = loadRoute(ADMIN_ROUTE, "admin", () => ({
    data: null,
    error: { message: "ADMIN_REQUIRED", code: "P0001" }
  }));
  const deniedResponse = await denied.api.GET(
    request(`/api/admin/students/${STUDENT_ID}/practice-entitlements`),
    { params: { studentId: STUDENT_ID } }
  );
  assert.equal(deniedResponse.status, 403);

  const validRoute = loadRoute(ADMIN_ROUTE, "admin", () => ({
    data: snapshotRows(),
    error: null
  }));
  const invalidId = await validRoute.api.GET(
    request("/api/admin/students/not-a-uuid/practice-entitlements"),
    { params: { studentId: "not-a-uuid" } }
  );
  assert.equal(invalidId.status, 400);
  assert.equal(validRoute.calls.clients.length, 0);
});

test("Student self-read API is student-only, read-only and never accepts a target id", async () => {
  for (const role of ["teacher", "admin"]) {
    const { api, calls } = loadRoute(STUDENT_ROUTE, role, () => ({
      data: snapshotRows(),
      error: null
    }));
    const response = await api.GET(request("/api/student/practice-entitlements"));
    assert.equal(response.status, 403);
    assert.equal(calls.clients.length, 0);
  }

  const { api, calls } = loadRoute(STUDENT_ROUTE, "student", () => ({
    data: snapshotRows({ build_sentence: 0 }),
    error: null
  }));
  assert.equal(api.POST, undefined);
  assert.equal(api.PATCH, undefined);
  assert.equal(api.PUT, undefined);
  assert.equal(api.DELETE, undefined);
  const response = await api.GET(request("/api/student/practice-entitlements?student_id=other"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  const payload = await response.json();
  assert.equal(payload.entitlements.length, 8);
  assert.equal(payload.enforcementEnabled, false);
  assert.equal(payload.viewerRole, "student");
  assert.deepEqual(calls.rpc, [["student_practice_entitlements_self", undefined]]);
});

test("Student self-read API requires login and rejects malformed snapshots", async () => {
  const unauthenticated = loadRoute(STUDENT_ROUTE, "student", () => ({
    data: snapshotRows(),
    error: null
  }));
  const unauthenticatedResponse = await unauthenticated.api.GET(
    request("/api/student/practice-entitlements", { token: "" })
  );
  assert.equal(unauthenticatedResponse.status, 401);
  assert.equal(unauthenticated.calls.clients.length, 0);

  const malformed = loadRoute(STUDENT_ROUTE, "student", () => ({
    data: snapshotRows().slice(0, 1),
    error: null
  }));
  const malformedResponse = await malformed.api.GET(
    request("/api/student/practice-entitlements")
  );
  assert.equal(malformedResponse.status, 500);
});

test("Admin Students list keeps rename/status and loads entitlements only on panel open", () => {
  const admin = read("components/admin/AdminStudents.tsx");
  const panel = read("components/admin/StudentPracticeEntitlementsPanel.tsx");

  assert.match(admin, /import \{ StudentPracticeEntitlementsPanel \}/);
  assert.match(admin, /练习权限/);
  assert.match(admin, /InlineStudentNameEditor/);
  assert.match(admin, /AccountStatusControl/);
  assert.match(admin, /AccountTabs/);
  assert.match(admin, /await load\(\)/);
  assert.match(admin, /publishCacheInvalidation/);
  // The list itself never calls the entitlement endpoint.
  assert.doesNotMatch(admin, /practice-entitlements/);

  assert.match(panel, /useEffect\(\(\) => \{\s*void load\(\);\s*\}, \[load\]\)/);
  assert.match(panel, /practice-entitlements/);
  assert.match(panel, /validatePracticeEntitlementFormValues/);
  assert.match(panel, /setRows\(payload\.entitlements\)/);
  assert.match(panel, /setDraft\(draftFromRows\(payload\.entitlements\)\)/);
  assert.match(panel, /role="alert"/);
  assert.match(panel, /role="status"/);
  assert.match(panel, /保存额度/);
  assert.match(panel, /defaultRemaining/);
});
