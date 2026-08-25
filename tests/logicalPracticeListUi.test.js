const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const catalog = read("components/LogicalPracticeCatalog.tsx");
const catalogHelper = read("lib/practiceLogicalCatalog.ts");
const shared = read("components/shared/PracticeCatalog.tsx");
const basPage = read("app/student/practice-sets/page.tsx");
const emailPage = read("app/student/write-email/page.tsx");
const discussionPage = read("app/student/academic-discussion/page.tsx");

test("BAS title is 套题 plus display_number and excludes display_title/raw set title", () => {
  assert.match(catalogHelper, /item\.task_type === "build_sentence"\) return `套题\$\{item\.display_number\}`/);
  assert.match(catalog, /logicalPracticeItemTitle\(item\)/);
  assert.doesNotMatch(catalog, /source_set_id|set_title/);
});

test("BAS and the shared card render API question_count as 10题", () => {
  assert.match(catalog, /questionCount: item\.question_count/);
  assert.match(shared, /\{set\.questionCount\}题/);
});

test("Email title is 题目 plus display_number and permanent display_title", () => {
  assert.match(catalogHelper, /`题目\$\{item\.display_number\}\$\{item\.display_title \? ` \$\{item\.display_title\}` : ""\}`/);
  assert.doesNotMatch(catalog, /subject|truncate/);
});

