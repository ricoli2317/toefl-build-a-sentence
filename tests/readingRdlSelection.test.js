const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  calculateRdlContainRect,
  createRdlLookupRequest,
  hitTestRdlCharacter,
  normalizeRdlSelectionRange,
  parseRdlSelectionMap,
  rdlSelectedText,
  rdlWordRangeAt,
  validateRdlImageBinding
} = require("../lib/reading/rdlSelection.ts");

const IMAGE_SHA = "a".repeat(64);

function selectionMapSource() {
  let globalIndex = 0;
  const line = (lineIndex, y, words) => ({
    line_index: lineIndex,
    text: words.map((word) => word.text).join(" "),
    bbox: { x: 0.1, y, width: 0.7, height: 0.08 },
    words: words.map((word, wordIndex) => {
      const charWidth = word.width / word.text.length;
      return {
        id: `l${lineIndex}w${wordIndex}`,
        line_index: lineIndex,
        word_index: wordIndex,
        text: word.text,
        bbox: { x: word.x, y, width: word.width, height: 0.08 },
        chars: [...word.text].map((char, charIndex) => ({
          id: `l${lineIndex}w${wordIndex}c${charIndex}`,
          line_index: lineIndex,
          word_index: wordIndex,
          char_index: charIndex,
          global_index: globalIndex++,
          char,
          bbox: { x: word.x + charIndex * charWidth, y, width: charWidth, height: 0.08 }
        }))
      };
    })
  });
  return {
    schema_version: 2,
    image_file: "material_final.png",
    image_sha256: IMAGE_SHA,
    canvas_width: 1000,
    canvas_height: 500,
    coordinate_space: "normalized_top_left_xywh_0_1",
    lines: [
      line(0, 0.2, [
        { text: "making", x: 0.1, width: 0.18 },
        { text: "friends", x: 0.34, width: 0.21 }
      ]),
      line(1, 0.4, [{ text: "across", x: 0.1, width: 0.18 }])
    ]
  };
}

function selectionMap() {
  return parseRdlSelectionMap(selectionMapSource());
}

test("contain geometry uses the rendered image rect and preserves letterbox offsets after resize", () => {
  assert.deepEqual(calculateRdlContainRect(600, 600, 1000, 500), {
    left: 0,
    top: 150,
    width: 600,
    height: 300,
    scale: 0.6
  });
  assert.deepEqual(calculateRdlContainRect(300, 600, 1000, 500), {
    left: 0,
    top: 225,
    width: 300,
    height: 150,
    scale: 0.3
  });
  const before = calculateRdlContainRect(600, 600, 1000, 500);
  const after = calculateRdlContainRect(300, 600, 1000, 500);
  assert.equal(before.left + 0.1 * before.width, 60);
  assert.equal(after.left + 0.1 * after.width, 30);
  assert.equal(before.top + 0.2 * before.height, 210);
  assert.equal(after.top + 0.2 * after.height, 255);
});

test("whole-word click expands a mapped character to the complete mapped word", () => {
  const map = selectionMap();
  const characterIndex = hitTestRdlCharacter(map, 0.175, 0.23);
  assert.notEqual(characterIndex, null);
  const range = rdlWordRangeAt(map, characterIndex);
  assert.equal(rdlSelectedText(map, range), "making");
});

test("partial-word drag keeps exact character endpoints", () => {
  const map = selectionMap();
  assert.equal(rdlSelectedText(map, normalizeRdlSelectionRange(0, 2)), "mak");
});

test("multi-word and cross-line selections restore reading-order spaces", () => {
  const map = selectionMap();
  assert.equal(rdlSelectedText(map, normalizeRdlSelectionRange(0, 12)), "making friends");
  assert.equal(rdlSelectedText(map, normalizeRdlSelectionRange(6, 18)), "friends across");
});

test("reverse drag normalizes to the same cross-line reading order", () => {
  const map = selectionMap();
  assert.deepEqual(normalizeRdlSelectionRange(18, 6), { startIndex: 6, endIndex: 18 });
  assert.equal(rdlSelectedText(map, normalizeRdlSelectionRange(18, 6)), "friends across");
});

