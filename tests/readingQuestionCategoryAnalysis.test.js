const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { createClient } = require("@supabase/supabase-js");
const { loadQuestionCategoryAnalysis } = require("../lib/reading/questionCategoryAnalysis.server.ts");
const { READING_QUESTION_CATEGORIES, categoryPracticeHref } = require("../lib/reading/questionCategory.ts");
const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

// Exercise actual supabase-js serialization and HEAD count response parsing.
// Fixtures represent FK-joined scoring rows, not precomputed category totals.
function countClient(tables, overrides = {}) {
  const requests = [];
  let inFlight = 0, peak = 0;
  const db = createClient("https://fixture.invalid", "fixture-key", {
    auth: { persistSession: false },
    global: { fetch: async (input, init) => {
      inFlight++; peak = Math.max(peak, inFlight);
      const url = new URL(input);
      const table = url.pathname.split("/").at(-1);
      requests.push({ table, url, init });
      assert.equal(init.method, "HEAD");
      assert.equal(new Headers(init.headers).get("Prefer"), "count=exact");
      assert.match(url.searchParams.get("select"), /reading_questions!inner\(\)/);
      assert.doesNotMatch(url.searchParams.get("select"), /student_answer|passage|\*/);
      const valueAt = (row, key) => key.split(".").reduce((value, part) => value?.[part], row);
      const rows = (tables[table] ?? []).filter((row) => [...url.searchParams].every(([key, value]) => {
        if (key === "select") return true;
        if (key === "or") {
          assert.equal(value, "(is_correct.eq.false,is_correct.is.null)");
          return row.is_correct === false || row.is_correct === null;
        }
        assert.ok(value.startsWith("eq."));
        return String(valueAt(row, key)) === value.slice(3);
      }));
      await Promise.resolve();
      inFlight--;
      if (overrides.error) return new Response(null, { status: 500 });
      return new Response(null, { status: 200, headers: overrides.missingCount ? {} : { "Content-Range": `*/${rows.length}` } });
    } }
  });
  return { db, requests, peak: () => peak };
}

function rap(category, extra = {}) {
  return { question_id: "same-question", is_correct: false, student_answer: "wrong",
    reading_questions: { module: "rap", question_category: category },
    reading_attempts: { student_id: "student", task_type: "rap", status: "submitted" }, ...extra };
}
function full(category, extra = {}) {
  return { question_id: "same-question", is_correct: false,
    reading_questions: { module: "rap", question_category: category },
    reading_full_set_module_attempts: { status: "submitted", reading_full_set_attempts: { student_id: "student", status: "completed" } }, ...extra };
}

test("RAP + completed Full Set count wrong events, including repeat questions/unanswered, but exclude incomplete/other students/tasks/corrections/category sessions", async () => {
  const category = "推断题";
  const fixture = countClient({
    reading_attempt_answers: [rap(category), rap(category), rap(category, { student_answer: null }),
      rap(category, { is_correct: true }),
      rap(category, { reading_attempts: { student_id: "student", status: "draft", task_type: "rap" } }),
      rap(category, { reading_attempts: { student_id: "other", status: "submitted", task_type: "rap" } }),
      rap(category, { reading_attempts: { student_id: "student", status: "submitted", task_type: "rdl" } }),
      rap(category, { reading_questions: { module: "ctw", question_category: category } }),
      rap("unmapped")],
    reading_full_set_answers: [full(category), full(category, { is_correct: null }), full(category, { is_correct: true }),
      full(category, { reading_full_set_module_attempts: { status: "submitted", reading_full_set_attempts: { student_id: "student", status: "in_progress" } } }),
      full(category, { reading_full_set_module_attempts: { status: "active", reading_full_set_attempts: { student_id: "student", status: "completed" } } }),
      full(category, { reading_full_set_module_attempts: { status: "submitted", reading_full_set_attempts: { student_id: "other", status: "completed" } } }),
      full(category, { reading_questions: { module: "rdl", question_category: category } })],
    reading_wrongbook_attempt_answers: [rap(category)],
    reading_question_category_session_answers: [rap(category)]
  });
  assert.deepEqual(await loadQuestionCategoryAnalysis(fixture.db, "student"), [{ questionCategory: category, count: 5 }]);
  assert.equal(fixture.requests.length, 20);
  assert.ok(fixture.peak() <= 4);
  assert.deepEqual(new Set(fixture.requests.map((r) => r.table)), new Set(["reading_attempt_answers", "reading_full_set_answers"]));
  assert.match(fixture.requests.find((r) => r.table === "reading_full_set_answers").url.searchParams.get("select"), /reading_full_set_module_attempts!inner\(reading_full_set_attempts!inner\(\)\)/);
});

