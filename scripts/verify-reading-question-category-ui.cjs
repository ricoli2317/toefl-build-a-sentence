// Offline Playwright verification against the REAL localhost Next.js UI.
// Start pnpm dev normally, wait for Ready, then invoke with its URL.
// All API/auth requests are intercepted; no Supabase/production contact occurs.
// PLAYWRIGHT_MODULE can point to a temporary install; dependencies stay untracked.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createFixtureServer, category } = require("../tests/fixtures/questionCategoryBrowser.cjs");
const origin = process.argv[2];
if (!origin || new URL(origin).hostname !== "localhost") throw new Error("Pass the Ready localhost origin; do not use production.");
const root = path.resolve(__dirname, "..");
const output = path.join(root, "outputs/question-category-ui");
fs.mkdirSync(output, { recursive: true });
const credentials = Object.fromEntries(fs.readFileSync(path.join(root, ".codex/tps-test-accounts.local"), "utf8")
  .split(/\r?\n/).filter((line) => /^[A-Z_]+=/.test(line)).map((line) => {
    const position = line.indexOf("="); return [line.slice(0, position), line.slice(position + 1).trim().replace(/^['"]|['"]$/g, "")];
  }));
async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const fixture = createFixtureServer();
  const page = await context.newPage();
  const errors = [];
  const blockedExternal = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const user = { id: "11111111-1111-4111-8111-111111111111", aud: "authenticated", role: "authenticated", email: "fixture@invalid.test", app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  const token = `${Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now()/1000)+3600, aud: "authenticated", role: "authenticated" })).toString("base64url")}.offline-fixture`;
  await context.route("**/*", async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (url.pathname.startsWith("/auth/v1/")) {
      // Auth payload is never logged, stored or forwarded. Credentials enter
      // only the normal localhost login fields and are consumed offline.
      return route.fulfill({ json: url.pathname.includes("token") ? { access_token: token, refresh_token: "offline-refresh", token_type: "bearer", expires_in: 3600, user } : user });
    }
    if (url.origin !== origin) { blockedExternal.push(url.origin); return route.abort(); }
    if (url.pathname === "/api/account/me") return route.fulfill({ json: { userId: user.id, role: "student", displayName: "Local Fixture Student", defaultRoute: "/student/question-category-practice" } });
    if (url.pathname.startsWith("/api/")) {
      const body = request.method() === "GET" ? null : request.postDataJSON();
      const payload = fixture.handle(url, request.method(), body);
      return route.fulfill({ status: payload ? 200 : 404, json: payload || { error: "Unmocked localhost API: blocked" } });
    }
    return route.continue();
  });
  await page.goto(`${origin}/login?returnTo=/student/question-category-practice`);
  await page.locator("#account").fill(credentials.STUDENT_EMAIL);
  await page.locator("#password").fill(credentials.STUDENT_PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.waitForURL("**/student/question-category-practice");
  await page.getByRole("button", { name: "开始练习", exact: true }).first().waitFor();
  assert.equal(await page.locator("article").count(), 10);
  const nav = page.getByRole("navigation", { name: "学生端主导航" });
  assert.equal(await nav.getByRole("link", { name: "按题型分类练习", exact: true }).getAttribute("aria-current"), "page");
  await page.screenshot({ path: path.join(output, "home-desktop.png"), fullPage: true });
  await page.locator("article").first().getByRole("button", { name: "开始练习" }).click();
  assert.equal(await page.locator('[data-testid="wrong-question-amount-15"]').isDisabled(), true);
  await page.getByText("当前题型共 8 道", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, "amount-shortfall.png") });
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector("aside").getBoundingClientRect().right <= 0);
  await page.screenshot({ path: path.join(output, "home-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForFunction(() => document.querySelector("aside").getBoundingClientRect().left === 0);
  await page.locator("article").filter({ hasText: category }).getByRole("button", { name: "开始练习" }).click();
  await page.locator('[data-testid="wrong-question-amount-20"]').click();
  await page.waitForURL(/session=/);
  await page.getByText(/target 1\)/).waitFor();
  const sessionId = new URL(page.url()).searchParams.get("session");
  const originalManifest = JSON.stringify(fixture.sessions.get(sessionId).session.groups);
  assert.ok(fixture.calls.filter((c) => c.path.startsWith("/api/reading/practice/")).length <= 2, "Initial content is current + next only");
  await page.getByText("Access to sunlight influenced growth.", { exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByText(/target 2\)/).waitFor();
  await page.waitForFunction(({ studentId, sessionId, itemId }) => {
    const draft = sessionStorage.getItem(`tps:category-draft:${studentId}:${sessionId}:${itemId}`);
    return draft && JSON.parse(draft).elapsedSeconds >= 2;
  }, { studentId: user.id, sessionId, itemId: fixture.content[0].item.itemId });
  const elapsedBeforeRefresh = await page.evaluate(({ studentId, sessionId, itemId }) => {
    return JSON.parse(sessionStorage.getItem(`tps:category-draft:${studentId}:${sessionId}:${itemId}`)).elapsedSeconds;
  }, { studentId: user.id, sessionId, itemId: fixture.content[0].item.itemId });
  await page.reload();
  await page.getByText(/target 2\)/).waitFor();
  assert.equal(JSON.stringify(fixture.sessions.get(sessionId).session.groups), originalManifest);
  assert.equal(fixture.calls.filter((c) => c.method === "POST" && c.path === "/api/reading/question-category").length, 1, "Refresh must not redraw");
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await page.getByText(/target 1\)/).waitFor();
  await page.screenshot({ path: path.join(output, "practice-resumed.png") });
  // Finish first source (one correct + two unanswered).
  for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByText(/source 2, target 1\)/).waitFor();
  await page.reload();
  await page.getByText(/source 2, target 1\)/).waitFor();
  assert.ok(fixture.sessions.get(sessionId).session.elapsedSeconds >= elapsedBeforeRefresh, "Committed cumulative time survives refresh");
  await page.evaluate(() => { window.__tpsSessionHeader = document.querySelector("header"); });
  const firstSubmitCount = fixture.calls.filter((c) => c.method === "POST" && c.path.includes("/groups/")).length;
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await page.getByTestId("reading-session-workspace-submitted").waitFor();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByText(/source 2, target 1\)/).waitFor();
  assert.equal(await page.evaluate(() => window.__tpsSessionHeader === document.querySelector("header")), true, "Cross-source Previous preserves shell header DOM");
  assert.equal(fixture.calls.filter((c) => c.method === "POST" && c.path.includes("/groups/")).length, firstSubmitCount, "Previous never resubmits");
  await page.screenshot({ path: path.join(output, "practice-cross-source.png") });
  for (let i = 0; i < 17; i++) {
    const next = page.getByRole("button", { name: i === 16 ? "Submit" : "Next", exact: true });
    await next.click();
    if ([2,5,8,11,14].includes(i)) await page.getByText(new RegExp(`source ${Math.floor(i / 3)+3}, target 1\\)`)).waitFor();
  }
  await page.waitForURL(`**/sessions/${sessionId}`);
  await page.getByText("题型分类练习·推断题", { exact: true }).waitFor();
  const resultSession = fixture.sessions.get(sessionId);
  assert.equal(resultSession.answers.length, 20);
  assert.equal(resultSession.session.correctPoints, 1);
  assert.equal(resultSession.session.status, "completed");
  assert.ok(resultSession.session.elapsedSeconds >= elapsedBeforeRefresh);
  await page.screenshot({ path: path.join(output, "result-20.png"), fullPage: true });
  const reviewLink = page.locator(`a[href$="/questions/13"]`);
  await reviewLink.click();
  await page.getByText(/source 5, target 2\)/).waitFor();
  await page.screenshot({ path: path.join(output, "review-question-14.png") });
  const callsBeforeRefresh = fixture.calls.length;
  await page.reload();
  await page.getByText(/source 5, target 2\)/).waitFor();
  const contentAfterRefresh = fixture.calls.slice(callsBeforeRefresh).filter((c) => c.path.startsWith("/api/reading/practice/"));
  assert.ok(contentAfterRefresh.length <= 2, "Hard-refresh review must not hydrate all sources");
  await page.goto(`${origin}/student/question-category-practice/sessions/${sessionId}`);
  await page.getByRole("link", { name: "重新练习", exact: true }).click();
  await page.waitForURL(/session=/);
  const retakeId = new URL(page.url()).searchParams.get("session");
  assert.notEqual(retakeId, sessionId);
  assert.equal(fixture.sessions.get(retakeId).session.amount, 20);
  assert.equal(fixture.sessions.get(retakeId).session.questionCategory, category);
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, "verification.json"), JSON.stringify({
    mode: "offline API/auth fixtures against real localhost UI", productionRequests: 0,
    checks: ["10 fixed rows", "sidebar active", "shared shortage chooser", "mobile", "20-question multi-source", "current+next prefetch", "refresh exact frozen session/index/answers", "cross-source Previous no resubmit", "aggregate result", "global question 14 review", "review hard-refresh lazy content", "new retake session"],
    answers: resultSession.answers.length, correctPoints: resultSession.session.correctPoints, totalPoints: resultSession.session.totalPoints,
    elapsedSeconds: resultSession.session.elapsedSeconds,
    pageErrors: errors, blockedExternalOrigins: [...new Set(blockedExternal)], screenshots: fs.readdirSync(output).filter((name) => name.endsWith(".png"))
  }, null, 2));
  console.log("Offline category UI verification passed; screenshots:", output);
  await browser.close();
}
main().catch((error) => { console.error(error.message); process.exit(1); });