test("Academic Discussion uses the same permanent title formatter as Email", () => {
  assert.match(catalogHelper, /if \(item\.task_type === "build_sentence"\)[\s\S]*return `题目/);
  assert.doesNotMatch(catalog, /professor_prompt|student_1_response/);
});

test("Email and AD render API question_count as 1题 without client constants", () => {
  assert.match(catalog, /questionCount: item\.question_count/);
  assert.doesNotMatch(catalog, /taskType === "email" \? 1|academic_discussion" \? 1/);
});

test("occurrence date converts 2026-07-14 to 260714", () => {
  assert.match(catalog, /\^\(\\d\{4\}\)-\(\\d\{2\}\)-\(\\d\{2\}\)\$/);
  assert.match(catalog, /match\[1\]\.slice\(-2\).*match\[2\].*match\[3\]/s);
});

test("multiple occurrence dates use a Chinese enumeration comma", () => {
  assert.match(catalog, /\.join\("、"\)/);
  assert.match(catalog, /metadata: formatOccurrenceDates\(item\.occurrence_dates\)/);
});

test("canonical roots contain no month grouping UI", () => {
  for (const source of [catalog, basPage, emailPage, discussionPage]) {
    assert.doesNotMatch(source, /MonthList|WritingMonthList|month cards|月份选择|按月练习/);
  }
});

test("logical list contains no tips or explanatory card", () => {
  assert.doesNotMatch(catalog, /小贴士|Tips|StudentInfoStrip|使用说明/);
});

test("card actions are visible and do not use an ellipsis menu", () => {
  assert.doesNotMatch(catalog + shared, /MoreHorizontal|Ellipsis|DropdownMenu|three-dot|三点菜单/);
  assert.match(shared, /renderActions\(set\)/);
});

test("unstarted has no status badge and exposes Start from API actions", () => {
  assert.match(catalog, /status === "unstarted"[\s\S]*"start"[\s\S]*"开始练习"/);
  assert.match(catalog, /return null;/);
  assert.doesNotMatch(catalog, />未开始</);
});

test("in-progress uses a separate blue status and Continue action", () => {
  assert.match(catalog, /status === "in_progress"[\s\S]*bg-blue-50[\s\S]*练习中/);
  assert.match(catalog, /"resume", FilePenLine, "继续练习", true/);
});

test("completed uses a separate green status and type-specific view action", () => {
  assert.match(catalog, /status === "completed"[\s\S]*bg-emerald-50[\s\S]*已完成/);
  assert.match(catalog, /taskType === "build_sentence" \? "查看结果" : "查看提交"/);
  assert.match(catalog, /item\.actions\.view_result/);
});

test("BAS does not synthesize an in-progress state", () => {
  assert.doesNotMatch(catalog, /taskType === "build_sentence"[^\n]*(?:in_progress|练习中)/);
  assert.match(catalog, /item\.student_state\.status/);
});

test("React key remains stable item_id", () => {
  assert.match(catalog, /setId: item\.item_id/);
  assert.match(shared, /key=\{set\.setId\}/);
});

test("display-number correction changes text without changing action identity", () => {
  assert.match(catalog, /display_number/);
  assert.match(catalog, /logicalPracticeActionHref\(taskType, actionName, item\.actions\[actionName\]\)/);
  assert.doesNotMatch(catalog, /logicalPracticeActionHref\([^\n]*display_number/);
});

test("pagination slices the cached full catalog locally with no page-size selector", () => {
  const serverCatalog = read("lib/practiceLogicalCatalog.ts");
  assert.match(serverCatalog, /LOGICAL_PRACTICE_PAGE_SIZE = 10/);
  assert.match(serverCatalog, /paginate: false/);
  assert.match(catalog, /catalog\.items\.slice\(from, from \+ catalog\.pagination\.page_size\)/);
  assert.match(catalog, /onClick=\{\(\) => onPageChange\(page - 1\)\}/);
  assert.match(catalog, /onClick=\{\(\) => onPageChange\(page \+ 1\)\}/);
  assert.match(catalog, /第 \{page\}\/\{visibleTotalPages\} 页/);
  assert.doesNotMatch(catalog, /page-size|pageSize|10 条\/页|select/);
});

test("headers render outside loading state and loading uses compact skeleton cards", () => {
  for (const [source, title] of [
    [basPage, "Build a Sentence"],
    [emailPage, "Write an Email"],
    [discussionPage, "Academic Discussion"]
  ]) assert.match(source, new RegExp(`StudentPage title="${title}"`));
  assert.match(catalog, /state\.loading \? \([\s\S]*LogicalPracticeListSkeleton/);
  assert.match(catalog, /Array\.from\(\{ length: 7 \}/);
});

test("error state retains the list shell and has an explicit retry without raw fallback", () => {
  assert.match(catalog, /LogicalPracticeCatalogError/);
  assert.match(catalog, /onRetry=\{\(\) => cache\.invalidate\(cacheKey\)\}/);
  assert.match(catalog, /重新加载/);
  assert.doesNotMatch(catalog, /fallback.*(?:month|raw)|\/api\/sets|email_questions|academic_discussion_questions/i);
});

test("empty state is task-specific and never says this month", () => {
  assert.match(catalog, /暂无可练习套题/);
  assert.match(catalog, /暂无可练习邮件题目/);
  assert.match(catalog, /暂无可练习学术讨论题目/);
  assert.doesNotMatch(catalog, /本月/);
});

test("BAS, Email, and AD roots share one LogicalPracticeCatalog and one card implementation", () => {
  for (const source of [basPage, emailPage, discussionPage]) {
    assert.match(source, /<LogicalPracticeCatalog/);
  }
  assert.match(catalog, /<PracticeSetCatalogList/);
});

test("raw and canonical metadata are not rendered by the final list", () => {
  assert.doesNotMatch(catalog, /canonical\.|source_id|source_question_id|question_id|normalization/);
});

test("shared card wraps long titles and actions without horizontal scrolling", () => {
  assert.match(shared, /break-words/);
  assert.match(shared, /min-w-0 flex-wrap/);
  assert.match(shared, /md:grid-cols-\[minmax\(0,1fr\)_5rem_6rem_minmax\(15rem,auto\)\]/);
  assert.match(shared, /data-question-count/);
  assert.match(shared, /data-status-column/);
  assert.match(shared, /data-actions-column/);
  assert.match(shared, /data-title-number/);
  assert.match(shared, /data-title-text/);
  assert.doesNotMatch(shared, /overflow-x-auto/);
});
