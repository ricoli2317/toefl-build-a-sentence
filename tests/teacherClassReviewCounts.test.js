import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(resolve(projectRoot, relativePath), "utf8");

test("class review counts are database-side and keep the historical buckets", () => {
  const server = read("lib/teacherClasses.server.ts");
  const countBlock = server.slice(
    server.indexOf("async function loadClassReviewCounts"),
    server.indexOf("export async function listClassAssignmentIds")
  );
  assert.match(countBlock, /mapWithConcurrency\(classIds, 4/);
  assert.match(countBlock, /status", "submitted"/);
  assert.match(countBlock, /attempt_kind", "original"/);
  assert.match(countBlock, /assignment\.group\.class_id", classId/);
  assert.match(countBlock, /assignment\.group\.teacher_id", teacherId/);
  assert.match(countBlock, /count: "exact", head: true/);
  assert.match(countBlock, /pending: Math\.max\(0, submitted - reviewed\)/);
  assert.match(countBlock, /reviewing: Math\.max\(0, reviewed - publishedCount - ignoredCount\)/);
  assert.match(countBlock, /writing_reviews\.published_at", "is", null/);
  assert.match(countBlock, /writing_reviews\.status", "ignored"/);
  // No attempt/review detail arrays are returned to the Next.js process.
  assert.doesNotMatch(countBlock, /readRowsByIds/);
  assert.doesNotMatch(countBlock, /submittedAttempts/);
  assert.doesNotMatch(countBlock, /reviewByAttempt/);
});

test("class counts skip the three review counts for a class without submissions", () => {
  const server = read("lib/teacherClasses.server.ts");
  const countBlock = server.slice(
    server.indexOf("async function loadClassReviewCount("),
    server.indexOf("async function countClassAttempts(")
  );
  assert.match(countBlock, /if \(submitted === 0\)/);
  assert.match(countBlock, /pending: 0, reviewing: 0, published: 0/);
});
