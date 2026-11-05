const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { correctionReviewWorkspaceFixture } = require("./fixtures/writingCorrectionReviewFixture.ts");
const root = path.resolve(__dirname, "..");
const cache = new Map();
let activeHooks = null;
const listeners = new Map();
const testDocument = { documentElement: { clientWidth: 1440 }, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const filename = path.join(root, file);
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  function resolve(id) {
    if (id === "react") return { ...React, useState: value => activeHooks ? activeHooks.useState(value) : React.useState(value), useRef: value => activeHooks ? activeHooks.useRef(value) : React.useRef(value), useEffect: (fn, deps) => activeHooks ? activeHooks.useEffect(fn, deps) : React.useEffect(fn, deps) };
    if (id === "next/link") return ({ children, ...props }) => React.createElement("a", props, children);
    if (id === "./StudentWritingReview") return { ReviewViewTab: ({ children, onClick }) => React.createElement("button", { onClick }, children), ReviewTabButton: ({ children, onClick }) => React.createElement("button", { onClick }, children) };
    if (id.endsWith("/StudentDataCache")) return { useStudentCachedData: () => ({ data: { avatars: {} } }) };
    if (id.endsWith("/WritingCorrectionComparison")) return { WritingCorrectionComparison: () => React.createElement("div", { "data-test-comparison": true }) };
    if (id.endsWith("/WritingQuestionPrompt")) return { WritingQuestionReview: () => null };
    if (id.startsWith("@/")) {
      const base = id.slice(2);
      if (fs.existsSync(path.join(root, base + ".tsx"))) return load(base + ".tsx");
      return require(path.join(root, base + ".ts"));
    }
    if (id.startsWith(".")) return load(path.join(path.dirname(file), id + ".tsx"));
    return require(id);
  }
  new Function("require", "module", "exports", "window", "document", code)(resolve, mod, mod.exports, {}, testDocument);
  cache.set(file, mod.exports);
  return mod.exports;
}
const shared = load("components/writing/WritingCorrectionReviewPresentation.tsx");
const student = load("components/student/StudentWritingCorrectionReview.tsx");
const article = load("components/student/StudentWritingReviewArticle.tsx");

test("ordinary published article shell keeps the original DOM and visual classes", () => {
  const { createElement: el } = React;
  const before = el("section", { className: "flex min-w-0 flex-col overflow-hidden rounded-xl border border-student-border bg-white shadow-[0_2px_12px_rgba(60,47,119,0.05)]" },
    el("div", { className: "flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-student-border px-4 py-2.5" }, el("div", null, el("h2", { className: "font-bold text-student-text" }, "批改稿"), el("p", { className: "mt-0.5 text-[11px] text-student-muted" }, "点击修改标记查看对应详情"))),
    el("article", { className: "min-h-[360px] flex-1 overflow-y-auto px-5 py-3.5 text-[15px] leading-7 text-student-text lg:min-h-0 sm:text-base" }, "Existing article"));
  const after = el(article.StudentWritingReviewArticleCard, null, el(article.StudentWritingReviewArticleHeader, { title: "批改稿", caption: "点击修改标记查看对应详情" }), el(article.StudentWritingReviewArticleBody, null, "Existing article"));
  const normalize = node => renderToStaticMarkup(node).replace(/ data-student-review-article-(?:header|body)="true"/g, "").replace(/class="([^"]*)"/g, (_, classes) => `class="${classes.split(" ").sort().join(" ")}"`);
  assert.equal(normalize(after), normalize(before));
});

test("correction reuses the same header and responsive body typography, with one controls row", () => {
  const html = renderToStaticMarkup(React.createElement(article.StudentWritingReviewArticleHeader, { title: "修订正文", reserveCaption: true, singleRow: true, actions: "Toggle" }));
  assert.match(html, /flex-nowrap/);
  assert.match(html, /px-4 py-2.5/);
  assert.match(html, /flex min-h-\[42\.5px\] items-center/);
  assert.doesNotMatch(html, /<p/);
  assert.match(html, /font-bold text-student-text/);
  const body = renderToStaticMarkup(React.createElement(article.StudentWritingReviewArticleBody, null, "Ledger host"));
  assert.match(body, /px-5 py-3.5/);
  assert.match(body, /leading-7.*sm:text-base/);
  assert.doesNotMatch(body, /sm:leading-7/);
  const editor = fs.readFileSync(path.join(root, "components/writing/WritingRevisionEditor.tsx"), "utf8");
  assert.match(editor, /StudentWritingReviewArticleBody ref=\{scroll\}/);
  assert.match(editor, /closest<HTMLElement>\('\.overflow-y-auto'\)/);
  const result = fs.readFileSync(path.join(root, "components/student/StudentWritingCorrectionReview.tsx"), "utf8");
  assert.match(result, /WritingCorrectionComparison studentReview/);
  assert.match(result, /selectedIssue=\{selected \?\? null\} locationRequest=\{locationRequest\}/);
});

