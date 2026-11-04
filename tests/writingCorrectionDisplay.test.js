const test = require("node:test");
const assert = require("node:assert/strict");
const { writingCorrectionDisplayDiff, WRITING_CORRECTION_CHANGE_STYLE } = require("../lib/writingCorrectionDisplay.ts");
const { writingCorrectionDiff } = require("../lib/writingCorrectionDiff.ts");
const { writingCorrectionFixture } = require("./fixtures/writingCorrectionFixture.ts");
const painted = parts => parts.filter(p => p.added).map(p => p.text).join("");

for (const [label, original, current, expected] of [
  ["word replacement", "a weekend workshop", "a monthly workshop", "monthly"],
  ["one letter added to word", "some issue", "some issues", "issues"],
  ["one letter substituted", "an event", "an Event", "Event"],
  ["replacement phrase", "more opportunities to learn", "a practical workshop", "a practical workshop"],
  ["added sentence", "Original.", "Original. A workshop could help students.", " A workshop could help students."],
  ["one inserted word", "the workshop", "the creative workshop", "creative "],
  ["pure word deletion", "a big green tree", "a tree", ""],
  ["pure character deletion", "some issues", "some issue", ""],
  ["restored original", "Original text", "Original text", ""],
  ["punctuation only", "Hello!", "Hello?", "?"],
  ["spaces are preserved", "one two", "one  two", " "],
  ["CJK and emoji", "中文😀内容", "中文🧑内容。", "🧑。"],
  ["independent edits preserve complete unchanged words", "I is here. He go home.", "I am here. He went home.", "amwent"],
  ["short unchanged word is not a bridge", "red a cat", "blue a dog", "bluedog"],
  ["contraction is a complete unit", "I can't go", "I couldn't go", "couldn't"],
  ["hyphenated word", "a well-made plan", "a well-timed plan", "well-timed"],
]) test(`display diff: ${label}`, () => {
  const parts = writingCorrectionDisplayDiff(original, current);
  assert.equal(parts.map(p => p.text).join(""), current);
  assert.equal(painted(parts), expected);
  assert.ok(parts.every(p => p.text.length > 0));
  for (let i = 1; i < parts.length; i++) assert.notEqual(parts[i].added, parts[i - 1].added);
});

test("actual browser prose: fragmented workshop/could/help/students becomes one natural replacement region", () => {
  const original = writingCorrectionFixture("email", false).response_text;
  // Read from the user's existing localhost editor; keep exact spaces/newlines.
  const current = "Dear Library Team,\n\nI am writing to suggest a weekend workshop. A workshop could help students \n\nThank you for considering my idea.\nBest,\nAlexdddddd";
  const raw = writingCorrectionDiff(original, current);
  assert.ok(raw.some(p => !p.added && p.text === "or"));
  assert.ok(raw.some(p => !p.added && p.text === "ent"));
  const display = writingCorrectionDisplayDiff(original, current);
  assert.ok(display.some(p => p.added && p.text === "A workshop could help students "));
  assert.ok(display.some(p => !p.added && p.text.includes(" writing to suggest a weekend workshop. ")));
  assert.ok(display.some(p => !p.added && p.text.includes("Thank you for considering my idea.")));
  assert.equal(display.at(-1).text, "Alexdddddd");
  assert.equal(display.map(p => p.text).join(""), current);
  assert.deepEqual(writingCorrectionDiff(original, current), raw, "display normalization never mutates the raw result");
});

test("style contains only blue background and text; never layout or font overrides", () => {
  assert.deepEqual(WRITING_CORRECTION_CHANGE_STYLE, { backgroundColor: "#E8F2FF", color: "#2457A6" });
});

test("display normalization preserves exact whitespace/code points and never splits a Latin word between states", () => {
  const original = "Some writing, words and emoji 😀.\n";
  for (const current of ["Some writings, Words and emoji 🧑.\n", "An entirely new sentence!  中文 😀\n\n", "", original]) {
    const parts = writingCorrectionDisplayDiff(original, current);
    assert.equal(parts.map(p => p.text).join(""), current);
    let at = 0;
    const boundaries = [];
    for (const p of parts) { at += p.text.length; boundaries.push(at); }
    for (const word of current.matchAll(/[A-Za-z]+/g)) {
      assert.ok(boundaries.every(b => b <= word.index || b >= word.index + word[0].length));
    }
  }
});