test("lookup query starts from selected text and remains manually editable", () => {
  const map = selectionMap();
  const selectedText = rdlSelectedText(map, rdlWordRangeAt(map, 0));
  assert.deepEqual(createRdlLookupRequest(selectedText), { query: "making" });
  assert.deepEqual(createRdlLookupRequest(" make "), { query: "make" });
});

test("image/map binding treats image_file as provenance and accepts a filename difference when SHA and dimensions match", () => {
  const map = selectionMap();
  const exact = {
    imageFile: "source_hd_geometry_fixed.png",
    imageSha256: IMAGE_SHA,
    naturalWidth: 1000,
    naturalHeight: 500
  };
  assert.equal(validateRdlImageBinding(map, exact), true);
});

test("image/map binding rejects matching filenames with different SHA", () => {
  const map = selectionMap();
  assert.equal(validateRdlImageBinding(map, {
    imageFile: "material_final.png",
    imageSha256: "b".repeat(64),
    naturalWidth: 1000,
    naturalHeight: 500
  }), false);
});

test("image/map binding rejects different filenames with different SHA and still checks dimensions", () => {
  const map = selectionMap();
  const exact = {
    imageFile: "source_hd.png",
    imageSha256: IMAGE_SHA,
    naturalWidth: 1000,
    naturalHeight: 500
  };
  assert.equal(validateRdlImageBinding(map, { ...exact, imageSha256: "b".repeat(64) }), false);
  assert.equal(validateRdlImageBinding(map, { ...exact, naturalWidth: 999 }), false);
});

test("selection map parser fails safely on unsupported coordinates or malformed characters", () => {
  const wrongSpace = selectionMapSource();
  wrongSpace.coordinate_space = "pixels";
  assert.throws(() => parseRdlSelectionMap(wrongSpace), /coordinate space/);
  const wrongText = selectionMapSource();
  wrongText.lines[0].words[0].chars[0].char = "X";
  assert.throws(() => parseRdlSelectionMap(wrongText), /does not match/);
});

test("RDL component uses pointer capture, mapped highlights, resize observation, and no OCR fallback", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../components/reading/ReadingPractice.tsx"),
    "utf8"
  );
  assert.match(source, /data-testid="rdl-selection-surface"/);
  assert.match(source, /onPointerDown=\{handlePointerDown\}/);
  assert.match(source, /onPointerMove=\{handlePointerMove\}/);
  assert.match(source, /onPointerUp=\{handlePointerUp\}/);
  assert.match(source, /setPointerCapture/);
  assert.match(source, /new ResizeObserver\(recalculateSelectionRect\)/);
  assert.match(source, /data-rdl-highlight="true"/);
  assert.match(source, /material\.selectionMapUrl/);
  assert.doesNotMatch(source, /OCR|querySelector|setTimeout|r2\.dev|\/Users\/rico\/Desktop/);
});

test("RDL lookup closes on outside pointer input without swallowing panel controls or new selections", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../components/reading/ReadingPractice.tsx"),
    "utf8"
  );
  const rdlSource = source.slice(
    source.indexOf("function RdlPracticeWorkspace"),
    source.indexOf("function sameRdlRect")
  );

  assert.match(rdlSource, /lookupPanelRef/);
  assert.match(rdlSource, /lookupPanelRef\.current\?\.contains\(target\)/);
  assert.match(rdlSource, /document\.addEventListener\("pointerdown", closeOnOutsidePointer, true\)/);
  assert.match(rdlSource, /document\.removeEventListener\("pointerdown", closeOnOutsidePointer, true\)/);
  assert.match(rdlSource, /setSelectionCommitted\(false\)/);
  assert.match(rdlSource, /setLookupQuery\(rdlSelectedText\(selectionMap, range\)\)/);
  assert.match(rdlSource, /ref=\{lookupPanelRef\}/);
});
