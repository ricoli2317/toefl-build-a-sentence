const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { compile, scheduler } = require("./helpers/wordbookReadHarness.cjs");
const dates = require("../lib/studentDates.ts");
const review = require("../lib/lexical/wordbookReview.ts");

// Real setup and calendar handlers; availability/session transport is entirely
// offline. Nothing in this test authenticates, queries SQL or writes real data.
function setup(t) {
  const previousStorage = global.localStorage;
  global.localStorage = {};
  t.after(() => { if (previousStorage === undefined) delete global.localStorage; else global.localStorage = previousStorage; });
  const formRunner = scheduler(), calendarRunner = scheduler();
  const requests = [], writes = [], pushes = [], saved = [];
  let nodes = [], calendarNodes = [], selector, lastAvailability = null, loading = false, coverageError = null;
  const { StudentDateSelection } = compile("components/student/StudentDateSelection.tsx", {
    react: { ...calendarRunner.hooks, useLayoutEffect() {} }, "@/lib/studentDates": dates,
    "@/components/teacher/TeacherPopover": { TeacherPopover() { throw new Error("setup must use the inline calendar"); } }
  });
  const cache = { studentId: "student-a", sessionReady: true, getSession: () => ({ accessToken: "offline-token" }), load() {} };
  const { WordbookReviewSetup } = compile("components/student/WordbookReview.tsx", {
    react: { ...formRunner.hooks, useEffect() {} },
    "next/link": () => null, "next/navigation": { useRouter: () => ({ push: url => pushes.push(url) }) },
    "@/components/StudentDataCache": { useStudentDataCache: () => cache },
    "./StudentWordbook": { wordbookReadCacheKey: url => url, useWordbookRead(url) {
      if (!url || new URL(url, "http://offline").searchParams.get("action") !== "availability") {
        return { data: url ? { dates: [] } : undefined, loading: false };
      }
      const settings = JSON.parse(new URL(url, "http://offline").searchParams.get("settings"));
      if (lastAvailability !== url) { requests.push(settings); lastAvailability = url; }
      return { loading, data: loading ? undefined : { total: settings.mode === "random" ? 100 : settings.mode === "date" ? 9 : 17, coverageError } };
    } },
    "@/lib/cacheInvalidation": { publishCacheInvalidation() {} }, "./StudentUI": {},
    "./StudentDateSelection": { StudentDateSelection }, "@/lib/studentDates": dates,
    "@/lib/lexical/wordbookReview": review, "./WordbookReviewWorkspace": {}, "./useWordbookLocalReview": {},
    "@/lib/lexical/wordbookReviewRequest": { fetchReview: async (url, token, body) => { writes.push({ url, body }); return { session: { session_id: "offline-review", domain: "reading" } }; } },
    "@/lib/lexical/wordbookReviewLocal": { localReview: (owner, round) => ({ owner, round }), saveLocalReview: (storage, value) => saved.push(value) },
    "@/lib/studentNavigation": { STUDENT_ROUTES: {} },
    "./WordbookReviewSetup.module.css": new Proxy({}, { get: (_, key) => key === "__esModule" ? false : String(key) })
  });
  function collect(node, output, expand = false) {
    if (Array.isArray(node)) { node.forEach(child => collect(child, output, expand)); return; }
    if (!node || typeof node !== "object") return;
    if (expand && typeof node.type === "function") { collect(node.type(node.props), output, expand); return; }
    output.push(node); collect(node.props?.children, output, expand);
  }
  function renderCalendar() {
    calendarNodes = [];
    if (selector) calendarRunner.render(() => collect(StudentDateSelection(selector.props), calendarNodes, true));
  }
  function render() {
    nodes = []; formRunner.render(() => collect(WordbookReviewSetup({ initialDomain: "reading" }), nodes));
    selector = nodes.find(node => node.type === StudentDateSelection); renderCalendar();
  }
  const text = node => Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" ? text(node.props?.children) : node == null ? "" : String(node);
  const button = label => nodes.find(node => node.type === "button" && text(node.props.children) === label);
  const dateButton = label => calendarNodes.find(node => node.type === "button" && node.props["aria-label"]?.split("，")[0] === label);
  const click = label => { const target = button(label); assert.ok(target); target.props.onClick(); render(); };
  const dateClick = label => { const target = dateButton(label); assert.ok(target && !target.props.disabled); target.props.onClick(); render(); };
  const hover = label => { dateButton(label).props.onMouseEnter(); renderCalendar(); };
  render();
  return { render, button, dateButton, click, dateClick, hover, requests, writes, pushes, saved,
    get nodes() { return nodes; }, get calendarNodes() { return calendarNodes; },
    get selector() { return selector; }, get settings() { return requests.at(-1); },
    set loading(value) { loading = value; }, set coverageError(value) { coverageError = value; } };
}

