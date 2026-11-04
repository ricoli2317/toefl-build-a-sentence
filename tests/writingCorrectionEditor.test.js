const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const ts = require("typescript");
const { createCorrectionFixtureTransport, FIXTURE_ORIGINAL_ID } = require("./fixtures/writingCorrectionFixture.ts");
const ROOT = path.resolve(__dirname, "..");

/**
 * Component/event unit harness, NOT a browser or React DOM/IME integration test.
 * Runs the actual session and shared editor functions with deterministic hooks,
 * HTTP fixtures and DOM geometry doubles; no third-party test dependencies.
 */
function harness() {
  let slots = [], cursor = 0, effects = [], raf = [];
  const listeners = new Map();
  const pushes = [];
  const node = { selectionStart: 0, selectionEnd: 0, offsetWidth: 500, clientWidth: 485,
    scrollHeight: 1500, clientHeight: 300, scrollTop: 1200, scrollLeft: 0,
    focusCalls: 0, rangeCalls: [], focus() { this.focusCalls++; }, setSelectionRange(start, end) { this.rangeCalls.push([start, end]); this.selectionStart = start; this.selectionEnd = end; } };
  const add = (kind, fn) => listeners.set(kind, fn);
  const remove = (kind, fn) => { if (listeners.get(kind) === fn) listeners.delete(kind); };
  const window = { requestAnimationFrame: (fn) => raf.push(fn), location: { href: "http://localhost:3000/student/writing-corrections/id" },
    addEventListener: add, removeEventListener: remove, history: { state: { app: true }, pushState: (...args) => pushes.push(["history", ...args]) } };
  const document = { visibilityState: "visible", addEventListener: add, removeEventListener: remove };
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const hooks = {
    ...React,
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], (value) => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
    useMemo(fn, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { value: fn(), deps }; return slots[i].value; },
    useCallback(fn, deps) { return hooks.useMemo(() => fn, deps); },
    useEffect(fn, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) { effects.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); } }
  };
  function compile(file, extra = "") {
    const filename = path.join(ROOT, file);
    const code = ts.transpileModule(fs.readFileSync(filename, "utf8") + extra, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true
    } }).outputText;
    const compiledModule = { exports: {} };
    function load(request) {
      if (request === "react") return hooks;
      if (request === "next/navigation") return { useRouter: () => ({ push: (href) => pushes.push(["router", href]) }) };
      if (request === "@/components/shared/PracticeHeader") return header;
      if (request.endsWith("/writingCorrectionClient")) return { writingCorrectionClient: {} };
      if (request === "./WritingPractice") return practice;
      if (request === "./WritingPracticeActions") return actions;
      if (request === "@/components/student/StudentWritingReview") return published;
      if (request === "./TeacherWritingReviewWorkspace") return sharedTeacher;
      if (request === "./WritingReviewPresentation") return presentation;
      if (request.startsWith("@/components/") || request.startsWith("./Writing")) return new Proxy({}, { get: () => () => null });
      if (request === "@/lib/writingClientSession") return {};
      if (request === "@/lib/supabase/client") return {};
      if (request.startsWith("@/")) return require(path.join(ROOT, request.slice(2) + ".ts"));
      return require(request);
    }
    new Function("require", "module", "exports", "window", "document", code)(load, compiledModule, compiledModule.exports, window, document);
    return compiledModule.exports;
  }
  const header = compile("components/shared/PracticeHeader.tsx");
  const practice = compile("components/writing/WritingPractice.tsx");
  const actions = compile("components/writing/WritingPracticeActions.tsx");
  const published = compile("components/student/StudentWritingReview.tsx");
  const presentation = compile("components/teacher/WritingReviewPresentation.tsx");
  const sharedTeacher = compile("components/teacher/TeacherWritingReviewWorkspace.tsx");
  const correction = compile("components/writing/WritingCorrection.tsx", "\nexport { WritingCorrectionSession as Session, FrozenCorrectionAnnotations as Annotations };\n");
  const teacher = compile("components/teacher/TeacherWritingCorrectionDetail.tsx");
  const list = compile("components/teacher/TeacherWritingReviewList.tsx", "\nexport { ReviewTable, WritingReviewBulkActions };\n");
  const history = compile("components/writing/WritingCorrectionHistory.tsx");
  function render(fn) { cursor = 0; effects = []; const tree = fn(); for (const effect of effects) effect(); return tree; }
  function flushRaf() { const pending = raf; raf = []; for (const fn of pending) fn(); }
  return { header, practice, correction, teacher, list, history, actions, published, sharedTeacher, presentation, render, flushRaf, node, listeners, pushes, window };
}