test("ranking merges both sources, sorts desc with fixed-order ties, returns positive top five only", async () => {
  const amounts = [1, 3, 3, 5, 0, 2, 1, 7, 4, 6];
  const fixture = countClient({
    reading_attempt_answers: READING_QUESTION_CATEGORIES.flatMap((category, i) => Array.from({ length: amounts[i] }, () => rap(category))),
    reading_full_set_answers: [full("词汇题"), full("词汇题")]
  });
  assert.deepEqual(await loadQuestionCategoryAnalysis(fixture.db, "student"), [
    { questionCategory: "词汇题", count: 7 }, { questionCategory: "推断题", count: 7 },
    { questionCategory: "句子插入题", count: 6 }, { questionCategory: "修辞目的题", count: 4 },
    { questionCategory: "否定信息题", count: 3 }
  ]);
});

test("empty histories never pad zero rows; missing/error counts are errors, not a misleading empty state", async () => {
  assert.deepEqual(await loadQuestionCategoryAnalysis(countClient({}).db, "student"), []);
  await assert.rejects(loadQuestionCategoryAnalysis(countClient({}, { missingCount: true }).db, "student"), /count unavailable/);
  await assert.rejects(loadQuestionCategoryAnalysis(countClient({}, { error: true }).db, "student"));
});

function compile(file, mocks = {}) {
  const filename = path.join(root, file);
  const js = ts.transpileModule(read(file), { fileName: filename, compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true
  } }).outputText;
  const loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(root);
  loaded.require = (request) => Object.hasOwn(mocks, request) ? mocks[request] : module.require(request);
  loaded._compile(js, filename);
  return loaded.exports;
}
const shared = compile("components/student/StudentErrorAnalysis.tsx");
const panelProps = {
  title: "Read an Academic Passage 题型分析", subtitle: "高频错误题型", emptyText: "暂无高频错误题型。",
  tone: "orange", minimumProgressPercent: 0,
  renderAction: (item, className) => React.createElement("button", { className }, "专项练习")
};
const render = (props) => renderToStaticMarkup(React.createElement(shared.StudentErrorAnalysis, { ...panelProps, ...props }));

test("shared orange panel renders top five ranks/counts and exact relative widths, including under 10%", () => {
  const html = render({ items: [100, 50, 25, 10, 1, 1].map((count, i) => ({ tag: `category-${i}`, count })) });
  assert.equal((html.match(/<li /g) ?? []).length, 5);
  assert.deepEqual([...html.matchAll(/style="width:([^\"]+)"/g)].map((m) => m[1]), ["100%", "50%", "25%", "10%", "1%"]);
  assert.match(html, /100 题/);
  for (const color of ["bg-orange-50 text-orange-500", "bg-orange-100", "bg-orange-500", "border-orange-300"]) assert.ok(html.includes(color));
  assert.doesNotMatch(html, /category-5/);
});

test("empty/short/loading/error states reuse BAS presentation without placeholder ranking rows", () => {
  const empty = render({ items: [] });
  assert.match(empty, /class="mt-3 text-sm text-student-muted">暂无高频错误题型。/);
  assert.doesNotMatch(empty, /<ol|<li/);
  assert.equal((render({ items: [{ count: 2, tag: "推断题" }] }).match(/<li /g) ?? []).length, 1);
  assert.doesNotMatch(render({ items: [], loading: true }), /暂无/);
  assert.match(render({ items: [], error: true }), /role="alert"/);
});

test("actual BAS wrapper preserves titles, orange theme, grammar links, footer and 10% minimum", () => {
  const file = "components/WrongQuestionsHome.tsx";
  const mocks = Object.fromEntries([...read(file).matchAll(/from "(@\/[^\"]+)"/g)].map((m) => [m[1], {}]));
  Object.assign(mocks, {
    "next/link": { __esModule: true, default: ({ href, children, ...props }) => React.createElement("a", { href, ...props }, children) },
    "next/navigation": {},
    "@/components/icons/StudentPracticeIcons": { STUDENT_PRACTICE_ICONS: {} },
    "@/lib/studentNavigation": { STUDENT_ROUTES: { grammarPractice: "/student/grammar-practice" } },
    "@/components/student/StudentErrorAnalysis": shared
  });
  const { BasGrammarAnalysis } = compile(file, mocks);
  const items = [{ tag: "语法一", count: 100 }, { tag: "语法二", count: 1 }];
  const html = renderToStaticMarkup(React.createElement(BasGrammarAnalysis, { items, tone: "orange", showLinks: false }));
  assert.match(html, /Build a Sentence/); assert.match(html, /高频错误语法点/);
  assert.match(html, /bg-orange-500/); assert.match(html, /width:10%/);
  assert.match(html, /mode=all/); assert.doesNotMatch(html, /查看全部语法点/);
  const links = renderToStaticMarkup(React.createElement(BasGrammarAnalysis, { items }));
  assert.match(links, /查看全部语法点/); assert.match(links, /按语法分类练习/);
  const empty = renderToStaticMarkup(React.createElement(BasGrammarAnalysis, { items: [] }));
  assert.match(empty, /暂无高频错误语法点。/);
});