test("setup has exactly two equal-width mode tabs with existing styles and no calendar apply button", t => {
  const view = setup(t);
  const tabs = view.nodes.filter(node => node.type === "button" && node.props.className === "mode");
  assert.deepEqual(tabs.map(node => node.props.children), ["指定日期", "随机数量"]);
  assert.equal(tabs[1].props["aria-pressed"], true);
  view.click("指定日期");
  assert.equal(view.button("指定日期").props["aria-pressed"], true);
  assert.equal(view.button("随机数量").props["aria-pressed"], false);
  assert.equal(view.selector.props.hideApply, true);
  assert.equal(view.selector.props.singleDay, undefined);
  assert.equal(view.calendarNodes.some(node => node.type === "button" && node.props.type === "submit"), false);
  assert.ok(view.button("开始复习").props.disabled);
  const css = fs.readFileSync(path.join(__dirname, "../components/student/WordbookReviewSetup.module.css"), "utf8");
  assert.match(css, /\.modes \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); border-bottom: 1px solid var\(--student-border\); \}/);
  assert.match(css, /\.mode\[aria-pressed="true"\] \{ border-bottom-color: var\(--student-primary\); color: var\(--student-primary\); font-weight: 600; \}/);
});

test("actual date clicks immediately recalculate day/range availability; hover never requests or changes counts", t => {
  const view = setup(t); view.click("指定日期");
  const today = dates.formatDateInputValue(dates.startOfLocalDay());
  const first = `${today.slice(0, 7)}-01`, second = `${today.slice(0, 7)}-03`;
  view.dateClick(first);
  assert.equal(view.settings.mode, "date");
  assert.equal(view.settings.start, first); assert.equal(view.settings.end, first);
  assert.ok(view.nodes.some(node => node.type === "strong" && node.props.children === 9));
  const count = view.requests.length, draft = view.selector.props.draft;
  view.hover(second); view.hover(`${today.slice(0, 7)}-02`);
  assert.equal(view.requests.length, count); assert.equal(view.selector.props.draft, draft);
  assert.equal(view.settings.mode, "date"); assert.equal(view.writes.length, 0);
  view.dateClick(second);
  assert.equal(view.requests.length, count + 1);
  assert.equal(view.settings.mode, "range");
  assert.equal(view.settings.start, first); assert.equal(view.settings.end, second);
  assert.ok(view.nodes.some(node => node.type === "strong" && node.props.children === 17));
  view.dateClick(first);
  assert.equal(view.settings.mode, "date"); assert.equal(view.settings.end, first);
  view.dateClick(first);
  assert.equal(view.settings.mode, "date");
  assert.equal(view.writes.length, 0);
});

test("backward cross-month ranges and restart feed the existing availability settings", t => {
  const view = setup(t); view.click("指定日期");
  const today = dates.startOfLocalDay(), first = dates.formatDateInputValue(new Date(today.getFullYear(), today.getMonth(), 1));
  view.dateClick(first); view.dateClick("上个月");
  const previous = dates.formatDateInputValue(dates.addDays(new Date(today.getFullYear(), today.getMonth(), 1), -1));
  view.hover(previous);
  assert.equal(view.settings.start, first); assert.equal(view.settings.mode, "date");
  view.dateClick(previous);
  assert.equal(view.settings.mode, "range"); assert.equal(view.settings.start, previous); assert.equal(view.settings.end, first);
  assert.deepEqual(view.settings.sources, ["ctw", "rap", "rdl"]);
});

test("random quantities and custom validation retain their existing behavior across mode switches", t => {
  const view = setup(t);
  assert.equal(view.settings.mode, "random"); assert.equal(view.settings.count, 10);
  const quantity = view.nodes.find(node => node.type === "button" && node.props["aria-label"] === "20 个");
  quantity.props.onClick(); view.render(); assert.equal(view.settings.count, 20);
  view.click("自定义");
  const input = view.nodes.find(node => node.type === "input" && node.props.inputMode === "numeric");
  input.props.onChange({ target: { value: "0" } }); view.render();
  assert.ok(view.button("开始复习").props.disabled);
  view.nodes.find(node => node.type === "input" && node.props.inputMode === "numeric").props.onChange({ target: { value: "25" } }); view.render();
  assert.equal(view.settings.count, 25); assert.ok(!view.button("开始复习").props.disabled);
  view.click("指定日期"); view.click("随机数量");
  assert.equal(view.settings.count, 25); assert.equal(view.settings.start, undefined); assert.equal(view.settings.end, undefined);
});

test("loading/coverage gates and 开始复习 use the existing session creation and navigation", async t => {
  const view = setup(t); view.click("指定日期");
  const today = dates.formatDateInputValue(dates.startOfLocalDay()); view.dateClick(today);
  view.loading = true; view.render(); assert.ok(view.button("开始复习").props.disabled);
  assert.ok(view.nodes.some(node => node.props?.children === "正在核算可复习词条…"));
  view.loading = false; view.coverageError = "REVIEW_COVERAGE_MISSING:ctw"; view.render();
  assert.ok(view.button("开始复习").props.disabled);
  view.coverageError = null; view.render(); assert.ok(!view.button("开始复习").props.disabled);
  const start = view.button("开始复习"); start.props.onClick();
  // The onClick intentionally discards its Promise, as in production.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(view.writes.length, 1);
  assert.equal(view.writes[0].url, "/api/student/wordbook/review");
  assert.deepEqual(view.writes[0].body.settings, view.settings);
  assert.ok(view.writes[0].body.requestId);
  assert.equal(view.saved.length, 1);
  assert.deepEqual(view.pushes, ["/student/wordbook/review/offline-review"]);
});
