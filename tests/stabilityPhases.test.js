const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { compileComponent, hookHarness, jsxRuntime, nodes, text, flush, deferred } = require("./fixtures/componentHarness.js");
const { fetchReadingFullSetWithSession, ReadingFullSetSessionError } = require("../lib/reading/fullSetClientSession.ts");
const { ReadingFullSetOccurrenceCache } = require("../lib/reading/fullSetOccurrenceCache.client.ts");
const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const response = (body = {}, status = 200) => new Response(JSON.stringify(body), { status });

function singletonFixture(browser = {}) {
  const constructions = [];
  const createClient = (url, key, options) => {
    let session = null;
    const listeners = new Set();
    const emit = event => { for (const listener of listeners) listener(event, session); };
    const client = {
      auth: {
        async signInWithPassword({ email }) {
          session = { access_token: `mock-${email}`, user: { id: email } };
          emit("SIGNED_IN");
          return { data: { session, user: session.user }, error: null };
        },
        async getSession() { return { data: { session }, error: null }; },
        async refreshSession() {
          session = { ...session, access_token: "mock-refreshed" };
          emit("TOKEN_REFRESHED");
          return { data: { session }, error: null };
        },
        async signOut() { session = null; emit("SIGNED_OUT"); return { error: null }; },
        onAuthStateChange(callback) {
          listeners.add(callback);
          return { data: { subscription: { unsubscribe: () => listeners.delete(callback) } } };
        }
      }
    };
    constructions.push({ url, key, options, client, listeners });
    return client;
  };
  const load = (...windows) => compileComponent("lib/supabase/client.ts", {
    "@supabase/supabase-js": { createClient },
    "./fetch.ts": { createSupabaseFetch: () => () => { throw new Error("No network allowed"); } }
  }, {
    window: windows.length ? windows[0] : browser,
    process: { env: { NEXT_PUBLIC_SUPABASE_URL: "https://project.example.invalid", NEXT_PUBLIC_SUPABASE_ANON_KEY: "mock-publishable" } }
  });
  return { load, constructions, browser };
}

test("browser singleton survives module reloads; separate pages stay separate and SSR cannot share clients", () => {
  const f = singletonFixture();
  const first = f.load().createBrowserSupabase();
  for (let i = 0; i < 20; i++) assert.strictEqual(f.load().createBrowserSupabase(), first);
  assert.equal(f.constructions.length, 1);
  assert.deepEqual(Object.keys(f.constructions[0].options), ["global"]); // SDK Auth defaults untouched.
  assert.notStrictEqual(f.load({}).createBrowserSupabase(), first);
  assert.equal(f.constructions.length, 2);
  assert.throws(() => f.load(undefined).createBrowserSupabase(), /cannot be used on the server/);
});

test("writing, login, reading and logout share even an in-memory-only session across account changes", async () => {
  const f = singletonFixture();
  const factory = f.load();
  const writing = compileComponent("lib/writingClientSession.ts", { "@/lib/supabase/client": factory });
  const client = factory.createBrowserSupabase();
  assert.strictEqual(writing.getWritingClient(), client);
  await client.auth.signInWithPassword({ email: "mock-first-user" });
  assert.equal((await writing.getWritingClientSession()).studentId, "mock-first-user");
  await client.auth.refreshSession();
  assert.equal((await writing.getWritingClientSession()).accessToken, "mock-refreshed");
  await client.auth.signInWithPassword({ email: "mock-second-user" });
  assert.equal((await writing.getWritingClientSession()).studentId, "mock-second-user");
  await writing.signOutWritingClientSession();
  assert.equal((await client.auth.getSession()).data.session, null);
  assert.equal(await writing.getWritingClientSession(), null);
  assert.equal(f.constructions.length, 1);
});

