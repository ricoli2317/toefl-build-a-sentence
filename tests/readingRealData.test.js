const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { validateReadingImportPackage } = require("../lib/reading/validation.ts");

const projectRoot = path.join(__dirname, "..");
const readingRoot = path.join(projectRoot, "data/reading");

function json(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function jsonFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? jsonFiles(target) : entry.name.endsWith(".json") ? [target] : [];
  }).sort();
}

function logicalPackages(module) {
  return jsonFiles(path.join(readingRoot, "import-packages", module))
    .map((file) => validateReadingImportPackage(json(file)));
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("splits 47 date sources into globally deduplicated CTW, RDL, and RAP logical items", () => {
  const sourcePackages = jsonFiles(path.join(readingRoot, "source-packages")).map(json);
  assert.equal(sourcePackages.length, 47);
  assert.equal(sourcePackages.filter((item) => item.sourceLabel.startsWith("5.")).length, 23);
  assert.equal(sourcePackages.filter((item) => item.sourceLabel.startsWith("6.")).length, 24);
  const candidates = sourcePackages.flatMap((item) => item.occurrences);
  assert.deepEqual(
    Object.fromEntries(["ctw", "rdl", "rap"].map((module) => [module, candidates.filter((item) => item.module === module).length])),
    { ctw: 140, rdl: 132, rap: 122 }
  );

  const ctw = logicalPackages("ctw");
  const rdl = logicalPackages("rdl");
  const rap = logicalPackages("rap");
  assert.deepEqual({ ctw: ctw.length, rdl: rdl.length, rap: rap.length }, { ctw: 97, rdl: 108, rap: 97 });
  assert.equal([...ctw, ...rdl, ...rap].reduce((count, item) => count + item.occurrences.length, 0), 394);
  assert.ok(ctw.every((item) => item.item.title === null));
  assert.ok(rdl.every((item) => item.item.title && item.materials.length === 1));
  assert.ok(rap.every((item) => item.item.title && item.passages.length === 1));
});

test("keeps every archived DOCX and canonical runtime asset checksum verified", () => {
  const sourceManifest = json(path.join(readingRoot, "manifests/source-documents.json"));
  assert.equal(sourceManifest.documentCount, 94);
  for (const document of sourceManifest.documents) {
    assert.equal(document.copyVerified, true, `${document.archivedPath} was not verified during copy`);
    const archived = path.join(projectRoot, document.archivedPath);
    assert.ok(fs.existsSync(archived), `missing archived source ${document.archivedPath}`);
    assert.equal(sha256(archived), document.sha256);
  }

  const materialManifest = json(path.join(readingRoot, "manifests/rdl-materials.json"));
  assert.equal(materialManifest.materialCount, 86);
  assert.equal(materialManifest.usedMaterialCount, 86);
  for (const material of materialManifest.materials) {
    assert.equal(material.imageCopyVerified, true, `${material.materialId} image copy not verified`);
    assert.equal(material.selectionMapCopyVerified, true, `${material.materialId} map copy not verified`);
    const image = path.join(projectRoot, "public", material.imageRuntimePath.slice(1));
    const selectionMap = path.join(projectRoot, "public", material.selectionMapRuntimePath.slice(1));
    assert.equal(sha256(image), material.imageSha256, `${material.materialId} image checksum mismatch`);
    assert.equal(sha256(selectionMap), material.selectionMapSha256, `${material.materialId} map checksum mismatch`);
  }
});

test("records every non-guessed source gap and conservative possible duplicate", () => {
  const unresolved = json(path.join(readingRoot, "reports/reading-import-unresolved.json"));
  assert.equal(unresolved.length, 1);
  assert.ok(unresolved.find((item) => item.set === "6.2" && item.question === "1-10"));
  assert.equal(unresolved.filter((item) => item.type === "rdl").length, 0);
  const dedup = json(path.join(readingRoot, "reports/reading-dedup-report.json"));
  assert.deepEqual(dedup.logicalItemCounts, { ctw: 97, rdl: 108, rap: 97 });
  assert.ok(dedup.exactDuplicateGroups.length > 0);
  assert.ok(dedup.possibleDuplicates.length > 0);
});

test("QA report covers three dates and every raw special RAP occurrence", () => {
  const qa = json(path.join(readingRoot, "reports/reading-import-qa.json"));
  assert.deepEqual(qa.ctwSamples.map((item) => item.set), ["5.3A", "5.18B", "6.30A"]);
  assert.deepEqual(qa.rdlSamples.map((item) => item.set), ["5.3A", "5.18B", "6.30A"]);
  assert.deepEqual(qa.rapMultipleChoiceSamples.map((item) => item.set), ["5.3A", "5.18B", "6.30A"]);
  assert.equal(qa.allInsertionChecks.length, 61);
  assert.ok(qa.allInsertionChecks.every((item) => item.anchorCount === 4));
  assert.equal(qa.allSentenceSelectionChecks.length, 23);
  assert.ok(qa.allSentenceSelectionChecks.every((item) => item.correctSentenceText.length > 0));
});
