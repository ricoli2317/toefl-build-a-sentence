const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  catalogCacheInstanceId,
  logCatalogCacheRebuild
} = require("../lib/catalogCacheDiagnostics.server.ts");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

function captureInfo(run) {
  const lines = [];
  const original = console.info;
  console.info = (...args) => {
    lines.push(args);
  };
  try {
    run();
  } finally {
    console.info = original;
  }
  return lines;
}

test("a rebuild log line is emitted once per callback execution with the required fields", () => {
  const lines = captureInfo(() => {
    logCatalogCacheRebuild({
      cacheKind: "practice_catalog",
      taskType: "email",
      revision: 42
    });
    logCatalogCacheRebuild({
      cacheKind: "reading_full_set_catalog",
      taskType: "full_set",
      revision: 7
    });
  });

  assert.equal(lines.length, 2, "one log line per callback execution");
  const [prefix, payloadText] = lines[0];
  assert.equal(prefix, "[catalog-cache]");
  const payload = JSON.parse(payloadText);
  assert.equal(payload.event, "rebuild");
  assert.equal(payload.cacheKind, "practice_catalog");
  assert.equal(payload.taskType, "email");
  assert.equal(payload.revision, 42);
  assert.equal(payload.vercelRegion, process.env.VERCEL_REGION ?? null);
  assert.equal(payload.instanceId, catalogCacheInstanceId);
  assert.ok(Number.isFinite(Date.parse(payload.timestamp)), "timestamp must be a date");
  assert.equal(new Date(payload.timestamp).toISOString(), payload.timestamp);

  const second = JSON.parse(lines[1][1]);
  assert.equal(second.instanceId, payload.instanceId, "instance id is module-level and stable");
  assert.equal(second.cacheKind, "reading_full_set_catalog");
  assert.equal(second.taskType, "full_set");
  assert.equal(second.revision, 7);
});

test("rebuild logging only lives inside the unstable_cache callbacks", () => {
  const modules = [
    ["lib/practiceCatalogCache.server.ts", "practiceCatalogCache"],
    ["lib/reading/catalogCache.server.ts", "readingCatalogCache"]
  ];
  for (const [file, label] of modules) {
    const source = read(file);
    const segments = source.split("unstable_cache(");
    const outsideCallbacks = segments[0];
    const callbacks = segments.slice(1);
    assert.ok(callbacks.length > 0, `${label}: unstable_cache callbacks must exist`);

    // Cache-hit entry points never run the callbacks, so a log call there
    // would be a bug: nothing may log outside the wrapped callbacks.
    assert.doesNotMatch(
      outsideCallbacks,
      /logCatalogCacheRebuild\(/,
      `${label}: no rebuild log outside the callbacks`
    );
    assert.equal(
      (source.match(/logCatalogCacheRebuild\(/g) ?? []).length,
      callbacks.length,
      `${label}: every unstable_cache callback logs its rebuild`
    );

    for (const callback of callbacks) {
      assert.match(callback, /async \(revision: number\)/, `${label}: callback keeps the revision argument`);
      const logIndex = callback.indexOf("logCatalogCacheRebuild(");
      assert.ok(logIndex >= 0, `${label}: callback logs its rebuild`);
      const logCall = callback.slice(logIndex, logIndex + 200);
      assert.match(logCall, /cacheKind:/);
      assert.match(logCall, /taskType/);
      assert.match(logCall, /revision/);

      for (const loader of [
        "loadPublicLogicalPracticeCatalog(",
        "loadPublicLogicalPracticeCatalogSearchIndex(",
        "loadPublicReadingCatalog(",
        "loadPublicReadingCatalogSearchIndex(",
        "buildReadingFullSetPublicCatalog("
      ]) {
        const loaderIndex = callback.indexOf(loader);
        if (loaderIndex < 0) continue;
        assert.ok(loaderIndex > logIndex, `${label}: logs before rebuilding through ${loader}`);
      }
    }
  }
});