test("all browser instantiation goes through the factory; existing Auth subscriptions retain cleanup", () => {
  const visit = dir => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? visit(`${dir}/${entry.name}`) : /\.(ts|tsx)$/.test(entry.name) ? [`${dir}/${entry.name}`] : []);
  const files = [...visit("components"), ...visit("app").filter(file => !file.startsWith("app/api/")), ...visit("lib")];
  for (const file of files) {
    const source = read(file);
    if (source.includes('"use client"') && file !== "lib/supabase/client.ts") {
      assert.doesNotMatch(source, /\bcreateClient\s*\(|new (?:SupabaseClient|GoTrueClient)\s*\(/, file);
    }
  }
  for (const file of ["components/StudentDataCache.tsx", "components/TeacherDataCache.tsx", "components/teacher/TeacherStudentWordbook.tsx", "components/RoleGate.tsx"]) {
    const source = read(file);
    assert.match(source, /onAuthStateChange/);
    assert.match(source, /subscription\.unsubscribe\(\)/);
  }
  assert.doesNotMatch(read("lib/supabase/server.ts"), /__tpsSupabaseClient/);
});

function transportFixture() {
  let currentUser = "mock-owner";
  let session = { access_token: "mock-A", user: { id: currentUser }, expires_at: Date.now() / 1000 + 1000 };
  const sends = [];
  const f = {
    sends,
    setSession(value) { session = value; },
    setUser(value) { currentUser = value; },
    fetch: async () => response(),
    getSession: async () => ({ data: { session }, error: null }),
    send(init) {
      return fetchReadingFullSetWithSession("https://example.invalid/api/reading/full-set-attempts/mock-attempt/occurrences/mock-occurrence", init, {
        studentId: "mock-owner",
        currentStudentId: () => currentUser,
        getSession: () => f.getSession(),
        fetchImpl: async (url, options) => { sends.push({ url, options }); return f.fetch(url, options); }
      });
    }
  };
  return f;
}

test("Full Set requests and retries read Token B after A expires, preserving request identity and payload", async () => {
  const f = transportFixture();
  await f.send();
  assert.equal(f.sends[0].options.headers.get("Authorization"), "Bearer mock-A");
  f.setSession({ access_token: "mock-B", user: { id: "mock-owner" }, expires_at: Date.now() / 1000 + 1000 });
  f.fetch = async () => { throw new Error("mock-content-failure"); };
  await assert.rejects(f.send(), /mock-content-failure/);
  f.fetch = async () => response();
  const body = JSON.stringify({ answers: [{ questionId: "q", answer: "local-answer" }], moduleNumber: 1 });
  await f.send({ method: "PUT", keepalive: true, body, headers: { Authorization: "Bearer mock-expired-A", "X-Reading-Full-Set-Trace-Id": "mock-trace" } });
  assert.equal(f.sends.length, 3);
  assert.equal(f.sends[2].options.headers.get("Authorization"), "Bearer mock-B");
  assert.equal(f.sends[2].options.headers.get("X-Reading-Full-Set-Trace-Id"), "mock-trace");
  assert.equal(f.sends[2].options.body, body);
  assert.equal(f.sends[2].options.keepalive, true);
  assert.equal(f.sends[2].url, f.sends[0].url);
});

test("Full Set rejects missing/expired/mismatched sessions before sending and never retries a 401", async () => {
  for (const session of [null, { access_token: "expired", expires_at: 1, user: { id: "mock-owner" } }, { access_token: "new-user", user: { id: "mock-other" } }]) {
    const f = transportFixture();
    f.setSession(session);
    await assert.rejects(f.send(), ReadingFullSetSessionError);
    assert.equal(f.sends.length, 0);
  }
  const f = transportFixture();
  f.fetch = async () => response({}, 401);
  assert.equal((await f.send({ method: "POST" })).status, 401);
  assert.equal(f.sends.length, 1);
});

test("Full Set refuses account switches before/during session resolution and discards late responses", async () => {
  const before = transportFixture();
  before.setUser("mock-other");
  await assert.rejects(before.send(), ReadingFullSetSessionError);
  assert.equal(before.sends.length, 0);
  const during = transportFixture();
  const lookup = deferred();
  during.getSession = () => lookup.promise;
  const pending = during.send();
  during.setUser("mock-other");
  lookup.resolve({ data: { session: { access_token: "mock-A", user: { id: "mock-owner" } } }, error: null });
  await assert.rejects(pending, ReadingFullSetSessionError);
  assert.equal(during.sends.length, 0);
  const after = transportFixture();
  const content = deferred();
  after.fetch = () => content.promise;
  const inflight = after.send();
  await flush();
  after.setUser(null);
  content.resolve(response());
  await assert.rejects(inflight, ReadingFullSetSessionError);
});

test("Full Set aborted requests never send after a pending session lookup", async () => {
  const f = transportFixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.send({ signal: controller.signal }), error => error.name === "AbortError");
  assert.equal(f.sends.length, 0);
});

