const test = require("node:test");
const assert = require("node:assert/strict");
const { createLedger, originalProjection, trackTransaction } = require("../lib/writingRevisionLedger.ts");
const { correctionIssueLocation } = require("../lib/writingCorrectionLocation.ts");
const { textDocument, textPosition } = require("../lib/writingRevisionDocument.ts");
const { Schema } = require("@tiptap/pm/model");
const { EditorState } = require("@tiptap/pm/state");

const pairs = [
  ["also important", "equally important"],
  ["express ideas", "express ideas and work with others"],
  ["provide my experience on", "share my experience of"],
  ["onganizing", "organizing"],
  ["help me do registration", "help me with registration"]
];
const original = "Art is also important. It helps us express ideas.\nI am writing to provide my experience on onganizing a campus event.\n\nI hired volunteers to help me do registration.\n\nLeave this unrelated paragraph unchanged.";
const corrected = pairs.reduce((text, [before, after]) => text.replace(before, after), original);
function deleteTracked(text, from, to) {
  const schema = new Schema({ nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*", group: "block" }, text: { group: "inline" } } });
  const state = EditorState.create({ schema, doc: schema.nodeFromJSON(textDocument(text)) });
  return trackTransaction(createLedger(text), state.tr.delete(textPosition(text, from), textPosition(text, to)));
}

for (const [before, after] of pairs) test(`persisted projection covers original deletion AND all new text: ${before}`, () => {
  const ledger = createLedger(original, corrected);
  const snapshot = JSON.stringify(ledger);
  const from = original.indexOf(before);
  const location = correctionIssueLocation(ledger, { original_text: before, replacement_text: after, original_sentence: null, source_start: from, source_end: from + before.length });
  assert.equal(location.ranges.map(range => corrected.slice(range.from, range.to)).join(""), after);
  if (!after.includes(before)) assert.ok(location.deletions.length);
  for (const deletion of location.deletions) {
    const record = ledger.deletions.find(item => item.id === deletion.id);
    for (const range of deletion.ranges) assert.ok(record.sources.slice(range.from, range.to).every(source => source >= from && source < from + before.length));
  }
  assert.equal(JSON.stringify(ledger), snapshot);
  assert.equal(originalProjection(ledger), original);
});

test("separate typing transactions at one deletion anchor highlight the complete replacement, not just the first keystroke", () => {
  const schema = new Schema({ nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*", group: "block" }, text: { group: "inline" } } });
  const before = "We help me do registration today.";
  let ledger = createLedger(before);
  let state = EditorState.create({ schema, doc: schema.nodeFromJSON(textDocument(before)) });
  const at = before.indexOf("do");
  let tr = state.tr.delete(textPosition(before, at), textPosition(before, at + 2));
  ledger = trackTransaction(ledger, tr); state = state.apply(tr);
  for (const [index, letter] of Array.from("with").entries()) {
    tr = state.tr.insertText(letter, textPosition(ledger.text, at + index));
    ledger = trackTransaction(ledger, tr); state = state.apply(tr);
  }
  const location = correctionIssueLocation(ledger, { original_text: "help me do registration", original_sentence: null });
  assert.equal(location.ranges.map(range => ledger.text.slice(range.from, range.to)).join(""), "help me with registration");
});

test("cross-line replacement and complete deletion use their real anchors", () => {
  const before = "Keep.\nFirst line of target\nSecond line of target\nKeep again.";
  const quote = "First line of target\nSecond line of target";
  const ledger = createLedger(before, before.replace(quote, "New first line\nNew second line"));
  const location = correctionIssueLocation(ledger, { original_text: quote, original_sentence: null });
  assert.equal(location.ranges.map(range => ledger.text.slice(range.from, range.to)).join(""), "New first line\nNew second line");
  const deleted = deleteTracked(before, before.indexOf(quote), before.indexOf(quote) + quote.length);
  const anchor = correctionIssueLocation(deleted, { original_text: quote, original_sentence: null });
  assert.equal(anchor.ranges.length, 0);
  assert.ok(anchor.deletions.length);
});

test("deletion highlighting is restricted to the target part of a larger deletion widget", () => {
  const before = "Start. one TARGET three. End.";
  const ledger = deleteTracked(before, before.indexOf("one"), before.indexOf("End."));
  const location = correctionIssueLocation(ledger, { original_text: "TARGET", original_sentence: null });
  const highlighted = location.deletions.flatMap(entry => {
    const deletion = ledger.deletions.find(item => item.id === entry.id);
    return entry.ranges.map(range => deletion.text.slice(range.from, range.to));
  }).join("");
  assert.equal(highlighted, "TARGET");
});

test("repeated final wording never redirects baseline-anchored location", () => {
  const ledger = createLedger("Wrong phrase. Right phrase.", "Right phrase. Right phrase.");
  const location = correctionIssueLocation(ledger, { original_text: "Wrong phrase.", original_sentence: null });
  assert.equal(location.ranges[0].from, 0);
  assert.equal(location.ranges.map(range => ledger.text.slice(range.from, range.to)).join(""), "Right phrase.");
});

test("boundary insertions outside the explicit replacement are never included", () => {
  const before = "Keep target intact.";
  const schema = new Schema({ nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*", group: "block" }, text: { group: "inline" } } });
  const state = EditorState.create({ schema, doc: schema.nodeFromJSON(textDocument(before)) });
  const ledger = trackTransaction(createLedger(before), state.tr.insertText("unrelated ", textPosition(before, before.indexOf("target"))));
  const location = correctionIssueLocation(ledger, { original_text: "target", original_sentence: null, replacement_text: "target" });
  assert.equal(location.ranges.map(range => ledger.text.slice(range.from, range.to)).join(""), "target");
});
