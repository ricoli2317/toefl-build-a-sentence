const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {
  notificationScreenshotFilename
} = require("../lib/notificationScreenshot.client.ts");

test("notification screenshot filenames are safe, readable and timestamped", () => {
  const name = notificationScreenshotFilename(
    '题目更新 / 2026:11*?"<>|',
    new Date(2026, 10, 22, 10, 5)
  );
  assert.equal(name, "通知-题目更新 2026 11-20261122-1005.png");
  assert.doesNotMatch(name, /[\\/:*?"<>|]/);
  assert.match(name, /\.png$/);
});

test("screenshot action is wired only into the notification detail header", () => {
  const center = fs.readFileSync(
    "components/notifications/NotificationCenter.tsx",
    "utf8"
  );
  const modal = fs.readFileSync(
    "components/notifications/NotificationModal.tsx",
    "utf8"
  );

  assert.match(modal, /headerAction\?: ReactNode/);
  assert.match(modal, /\{headerAction \? <div className="shrink-0">\{headerAction\}<\/div> : null\}/);
  assert.match(
    center,
    /headerAction=\{view === "detail" && detail \? \(\s*<NotificationScreenshotActions/
  );
  assert.equal((center.match(/<NotificationScreenshotActions/g) ?? []).length, 1);
  assert.doesNotMatch(
    center,
    /<article[\s\S]{0,800}<NotificationScreenshotActions/
  );
});
