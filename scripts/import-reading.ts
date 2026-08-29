// Historical Batch 1B package importer retained for audit/replay only. Future
// Reading production handoff uses the teacher CSV importer.
import { access, readFile, readdir, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { createServiceSupabase } from "../lib/supabase/server.ts";
import { importReadingPackage } from "../lib/reading/importer.ts";
import { validateReadingImportPackage } from "../lib/reading/validation.ts";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const monthFlagIndex = args.indexOf("--occurrence-month");
  const occurrenceMonth = monthFlagIndex >= 0 ? args[monthFlagIndex + 1] : null;
  if (occurrenceMonth !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(occurrenceMonth)) {
    throw new Error("--occurrence-month must be YYYY-MM");
  }
  if (occurrenceMonth !== null && !dryRun) {
    throw new Error("--occurrence-month is a dry-run reporting filter and cannot be used for database writes");
  }
  const ignoredIndexes = new Set([
    args.indexOf("--dry-run"),
    args.indexOf("--"),
    monthFlagIndex,
    monthFlagIndex >= 0 ? monthFlagIndex + 1 : -1
  ]);
  const inputPath = args.find((_, index) => !ignoredIndexes.has(index));

  if (!inputPath) {
    throw new Error("Usage: pnpm import:reading -- <package.json|package-directory> [--dry-run] [--occurrence-month YYYY-MM]");
  }

  const absolutePath = resolve(process.cwd(), inputPath);
  const inputFiles = await packageFiles(absolutePath);
  const packages = await Promise.all(inputFiles.map(async (file) => {
    const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
    return { file, packageData: validateReadingImportPackage(raw) };
  }));

  if (dryRun) {
    for (const { packageData } of packages) await validateLocalReferences(packageData);
    const selected = occurrenceMonth === null
      ? packages
      : packages.filter(({ packageData }) =>
          packageData.occurrences.some((occurrence) => occurrence.yearMonth === occurrenceMonth)
        );
    const selectedOccurrences = selected.flatMap(({ packageData }) =>
      packageData.occurrences
        .filter((occurrence) => occurrenceMonth === null || occurrence.yearMonth === occurrenceMonth)
        .map((occurrence) => ({ packageData, occurrence }))
    );
    console.log(JSON.stringify({
      valid: true,
      occurrenceMonth,
      packageCount: selected.length,
      logicalItemIds: selected.map(({ packageData }) => packageData.item.logicalItemId),
      occurrenceCount: selectedOccurrences.length,
      sourceQuestionRowCount: selectedOccurrences.reduce(
        (count, { occurrence }) => count + occurrence.questionSources.length,
        0
      ),
      sourceScoredItemCount: selectedOccurrences.reduce(
        (count, { packageData }) => count + packageData.item.scoredItemCount,
        0
      ),
      logicalQuestionRowCount: selected.reduce((count, { packageData }) => count + packageData.questions.length, 0),
      logicalScoredItemCount: selected.reduce((count, { packageData }) => count + packageData.item.scoredItemCount, 0),
      pendingMaterialIds: Array.from(new Set(selected.flatMap(({ packageData }) =>
        packageData.materials
          .filter((material) => material.bindingStatus === "pending")
          .map((material) => material.materialId)
      ))).sort()
    }, null, 2));
    return;
  }

  const supabase = createServiceSupabase();
  const results = [];
  for (const { packageData } of packages) {
    results.push(await importReadingPackage(supabase, packageData));
  }
  console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
}

async function packageFiles(inputPath: string): Promise<string[]> {
  const inputStat = await stat(inputPath);
  if (inputStat.isFile()) return [inputPath];
  if (!inputStat.isDirectory()) throw new Error(`Input must be a JSON file or directory: ${inputPath}`);
  const files = await collectJsonFiles(inputPath);
  if (files.length === 0) throw new Error(`No JSON import packages found in ${inputPath}`);
  return files.sort();
}

async function collectJsonFiles(inputPath: string): Promise<string[]> {
  const entries = await readdir(inputPath, { withFileTypes: true });
  const files = (await Promise.all(entries.map(async (entry): Promise<string[]> => {
    const target = join(inputPath, entry.name);
    if (entry.isDirectory()) return collectJsonFiles(target);
    return entry.isFile() && extname(entry.name).toLowerCase() === ".json" ? [target] : [];
  }))).flat().sort();
  return files;
}

async function validateLocalReferences(packageData: ReturnType<typeof validateReadingImportPackage>) {
  for (const occurrence of packageData.occurrences) {
    if (occurrence.sourceKind === "synthetic") continue;
    await access(resolve(process.cwd(), occurrence.sourceQuestionFile));
    await access(resolve(process.cwd(), occurrence.sourceAnswerFile));
  }
  for (const material of packageData.materials) {
    if (material.bindingStatus !== "bound") continue;
    for (const runtimePath of [material.imageAssetPath, material.hitboxDataPath]) {
      if (!runtimePath?.startsWith("/reading/")) {
        throw new Error(`item=${packageData.item.logicalItemId} material=${material.materialId}: invalid runtime path`);
      }
      await access(resolve(process.cwd(), "public", runtimePath.slice(1)));
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