test("actual category home shares one selected state/dialog/router path between ranking and original list", () => {
  let selected = null, pushed;
  let refreshOnMount;
  const Dialog = () => null;
  const categories = READING_QUESTION_CATEGORIES.map((questionCategory) => ({ questionCategory, count: 30 }));
  const { QuestionCategoryPracticeHome } = compile("components/reading/QuestionCategoryPracticeHome.tsx", {
    react: { ...React, useState: () => [selected, (value) => { selected = value; }] },
    "next/navigation": { useRouter: () => ({ push: (href) => { pushed = href; } }) },
    "@/components/StudentDataCache": { STUDENT_READING_CATEGORY_COUNTS_CACHE_KEY: "counts", STUDENT_READING_HISTORY_CACHE_PREFIX: "reading:history",
      useStudentCachedData: (key, _loader, options) => {
        if (key === "counts") return { data: { categories }, loading: false, error: "" };
        refreshOnMount = options?.refreshOnMount;
        return { data: { ranking: [{ questionCategory: "推断题", count: 7 }] }, loading: false, error: "" };
      } },
    "@/components/student/StudentUI": { StudentNavigation: () => null, StudentErrorState: () => null, StudentLoadingState: () => null },
    "@/components/student/PracticeAmountDialog": { PracticeAmountDialog: Dialog },
    "@/components/student/StudentErrorAnalysis": shared,
    "@/lib/studentNavigation": require("../lib/studentNavigation.ts"),
    "@/lib/studentUiText": require("../lib/studentUiText.ts"),
    "@/lib/wrongQuestionBank": require("../lib/wrongQuestionBank.ts"),
    "@/lib/reading/questionCategory": require("../lib/reading/questionCategory.ts")
  });
  const elements = (node) => !React.isValidElement(node) ? [] : [node, ...React.Children.toArray(node.props.children).flatMap(elements)];
  const tree = QuestionCategoryPracticeHome();
  const all = elements(tree);
  const panel = all.find((el) => el.type === shared.StudentErrorAnalysis);
  const articles = all.filter((el) => el.type === "article");
  assert.equal(articles.length, 10);
  assert.equal(refreshOnMount, true);
  panel.props.renderAction(panel.props.items[0], "orange").props.onClick();
  assert.equal(selected, "推断题");
  let dialog = elements(QuestionCategoryPracticeHome()).find((el) => el.type === Dialog);
  assert.deepEqual(dialog.props.options.map((option) => option.amount), [5, 10, 15, 20]);
  assert.equal(dialog.props.count, 30); // Pool count, NOT historical wrong count (7).
  dialog.props.onStart(5);
  assert.equal(pushed, categoryPracticeHref("推断题", 5));
  dialog.props.onClose(); assert.equal(selected, null);
  elements(articles[0]).find((el) => el.type === "button").props.onClick();
  assert.equal(selected, "事实信息题");
  dialog = elements(QuestionCategoryPracticeHome()).find((el) => el.type === Dialog);
  dialog.props.onStart(20);
  assert.equal(pushed, categoryPracticeHref("事实信息题", 20));
});

test("analysis API authorizes before service-only counts, takes owner from auth, and never writes sessions", () => {
  const api = read("app/api/reading/question-category/analysis/route.ts");
  assert.match(api, /requireReadingAttemptStudent\(request\)/);
  assert.match(api, /if \(auth.error\) return auth.error/);
  assert.match(api, /loadQuestionCategoryAnalysis\(createServiceSupabase\(\), auth.userId\)/);
  assert.ok(api.indexOf("if (auth.error)") < api.indexOf("createServiceSupabase(), auth.userId"));
  assert.doesNotMatch(api, /request\.json|searchParams|POST|insert\(|rpc\(/);
});

test("actual API rejects unauthenticated requests before DB access and ignores forged student IDs", async () => {
  let auth = { error: { status: 401 }, client: null, userId: null };
  let serviceCalls = 0, countedOwner;
  const service = {};
  const route = compile("app/api/reading/question-category/analysis/route.ts", {
    "@/lib/reading/attemptServer": {
      requireReadingAttemptStudent: async () => auth,
      readingAttemptJson: (body, options) => ({ body, status: options?.status ?? 200 }),
      readingAttemptError: () => ({ status: 500 })
    },
    "@/lib/supabase/server": { createServiceSupabase: () => { serviceCalls++; return service; } },
    "@/lib/reading/questionCategoryAnalysis.server": { loadQuestionCategoryAnalysis: async (db, owner) => {
      assert.equal(db, service); countedOwner = owner;
      return [{ questionCategory: "推断题", count: 7 }];
    } }
  });
  const request = new Request("https://fixture.invalid/api/reading/question-category/analysis?studentId=other");
  assert.equal(await route.GET(request), auth.error);
  assert.equal(serviceCalls, 0);
  auth = { error: null, client: {}, userId: "verified-student" };
  assert.deepEqual(await route.GET(request), { status: 200, body: { ranking: [{ questionCategory: "推断题", count: 7 }] } });
  assert.equal(serviceCalls, 1); assert.equal(countedOwner, "verified-student");
});
