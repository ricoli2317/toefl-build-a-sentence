const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  resolveMirrorScrollTop,
  writingScrollbarWidth
} = require("../lib/writingEditorScroll.ts");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

test("classic scrollbars report their layout width, overlay scrollbars report zero", () => {
  assert.equal(writingScrollbarWidth(754, 739), 15);
  assert.equal(writingScrollbarWidth(800, 800), 0);
  assert.equal(writingScrollbarWidth(739, 754), 0);
  assert.equal(writingScrollbarWidth(Number.NaN, 700), 0);
  assert.equal(writingScrollbarWidth(700, Number.NaN), 0);
});

test("mirror follows the textarea position when both layers share the same height", () => {
  assert.equal(
    resolveMirrorScrollTop({
      textareaScrollTop: 1200,
      textareaScrollHeight: 5000,
      textareaClientHeight: 320,
      mirrorScrollHeight: 5000,
      mirrorClientHeight: 320
    }),
    1200
  );
});

test("mirror clamps to its own maximum scroll position", () => {
  assert.equal(
    resolveMirrorScrollTop({
      textareaScrollTop: 4500,
      textareaScrollHeight: 5000,
      textareaClientHeight: 320,
      mirrorScrollHeight: 4600,
      mirrorClientHeight: 320
    }),
    4280
  );
});

test("mirror pins to its bottom when the textarea is at its bottom edge", () => {
  assert.equal(
    resolveMirrorScrollTop({
      textareaScrollTop: 4680,
      textareaScrollHeight: 5000,
      textareaClientHeight: 320,
      mirrorScrollHeight: 4800,
      mirrorClientHeight: 320
    }),
    4480
  );
  // Sub-pixel differences at the bottom still pin both layers to the end.
  assert.equal(
    resolveMirrorScrollTop({
      textareaScrollTop: 4679.5,
      textareaScrollHeight: 5000,
      textareaClientHeight: 320,
      mirrorScrollHeight: 5001,
      mirrorClientHeight: 320
    }),
    4681
  );
});

test("mirror handles empty and non-scrollable content", () => {
  assert.equal(
    resolveMirrorScrollTop({
      textareaScrollTop: 0,
      textareaScrollHeight: 320,
      textareaClientHeight: 320,
      mirrorScrollHeight: 320,
      mirrorClientHeight: 320
    }),
    0
  );
  assert.equal(
    resolveMirrorScrollTop({
      textareaScrollTop: -12,
      textareaScrollHeight: 5000,
      textareaClientHeight: 320,
      mirrorScrollHeight: 5000,
      mirrorClientHeight: 320
    }),
    0
  );
});

test("the editor reuses the shared geometry helpers for width and scroll", () => {
  const practice = read("components/writing/WritingPractice.tsx");
  assert.match(practice, /writingScrollbarWidth, resolveMirrorScrollTop|resolveMirrorScrollTop, writingScrollbarWidth/);
  assert.match(practice, /writingScrollbarWidth\(textarea\.offsetWidth, textarea\.clientWidth\)/);
  assert.match(practice, /mirror\.style\.right = desiredRight/);
  assert.match(practice, /resolveMirrorScrollTop\(\{/);
});

test("scroll synchronization is not limited to the textarea scroll event", () => {
  const practice = read("components/writing/WritingPractice.tsx");
  const hook = practice.slice(practice.indexOf("function useWritingEditor"));
  assert.match(hook, /function onScroll\(\) \{\s*syncMirror\(\);/);
  assert.match(practice, /onScroll=\{actions\.onScroll\}/);
  // The selection restore frame re-syncs the mirror.
  assert.match(
    hook,
    /setSelectionRange\(start, end\);[\s\S]{0,220}syncMirror\(\);/
  );
  // Mount, resize, background-tab return and page cache restore.
  assert.match(hook, /new ResizeObserver\(\(\) => syncMirror\(\)\)/);
  assert.match(hook, /observer\?\.observe\(textarea\)/);
  assert.match(hook, /addEventListener\("visibilitychange"/);
  assert.match(hook, /addEventListener\("pageshow"/);
  assert.match(hook, /observer\?\.disconnect\(\)/);
  assert.match(hook, /removeEventListener\("visibilitychange"/);
  assert.match(hook, /removeEventListener\("pageshow"/);
});

test("the mirror width is measured instead of a fixed platform padding", () => {
  const practice = read("components/writing/WritingPractice.tsx");
  assert.doesNotMatch(practice, /px-\[15px\]|paddingRight.*15|15px.*paddingRight/);
  assert.doesNotMatch(practice, /mirror\.style\.paddingRight/);
  // The visible text layer keeps its original classes and scrollbar handling.
  assert.match(practice, /pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words/);
});

test("no continuous animation loop was added for the sync", () => {
  const practice = read("components/writing/WritingPractice.tsx");
  const hook = practice.slice(practice.indexOf("function useWritingEditor"));
  // The only rAF is the existing selection restore frame.
  assert.equal((hook.match(/requestAnimationFrame\(/g) ?? []).length, 1);
  assert.doesNotMatch(hook, /setInterval\(/);
});
