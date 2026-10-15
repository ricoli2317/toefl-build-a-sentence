// Offline content QA only. No credentials, database connection or content writes.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadVocabularySource } from "../lib/ctw-vocabulary/import.ts";
import { ctwReviewCard, vocabularyPromptForms } from "../lib/ctw-vocabulary/review.ts";
import { protectedReviewPrompt, reviewExample } from "../lib/lexical/wordbookReviewPresentation.ts";
import { applyVocabularySpellingReview } from "../lib/ctw-vocabulary/spelling-review.ts";
const original = loadVocabularySource(readFileSync(resolve("data/ctw-vocabulary/ctw-vocabulary-cefr-reviewed.json")), "initial");
const adjustments = JSON.parse(readFileSync(resolve("data/ctw-vocabulary/irregular-spelling-adjustments.json"), "utf8"));
const rows = applyVocabularySpellingReview(original.rows, adjustments.changes);
const changes: { word: string; sense: number; original: string; protected: string }[] = [];
let residual = 0, senses = 0;
rows.forEach((row, index) => {
  const entry = { ...row, entry_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    list_number: Number(row.list_id.slice(5)), list_position: index % 50 + 1, source_sha256: "" };
  const forms = vocabularyPromptForms(entry);
  ctwReviewCard(entry, index);
  row.senses.forEach((sense, n) => {
    senses++;
    const safe = protectedReviewPrompt(sense.meaning_zh, row.word, forms);
    if (reviewExample(safe, row.word, true, forms)?.some(part => part.target)) residual++;
    if (safe !== sense.meaning_zh) changes.push({ word: row.word, sense: n + 1, original: sense.meaning_zh, protected: safe });
  });
});
const report = { words: rows.length, senses, protectedSenses: changes.length, residualLeaks: residual, changes };
const output = resolve(process.argv[2] ?? "outputs/ctw-vocabulary-unification/prompt-audit.json");
mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ words: report.words, senses, protectedSenses: changes.length, residualLeaks: residual, output }));
if (residual) process.exitCode = 1;
