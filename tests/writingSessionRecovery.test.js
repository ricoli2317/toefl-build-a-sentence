const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  WritingSessionError,
  isWritingSessionError,
  sendWritingRequestWithSession
} = require("../lib/writingRequestSession.ts");
const {
  WRITING_RECOVERY_STORAGE_PREFIX,
  applyWritingRecoveryBackup,
  clearWritingRecoveryBackup,
  createWritingRecoveryBackup,
  parseWritingRecoveryBackup,
  readWritingRecoveryBackup,
  writeWritingRecoveryBackup,
  writingRecoveryMatchesAttempt,
  writingRecoveryStorageKey
} = require("../lib/writingRecovery.ts");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

function session(accessToken, studentId = "student-1") {
  return { accessToken, email: "student@test.com", studentId };
}

function jsonResponse(status, payload = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
}

function sampleAttempt(overrides = {}) {
  return {
    attempt_id: "attempt-1",
    assignment_id: null,
    question_id: "question-1",
    task_type: "email",
    user_id: "student-1",
    status: "draft",
    response_text: "server draft",
    overtime_ranges: [],
    elapsed_seconds: 30,
    remaining_seconds: 420,
    ...overrides
  };
}

function sampleBackup(overrides = {}) {
  return {
    attemptId: "attempt-1",
    studentId: "student-1",
    taskType: "email",
    assignmentId: null,
    questionId: "question-1",
    text: "local unsaved text",
    overtimeRanges: [{ start: 0, end: 5 }],
    elapsedSeconds: 90.9,
    remainingSeconds: 419.9,
    savedAt: "2026-10-03T05:00:00.000Z",
    ...overrides
  };
}

test("every request reads the current session instead of a captured token", async () => {
  let current = session("token-a");
  const sent = [];
  const dependencies = {
    getSession: async () => current,
    refreshSession: async () => null
  };
  await sendWritingRequestWithSession(async (token) => {
    sent.push(token);
    return jsonResponse(200, { attempt: {} });
  }, dependencies);
  current = session("token-b");
  const result = await sendWritingRequestWithSession(async (token) => {
    sent.push(token);
    return jsonResponse(200, { attempt: {} });
  }, dependencies);
  assert.deepEqual(sent, ["token-a", "token-b"]);
  assert.equal(result.session.accessToken, "token-b");
});