for (const taskType of ["email", "academic_discussion"]) test(`published ${taskType} result uses shared read-only review, includes both explanations and no internal labels`, () => {
  const workspace = correctionReviewWorkspaceFixture({ adjusted: true, taskType });
  const state = workspace.review.state;
  const data = { attempt: { ...workspace.attempt, response_text: workspace.corrected_response_text }, question: workspace.question, question_source: workspace.question_source, original_response_text: workspace.source.original_response_text, display_name: "Published fixture", review: {
    original_score: 3, correction_score: 4, score_delta: 1, published_at: "2026-11-05T00:00:00Z", score_rationale: "PUBLISHED_RATIONALE", score_change_explanation: "PUBLISHED_DELTA_REASON", completion: state.completion,
    issues: state.issues.map(issue => ({ ...issue, status: "resolved", explanation: "PUBLISHED_EXPLANATION", ai_explanation: "UNPUBLISHED_INTERNAL_OUTPUT" })), new_issues: []
  } };
  const html = renderToStaticMarkup(React.createElement(student.StudentWritingCorrectionReviewResult, { data, backHref: "/student" }));
  assert.match(html, /PUBLISHED_RATIONALE/);
  assert.match(html, /PUBLISHED_DELTA_REASON/);
  assert.match(html, /PUBLISHED_EXPLANATION/);
  assert.match(html, /role="progressbar"/);
  assert.equal((html.match(/data-completion-stat/g) || []).length, 4);
  assert.equal((html.match(/data-correction-review-item/g) || []).length, 1);
  assert.doesNotMatch(html, /\bAI\b|UNPUBLISHED_INTERNAL_OUTPUT|<select|<textarea|教师已修改|教师判定/);
});

test("shared completion preserves four compact boxes and the supplied published percentage", () => {
  const completion = correctionReviewWorkspaceFixture({ adjusted: true }).review.state.completion;
  const html = renderToStaticMarkup(React.createElement(shared.CorrectionCompletionPanel, { completion }));
  assert.match(html, /grid-cols-2 gap-2/);
  assert.equal((html.match(/flex h-8 /g) || []).length, 4);
  assert.match(html, /无法确定/);
  assert.match(html, new RegExp(`aria-valuenow="${completion.rate * 100}"`));
});

test("shared issue card locates from non-controls and supports keyboard without hijacking inputs", () => {
  const issue = correctionReviewWorkspaceFixture({ adjusted: true }).review.state.issues[0];
  let count = 0;
  const card = shared.CorrectionIssueCard({ issue, selected: false, onLocate: () => count++ });
  card.props.onClick({ target: { closest: () => null } });
  card.props.onClick({ target: { closest: () => ({}) } });
  const target = {};
  card.props.onKeyDown({ target, currentTarget: target, key: "Enter", preventDefault() {} });
  assert.equal(count, 2);
});

