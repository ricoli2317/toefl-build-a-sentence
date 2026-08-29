const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  asReadingAssetObjectKey,
  readingRdlObjectKeys,
  resolveReadingAssetUrl
} = require("../lib/reading/assets.ts");
const {
  buildRdlAssetManifest,
  READING_R2_CACHE_CONTROL,
  validateRdlAssetManifest
} = require("../lib/reading/r2Manifest.ts");
const { publishRdlAssetManifest } = require("../lib/reading/r2Publishing.ts");

const canonicalRoot = "/Users/rico/Desktop/真题/阅读/rdl-image-hitbox-prototype";

function digest(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

test("freezes stable RDL object keys and resolves them from one base URL", () => {
  assert.deepEqual(readingRdlObjectKeys("RDL-084"), {
    imageObjectKey: "reading/rdl/RDL-084/material_final.png",
    selectionMapObjectKey: "reading/rdl/RDL-084/selection_map.json"
  });
  assert.equal(
    resolveReadingAssetUrl("reading/rdl/RDL-084/material final.png", "https://assets.example.com/"),
    "https://assets.example.com/reading/rdl/RDL-084/material%20final.png"
  );
  assert.throws(() => resolveReadingAssetUrl("/reading/rdl/RDL-084/material_final.png", "https://assets.example.com"));
  assert.throws(() => resolveReadingAssetUrl("reading/../secret", "https://assets.example.com"));
  assert.throws(() => resolveReadingAssetUrl("reading/rdl/RDL-084/material_final.png", undefined), /READING_ASSET_BASE_URL/);
});

test("builds a complete production manifest from the canonical authority", async () => {
  const manifest = await buildRdlAssetManifest({
    canonicalRoot,
    generatedAt: "2026-08-28T00:00:00.000Z",
    integrityStatus: "COMPLETE"
  });
  assert.equal(manifest.materialCount, 86);
  assert.equal(manifest.objectCount, 172);
  assert.equal(manifest.publishStatus, "prepared");
  assert.equal(validateRdlAssetManifest(JSON.parse(JSON.stringify(manifest))).materialCount, 86);
  assert.equal(manifest.materials.filter((item) => item.selectionBinding.status === "exact_image_sha256").length, 86);
  assert.equal(manifest.materials.filter((item) => item.selectionBinding.status === "accepted_legacy_selection_source").length, 0);
  for (const material of manifest.materials) {
    assert.equal(material.cacheControl, READING_R2_CACHE_CONTROL);
    assert.equal(material.imageContentType, "image/png");
    assert.equal(material.selectionMapContentType, "application/json");
    assert.ok(!material.imageObjectKey.startsWith("/"));
    assert.ok(!material.selectionMapObjectKey.startsWith("/"));
  }
});

test("publisher is idempotent and refuses to overwrite mismatched frozen objects", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reading-r2-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "fixture"));
  const image = Buffer.from("canonical-image");
  const selection = Buffer.from('{"schema_version":2}');
  fs.writeFileSync(path.join(root, "fixture/image.png"), image);
  fs.writeFileSync(path.join(root, "fixture/map.json"), selection);
  const material = {
    materialId: "RDL-999",
    canonicalImagePath: "fixture/image.png",
    canonicalSelectionMapPath: "fixture/map.json",
    imageObjectKey: asReadingAssetObjectKey("reading/rdl/RDL-999/material_final.png"),
    selectionMapObjectKey: asReadingAssetObjectKey("reading/rdl/RDL-999/selection_map.json"),
    imageSha256: digest(image),
    selectionMapSha256: digest(selection),
    imageSize: image.length,
    selectionMapSize: selection.length,
    imageContentType: "image/png",
    selectionMapContentType: "application/json",
    cacheControl: READING_R2_CACHE_CONTROL,
    sourceCanonicalIdentity: { materialIndexAssetId: "RDL-999", canonicalSource: null, provenance: null },
    selectionBinding: {
      status: "exact_image_sha256",
      selectionImageFile: "image.png",
      selectionImageSha256: digest(image),
      canonicalImageSha256: digest(image)
    },
    remote: null
  };
  const manifest = {
    schemaVersion: 1,
    protocol: "tps-reading-rdl-assets-v1",
    generatedAt: "2026-08-28T00:00:00.000Z",
    publishStatus: "prepared",
    objectKeyConvention: "reading/rdl/<MATERIAL_ID>/<asset-file>",
    materialCount: 1,
    objectCount: 2,
    source: {
      materialIndexPath: "data/material-index.json",
      materialIndexSha256: "0".repeat(64),
      selectionCatalogPath: "data/selection-assets.json",
      selectionCatalogSha256: "1".repeat(64),
      integrityStatus: "COMPLETE"
    },
    publication: {
      bucketName: null,
      publicBaseUrlType: null,
      checksumVerifiedCount: 0,
      contentTypeVerifiedCount: 0,
      cacheControlVerifiedCount: 0,
      publicRuntimeVerifiedCount: 0,
      corsVerified: false
    },
    materials: [material]
  };
  const objects = new Map();
  let puts = 0;
  const store = {
    async getObject(key) { return objects.get(key) ?? null; },
    async putObject(input) {
      puts += 1;
      objects.set(input.objectKey, {
        bytes: input.bytes,
        contentType: input.contentType,
        cacheControl: input.cacheControl
      });
    }
  };
  const first = await publishRdlAssetManifest({ canonicalRoot: root, bucketName: "test", manifest, store });
  assert.equal(puts, 2);
  assert.equal(first.publishStatus, "verified");
  const second = await publishRdlAssetManifest({ canonicalRoot: root, bucketName: "test", manifest, store });
  assert.equal(puts, 2);
  assert.ok(second.materials[0].remote.image.status === "verified_existing");

  objects.set(material.imageObjectKey, {
    bytes: Buffer.from("different"),
    contentType: "image/png",
    cacheControl: READING_R2_CACHE_CONTROL
  });
  await assert.rejects(
    publishRdlAssetManifest({ canonicalRoot: root, bucketName: "test", manifest, store }),
    /refusing to overwrite/
  );
  assert.equal(puts, 2);
});
