const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { compile, scheduler } = require("./helpers/wordbookReadHarness.cjs");
const dates = require("../lib/studentDates.ts");

// Execute the shared component's actual calendar/form handlers offline. These
// tests never load an API, authenticate, or create practice/review sessions.
function picker(overrides = {}) {
  const runner = scheduler();
  let closed = 0, applied = [], changes = [], nodes = [];
  const props = {
    draft: { start: "", end: "" },
    bounds: { min: "2026-07-01", max: "2026-10-11" },
    activity: { month: new Date(2026, 9, 1), dates: ["2026-10-03"], onMonthChange(month) { props.activity.month = month; } },
    onDraftChange(draft) { props.draft = draft; changes.push(draft); },
    onApply(close) { applied.push(dates.boundedDateDraft(props.draft, props.bounds)); close(); },
    onClear() { props.draft = { start: "", end: "" }; },
    ...overrides
  };
  const { StudentDateSelection } = compile("components/student/StudentDateSelection.tsx", {
    react: { ...runner.hooks, useLayoutEffect() {} },
    "@/lib/studentDates": dates,
    "@/components/teacher/TeacherPopover": { TeacherPopover: ({ children }) => children(() => { closed++; }) }
  });
  function visit(node) {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== "object") return;
    if (typeof node.type === "function") { visit(node.type(node.props)); return; }
    nodes.push(node);
    visit(node.props?.children);
  }
  const render = () => { nodes = []; runner.render(() => visit(StudentDateSelection(props))); };
  const button = label => nodes.find(node => node.type === "button" &&
    (node.props["aria-label"]?.split("，")[0] === label || node.props.children === label));
  const click = label => {
    const target = button(label);
    assert.ok(target, `button ${label} exists`);
    assert.ok(!target.props.disabled, `button ${label} is enabled`);
    target.props.onClick(); render();
  };
  const hover = label => { const target = button(label); assert.ok(target); target.props.onMouseEnter(); render(); };
  const leave = () => { nodes.find(node => node.props?.onMouseLeave).props.onMouseLeave(); render(); };
  const submit = () => {
    const action = nodes.find(node => node.type === "button" && node.props.type === "submit");
    assert.equal(action.props.children, "查看");
    assert.ok(!action.props.disabled);
    nodes.find(node => node.type === "form").props.onSubmit({ preventDefault() {} });
    render();
  };
  render();
  return { props, render, button, click, hover, leave, submit, changes, applied,
    get nodes() { return nodes; }, get closed() { return closed; } };
}

test("first / second / third calendar clicks select a day, a range, then a new day", () => {
  const view = picker();
  assert.equal(view.nodes.some(node => node.type === "input"), false);
  assert.ok(view.button("查看").props.disabled);
  view.click("2026-10-03");
  assert.deepEqual(view.props.draft, { start: "2026-10-03", end: "" });
  view.submit();
  assert.deepEqual(view.applied[0], { start: "2026-10-03", end: "2026-10-03" });
  view.click("2026-10-07");
  assert.deepEqual(view.props.draft, { start: "2026-10-03", end: "2026-10-07" });
  for (let day = 1; day <= 11; day++) {
    const button = view.button(`2026-10-${String(day).padStart(2, "0")}`);
    assert.equal(button.props["aria-pressed"], day >= 3 && day <= 7);
    if (day >= 3 && day <= 7) assert.match(button.props.className, /bg-student-primary-soft/);
  }
  view.submit();
  assert.deepEqual(view.applied[1], { start: "2026-10-03", end: "2026-10-07" });
  view.click("2026-10-09");
  assert.deepEqual(view.props.draft, { start: "2026-10-09", end: "" });
  assert.equal(view.button("2026-10-03").props["aria-pressed"], false);
  assert.equal(view.button("2026-10-09").props["aria-pressed"], true);
  // Selecting dates only changes draft; applying remains an explicit action.
  assert.equal(view.changes.length, 3); assert.equal(view.applied.length, 2);
});

test("reverse-order and cross-month clicks form an ordered range without changing date normalization", () => {
  const view = picker();
  view.click("2026-10-07"); view.click("2026-10-03");
  assert.deepEqual(view.props.draft, { start: "2026-10-03", end: "2026-10-07" });
  view.click("2026-10-03"); view.click("上个月");
  assert.deepEqual(view.props.draft, { start: "2026-10-03", end: "" });
  view.click("2026-09-29"); view.submit();
  assert.deepEqual(view.applied[0], { start: "2026-09-29", end: "2026-10-03" });
  assert.equal(view.button("2026-09-30").props["aria-pressed"], true);
  view.click("下个月");
  assert.equal(view.button("2026-10-01").props["aria-pressed"], true);
});

test("same-day second click keeps single-day apply behavior and third click restarts", () => {
  const view = picker();
  view.click("2026-10-03"); view.click("2026-10-03"); view.submit();
  assert.deepEqual(view.applied[0], { start: "2026-10-03", end: "2026-10-03" });
  view.click("2026-10-07");
  assert.deepEqual(view.props.draft, { start: "2026-10-07", end: "" });
});

test("an existing applied selection starts a fresh range and clear still calls the existing callback", () => {
  const view = picker({ draft: { start: "2026-10-01", end: "2026-10-07" } });
  view.click("2026-10-03");
  assert.deepEqual(view.props.draft, { start: "2026-10-03", end: "" });
  view.click("清除日期选择");
  assert.equal(view.closed, 1);
  assert.deepEqual(view.props.draft, { start: "", end: "" });
  assert.ok(view.button("查看").props.disabled);
  assert.equal(view.applied.length, 0);
});