test("comparison fills available fluid width and correction review has a separate constrained scroll child", () => {
  const comparison = fs.readFileSync(path.join(root, "components/teacher/WritingCorrectionComparison.tsx"), "utf8");
  assert.match(comparison, /mx-auto w-full min-w-0 max-w/);
  const teacher = fs.readFileSync(path.join(root, "components/teacher/TeacherWritingCorrectionDetail.tsx"), "utf8");
  assert.match(teacher, /data-correction-review-scroll className="min-h-0 flex-1 overflow-y-auto/);
  assert.match(teacher, /filter\(status => status !== "uncertain"\)/);
  const server = fs.readFileSync(path.join(root, "lib/writingCorrectionPublished.server.ts"), "utf8");
  assert.match(server, /select\("published_review,published_at"\)/);
  assert.doesNotMatch(server, /select\([^\n]*(?:teacher_overrides|ai_review|ai_raw)/);
});

function resultHarness({ empty = false, newCount = 2 } = {}) {
  const workspace = correctionReviewWorkspaceFixture({ adjusted: true });
  const state = workspace.review.state;
  const data = { attempt: { ...workspace.attempt, response_text: workspace.corrected_response_text }, question: workspace.question, question_source: workspace.question_source, original_response_text: workspace.source.original_response_text, display_name: "Published fixture", review: {
    original_score: 3, correction_score: 4, score_delta: 1, published_at: "2026-11-05T00:00:00Z", score_rationale: "Published rationale", score_change_explanation: "Published difference", completion: state.completion,
    issues: empty ? [] : state.issues.map(issue => ({ ...issue, status: issue.effective_status, explanation: issue.ai_explanation })),
    new_issues: Array.from({ length: newCount }, (_, index) => ({ ...state.new_issues[0], index }))
  } };
  const slots = []; let cursor = 0, effects = [];
  const hooks = {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial; return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }]; },
    useRef(initial) { const index = cursor++; return slots[index] ?? (slots[index] = { current: initial }); },
    useEffect(fn) { const index = cursor++; effects.push(() => { slots[index]?.(); slots[index] = fn(); }); }
  };
  function render() { cursor = 0; effects = []; activeHooks = hooks; try { const tree = student.StudentWritingCorrectionReviewResult({ data, backHref: "/student" }); effects.forEach(fn => fn()); return tree; } finally { activeHooks = null; } }
  return { data, render };
}
function nodes(tree, predicate) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(child => nodes(child, predicate));
  const children = typeof tree.type === "function" ? tree.type(tree.props) : tree.props?.children;
  return [...(predicate(tree) ? [tree] : []), ...nodes(children, predicate)];
}
const nodeText = tree => typeof tree === "string" || typeof tree === "number" ? String(tree) : Array.isArray(tree) ? tree.map(nodeText).join("") : tree?.props ? nodeText(typeof tree.type === "function" ? tree.type(tree.props) : tree.props.children) : "";
const navigation = (tree, name) => nodes(tree, node => node.type === "button" && node.props["aria-label"] === name)[0];
const tabButton = (tree, prefix) => nodes(tree, node => node.type === "button" && nodeText(node).startsWith(prefix))[0];
const currentCard = tree => nodes(tree, node => node.type?.name === "CorrectionIssueCard")[0];
const comparison = tree => nodes(tree, node => Boolean(node.props?.studentReview))[0];

test("detail navigation keeps independent indices, drives original location and clears it on the new-issue tab", () => {
  const h = resultHarness(); let tree = h.render();
  assert.equal(currentCard(tree).props.issue.issue_id, h.data.review.issues[0].issue_id);
  assert.equal(navigation(tree, "上一条").props.disabled, true);
  navigation(tree, "下一条").props.onClick(); tree = h.render();
  assert.equal(currentCard(tree).props.issue.issue_id, h.data.review.issues[1].issue_id);
  assert.equal(comparison(tree).props.selectedIssue.issue_id, h.data.review.issues[1].issue_id);
  const request = comparison(tree).props.locationRequest;
  tabButton(tree, "订正产生的新问题").props.onClick(); tree = h.render();
  assert.equal(comparison(tree).props.selectedIssue, null);
  assert.equal(navigation(tree, "上一条").props.disabled, true);
  navigation(tree, "下一条").props.onClick(); tree = h.render();
  assert.equal(nodes(tree, node => node.props?.["data-correction-new-issue"] === 1).length, 1);
  assert.equal(navigation(tree, "下一条").props.disabled, true);
  tabButton(tree, "原始问题逐项审核").props.onClick(); tree = h.render();
  assert.equal(currentCard(tree).props.issue.issue_id, h.data.review.issues[1].issue_id);
  assert.ok(comparison(tree).props.locationRequest > request);
  tabButton(tree, "订正产生的新问题").props.onClick(); tree = h.render();
  assert.equal(nodes(tree, node => node.props?.["data-correction-new-issue"] === 1).length, 1);
  tabButton(tree, "原始问题逐项审核").props.onClick(); tree = h.render();
  listeners.get("click")({ clientX: 100, target: { closest: () => null } }); tree = h.render();
  assert.equal(comparison(tree).props.selectedIssue, null);
  assert.equal(currentCard(tree).props.issue.issue_id, h.data.review.issues[1].issue_id, "blank click preserves the index");
  currentCard(tree).props.onLocate(); tree = h.render();
  assert.equal(comparison(tree).props.selectedIssue.issue_id, h.data.review.issues[1].issue_id);
});

