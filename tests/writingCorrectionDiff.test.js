const test = require("node:test");
const assert = require("node:assert/strict");
const { writingCorrectionDiff } = require("../lib/writingCorrectionDiff.ts");
const added = (parts) => parts.filter((part) => part.added).map((part) => part.text).join("");

for (const [label, original, current, green] of [
  ["initial equals frozen original", "I is writing.", "I is writing.", ""],
  ["empty documents", "", "", ""],
  ["entire insertion", "", "New text!\n", "New text!\n"],
  ["entire deletion", "Old text", "", ""],
  ["insert at start and end", "middle", "A middle Z", "A  Z"],
  ["separated replacements retain the intervening prose", "I is here. He go home.", "I am here. He went home.", "amwent"],
  ["pure deletion never marks surviving text", "A big green tree.", "A tree.", ""],
  ["repeated characters and pure deletion", "aaaaa bb aa", "aaa aa", ""],
  ["spaces punctuation and line breaks are not normalized", "a b\nc.", "a  b\n\nc!", " \n!"],
  ["Chinese and astral code points", "中文😀内容", "中文🧑内容。", "🧑。"],
  ["reverting to frozen prose removes green", "Original text", "Original text", ""],
  ["unrelated rewrite", "abc", "XYZ", "XYZ"],
  ["deleting a newline does not mark joined text", "one\ntwo\n", "onetwo", ""],
]) test(`correction diff: ${label}`, () => {
  const parts = writingCorrectionDiff(original, current);
  assert.equal(parts.map((part) => part.text).join(""), current);
  assert.equal(added(parts), green);
  assert.ok(parts.every((part) => part.text.length));
});

test("exact diff matches a reference LCS length across 2,000 deterministic random pairs", () => {
  let seed = 711;
  function random(n) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; }
  const alphabet = ["a", "b", " ", "\n", ".", "中", "😀"];
  const text = () => Array.from({ length: random(24) }, () => alphabet[random(alphabet.length)]).join("");
  function lcs(a, b) {
    const row = new Uint32Array(b.length + 1);
    for (const char of a) {
      let diagonal = 0;
      for (let j = 1; j <= b.length; j++) {
        const above = row[j]; row[j] = char === b[j - 1] ? diagonal + 1 : Math.max(above, row[j - 1]); diagonal = above;
      }
    }
    return row[b.length];
  }
  for (let i = 0; i < 2000; i++) {
    const original = text(), current = text();
    const parts = writingCorrectionDiff(original, current);
    assert.equal(parts.map((part) => part.text).join(""), current);
    assert.equal(Array.from(parts.filter((part) => !part.added).map((part) => part.text).join("")).length, lcs(Array.from(original), Array.from(current)));
    let cursor = 0;
    for (const char of parts.filter((part) => !part.added).flatMap((part) => Array.from(part.text))) {
      const index = original.indexOf(char, cursor);
      assert.ok(index >= cursor); cursor = index + char.length;
    }
  }
});

test("long documents have no truncation, rewrite threshold or lost trailing newline", () => {
  const original = "A paragraph with stable text.\n".repeat(500);
  const parts = writingCorrectionDiff(original, original + "New ending.\n");
  assert.equal(parts.map((part) => part.text).join(""), original + "New ending.\n");
  assert.equal(added(parts), "New ending.\n");
});

test("broad edits beyond the Myers trace budget use exact fallback, including pure deletion", () => {
  const original = "a".repeat(180) + "Stable anchor.\n" + "b".repeat(180);
  const current = "X".repeat(180) + "Stable anchor.\n" + "Y".repeat(180);
  const parts = writingCorrectionDiff(original, current);
  assert.equal(parts.map((part) => part.text).join(""), current);
  assert.equal(added(parts), "X".repeat(180) + "Y".repeat(180));
  assert.equal(added(writingCorrectionDiff(original, "Stable anchor.\n")), "");
});
