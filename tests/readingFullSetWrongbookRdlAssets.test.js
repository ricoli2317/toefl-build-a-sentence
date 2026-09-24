const assert = require("node:assert/strict");
const test = require("node:test");

const {
  clearFullSetWrongbookRdlAssetCacheForTests,
  loadFullSetWrongbookRdlAssets
} = require("../lib/reading/fullSetWrongbookRdlAssets.server.ts");

function selectionMap(imageSha256 = "a".repeat(64)) {
  return {
    schema_version: 2,
    image_file: "material_final.png",
    image_sha256: imageSha256,
    canvas_width: 1200,
    canvas_height: 800,
    coordinate_space: "normalized_top_left_xywh_0_1",
    // Legacy R2 selection maps predate `break_after`; keep this fixture
    // legacy-shaped so the runtime backward-compatibility contract stays covered.
    lines: [{
      line_index: 0,
      text: "A",
      bbox: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
      words: [{
        id: "word-0",
        word_index: 0,
        text: "A",
        bbox: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 },
        chars: [{
          id: "char-0",
          char: "A",
          char_index: 0,
          global_index: 0,
          bbox: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 }
        }]
      }]
    }]
  };
}

function input(overrides = {}) {
  return {
    assetVersion: "2026-09-15T01:00:00.000Z",
    imageObjectKey: "reading/rdl/RDL-999/material_final.png",
    imageUrl: "https://assets.test/reading/rdl/RDL-999/material_final.png",
    materialId: "RDL-999",
    selectionMapObjectKey: "reading/rdl/RDL-999/selection_map.json",
    selectionMapUrl: "https://assets.test/reading/rdl/RDL-999/selection_map.json",
    ...overrides
  };
}

test("wrongbook immutable RDL verification fetches only the map and shares a versioned binding", async (t) => {
  clearFullSetWrongbookRdlAssetCacheForTests();
  const originalFetch = global.fetch;
  const urls = [];
  global.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify(selectionMap()), {
      headers: { "Content-Type": "application/json" },
      status: 200
    });
  };
  t.after(() => {
    global.fetch = originalFetch;
    clearFullSetWrongbookRdlAssetCacheForTests();
  });

  const first = await loadFullSetWrongbookRdlAssets(input());
  const cached = await loadFullSetWrongbookRdlAssets(input());
  assert.equal(first.imageSha256, "a".repeat(64));
  assert.strictEqual(cached, first);
  assert.deepEqual(urls, ["https://assets.test/reading/rdl/RDL-999/selection_map.json"]);
  assert.ok(urls.every((url) => !url.endsWith("material_final.png")));

  await loadFullSetWrongbookRdlAssets(input({ assetVersion: "2026-09-15T02:00:00.000Z" }));
  assert.equal(urls.length, 2, "updated_at must invalidate the process binding cache");
});

test("wrongbook RDL cache rejects mismatched identities and retries a failed map fetch", async (t) => {
  clearFullSetWrongbookRdlAssetCacheForTests();
  const originalFetch = global.fetch;
  let fetches = 0;
  global.fetch = async () => {
    fetches += 1;
    if (fetches === 1) return new Response("unavailable", { status: 503 });
    return new Response(JSON.stringify(selectionMap()), { status: 200 });
  };
  t.after(() => {
    global.fetch = originalFetch;
    clearFullSetWrongbookRdlAssetCacheForTests();
  });

  await assert.rejects(loadFullSetWrongbookRdlAssets(input()), /503/);
  await loadFullSetWrongbookRdlAssets(input());
  assert.equal(fetches, 2, "failed bindings must not poison the retry path");
  await assert.rejects(loadFullSetWrongbookRdlAssets(input({
    imageObjectKey: "reading/rdl/RDL-998/material_final.png"
  })), /material identity/);
});