test("original detail boundaries, empty tabs and one-item navigation are safe", () => {
  const h = resultHarness({ newCount: 1 }); let tree = h.render();
  for (let index = 1; index < h.data.review.issues.length; index++) { navigation(tree, "下一条").props.onClick(); tree = h.render(); }
  assert.equal(navigation(tree, "下一条").props.disabled, true);
  assert.equal(currentCard(tree).props.issue.issue_id, h.data.review.issues.at(-1).issue_id);
  navigation(tree, "下一条").props.onClick(); tree = h.render();
  assert.equal(currentCard(tree).props.issue.issue_id, h.data.review.issues.at(-1).issue_id);
  tabButton(tree, "订正产生的新问题").props.onClick(); tree = h.render();
  assert.equal(navigation(tree, "上一条").props.disabled, true);
  assert.equal(navigation(tree, "下一条").props.disabled, true);
  const empty = resultHarness({ empty: true, newCount: 0 }); tree = empty.render();
  assert.match(nodeText(tree), /暂无原始问题审核/);
  assert.equal(navigation(tree, "上一条").props.disabled, true);
  assert.equal(navigation(tree, "下一条").props.disabled, true);
  tabButton(tree, "订正产生的新问题").props.onClick(); tree = empty.render();
  assert.match(nodeText(tree), /暂无已发布的新问题/);
  assert.equal(navigation(tree, "上一条").props.disabled, true);
  assert.equal(navigation(tree, "下一条").props.disabled, true);
});

test("review details stay below the article; the right column contains only completion and scoring", () => {
  const h = resultHarness(); const tree = h.render();
  const main = nodes(tree, node => node.type === "main")[0];
  assert.match(main.props.className, /lg:grid-rows-\[minmax\(0,2fr\)_minmax\(0,1fr\)\]/);
  assert.equal(nodes(main, node => node.props?.["data-correction-detail"] !== undefined).length, 1);
  const right = nodes(tree, node => node.type === "aside")[0];
  assert.doesNotMatch(nodeText(right), /原始问题逐项审核|订正产生的新问题/);
  const toolbar = nodes(main, node => node.props?.["data-correction-detail-toolbar"] !== undefined)[0];
  assert.equal(nodes(toolbar, node => node.type === "button").length, 4);
  assert.equal(nodes(main, node => node.props?.["data-correction-review-item"] !== undefined).length, 1);
  const server = fs.readFileSync(path.join(root, "lib/writingCorrectionPublished.server.ts"), "utf8");
  assert.match(server, /new_issues\.filter\(issue => issue\.review_status !== "dismissed"\)/);
});

test("detail caption lives inside the issue card and scoring fills the remaining column with internal scrolling", () => {
  const h = resultHarness(); let tree = h.render();
  assert.equal(nodeText(currentCard(tree).props.badge), "当前审核详情（1/6）");
  const detail = nodes(tree, node => node.props?.["data-correction-detail-scroll"] !== undefined)[0];
  assert.equal(currentCard(tree).props.badge.type, "h2");
  assert.match(currentCard(tree).props.badge.props.className, /order-first basis-full text-sm font-bold/);
  assert.equal(nodes(detail, node => node.type === "h2").length, 1, "title appears once, inside the issue card");
  const score = nodes(tree, node => node.props?.["data-correction-score-card"] !== undefined)[0];
  assert.match(score.props.className, /lg:min-h-0 lg:flex-1 lg:shrink/);
  const scoreScroll = nodes(score, node => node.props?.["data-correction-score-scroll"] !== undefined)[0];
  assert.match(scoreScroll.props.className, /lg:min-h-0 lg:flex-1 lg:overflow-y-auto/);
  navigation(tree, "下一条").props.onClick(); tree = h.render();
  assert.equal(nodeText(currentCard(tree).props.badge), "当前审核详情（2/6）");
  tabButton(tree, "订正产生的新问题").props.onClick(); tree = h.render();
  const newCard = nodes(tree, node => node.props?.["data-correction-new-issue"] === 0)[0];
  assert.match(nodeText(newCard), /当前审核详情（1\/2）/);
});