test("Full Set content cache remains reusable across token rotation; retry does not clear answers or reload runner", async () => {
  const f = transportFixture();
  const cache = new ReadingFullSetOccurrenceCache();
  const local = { answers: { q: "local-answer" }, questionTimes: { q: 17 }, position: 2 };
  const load = async () => { await f.send(); return local; };
  assert.strictEqual(await cache.acquire("mock-attempt:1:occurrence", load).promise, local);
  f.setSession({ access_token: "mock-B", user: { id: "mock-owner" } });
  assert.strictEqual(await cache.acquire("mock-attempt:1:occurrence", load).promise, local);
  assert.equal(f.sends.length, 1);
  const runner = read("components/reading/ReadingFullSetRunner.tsx");
  const retry = runner.slice(runner.indexOf("const retryOccurrence"), runner.indexOf("const startModule2"));
  assert.doesNotMatch(retry, /loadRunner|clearOccurrenceCaches\(|setAnswersByOccurrence|answersRef\.current|questionTimesRef\.current|setPosition/);
  assert.match(retry, /handleWorkspaceReady\(\)/);
  assert.match(retry, /setOccurrenceRetry/);
  assert.doesNotMatch(runner, /setAccessToken|\[accessToken|Bearer \$\{accessToken\}/);
  assert.doesNotMatch(runner, /await fetch\(/);
});

test("browser IDs preserve native UUIDs, support getRandomValues-only browsers and degrade diagnostics without crypto", () => {
  const native = compileComponent("lib/browserId.ts", {}, { crypto: { randomUUID: () => "native-mock-uuid" } });
  assert.equal(native.createDiagnosticId(), "native-mock-uuid");
  const legacy = compileComponent("lib/browserId.ts", {}, { crypto: { getRandomValues: bytes => { bytes.fill(7); return bytes; } } });
  assert.match(legacy.createBrowserUuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const missing = compileComponent("lib/browserId.ts", {}, { crypto: undefined });
  const first = missing.createDiagnosticId();
  assert.match(first, /^diag-/);
  assert.notEqual(missing.createDiagnosticId(), first);
  assert.throws(() => missing.createBrowserUuid(), /无法生成练习请求编号/);
  const events = [];
  const perf = compileComponent("lib/studentPerformance.client.ts", {
    react: { useEffect() {}, useRef: () => ({ current: null }) }, "./browserId.ts": missing
  }, { window: { location: { pathname: "/student/home", search: "" } }, console: { info: (...args) => events.push(args) } });
  assert.doesNotThrow(() => perf.beginStudentNavigationTrace("/student/home"));
  assert.match(events[0][1], /diag-/);
});

test("student dashboard differentiates loading, real zeros and failed data with cache-only retry", () => {
  const zeroSummary = { buildSentence: { completedSetCount: 0, totalSetCount: 0, currentMonthSetCount: 0 }, drafts: { email: null, academic_discussion: null }, readingProgress: {}, overview: { totalPracticeCount: 0, currentMonthPracticeCount: 0, learningDayCount: 0, pendingFeedbackCount: 0 } };
  let state = { loading: true, data: null, error: "" };
  const invalidations = [];
  const dashboard = compileComponent("components/student/StudentDashboard.tsx", {
    "react/jsx-runtime": jsxRuntime,
    "next/link": { default: "a" }, "next/image": { default: "img" }, "lucide-react": {},
    "@/components/icons/CompleteTheWordsIcon": {},
    "@/components/StudentDataCache": {
      STUDENT_DASHBOARD_SUMMARY_CACHE_KEY: "dashboard-summary",
      useStudentCachedData: () => state,
      useStudentDataCache: () => ({ invalidate: key => invalidations.push(key) })
    },
    "@/lib/studentNavigation": require("../lib/studentNavigation.ts"),
    "@/lib/writing": require("../lib/writing.ts"),
    "@/lib/studentPerformance.client": { useStudentPagePerformance() {} }
  }).StudentDashboard;
  assert.match(text(dashboard()), /加载中/);
  state = { loading: false, data: zeroSummary, error: "" };
  assert.match(text(dashboard()), /累计练习0/);
  assert.doesNotMatch(text(dashboard()), /失败/);
  state = { loading: false, data: null, error: "mock-load-failure" };
  const failed = dashboard();
  assert.match(text(failed), /首页概览加载失败/);
  assert.doesNotMatch(text(failed), /累计练习0|暂无草稿/);
  nodes(failed).find(node => node.type === "button").props.onClick();
  assert.deepEqual(invalidations, ["dashboard-summary"]);
  state = { loading: false, data: zeroSummary, error: "" };
  assert.match(text(dashboard()), /累计练习0/);
});

test("RDL image error retries only the same image and works without ResizeObserver", async () => {
  for (const hasObserver of [false, true]) {
    const h = hookHarness();
    let answerChanges = 0;
    let observeCalls = 0;
    let disconnectCalls = 0;
    const listeners = new Set();
    const fakeNode = { clientWidth: 100, clientHeight: 100, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) };
    let image = null;
    let imageRef = null;
    const reading = compileComponent("components/reading/ReadingPractice.tsx", {
      react: h.react, "react/jsx-runtime": jsxRuntime,
      "@/components/lexical/LexicalLookup": { useLexicalLookup: () => null, lexicalBlockAttributes: () => ({}) },
      "@/lib/reading/rdlSelection": { ...require("../lib/reading/rdlSelection.ts"), validateRdlImageBinding: () => false },
      "@/lib/reading/materialTypes": { rdlDisplayInstruction: () => "Material" },
      fallback: () => ({})
    }, {
      window: { addEventListener: event => listeners.add(event), removeEventListener: event => listeners.delete(event) },
      ResizeObserver: hasObserver ? class { observe() { observeCalls++; } disconnect() { disconnectCalls++; } } : undefined,
      fetch: () => { throw new Error("Image retry must never call an API or create an attempt"); }
    }, "\nexport { RdlPracticeWorkspace };");
    const answer = { kind: "choice", optionId: "mock-option" };
    const props = { answer, answerKeyOnly: false, lookupEnabled: false, naturalFlow: false,
      material: { imageUrl: "https://assets.example.invalid/material.png", materialId: "mock-material", selectionMap: null, imageSha256: null },
      question: { questionId: "mock-question", stem: "Question", options: [] }, readOnly: false,
      onAnswerChange: () => answerChanges++ };
    let lastKey;
    const render = () => h.render(reading.RdlPracticeWorkspace, props, tree => {
      const img = nodes(tree).find(node => node.type === "img");
      if (img) {
        if (img.key !== lastKey) image = { ...fakeNode, complete: false, naturalWidth: 0, naturalHeight: 0, decode: async () => {} };
        lastKey = img.key;
        img.props.ref.current = image;
        imageRef = img.props.ref;
      } else if (imageRef) imageRef.current = null;
      for (const node of nodes(tree)) if (node.type === "div" && node.props.ref) node.props.ref.current = fakeNode;
    });
    let tree = render();
    const first = nodes(tree).find(node => node.type === "img");
    first.props.onError();
    tree = render();
    assert.match(text(tree), /图片加载失败/);
    nodes(tree).find(node => node.type === "button" && text(node) === "重新加载图片").props.onClick();
    tree = render();
    const retried = nodes(tree).find(node => node.type === "img");
    assert.equal(retried.props.src, first.props.src);
    assert.notEqual(retried.key, first.key);
    image.naturalWidth = 100;
    image.naturalHeight = 100;
    retried.props.onLoad({ currentTarget: image });
    await flush();
    tree = render();
    assert.match(nodes(tree).find(node => node.type === "img").props.className, /opacity-100/);
    assert.strictEqual(props.answer, answer);
    assert.equal(answerChanges, 0);
    assert.ok(listeners.has("resize"));
    assert.equal(observeCalls > 0, hasObserver);
    h.unmount();
    assert.equal(listeners.size, 0);
    assert.equal(disconnectCalls > 0, hasObserver);
  }
});

for (const domain of ["Student", "Teacher"]) {
  test(`${domain} cache retains same-account data on refresh and clears old-account/in-flight data on switch`, async () => {
    const h = hookHarness();
    const listeners = new Set();
    const initial = deferred();
    const source = compileComponent(`components/${domain}DataCache.tsx`, {
      react: h.react, "react/jsx-runtime": jsxRuntime,
      "@/lib/supabase/client": { createBrowserSupabase: () => ({ auth: {
        getSession: () => initial.promise,
        onAuthStateChange: callback => {
          listeners.add(callback);
          return { data: { subscription: { unsubscribe: () => listeners.delete(callback) } } };
        }
      } }) },
      "@/lib/cacheInvalidation": { subscribeToCacheInvalidation: () => () => {}, cacheDomainsForEvent: () => [] },
      "@/lib/studentSetStatus": require("../lib/studentSetStatus.ts")
    });
    const Provider = source[`${domain}DataCacheProvider`];
    const render = () => h.render(Provider).props.value;
    const emit = (user, token = "mock-A") => {
      for (const listener of listeners) listener(user ? "SIGNED_IN" : "SIGNED_OUT", user ? { access_token: token, user: { id: user } } : null);
    };
    let value = render();
    emit("mock-owner");
    value = render();
    const set = (key, data) => domain === "Student" ? value.setData(key, data) : value.set(key, data);
    set("local", { answer: "unsaved-mock-value" });
    emit("mock-owner", "mock-B");
    value = render();
    assert.equal(value.getEntry("local").data.answer, "unsaved-mock-value");
    const delayed = deferred();
    const oldLoad = value.load("delayed", () => delayed.promise);
    emit("mock-other");
    value = render();
    assert.equal(value.getEntry("local"), undefined);
    set("local", { answer: "new-account-value" });
    initial.resolve({ data: { session: { access_token: "stale-initial", user: { id: "mock-owner" } } } });
    delayed.resolve({ answer: "old-account-response" });
    await oldLoad;
    await flush();
    value = render();
    assert.equal(value.getEntry("local").data.answer, "new-account-value");
    assert.equal(value.getEntry("delayed"), undefined);
    if (domain === "Student") assert.equal(value.getSession().studentId, "mock-other");
    emit(null);
    assert.equal(render().getEntry("local"), undefined);
    h.unmount();
    assert.equal(listeners.size, 0);
    if (domain === "Student") assert.equal(value.getSession(), null);
  });
}

test("actual Full Set Runner rotates tokens and locally retries without clearing answers, cursor, timing or bootstrap", async () => {
  const h = hookHarness();
  const now = new Date().toISOString();
  const module1 = { moduleAttemptId: "mock-module", moduleNumber: 1, status: "active", timeLimitSeconds: 1230,
    startedAt: now, deadlineAt: new Date(Date.now() + 600_000).toISOString(), remainingSeconds: 600,
    timerRevision: 1, submittedAt: null, submissionReason: null, answerRevision: 0,
    currentOccurrenceId: "mock-first", currentQuestionIndex: 0, cursorRevision: 0 };
  const attempt = { attemptId: "mock-attempt", fullSetId: "20260601A", status: "in_progress", currentModule: 1,
    startedAt: now, completedAt: null, serverNow: now, module1, module2: null };
  const occurrences = ["mock-first", "mock-next"].map((occurrenceId, i) => ({ occurrenceId, logicalItemId: `mock-logical-${i}`,
    taskType: "rap", sourceQuestionStart: i + 1, sourceQuestionEnd: i + 1 }));
  const practice = occurrence => ({ item: { itemId: occurrence.logicalItemId, module: "rap", title: "Mock", questionCount: 1, scoringPointCount: 1 },
    material: null, passage: null,
    questions: [{ questionId: occurrence.occurrenceId, questionOrder: 1, questionType: "rap_multiple_choice", stem: "Mock question", options: [{ optionId: "mock-option", optionOrder: 1, text: "Mock" }], highlightRanges: [] }] });
  const payload = occurrence => ({ answerRevision: 0, occurrenceRevision: 0, answers: {}, occurrence, practice: practice(occurrence), questionTimes: { [occurrence.occurrenceId]: 5 } });
  const trace = { attemptId: "mock-attempt", traceId: "mock-trace", startedAt: performance.now() };
  let handoffReads = 0;
  let inspection;
  let token = "mock-A";
  let failNext = true;
  const sends = [];
  const cache = { getEntry: () => undefined, getSession: () => ({ studentId: "mock-owner", accessToken: token }),
    invalidate() {}, sessionReady: true, setData() {} };
  const timers = new Map();
  let timerId = 0;
  const windowMock = { setTimeout: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id),
    setInterval: () => ++timerId, clearInterval() {}, addEventListener() {}, removeEventListener() {} };
  const fetchImpl = async (url, init) => {
    sends.push({ url, token: new Headers(init.headers).get("Authorization") });
    if (url.endsWith("/loads")) return response({ started: true, loadId: "mock-load", expiresAt: new Date(Date.now() + 45_000).toISOString(), attempt });
    if (url.includes("/loads/")) return response({ finished: true, attempt });
    if (url.endsWith("/activate")) return response({ attempt });
    if (url.endsWith("/occurrences/mock-next")) return failNext ? response({ error: "mock-content-failure" }, 500) : response(payload(occurrences[1]));
    throw new Error(`Unexpected request: ${url}`);
  };
  const sessionTransport = require("../lib/reading/fullSetClientSession.ts");
  const perf = {
    createReadingFullSetPerformanceTrace: () => trace,
    logReadingFullSetPerformancePhase() {},
    readingFullSetTraceHeaders: (_token, value) => value ? { "X-Reading-Full-Set-Trace-Id": value.traceId } : {},
    fetchReadingFullSetWithTimeout: (url, init, _timeout, send) => send(url, init)
  };
  const { ReadingFullSetRunner } = compileComponent("components/reading/ReadingFullSetRunner.tsx", {
    react: h.react, "react/jsx-runtime": jsxRuntime,
    "next/link": { default: "a" }, "next/navigation": { useRouter: () => router },
    "@/components/StudentDataCache": { useStudentDataCache: () => cache, studentReadingFullSetOccurrenceCacheKey: (a, b) => `${a}:${b}` },
    "@/lib/reading/fullSetBootstrapHandoff.client": { consumeReadingFullSetBootstrapHandoff: () => {
      handoffReads++;
      return { runner: { attempt, occurrences, title: "Mock" }, firstOccurrence: payload(occurrences[0]), traceId: trace.traceId, trace };
    } },
    "@/lib/reading/fullSetPerformance.client": perf,
    "@/lib/reading/fullSetClientSession": { ...sessionTransport,
      fetchReadingFullSetWithSession: (url, init, deps) => sessionTransport.fetchReadingFullSetWithSession(url, init, { ...deps,
        getSession: async () => ({ data: { session: { access_token: token, user: { id: "mock-owner" } } }, error: null }), fetchImpl }) },
    "@/lib/studentCacheEvents": { invalidateStudentWrongbook() {} },
    "./ReadingPractice": { ReadingPracticeHeader: "header", ReadingQuestionViewport: "viewport", ReadingWorkspaceRouter: "workspace" },
    "@/components/shared/PracticeReview": { PracticeReview: "review" },
    fallback: name => {
      if (name.startsWith("@/lib/")) return require(path.join(root, name.slice(2) + ".ts"));
      throw new Error(`Unmocked dependency: ${name}`);
    }
  }, { window: windowMock, document: { body: { style: {} }, documentElement: { style: {} } },
    requestAnimationFrame: callback => callback(), inspectRunner: value => { inspection = value; } }, "", source => {
    const marker = "  if (loading) return <RunnerMessage";
    assert.ok(source.includes(marker));
    return source.replace(marker, "  inspectRunner({ runner, position, answersRef, questionTimesRef, timerRef, setPosition, updateAnswer, handleWorkspaceReady, retryOccurrence, occurrenceLoad });\n" + marker);
  });
  const router = { push() {}, replace() {} };
  const render = () => h.render(ReadingFullSetRunner, { attemptId: "mock-attempt", expectedFullSetId: "20260601A" });
  render();
  await flush();
  render();
  inspection.handleWorkspaceReady();
  await flush();
  render();
  inspection.updateAnswer("mock-first", { kind: "choice", optionId: "mock-option" });
  render();
  const before = inspection.answersRef.current["mock-first"];
  const timer = inspection.timerRef.current;
  token = "mock-B";
  render();
  assert.strictEqual(inspection.answersRef.current["mock-first"], before);
  assert.strictEqual(inspection.timerRef.current, timer);
  assert.equal(handoffReads, 1);
  inspection.setPosition({ occurrenceIndex: 1, questionIndex: 0 });
  render();
  await flush();
  render();
  assert.equal(inspection.occurrenceLoad.status, "error");
  const requestsBeforeRetry = sends.filter(send => send.url.endsWith("/occurrences/mock-next")).length;
  failNext = false;
  inspection.retryOccurrence();
  render();
  await flush();
  render();
  assert.deepEqual(inspection.answersRef.current["mock-first"], before);
  assert.ok(inspection.questionTimesRef.current["mock-first"]["mock-first"] >= 5);
  assert.equal(inspection.position.occurrenceIndex, 1);
  assert.equal(handoffReads, 1);
  const nextRequests = sends.filter(send => send.url.endsWith("/occurrences/mock-next"));
  assert.equal(nextRequests.length, requestsBeforeRetry + 1);
  assert.ok(nextRequests.every(send => send.token === "Bearer mock-B"));
  assert.equal(sends.filter(send => send.url === "/api/reading/full-set-attempts").length, 0);
  h.unmount();
});

test("real SDK with mock-only transport restores storage without requests and auto-refreshes the shared session", async () => {
  const { createClient } = require("@supabase/supabase-js");
  const store = new Map();
  const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) };
  const calls = [];
  const user = { id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated", email: "mock@example.invalid" };
  const token = suffix => [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600, mock: suffix })).toString("base64url"),
    Buffer.from("mock-signature-not-a-real-token").toString("base64url")
  ].join(".");
  const tokenA = token("A");
  const tokenB = token("B");
  const fakeFetch = async (url, init) => {
    const parsed = new URL(url);
    const grant = parsed.searchParams.get("grant_type");
    calls.push({ path: parsed.pathname, grant, method: init.method });
    if (parsed.pathname.endsWith("/logout")) return response();
    assert.equal(parsed.pathname, "/auth/v1/token");
    assert.ok(grant === "password" || grant === "refresh_token");
    return response({ access_token: grant === "password" ? tokenA : tokenB, refresh_token: `mock-refresh-${grant}`,
      token_type: "bearer", expires_in: 3600, user });
  };
  const load = () => compileComponent("lib/supabase/client.ts", {
    "@supabase/supabase-js": { createClient: (url, key, options) => createClient(url, key, { ...options, auth: { storage } }) },
    "./fetch.ts": { createSupabaseFetch: () => fakeFetch }
  }, { window: {}, process: { env: { NEXT_PUBLIC_SUPABASE_URL: "https://project.example.invalid", NEXT_PUBLIC_SUPABASE_ANON_KEY: "mock-publishable" } } });
  const firstPage = load();
  const first = firstPage.createBrowserSupabase();
  let restored;
  try {
    await first.auth.initialize();
    await first.auth.stopAutoRefresh();
    assert.equal(first.auth.autoRefreshToken, true);
    assert.equal(first.auth.persistSession, true);
    const login = await first.auth.signInWithPassword({ email: "mock@example.invalid", password: "synthetic-unit-test-only" });
    assert.equal(login.error, null);
    assert.equal(login.data.session.access_token, tokenA);
    assert.strictEqual(firstPage.createBrowserSupabase(), first);
    await first.auth.dispose();

    restored = load().createBrowserSupabase();
    await restored.auth.initialize();
    await restored.auth.stopAutoRefresh();
    assert.equal((await restored.auth.getSession()).data.session.access_token, tokenA);
    assert.equal(calls.length, 1, "restoration must not add an auth verification request");
    const events = [];
    const { data: { subscription } } = restored.auth.onAuthStateChange(event => events.push(event));
    const key = [...store.keys()].find(value => value.endsWith("-auth-token"));
    const storedSession = JSON.parse(store.get(key));
    storedSession.expires_at = 1;
    store.set(key, JSON.stringify(storedSession));
    // Exercise the real SDK background-tick code deterministically, without
    // sleeping for its interval or contacting an Auth server.
    await restored.auth._autoRefreshTokenTick();
    assert.equal((await restored.auth.getSession()).data.session.access_token, tokenB);
    assert.equal(calls.filter(call => call.grant === "refresh_token").length, 1);
    assert.ok(events.includes("TOKEN_REFRESHED"));
    assert.equal((await restored.auth.signOut()).error, null);
    assert.equal((await restored.auth.getSession()).data.session, null);
    subscription.unsubscribe();
  } finally {
    await first.auth.dispose();
    await restored?.auth.dispose();
  }
});