function all(tree, predicate) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap((child) => all(child, predicate));
  const child = sharedPresentation(tree) ? tree.type(tree.props) : tree.props?.children;
  return [...(predicate(tree) ? [tree] : []), ...all(child, predicate)];
}
// Expand the actual reused, hook-free UI rather than replacing it with fake
// buttons. Keep stateful components opaque to this deterministic hook harness.
const sharedPresentation = (tree) => typeof tree?.type === "function" && ["PracticeHeader", "PracticeTimer", "WritingPageHeader", "WritingPracticeActions", "ReviewViewTab", "ReviewTabButton", "CompactSection", "WritingReviewInfoBar", "ScoreSelect", "MiniButton", "ReviewWorkspaceFrame", "ReviewWorkspaceGrid", "ReviewToolbar", "ReviewToolbarActions", "ReviewToolbarButton", "ReviewFilterChip", "ReviewFeedbackLine", "ReviewBadge", "ReviewScoreTable", "ReviewScoreRow", "ReviewOfficialScoreCard", "ReviewScoreRationale", "ReviewSelect"].includes(tree.type.name);
const text = (tree) => typeof tree === "string" || typeof tree === "number" ? String(tree) : Array.isArray(tree) ? tree.map(text).join("") : tree?.props ? text(sharedPresentation(tree) ? tree.type(tree.props) : tree.props.children) : "";
const button = (tree, label) => { const result = all(tree, (el) => el.type === "button" && text(el) === label)[0]; assert.ok(result, `button ${label}`); return result; };
const tick = () => new Promise(setImmediate);

test("teacher AI defaults are editable; direct publication and later edits keep draft/snapshot separate", async () => {
  const { correctionReviewWorkspaceFixture, applyFixtureTeacher } = require("./fixtures/writingCorrectionReviewFixture.ts");
  let workspace = correctionReviewWorkspaceFixture({ adjusted: true });
  workspace.review.teacher = { issue_statuses: {}, correction_score: null, score_rationale: null, new_issue_reviews: {} };
  const { correctionReviewState } = require("../lib/writingCorrectionReview.ts");
  workspace.review.state = correctionReviewState({ issues: workspace.review.state.issues, originalScore: 3, ai: workspace.review.ai, teacher: workspace.review.teacher });
  const requests = [];
  const send = async (_path, init) => {
    if (init?.method === "POST") {
      const body = JSON.parse(init.body); requests.push(body);
      workspace = applyFixtureTeacher(workspace, body.teacher, body.action === "publish");
    }
    return Response.json({ workspace });
  };
  const h = harness();
  const run = () => h.teacher.TeacherWritingCorrectionDetail({ attemptId: workspace.attempt.attempt_id, returnTo: "/teacher/writing/reviews", send });
  h.render(run); await tick(); let tree = h.render(run);
  let score = all(tree, el => el.type === "select" && el.props["aria-label"] === "教师订正评分")[0];
  assert.equal(score.props.value, workspace.review.ai.correction_score);
  assert.equal(all(score, el => el.type === "option").length, 6);
  const rationale = all(tree, el => el.type === "textarea" && el.props["aria-label"] === "教师评分解释")[0];
  assert.equal(rationale.props.value, workspace.review.ai.score_rationale);
  const delta = all(tree, el => el.type === "textarea" && el.props["aria-label"] === "分差原因")[0];
  assert.equal(delta.props.value, workspace.review.ai.score_change_explanation);
  const judgment = all(tree, el => el.type === "select" && String(el.props["aria-label"]).startsWith("教师判定"))[0];
  assert.equal(judgment.props.value, workspace.review.state.issues[0].ai_status);
  assert.doesNotMatch(text(tree), /跟随 AI|计算方式|未判定|驳回|AI 请求信息/);
  score.props.onChange({ target: { value: "5" } });
  rationale.props.onChange({ target: { value: "Teacher version" } });
  delta.props.onChange({ target: { value: "Teacher delta" } });
  tree = h.render(run);
  const publish = button(tree, "发布"); publish.props.onClick(); publish.props.onClick();
  await tick(); tree = h.render(run);
  assert.equal(requests.length, 1);
  assert.equal(workspace.review.published.correction_score, 5);
  assert.equal(workspace.review.published.score_change_explanation, "Teacher delta");
  score = all(tree, el => el.type === "select" && el.props["aria-label"] === "教师订正评分")[0];
  assert.equal(score.props.disabled, false);
  score.props.onChange({ target: { value: "4" } }); tree = h.render(run);
  button(tree, "保存").props.onClick(); await tick(); tree = h.render(run);
  assert.equal(workspace.review.teacher.correction_score, 4);
  assert.equal(workspace.review.published.correction_score, 5);
  button(tree, "发布").props.onClick(); await tick(); h.render(run);
  assert.equal(workspace.review.published.correction_score, 4);
  assert.notEqual(workspace.review.ai.score_rationale, "Teacher version");
});

