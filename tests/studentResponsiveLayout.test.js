const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

test("student page shell uses a wide fluid canvas instead of the old 1440-oriented cap", () => {
  const globals = read("app/globals.css");
  const pageRule = globals.slice(
    globals.indexOf(".student-page {"),
    globals.indexOf(".student-page-title")
  );

  assert.match(pageRule, /max-width: 1800px/);
  assert.match(pageRule, /padding-inline: clamp\(/);
  assert.match(pageRule, /padding-block: clamp\(/);
  assert.doesNotMatch(pageRule, /max-w-\[1240px\]/);
});

test("BAS keeps its reading-oriented workspace bounded inside the fluid page canvas", () => {
  const globals = read("app/globals.css");
  const practice = read("components/PracticeSession.tsx");

  assert.match(globals, /\.student-practice-workspace \{[\s\S]*max-width: 1440px/);
  assert.match(practice, /className="student-practice-workspace space-y-6"/);
});

test("Writing practice stacks on phone and tablet portrait while retaining the desktop split", () => {
  const practice = read("components/writing/WritingPractice.tsx");

  assert.match(practice, /min-h-\[100dvh\][^"\n]*lg:h-\[100dvh\][^"\n]*lg:overflow-hidden/);
  assert.match(practice, /grid-cols-1[^"\n]*lg:grid-cols-\[minmax\(0,2fr\)_minmax\(0,3fr\)\]/);
  assert.match(practice, /max-w-\[1920px\]/);
  assert.match(practice, /min-h-\[650px\][^"\n]*lg:h-full[^"\n]*lg:min-h-0/);
  assert.match(practice, /grid-cols-\[auto_minmax\(0,1fr\)_auto\]/);
  assert.match(practice, /min-w-0 max-w-full[^"\n]*truncate/);
});

test("immersive writing review caps only the internal workspace on ultrawide screens", () => {
  const review = read("components/student/StudentWritingReview.tsx");

  assert.ok((review.match(/max-w-\[1920px\]/g) ?? []).length >= 2);
  assert.match(review, /min-h-\[100dvh\] bg-\[#f8f9fc\]/);
});

test("Reading result pages reflow summary and detail without widening reading content indefinitely", () => {
  const globals = read("app/globals.css");
  const resultPages = [
    "components/reading/ReadingResult.tsx",
    "components/reading/ReadingFullSetResult.tsx",
    "components/reading/ReadingWrongbookResult.tsx"
  ].map(read);

  assert.match(globals, /@media \(min-width: 1800px\)[\s\S]*grid-template-columns: minmax\(0, 1\.7fr\) minmax\(28rem, 0\.8fr\)/);
  for (const resultPage of resultPages) {
    assert.match(resultPage, /student-result-overview-layout/);
    assert.match(resultPage, /student-result-overview-navigation/);
  }
});

test("Reading practice keeps mobile content full width and restores side rails from tablet upward", () => {
  const practice = read("components/reading/ReadingPractice.tsx");

  assert.match(practice, /grid-cols-2[^"\n]*sm:grid-cols-\[minmax\(72px,1fr\)_minmax\(0,1440em\)_minmax\(72px,1fr\)\]/);
  assert.match(practice, /col-span-2 col-start-1 row-start-1[^"\n]*sm:col-span-1 sm:col-start-2/);
  assert.match(practice, /col-start-1 row-start-2[^"\n]*sm:row-start-1/);
  assert.match(practice, /col-start-2 row-start-2[^"\n]*sm:col-start-3 sm:row-start-1/);
});
