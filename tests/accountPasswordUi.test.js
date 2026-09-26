import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (relativePath) =>
  readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("login page shows 忘记密码？ next to the password label", async () => {
  const login = await read("components/LoginPanel.tsx");
  assert.match(login, /忘记密码？/);
  // The bare label (without the question mark) must no longer be rendered.
  assert.doesNotMatch(login, />\s*忘记密码\s*</);
  // Link styling and placement stay unchanged: same text style class and the
  // same gap from the 密码 label row.
  assert.match(login, /mt-4 flex items-center gap-3\.5/);
  assert.match(login, /text-sm font-semibold text-student-primary hover:underline/);
});

test("login page waiting message comes from the server-resolved role", async () => {
  const login = await read("components/LoginPanel.tsx");
  assert.match(login, /passwordResetWaitingMessage/);
  assert.match(login, /typeof payload\.role === "string" \? payload\.role : null/);
  // The literals live in the shared helper only; the login page never guesses.
  assert.doesNotMatch(login, /请等待教师许可|请等待管理员许可/);

  const route = await read("app/api/auth/password-reset-requests/route.ts");
  assert.match(route, /role: result\.role/);

  const server = await read("lib/passwordResetRequests.server.ts");
  assert.match(server, /\{ ok: true; role: PasswordResetTargetRole \}/);
  assert.match(server, /return \{ ok: true, role: profile\.role \}/);
});

test("modal shell portals to document.body and caps itself to the viewport height", async () => {
  const modal = await read("components/shared/ConfirmDialog.tsx");
  // Portal: fixed overlays must not be anchored by ancestor backdrop-filter or
  // transform containing blocks (the Student header uses backdrop-blur).
  assert.match(modal, /createPortal/);
  assert.match(modal, /document\.body/);
  // Short viewports: panel never exceeds the viewport and scrolls internally.
  assert.match(modal, /max-h-\[calc\(100dvh-3rem\)\]/);
  assert.match(modal, /overflow-y-auto/);

  const studentShell = await read("components/student/StudentShell.tsx");
  assert.match(studentShell, /backdrop-blur/);
});