// Session-controller seam only. The real Tiptap editor, history, mapping and
// clipboard are independently exercised by PM tests and actual Chrome tests.
function correctionEditor(tree) {
  const node = all(tree, el => el.props?.initialState?.ledger && el.props?.onChange)[0];
  assert.ok(node, 'shared revision editor is mounted');
  const state = node.props.initialState;
  return { ...node, props: { ...node.props, actions: { text: state.ledger.text,
    canUndo: state.ledger.text !== state.ledger.original,
    onChange: event => node.props.onChange(require('../lib/writingRevisionState.ts').initializeWritingRevision(state.ledger.original, event.currentTarget.value))
  } } };
}

test("Writing header uses Reading's shared presentation and only one Back action", () => {
  const h = harness(); let exits = 0;
  const tree = h.practice.WritingPageHeader({ title: 'A real source title · 订正', onBack: () => exits++, disabled: true });
  assert.ok(all(tree, el => el.type === h.header.PracticeHeader).length === 1);
  assert.equal(button(tree, 'Back').props.disabled, true);
  assert.equal(all(tree, el => el.type === 'button').length, 1);
  button(tree, 'Back').props.onClick(); assert.equal(exits, 1);
  assert.match(text(tree), /A real source title · 订正/);
  assert.doesNotMatch(text(tree), /Exit Practice|Elapsed|Time Left/);
});

test("shared timer is a pure Reading display with caller-owned label, value and responsive visibility", () => {
  const h = harness();
  const tree = h.header.PracticeTimer({ label: 'Time Left', value: '01:09', testId: 'writing-practice-time' });
  assert.match(tree.props.className, /hidden.*sm:flex/);
  const number = all(tree, el => el.props?.['data-testid'] === 'writing-practice-time')[0];
  assert.match(number.props.className, /font-mono.*tabular-nums/);
  assert.equal(text(tree), 'Time Left01:09');
});

test("shared ordinary/correction toolbar renders the same Save/Publish controls and preserves caller locks and callbacks", () => {
  const h = harness(), calls = [];
  const tree = h.presentation.ReviewToolbarActions({ generateLabel: '重新生成 AI 评价', statusText: '有未发布修改', generateDisabled: true, saveDisabled: false, publishDisabled: true, onGenerate: () => calls.push('generate'), onSave: () => calls.push('save'), onPublish: () => calls.push('publish') });
  assert.equal(button(tree, '保存').props.disabled, false);
  assert.equal(button(tree, '发布').props.disabled, true);
  assert.equal(button(tree, '重新生成 AI 评价').props.disabled, true);
  button(tree, '保存').props.onClick(); assert.deepEqual(calls, ['save']);
  assert.match(text(tree), /有未发布修改/);
  assert.match(button(tree, '保存').props.className, /!min-h-8 !px-3 !py-1 text-xs/);
});

test("official score display reuses its reference textarea without inventing dimension scores or changing values", () => {
  const h = harness();
  let value;
  const tree = h.presentation.ReviewOfficialScoreCard({ aiScore: 3, teacherControl: React.createElement(h.sharedTeacher.ScoreSelect, { value: 4, onChange() {} }), rationale: React.createElement(h.presentation.ReviewScoreRationale, { value: 'Teacher rationale', disabled: true, onChange: event => { value = event.target.value; } }) });
  assert.match(text(tree), /官方整体评分AI：3教师最终/);
  const textarea = all(tree, el => el.type === 'textarea')[0];
  assert.equal(textarea.props.value, 'Teacher rationale'); assert.equal(textarea.props.disabled, true);
  assert.match(textarea.props.className, /h-16.*text-\[10px\].*leading-4/);
  textarea.props.onChange({ target: { value: 'Updated' } }); assert.equal(value, 'Updated');
  assert.equal(all(tree, el => el.type === 'select')[0].props.value, 4);
});

test("ordinary and correction feedback cards use one presentational article while keeping arbitrary issue content", () => {
  const h = harness(), { renderToStaticMarkup } = require('react-dom/server');
  const html = renderToStaticMarkup(React.createElement(h.presentation.ReviewFeedbackCard, null, React.createElement(h.presentation.ReviewFeedbackLine, { label: '建议', value: 'Frozen suggestion' })));
  assert.match(html, /<article/); assert.match(html, /text-\[11px\] leading-\[1\.55\]/);
  assert.match(html, /<strong>建议：<\/strong>Frozen suggestion/);
});