test("Full Set keepalive starts synchronously with a fresh event-updated JWT, but expired JWT uses the SDK", async () => {
  const jwt = expiration => `mock.${Buffer.from(JSON.stringify({ sub: "mock-owner", exp: expiration })).toString("base64url")}.mock`;
  const fresh = jwt(Math.floor(Date.now() / 1000) + 3600);
  let cachedToken = fresh;
  let sessionReads = 0;
  let sends = 0;
  let sentToken;
  const dependencies = {
    studentId: "mock-owner", currentStudentId: () => "mock-owner",
    cachedSession: () => ({ studentId: "mock-owner", accessToken: cachedToken }),
    getSession: async () => { sessionReads++; return { data: { session: { user: { id: "mock-owner" }, access_token: "mock-rotated" } }, error: null }; },
    fetchImpl: async (_url, init) => { sends++; sentToken = init.headers.get("Authorization"); return response(); }
  };
  const first = fetchReadingFullSetWithSession("https://example.invalid/keepalive", { method: "PUT", keepalive: true }, dependencies);
  assert.equal(sends, 1, "live pagehide writes must start before any SDK await");
  await first;
  assert.equal(sessionReads, 0);
  assert.equal(sentToken, `Bearer ${fresh}`);
  cachedToken = jwt(1);
  await fetchReadingFullSetWithSession("https://example.invalid/keepalive", { method: "PUT", keepalive: true }, dependencies);
  assert.equal(sessionReads, 1);
  assert.equal(sentToken, "Bearer mock-rotated");
});
