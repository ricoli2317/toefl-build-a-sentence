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
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const filename = path.join(root, file);
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  function resolve(id) {
    if (id === "next/link") return ({ children, ...props }) => React.createElement("a", props, children);
    if (id === "./StudentWritingReview") return { ReviewViewTab: ({ children, onClick }) => React.createElement("button", { onClick }, children) };
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
  new Function("require", "module", "exports", code)(resolve, mod, mod.exports);
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
  assert.equal((html.match(/data-correction-review-item/g) || []).length, state.issues.length);
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