test("reused score selector preserves ordinary 0–5 defaults and adds nullable AI inheritance only when requested", () => {
  const h = harness();
  let changed = 'unchanged';
  const ordinary = h.sharedTeacher.ScoreSelect({ value: 3, onChange: value => { changed = value; } });
  assert.equal(ordinary.props.value, 3);
  assert.equal(ordinary.props.disabled, false);
  assert.deepEqual(all(ordinary, el => el.type === 'option').map(el => el.props.value), [0, 1, 2, 3, 4, 5]);
  ordinary.props.onChange({ target: { value: '0' } }); assert.equal(changed, 0);
  const correction = h.sharedTeacher.ScoreSelect({ value: null, disabled: true, inheritLabel: '跟随 AI（3）', onChange: value => { changed = value; } });
  assert.equal(correction.props.value, ''); assert.equal(correction.props.disabled, true);
  assert.deepEqual(all(correction, el => el.type === 'option').map(el => el.props.value), ['', 0, 1, 2, 3, 4, 5]);
  correction.props.onChange({ target: { value: '' } }); assert.equal(changed, null);
});

test("reused writing actions keep ordinary labels and independent correction save/submit disabled states", () => {
  const h = harness();
  const ordinary = h.actions.WritingPracticeActions({ disabled: false, onSave() {}, onSubmit() {} });
  assert.equal(button(ordinary, 'Save Draft').props.disabled, false);
  assert.equal(button(ordinary, 'Submit').props.disabled, false);
  const correction = h.actions.WritingPracticeActions({ disabled: false, onSave() {}, onSubmit() {}, saveDisabled: true, saveLabel: '保存草稿', submitLabel: '提交订正' });
  assert.equal(button(correction, '保存草稿').props.disabled, true);
  assert.equal(button(correction, '提交订正').props.disabled, false);
});

test("reused review tabs retain ordinary navigation semantics and add correction tab/panel linkage", () => {
  const h = harness();
  const ordinary = h.published.ReviewViewTab({ active: true, children: '批改稿', onClick() {} });
  assert.equal(ordinary.props['aria-current'], 'page'); assert.equal(ordinary.props.role, undefined);
  const correction = h.published.ReviewViewTab({ active: false, tabId: 'edit-tab', panelId: 'edit-panel', children: '编辑订正', onClick() {} });
  assert.equal(correction.props.role, 'tab'); assert.equal(correction.props['aria-selected'], false);
  assert.equal(correction.props.id, 'edit-tab'); assert.equal(correction.props['aria-controls'], 'edit-panel');
  assert.equal(correction.props['aria-current'], undefined);
});

test("shared editor event simulation: Cut/Paste/Undo/Redo retain text, selection and internal clipboard", () => {
  const h = harness();
  const run = () => h.practice.useWritingEditor("Alpha beta", [], () => {}, () => false, false);
  let editor = h.render(run);
  editor.textareaRef.current = h.node;
  h.node.selectionStart = 0; h.node.selectionEnd = 5;
  editor.cut(); editor = h.render(run); h.flushRaf();
  assert.equal(editor.text, " beta"); assert.equal(editor.internalClipboard, "Alpha");
  assert.deepEqual(h.node.rangeCalls.at(-1), [0, 0]);
  h.node.selectionStart = 5; h.node.selectionEnd = 5;
  editor.pasteInternal(); editor = h.render(run); h.flushRaf();
  assert.equal(editor.text, " betaAlpha");
  editor.undo(); editor = h.render(run); h.flushRaf(); assert.equal(editor.text, " beta");
  editor.undo(); editor = h.render(run); h.flushRaf(); assert.equal(editor.text, "Alpha beta");
  editor.redo(); editor = h.render(run); h.flushRaf(); assert.equal(editor.text, " beta");
  assert.deepEqual(editor.overtimeRanges, []);
});