test("a 401 refreshes once and retries with the refreshed token", async () => {
  const sent = [];
  let refreshCalls = 0;
  const result = await sendWritingRequestWithSession(
    async (token) => {
      sent.push(token);
      return sent.length === 1
        ? jsonResponse(401, { error: "Invalid session" })
        : jsonResponse(200, { attempt: { attempt_id: "attempt-1" } });
    },
    {
      getSession: async () => session("expired-token"),
      refreshSession: async () => {
        refreshCalls += 1;
        return session("fresh-token");
      }
    }
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(sent, ["expired-token", "fresh-token"]);
  assert.equal(refreshCalls, 1);
});

test("automatic recovery stops after one refresh when the session cannot be restored", async () => {
  let refreshCalls = 0;
  let sends = 0;
  await assert.rejects(
    sendWritingRequestWithSession(
      async () => {
        sends += 1;
        return jsonResponse(401, { error: "Invalid session" });
      },
      {
        getSession: async () => session("expired-token"),
        refreshSession: async () => {
          refreshCalls += 1;
          return null;
        }
      }
    ),
    (error) => isWritingSessionError(error) && error instanceof WritingSessionError
  );
  assert.equal(refreshCalls, 1);
  assert.equal(sends, 1);
});

test("a second 401 after refresh is never retried again", async () => {
  let refreshCalls = 0;
  let sends = 0;
  await assert.rejects(
    sendWritingRequestWithSession(
      async () => {
        sends += 1;
        return jsonResponse(401, { error: "Invalid session" });
      },
      {
        getSession: async () => session("expired-token"),
        refreshSession: async () => {
          refreshCalls += 1;
          return session("fresh-token");
        }
      }
    ),
    (error) => isWritingSessionError(error)
  );
  assert.equal(refreshCalls, 1);
  assert.equal(sends, 2);
});

test("non-authentication failures never trigger a token refresh", async () => {
  let refreshCalls = 0;
  const { response } = await sendWritingRequestWithSession(
    async () => jsonResponse(500, { error: "写作记录保存失败，请稍后重试。" }),
    {
      getSession: async () => session("token"),
      refreshSession: async () => {
        refreshCalls += 1;
        return session("fresh-token");
      }
    }
  );
  assert.equal(response.status, 500);
  assert.equal(refreshCalls, 0);
});

test("a missing session raises the dedicated session error", async () => {
  await assert.rejects(
    sendWritingRequestWithSession(async () => jsonResponse(200), {
      getSession: async () => null,
      refreshSession: async () => null
    }),
    WritingSessionError
  );
});

test("the one-time backup round-trips through sessionStorage without credentials", () => {
  const storage = memoryStorage();
  const backup = createWritingRecoveryBackup(sampleBackup());
  assert.equal(backup.elapsedSeconds, 90);
  assert.equal(backup.remainingSeconds, 419);
  assert.equal(writeWritingRecoveryBackup(storage, backup), true);
  const restored = readWritingRecoveryBackup(storage, "attempt-1");
  assert.deepEqual(restored, backup);
  assert.equal(
    writingRecoveryStorageKey("attempt-1"),
    `${WRITING_RECOVERY_STORAGE_PREFIX}attempt-1`
  );
  assert.equal(restored.accessToken, undefined);
  assert.equal(restored.refreshToken, undefined);
});

test("malformed or foreign backup payloads are ignored", () => {
  assert.equal(parseWritingRecoveryBackup(null), null);
  assert.equal(parseWritingRecoveryBackup("not json"), null);
  assert.equal(parseWritingRecoveryBackup(JSON.stringify({ version: 2 })), null);
  const missingStudent = { ...sampleBackup() };
  delete missingStudent.studentId;
  assert.equal(parseWritingRecoveryBackup(JSON.stringify(missingStudent)), null);
  assert.equal(
    parseWritingRecoveryBackup(JSON.stringify({ ...sampleBackup(), taskType: "reading" })),
    null
  );
});

test("a backup only matches the same student, attempt, question and assignment", () => {
  const backup = createWritingRecoveryBackup(sampleBackup());
  const matches = (attempt, studentId = "student-1") =>
    writingRecoveryMatchesAttempt({ attempt, backup, studentId });
  assert.equal(matches(sampleAttempt()), true);
  assert.equal(matches(sampleAttempt(), "student-2"), false);
  assert.equal(matches(sampleAttempt({ attempt_id: "attempt-2" })), false);
  assert.equal(matches(sampleAttempt({ question_id: "question-2" })), false);
  assert.equal(matches(sampleAttempt({ task_type: "academic_discussion" })), false);
  assert.equal(matches(sampleAttempt({ assignment_id: "assignment-1" })), false);
  assert.equal(matches(sampleAttempt({ user_id: "student-2" })), false);
});

test("restoring a backup replaces only the draft text, timer and overtime markers", () => {
  const backup = createWritingRecoveryBackup(sampleBackup());
  const restored = applyWritingRecoveryBackup(sampleAttempt(), backup);
  assert.equal(restored.response_text, "local unsaved text");
  assert.equal(restored.elapsed_seconds, 90);
  assert.equal(restored.remaining_seconds, 419);
  assert.deepEqual(restored.overtime_ranges, [{ start: 0, end: 5 }]);
  assert.equal(restored.attempt_id, "attempt-1");
  assert.equal(restored.status, "draft");
});

test("a failing sessionStorage write is reported without throwing", () => {
  const failing = {
    getItem: () => null,
    removeItem: () => {},
    setItem: () => {
      throw new Error("QuotaExceededError");
    }
  };
  const backup = createWritingRecoveryBackup(sampleBackup());
  assert.equal(writeWritingRecoveryBackup(failing, backup), false);
  assert.equal(writeWritingRecoveryBackup(null, backup), false);
  clearWritingRecoveryBackup(failing, "attempt-1");
});

test("clearing the recovery backup only removes the matching attempt key", () => {
  const storage = memoryStorage();
  writeWritingRecoveryBackup(storage, createWritingRecoveryBackup(sampleBackup()));
  writeWritingRecoveryBackup(
    storage,
    createWritingRecoveryBackup(sampleBackup({ attemptId: "attempt-2" }))
  );
  clearWritingRecoveryBackup(storage, "attempt-1");
  assert.equal(readWritingRecoveryBackup(storage, "attempt-1"), null);
  assert.ok(readWritingRecoveryBackup(storage, "attempt-2"));
});

test("save, submit and autosave share the one fresh-session request path", () => {
  const practice = read("components/writing/WritingPractice.tsx");
  assert.match(practice, /const requestUpdate = useCallback/);
  assert.match(practice, /sendWritingRequestWithSession\(/);
  assert.doesNotMatch(practice, /Authorization: `Bearer \$\{accessToken\}`/);
  assert.doesNotMatch(practice, /accessToken=\{accessToken\}/);
  assert.match(practice, /requestUpdate\("sync"\)/);
  assert.match(practice, /requestUpdate\("save", \{ responseText: snapshotText \}\)/);
  assert.match(practice, /requestUpdate\("submit", \{ responseText: textRef\.current \}\)/);
});

test("background autosave failures only arm the recovery prompt, never a toast", () => {
  const practice = read("components/writing/WritingPractice.tsx");
  const catchIndex = practice.indexOf(".catch((syncError)");
  assert.ok(catchIndex > 0);
  const syncCatch = practice.slice(catchIndex, catchIndex + 400);
  assert.match(syncCatch, /markSaveFailure\(syncError\)/);
  assert.doesNotMatch(syncCatch, /setError|setMessage|window\.alert/);
  const syncThen = practice.slice(
    practice.indexOf("const syncSnapshot = textRef.current;"),
    practice.indexOf(".catch((syncError)")
  );
  assert.match(
    syncThen,
    /clearWritingRecoveryBackup\(getWritingRecoveryStorage\(\), attempt\.attempt_id\)/
  );
});

test("WritingPractice exposes the manual recovery and backup re-login flow", () => {
  const practice = read("components/writing/WritingPractice.tsx");
  assert.match(practice, /草稿暂未保存。当前作文仍保留在编辑器中，请点击“重新连接并保存”。/);
  assert.match(
    practice,
    /当前作文尚未成功保存到服务器。你可以先备份作文，再重新登录并恢复，无需重新输入全文。/
  );
  assert.match(practice, /备份并重新登录/);
  assert.match(practice, /复制全文/);
  assert.match(practice, /临时备份写入失败/);
  assert.match(practice, /const stored = writeWritingRecoveryBackup\(storage, backup\);/);
  assert.match(
    practice,
    /if \(!stored\)[\s\S]{0,260}return;[\s\S]{0,360}window\.location\.assign\(/
  );
  assert.match(practice, /\/login\?returnTo=\$\{encodeURIComponent\(returnTo\)\}/);
  assert.match(practice, /signOutWritingClientSession\(\)/);
});

test("manual recovery saves the latest editor text at click time", () => {
  const practice = read("components/writing/WritingPractice.tsx");
  const reconnect = practice.slice(practice.indexOf("async function reconnectAndSave"));
  assert.match(reconnect.slice(0, 600), /const snapshotText = textRef\.current;/);
  assert.match(practice, /text: textRef\.current,/);
  assert.match(practice, /writeWritingRecoveryBackup\(storage, backup\)/);
});

test("successful manual recovery clears the prompt, failure escalates to the backup flow", () => {
  const practice = read("components/writing/WritingPractice.tsx");
  const reconnect = practice.slice(
    practice.indexOf("async function reconnectAndSave"),
    practice.indexOf("async function backupAndRelogin")
  );
  assert.match(reconnect, /const savedAttempt = await requestUpdate\("save", \{ responseText: snapshotText \}\)/);
  assert.match(reconnect, /applySavedAttempt\(savedAttempt, snapshotText\)/);
  assert.match(reconnect, /setSaveRecovery\(null\)/);
  assert.match(reconnect, /stage: "backup"/);
  assert.match(reconnect, /authRelated: isWritingSessionError\(recoveryError\)/);
  assert.doesNotMatch(reconnect, /requestUpdate\("submit"/);
});

test("a failed submit keeps the text, re-arms retry and never creates a new attempt", () => {
  const practice = read("components/writing/WritingPractice.tsx");
  const submitBlock = practice.slice(
    practice.indexOf("const submit = useCallback"),
    practice.indexOf("useEffect(() => {\n    if (answerMode === \"exam\"")
  );
  assert.match(submitBlock, /submitStartedRef\.current = false/);
  assert.match(submitBlock, /submittingRef\.current = false/);
  assert.match(submitBlock, /isWritingSessionError\(submitError\)\) markSaveFailure/);
  assert.doesNotMatch(submitBlock, /method: "POST"/);
});

test("the restored backup saves a draft to the same attempt and never auto-submits", () => {
  const practice = read("components/writing/WritingPractice.tsx");
  assert.match(practice, /recoverySaveStartedRef/);
  const restoreBlock = practice.slice(practice.indexOf("recoverySaveStartedRef.current = true"));
  assert.match(restoreBlock, /requestUpdate\("save", \{ responseText: snapshotText \}\)/);
  assert.doesNotMatch(restoreBlock.slice(0, 900), /requestUpdate\("submit"/);
  assert.match(practice, /readWritingRecoveryBackup\(getWritingRecoveryStorage\(\), attemptId\)/);
  assert.match(practice, /writingRecoveryMatchesAttempt\(/);
  assert.match(
    practice,
    /clearWritingRecoveryBackup\(getWritingRecoveryStorage\(\), savedAttempt\.attempt_id\)/
  );
  // The exam auto-submit is skipped for a restored page so the student can
  // review the recovered text and submit manually.
  assert.match(
    practice,
    /A restored backup always saves the draft first[\s\S]{0,120}if \(recoveryApplied\) return;/
  );
});

test("a submitted attempt never receives the backup text", () => {
  const practice = read("components/writing/WritingPractice.tsx");
  assert.match(
    practice,
    /result\.attempt\.status === "draft"[\s\S]{0,160}applyWritingRecoveryBackup/
  );
  assert.match(practice, /nextBlockedRecoveryText = backup\.text;/);
  assert.match(practice, /本次作答已提交，无法自动覆盖/);
});

test("normal writing adds no new timers and no direct sessionStorage access", () => {
  const practice = read("components/writing/WritingPractice.tsx");
  assert.equal((practice.match(/window\.setInterval\(/g) ?? []).length, 2);
  assert.doesNotMatch(practice, /window\.sessionStorage/);
  assert.match(practice, /getWritingRecoveryStorage\(\)/);
});

test("the shared login page returns to a safe student practice URL", () => {
  const login = read("components/LoginPanel.tsx");
  assert.match(login, /safeStudentReturnTo/);
  assert.match(login, /new URLSearchParams\(window\.location\.search\)/);
  assert.match(login, /router\.push\(readLoginReturnTo\(\) \?\? result\.defaultRoute\)/);
  assert.match(login, /router\.replace\(readLoginReturnTo\(\) \?\? result\.defaultRoute\)/);
});

test("the recovery storage module never carries credentials", () => {
  const recovery = read("lib/writingRecovery.ts");
  assert.doesNotMatch(recovery, /access_token|refresh_token|accessToken|refreshToken/);
  assert.match(recovery, /sessionStorage/);
});
