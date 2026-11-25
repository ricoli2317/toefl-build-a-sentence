import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(resolve(projectRoot, relativePath), "utf8");

test("next-page failures retry automatically twice, then pause until a manual retry", () => {
  const hook = read("components/teacher/TeacherIncrementalList.tsx");
  assert.match(hook, /const MAX_AUTO_RETRIES = 2;/);
  assert.match(hook, /attempt < MAX_AUTO_RETRIES/);
  // The error is only stored after the retry budget is exhausted.
  assert.match(
    hook,
    /pausedRef\.current = true;\s*setLoadMoreError\(loadMoreErrorMessage\(error\)\)/
  );
  // Automatic calls stop at the pause; the explicit retry starts a new request.
  assert.match(hook, /if \(!manual && pausedRef\.current\) return;/);
  assert.match(hook, /const retryLoadMore = useCallback\(\(\) => \{\s*void requestNextPage\(true\);/);
  // A new filter/tab or a fresh cached page clears the old failure.
  assert.match(hook, /setLoadMoreError\(""\)/);
  assert.doesNotMatch(hook, /setInterval\(/);
});

test("the infinite trigger stops observing while the list is paused", () => {
  const hook = read("components/teacher/TeacherIncrementalList.tsx");
  assert.match(hook, /paused = false/);
  assert.match(hook, /if \(!node \|\| !hasMore \|\| paused\) return;/);
  assert.match(hook, /\[hasMore, loading, loadingMore, paused\]/);

  const assignments = read("components/teacher/TeacherWritingAssignmentList.tsx");
  assert.match(assignments, /paused: Boolean\(loadMoreError\)/);
  const reviews = read("components/teacher/TeacherWritingReviewList.tsx");
  assert.match(reviews, /paused: Boolean\(loadMoreError\)/);
  assert.match(reviews, /paused: Boolean\(classesLoadMoreError\)/);
  assert.match(reviews, /paused: Boolean\(list\.loadMoreError\)/);
});

test("the footer keeps the failed page's data and offers one explicit retry", () => {
  const hook = read("components/teacher/TeacherIncrementalList.tsx");
  assert.match(hook, /正在加载更多…/);
  assert.match(hook, /onClick=\{onRetry\}/);
  assert.match(hook, />\s*重试\s*</);
  assert.match(hook, /已全部加载/);
  assert.doesNotMatch(hook, /onRetry=.*onRetry=.*onRetry=/);
});