test("bounded dates, month limits, activity dots and loading/error presentation remain intact", () => {
  const view = picker();
  assert.ok(view.button("下个月").props.disabled);
  assert.ok(view.button("2026-10-12").props.disabled);
  assert.equal(view.nodes.filter(node => node.props?.["data-activity-dot"] !== undefined).length, 1);
  view.click("上个月"); view.click("上个月"); view.click("上个月");
  assert.ok(view.button("上个月").props.disabled);
  assert.ok(!view.button("2026-07-01").props.disabled);
  view.props.activity.loading = true; view.render();
  assert.ok(view.nodes.some(node => node.props?.children === "正在加载活动日期…"));
  view.props.activity.error = "活动日期读取失败"; view.render();
  assert.ok(view.nodes.some(node => node.props?.children === "活动日期读取失败"));
});

test("single-day-only review mode remains single-day; inline action label is also 查看", () => {
  const view = picker({ singleDay: true, inline: true, hideHints: true });
  view.click("2026-10-03"); view.click("2026-10-07");
  assert.deepEqual(view.props.draft, { start: "2026-10-07", end: "2026-10-07" });
  view.submit();
  assert.deepEqual(view.applied[0], { start: "2026-10-07", end: "2026-10-07" });
  assert.equal(view.closed, 0);
});

test("a caller without activity data still has a selectable calendar and working month arrows", () => {
  const view = picker({ activity: undefined, draft: { start: "2026-10-03", end: "2026-10-03" } });
  view.click("上个月"); view.click("2026-09-29"); view.submit();
  assert.deepEqual(view.applied[0], { start: "2026-09-29", end: "2026-09-29" });
});

test("hover dynamically previews forward/backward ranges without changing the draft or applying", () => {
  const view = picker();
  view.hover("2026-10-07");
  assert.equal(view.button("2026-10-07").props["data-range-preview"], undefined);
  view.click("2026-10-03");
  view.hover("2026-10-07");
  for (let day = 1; day <= 11; day++) {
    const button = view.button(`2026-10-${String(day).padStart(2, "0")}`);
    assert.equal(Boolean(button.props["data-range-preview"]), day >= 3 && day <= 7);
    assert.equal(button.props["aria-pressed"], day === 3);
    if (day >= 3 && day <= 7) assert.match(button.props.className, /bg-student-primary-soft/);
  }
  view.hover("2026-10-05");
  assert.equal(view.button("2026-10-07").props["data-range-preview"], undefined);
  view.hover("2026-10-01");
  assert.ok(view.button("2026-10-02").props["data-range-preview"]);
  assert.equal(view.button("2026-10-04").props["data-range-preview"], undefined);
  assert.deepEqual(view.props.draft, { start: "2026-10-03", end: "" });
  assert.equal(view.changes.length, 1); assert.equal(view.applied.length, 0);
  view.leave();
  assert.equal(view.button("2026-10-02").props["data-range-preview"], undefined);
  assert.equal(view.button("2026-10-03").props["aria-pressed"], true);
});

test("cross-month hover preserves the first click and the second click commits only its own date", () => {
  const view = picker();
  view.click("2026-10-03"); view.hover("2026-10-07"); view.click("上个月");
  assert.equal(view.button("2026-09-30").props["data-range-preview"], undefined);
  view.hover("2026-09-29");
  assert.ok(view.button("2026-09-30").props["data-range-preview"]);
  assert.deepEqual(view.props.draft, { start: "2026-10-03", end: "" });
  view.click("2026-09-28");
  assert.deepEqual(view.props.draft, { start: "2026-09-28", end: "2026-10-03" });
  view.hover("2026-09-20");
  assert.equal(view.button("2026-09-20").props["data-range-preview"], undefined);
  assert.equal(view.button("2026-09-30").props["aria-pressed"], true);
  view.click("下个月"); view.click("2026-10-03"); view.hover("2026-10-12");
  assert.equal(view.button("2026-10-11").props["data-range-preview"], undefined);
});

test("inline auto-apply callers can omit 查看 without changing other selectors", () => {
  const view = picker({ inline: true, hideApply: true, onApply: undefined });
  assert.equal(view.button("查看"), undefined);
  view.click("2026-10-03"); view.hover("2026-10-07"); view.click("2026-10-07");
  assert.deepEqual(view.props.draft, { start: "2026-10-03", end: "2026-10-07" });
  assert.equal(view.applied.length, 0);
  const single = picker({ singleDay: true });
  single.click("2026-10-03"); single.hover("2026-10-07");
  assert.equal(single.button("2026-10-07").props["data-range-preview"], undefined);
  assert.ok(single.button("查看"));
});

test("student and teacher practice/wordbook/history surfaces all reuse the same selector", () => {
  const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  for (const file of ["components/student/StudentPracticeHistory.tsx", "components/teacher/TeacherStudentPracticeSection.tsx",
    "components/student/StudentWordbook.tsx", "components/student/WordbookReview.tsx"]) {
    assert.match(read(file), /<StudentDateSelection/);
    assert.doesNotMatch(read(file), /type="date"/);
  }
  const teacher = read("components/teacher/TeacherStudentWordbook.tsx");
  assert.match(teacher, /<WordbookView/);
  assert.match(teacher, /<WordbookReviewHistoryView/);
});
