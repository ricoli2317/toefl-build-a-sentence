const test = require("node:test");
const assert = require("node:assert/strict");
const { writingCorrectionDisplaySides } = require("../lib/writingCorrectionDisplay.ts");
const {
  legacyParagraphRanges,
  sliceStyledParts,
  visualLineRanges
} = require("../lib/writingCorrectionVisualLines.ts");

const changedText = (parts) =>
  parts.filter((part) => part.changed).map((part) => part.text).join("");

test("both sides of the diff are marked: additions on the current, deletions on the original", () => {
  const sides = writingCorrectionDisplaySides(
    "I is writing to suggest a workshop.",
    "I am writing to suggest a weekend workshop."
  );
  assert.equal(sides.original.map((part) => part.text).join(""), "I is writing to suggest a workshop.");
  assert.equal(sides.current.map((part) => part.text).join(""), "I am writing to suggest a weekend workshop.");
  assert.ok(changedText(sides.original).includes("is"));
  assert.ok(changedText(sides.current).includes("am"));
  assert.ok(changedText(sides.current).includes("weekend"));
  assert.ok(!changedText(sides.original).includes("workshop"));
});

test("identical documents produce no changed parts on either side", () => {
  const sides = writingCorrectionDisplaySides("Same text.", "Same text.");
  assert.equal(changedText(sides.original), "");
  assert.equal(changedText(sides.current), "");
});

test("a pure deletion only marks the original side", () => {
  const sides = writingCorrectionDisplaySides(
    "First sentence. Second sentence.",
    "First sentence."
  );
  assert.equal(changedText(sides.current), "");
  assert.ok(changedText(sides.original).includes("Second"));
});

test("a pure insertion only marks the current side", () => {
  const sides = writingCorrectionDisplaySides("First sentence.", "First sentence. Second one.");
  assert.equal(changedText(sides.original), "");
  assert.ok(changedText(sides.current).includes("Second"));
});

test("paragraph fallback splits on newlines and keeps empty paragraphs", () => {
  const text = "A\n\nB";
  assert.deepEqual(legacyParagraphRanges(text), [
    { start: 0, end: 1 },
    { start: 2, end: 2 },
    { start: 3, end: 4 }
  ]);
});

test("visual lines fall back to paragraphs without a DOM", () => {
  const ranges = visualLineRanges({} , "A\nB");
  assert.deepEqual(ranges, [
    { start: 0, end: 1 },
    { start: 2, end: 3 }
  ]);
});

test("slicing keeps only the requested line and preserves change flags", () => {
  const parts = [
    { text: "Alpha ", changed: false },
    { text: "beta", changed: true },
    { text: " gamma", changed: false }
  ];
  const first = sliceStyledParts(parts, { start: 0, end: 6 });
  assert.equal(first.map((part) => part.text).join(""), "Alpha ");
  assert.deepEqual(first.map((part) => part.changed), [false]);

  const second = sliceStyledParts(parts, { start: 6, end: 16 });
  assert.equal(second.map((part) => part.text).join(""), "beta gamma");
  assert.deepEqual(second.map((part) => part.changed), [true, false]);

  const empty = sliceStyledParts(parts, { start: 16, end: 16 });
  assert.deepEqual(empty, []);
});

test("slicing never invents or drops characters across boundaries", () => {
  const parts = writingCorrectionDisplaySides("one two three", "one 2 three").current;
  const lines = legacyParagraphRanges("one 2 three");
  const rendered = lines
    .flatMap((line) => sliceStyledParts(parts, line))
    .map((part) => part.text)
    .join("");
  assert.equal(rendered, "one 2 three");
});

test("comparison mounts the SAME revision view as students, readonly with teacher typography and exact blank text", () => {
  const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
  const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../components/teacher/WritingCorrectionComparison.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  const module = { exports: {} }; let received;
  const load = name => name === 'react' ? { ...React, useMemo: fn => fn(), useState: init => [init(), () => {}], useRef: () => ({ current: null }), useEffect() {} }
    : name === './WritingReviewPresentation' ? { REVIEW_ESSAY_TEXT_CLASS: 'text-[15px] leading-8' }
    : name === '@/components/writing/WritingRevisionEditor' ? { WritingRevisionEditor: props => { received = props; return React.createElement('article', null, props.initialState.ledger.text); } }
    : name.startsWith('@/lib/') ? require(path.join(__dirname, '..', name.slice(2) + '.ts')) : require(name);
  new Function('require', 'module', 'exports', code)(load, module, module.exports);
  const html = renderToStaticMarkup(React.createElement(module.exports.WritingCorrectionComparison, { original: 'A\n\nB', corrected: 'A\n\nBetter' }));
  assert.equal(received.teacher, true); assert.equal(received.readOnly, true);
  assert.equal(received.className, 'text-[15px] leading-8');
  assert.equal(received.initialState.ledger.original, 'A\n\nB');
  assert.equal(received.initialState.ledger.text, 'A\n\nBetter');
  assert.match(html, /<article>A\n\nBetter<\/article>/);
  assert.doesNotMatch(html, /data-comparison-group|data-comparison-side|#FAF9FF/);
  assert.doesNotMatch(html, /\u00a0|&nbsp;|rounded|shadow/);
});