test("IME event simulation never forces focus or selection during composition; mirror geometry remains shared", () => {
  const h = harness();
  const run = () => h.practice.useWritingEditor("", [], () => {}, () => false, false);
  let editor = h.render(run);
  editor.textareaRef.current = h.node;
  const mirror = { style: {}, scrollHeight: 1500, clientHeight: 300, scrollTop: 0, scrollLeft: 0 };
  editor.mirrorRef.current = mirror;
  editor.onCompositionStart();
  editor.onChange({ currentTarget: { value: "中", selectionStart: 1, selectionEnd: 1 } });
  editor = h.render(run); h.flushRaf();
  assert.equal(editor.text, "中");
  assert.equal(h.node.rangeCalls.length, 0);
  assert.equal(h.node.focusCalls, 0);
  let prevented = false;
  editor.onKeyDown({ metaKey: true, key: "z", nativeEvent: { isComposing: true }, preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  editor.onCompositionEnd();
  assert.equal(mirror.style.right, "15px");
  assert.equal(mirror.scrollTop, 1200);
  editor.onChange({ currentTarget: { value: "中文", selectionStart: 2, selectionEnd: 2 } });
  editor = h.render(run); h.flushRaf();
  assert.equal(editor.text, "中文"); assert.deepEqual(h.node.rangeCalls.at(-1), [2, 2]);
  const previousFocusCalls = h.node.focusCalls;
  editor.onChange({ currentTarget: { value: "中文a", selectionStart: 3, selectionEnd: 3 } });
  editor.onCompositionStart(); h.flushRaf();
  assert.equal(h.node.focusCalls, previousFocusCalls, "a pre-composition queued frame must not move selection");
});

test("actual correction session: tab switching retains editor history and unsaved text; save updates the version", async () => {
  const store = new Map();
  const fixture = createCorrectionFixtureTransport({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }, "email", false);
  const attempt = await fixture.client.create(FIXTURE_ORIGINAL_ID);
  const h = harness();
  const run = () => h.correction.Session({ initialAttempt: attempt, backHref: "/original", client: fixture.client });
  let tree = h.render(run);
  const getEditor = () => correctionEditor(tree).props.actions;
  const edit = (value) => { getEditor().onChange({ currentTarget: { value, selectionStart: value.length, selectionEnd: value.length } }); tree = h.render(run); };
  assert.match(text(tree), /已保存/); // unchanged legacy drafts do not warn on Back
  edit(attempt.response_text + "\nMy changes.");
  assert.match(text(tree), /有未保存修改/);
  assert.ok(getEditor().canUndo);
  button(tree, "查看批注").props.onClick(); tree = h.render(run);
  assert.equal(all(tree, (el) => el.props?.id === "correction-edit")[0].props.hidden, true);
  button(tree, "编辑订正").props.onClick(); tree = h.render(run);
  assert.equal(getEditor().text, attempt.response_text + "\nMy changes.");
  assert.ok(getEditor().canUndo);
  button(tree, "Save Draft").props.onClick(); tree = h.render(run);
  assert.equal(button(tree, "Save Draft").props.disabled, true);
  await tick(); tree = h.render(run);
  assert.match(text(tree), /已保存/);
  assert.equal((await fixture.client.load(attempt.attempt_id)).response_text, getEditor().text);
});

test("actual session: 409 keeps local text; latest draft is only loaded after explicit replacement confirmation", async () => {
  const store = new Map();
  const fixture = createCorrectionFixtureTransport({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }, "academic_discussion", true);
  const attempt = await fixture.client.create(FIXTURE_ORIGINAL_ID);
  let loads = 0;
  const client = { ...fixture.client, load: (...args) => { loads++; return fixture.client.load(...args); } };
  const h = harness();
  const run = () => h.correction.Session({ initialAttempt: attempt, backHref: "/original", client });
  let tree = h.render(run);
  const getEditor = () => correctionEditor(tree).props.actions;
  getEditor().onChange({ currentTarget: { value: "Local unsaved text", selectionStart: 18, selectionEnd: 18 } }); tree = h.render(run);
  fixture.failNext("conflict");
  button(tree, "Save Draft").props.onClick(); await tick(); tree = h.render(run);
  assert.equal(getEditor().text, "Local unsaved text"); assert.equal(loads, 0);
  assert.equal(button(tree, "Save Draft").props.disabled, true);
  button(tree, "重新读取最新草稿").props.onClick(); tree = h.render(run);
  assert.equal(loads, 0);
  const localPreview = all(tree, (el) => el.type === "textarea")[0];
  assert.equal(localPreview.props.value, "Local unsaved text");
  button(tree, "确认读取并替换").props.onClick(); await tick(); tree = h.render(run);
  assert.equal(loads, 1);
  assert.match(getEditor().text, /Saved in another tab/);
  assert.match(text(tree), /已保存/);
  assert.match(text(tree), /Local unsaved text/); // recoverable, page-local copy
});

test("actual session: failed save cannot exit; discard/cancel and unload guards perform no asynchronous saves", async () => {
  const store = new Map();
  const fixture = createCorrectionFixtureTransport({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }, "email", false);
  const attempt = await fixture.client.create(FIXTURE_ORIGINAL_ID);
  const h = harness();
  const run = () => h.correction.Session({ initialAttempt: attempt, backHref: "/original", client: fixture.client });
  let tree = h.render(run);
  correctionEditor(tree).props.actions.onChange({ currentTarget: { value: "Unsaved", selectionStart: 7, selectionEnd: 7 } }); tree = h.render(run);
  let prevented = false;
  h.listeners.get("beforeunload")({ preventDefault() { prevented = true; } });
  assert.ok(prevented);
  button(tree, "Back").props.onClick(); tree = h.render(run);
  button(tree, "取消").props.onClick(); tree = h.render(run);
  assert.equal(h.pushes.length, 0);
  button(tree, "Back").props.onClick(); tree = h.render(run);
  fixture.failNext("network");
  button(tree, "保存并退出").props.onClick(); await tick(); tree = h.render(run);
  assert.equal(h.pushes.length, 0);
  assert.match(text(tree), /有未保存修改/);
  button(tree, "Back").props.onClick(); tree = h.render(run);
  button(tree, "放弃修改").props.onClick();
  assert.deepEqual(h.pushes.at(-1), ["router", "/original"]);
  assert.equal((await fixture.client.load(attempt.attempt_id)).response_text, attempt.response_text);
});

test("actual frozen panel feeds only frozen original and LE/F to the shared marker/detail components", async () => {
  const fixture = createCorrectionFixtureTransport({ getItem: () => null, setItem: () => {} }, "email", false);
  const attempt = await fixture.client.create(FIXTURE_ORIGINAL_ID);
  attempt.response_text = "Completely different correction body";
  const h = harness();
  const tree = h.render(() => h.correction.Annotations({ attempt }));
  const marked = all(tree, (el) => Boolean(el.props?.markerSegments))[0];
  assert.equal(marked.props.markerSegments.map((part) => part.originalText).join(""), attempt.correction_source_snapshot.original_response_text);
  assert.equal(marked.props.markerSegments.some((part) => part.edit?.edit_id === "fixture-le"), true);
  assert.equal(marked.props.markerSegments.some((part) => part.feedbackIds.includes("fixture-f")), true);
  assert.doesNotMatch(text(tree), /HIDDEN SCORE|HIDDEN OVERALL|HIDDEN TEACHER|Completely different/);
  const detail = all(tree, (el) => Boolean(el.props?.item))[0];
  assert.equal(detail.props.item.edit.edit_id, "fixture-le");
  assert.equal(detail.props.item.edit.original_text, "I is");
});

test("actual shared textarea/mirror markup accepts display-only blue background/text without changing typography", () => {
  const { renderToStaticMarkup } = require("react-dom/server");
  const h = harness();
  const actions = h.render(() => h.practice.useWritingEditor("One  two\n", [], () => {}, () => false, false));
  const markup = renderToStaticMarkup(React.createElement(h.practice.WritingEditor, {
    actions, compact: true, disabled: false,
    mirrorContent: React.createElement("span", { style: require("../lib/writingCorrectionDisplay.ts").WRITING_CORRECTION_CHANGE_STYLE }, actions.text)
  }));
  assert.match(markup, /background-color:#E8F2FF;color:#2457A6/);
  assert.match(markup, /<textarea[^>]+aria-label="Writing response"/);
  assert.equal((markup.match(/px-4 py-3 text-\[15px\] leading-\[1\.45\]/g) ?? []).length, 2);
  assert.match(markup, /whitespace-pre-wrap break-words/);
  assert.match(markup, /caret-\[#172033\]/);
  assert.doesNotMatch(markup, /contenteditable|data-edit-id|data-feedback-marker/);
});

for (const failure of [null, "network", "conflict", "lost-submit"]) {
  test(`Phase 3 actual session: save before submit, duplicate-click guard, failure=${failure} (Mock)`, async () => {
    const store = new Map();
    const fixture = createCorrectionFixtureTransport({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }, "email", false);
    const attempt = await fixture.client.create(FIXTURE_ORIGINAL_ID);
    const calls = [];
    const client = { ...fixture.client,
      save: (...args) => { calls.push(["save", ...args]); return fixture.client.save(...args); },
      submit: (...args) => { calls.push(["submit", ...args]); return fixture.client.submit(...args); } };
    const h = harness();
    const run = () => h.correction.Session({ initialAttempt: attempt, backHref: "/original", client });
    let tree = h.render(run);
    const getEditor = () => correctionEditor(tree);
    getEditor().props.actions.onChange({ currentTarget: { value: "Last edited body", selectionStart: 16, selectionEnd: 16 } }); tree = h.render(run);
    if (failure) fixture.failNext(failure);
    const submit = button(tree, "提交订正");
    submit.props.onClick(); submit.props.onClick(); tree = h.render(run);
    assert.doesNotMatch(text(tree), /确认提交/);
    await tick(); tree = h.render(run);
    assert.equal(calls.filter((call) => call[0] === "save").length, 1);
    if (failure === "network" || failure === "conflict") {
      assert.equal(calls.filter((call) => call[0] === "submit").length, 0);
      assert.equal(getEditor().props.actions.text, "Last edited body");
      assert.equal(button(tree, "提交订正").props.disabled, failure === "conflict");
    } else {
      assert.deepEqual(calls.map((call) => call[0]), ["save", "submit"]);
      assert.equal(calls[1][2], 1, "submit must use save's fresh version");
      if (failure === "lost-submit") {
        assert.equal(getEditor().props.readOnly, true);
        button(tree, "重试提交").props.onClick(); await tick(); tree = h.render(run);
        assert.deepEqual(calls.map((call) => call[0]), ["save", "submit", "submit"]);
        assert.equal(calls[2][2], 1);
      }
      assert.equal(getEditor().props.readOnly, true);
      assert.equal(getEditor().props.actions.text, "Last edited body");
      assert.match(text(tree), /已提交/);
      assert.doesNotMatch(text(tree), /订正提交成功|只读/);
      button(tree, "Back").props.onClick();
      assert.deepEqual(h.pushes.at(-1), ["router", "/original"]);
      assert.equal(all(tree, (el) => el.type === "button" && ["Save Draft", "提交订正", "编辑订正"].includes(text(el))).length, 0);
      assert.equal((await fixture.client.history(FIXTURE_ORIGINAL_ID)).length, 1);
    }
  });
}

test("Phase 3 actual session submits saved body without a redundant save and loads submitted read-only (Mock)", async () => {
  const store = new Map();
  const fixture = createCorrectionFixtureTransport({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }, "academic_discussion", true);
  const attempt = await fixture.client.create(FIXTURE_ORIGINAL_ID);
  let saves = 0;
  // This case is already adopted, unlike an old text-only draft. Adoption of
  // legacy drafts is tested separately and must save even if text is unchanged.
  attempt.revision_state = require('../lib/writingRevisionState.ts').initializeWritingRevision(attempt.response_text, attempt.response_text);
  const client = { ...fixture.client, save: () => { saves++; throw new Error("must not save"); } };
  // The transport must actually hold the adopted state, not just the local prop.
  const fixtureState = attempt.revision_state;
  const originalSubmit = client.submit;
  client.submit = async (...args) => ({ ...await originalSubmit(...args), revision_state: fixtureState });
  const h = harness();
  const run = () => h.correction.Session({ initialAttempt: attempt, backHref: "/original", client });
  let tree = h.render(run);
  button(tree, "提交订正").props.onClick(); await tick(); tree = h.render(run);
  assert.equal(saves, 0);
  const submitted = await client.load(attempt.attempt_id);
  const loaded = harness();
  const loadedTree = loaded.render(() => loaded.correction.Session({ initialAttempt: submitted, backHref: "/original", client }));
  assert.equal(correctionEditor(loadedTree).props.readOnly, true);
  assert.doesNotMatch(text(loadedTree), /Save Draft|编辑订正|提交订正/);
});

for (const hasDraft of [false, true]) test(`teacher detail reuses review controls and logs, without return/publish confirmation, draft=${hasDraft}`, async () => {
  const store = new Map();
  const fixture = createCorrectionFixtureTransport({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }, "email", false);
  const attempt = await fixture.client.create(FIXTURE_ORIGINAL_ID);
  await fixture.client.submit(attempt.attempt_id, 0);
  if (hasDraft) await fixture.client.create(FIXTURE_ORIGINAL_ID);
  const h = harness();
  const run = () => h.teacher.TeacherWritingCorrectionDetail({ attemptId: attempt.attempt_id, returnTo: "/teacher/writing/reviews", send: fixture.teacherSend });
  h.render(run); await tick(); let tree = h.render(run);
  assert.match(text(tree), /Mock Student/);
  // This harness stubs every @/components import, so the comparison body is
  // covered by tests/writingCorrectionComparison.test.js and the browser pass.
  // Here we assert the Phase 4 workspace shell replaced the read-only receiver.
  assert.match(text(tree), /订正批改/);
  assert.ok(all(tree, el => Boolean(el.props?.corrected)).length);
  assert.match(text(tree), /完成度/);
  assert.doesNotMatch(text(tree), /HIDDEN SCORE|HIDDEN TEACHER|HIDDEN OVERALL/);
  assert.doesNotMatch(text(tree), /只读接收/);
  assert.doesNotMatch(text(tree), /退回订正|已发布并冻结|计算方式|跟随 AI/);
  assert.match(text(tree), /查看 AI 日志/);
  assert.equal(all(tree, el => el.props?.title === "发布订正评价").length, 0);
  assert.equal((await fixture.client.load(attempt.attempt_id)).status, "submitted");
});

test("teacher queue uses the same ignore control for corrections and originals", () => {
  const h = harness();
  const original = { attemptId: "original", studentName: "Student", taskType: "email", displayName: "Title", reviewStatus: "pending", reviewContext: "free_practice" };
  const correction = { ...original, attemptId: "correction", attemptKind: "correction", originalAttemptId: "original" };
  const tree = h.render(() => h.list.ReviewTable({ actions: { busy: false }, attempts: [original, correction], filtered: [original, correction], loading: false, error: "", returnTo: "/teacher/writing/reviews", emptyTexts: {}, selection: { selectedIds: new Set(), addMany() {} } }));
  assert.match(text(tree), /订正稿/);
  const rows = all(tree, (el) => el.type === "tr" && el.props["data-writing-review-row"]);
  assert.equal(rows.length, 2);
  assert.equal(all(rows[0], (el) => el.type === "button" && text(el) === "忽略").length, 1);
  assert.equal(all(rows[1], (el) => el.type === "button" && text(el) === "忽略").length, 1);
  assert.doesNotMatch(text(rows[1]), /原稿：|订正：/);
  assert.equal(button(rows[1], "退回").props.disabled, false);
  assert.match(all(rows[1], (el) => el.props?.href)[0].props.href, /\/correction\?returnTo=/);
  const bulk = h.render(() => h.list.WritingReviewBulkActions({ busy: false, count: 2 }));
  assert.equal(Boolean(button(bulk, "忽略").props.disabled), false);
});

test("Phase 3 history presentation separates resumable drafts from read-only submitted records and uses DB review status", () => {
  const h = harness();
  const tree = h.render(() => h.history.WritingCorrectionHistoryItems({ items: [
    { attempt_id: "draft", task_type: "email", status: "draft", submitted_at: null, reviewStatus: null },
    { attempt_id: "submitted", task_type: "academic_discussion", status: "submitted", submitted_at: "2026-11-03T00:00:00Z", reviewStatus: "pending" },
    { attempt_id: "reviewing", task_type: "email", status: "submitted", submitted_at: "2026-11-03T00:00:00Z", reviewStatus: "reviewing" }
  ] }));
  const historyRows = all(tree, (el) => el.type === "li");
  assert.match(text(historyRows[0]), /尚未提交草稿继续订正/);
  assert.match(text(historyRows[1]), /已提交等待批改中查看/);
  assert.doesNotMatch(text(tree), /WE · 订正|AD · 订正|只读/);
  const links = all(tree, (el) => el.type === "a");
  assert.equal(text(links[0]), "继续订正");
  assert.equal(text(links[1]), "查看");
  assert.match(links[0].props.href, /\/writing-corrections\/draft/);
  assert.doesNotMatch(text(tree), /评分|完成度|AI/);
});

for (const status of [409, 502]) test(`Phase 3 submit failure after successful save: ${status} preserves saved text/version; never creates attempt`, async () => {
  const { CorrectionRequestError } = require("../lib/writingCorrectionUi.ts");
  const store = new Map();
  const fixture = createCorrectionFixtureTransport({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }, "email", false);
  const attempt = await fixture.client.create(FIXTURE_ORIGINAL_ID);
  let submits = 0;
  const client = { ...fixture.client, submit: async () => { submits++; throw new CorrectionRequestError(status, status === 409 ? "WRITING_CORRECTION_VERSION_CONFLICT" : "CORRECTION_REQUEST_FAILED", "Submit failed"); } };
  const h = harness();
  const run = () => h.correction.Session({ initialAttempt: attempt, backHref: "/original", client });
  let tree = h.render(run);
  const getEditor = () => correctionEditor(tree);
  getEditor().props.actions.onChange({ currentTarget: { value: "Final saved body", selectionStart: 16, selectionEnd: 16 } }); tree = h.render(run);
  button(tree, "提交订正").props.onClick(); await tick(); tree = h.render(run);
  assert.equal(submits, 1);
  assert.equal(getEditor().props.actions.text, "Final saved body");
  const saved = await fixture.client.load(attempt.attempt_id);
  assert.equal(saved.draft_version, 1); assert.equal(saved.response_text, "Final saved body");
  assert.equal((await fixture.client.history(FIXTURE_ORIGINAL_ID)).length, 1);
  if (status === 409) assert.equal(button(tree, "提交订正").props.disabled, true);
  else { assert.equal(getEditor().props.readOnly, true); assert.ok(button(tree, "重试提交")); }
});

test('a different version submitted by another tab is a conflict, never shown as our local submission', async () => {
  const store = new Map();
  const fixture = createCorrectionFixtureTransport({getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)},'email',false);
  const attempt = await fixture.client.create(FIXTURE_ORIGINAL_ID);
  const client = {...fixture.client, submit:async () => ({...attempt,status:'submitted',submitted_at:'2026-11-04T00:00:00Z',draft_version:3,response_text:'Other submitted body',
    revision_state:require('../lib/writingRevisionState.ts').initializeWritingRevision(attempt.response_text,'Other submitted body')})};
  const h=harness();const run=()=>h.correction.Session({initialAttempt:attempt,backHref:'/original',client});let tree=h.render(run);
  correctionEditor(tree).props.actions.onChange({currentTarget:{value:'My local body'}});tree=h.render(run);
  button(tree,'提交订正').props.onClick();await tick();tree=h.render(run);
  assert.equal(correctionEditor(tree).props.actions.text,'My local body');assert.doesNotMatch(text(tree),/订正提交成功/);
  assert.equal(button(tree,'提交订正').props.disabled,true);assert.match(text(tree),/修订版本与本地不同/);
});
