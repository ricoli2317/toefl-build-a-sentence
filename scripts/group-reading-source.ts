// Historical May/June Batch 1B package-generation tool. It is not the future
// Reading content-production workflow; future TPS imports consume final CSV.
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  computeReadingDisplayRanks,
  groupReadingSourceOccurrences
} from "../lib/reading/grouping.ts";
import type {
  ReadingImportPackage,
  ReadingModule,
  ReadingSourceOccurrenceCandidate,
  ReadingSourcePackage
} from "../lib/reading/types.ts";

async function main() {
  const projectRoot = process.cwd();
  const sourceRoot = resolve(projectRoot, "data/reading/source-packages");
  const sourceFiles = await jsonFiles(sourceRoot);
  const sourcePackages = await Promise.all(sourceFiles.map(async (file) =>
    JSON.parse(await readFile(file, "utf8")) as ReadingSourcePackage
  ));
  const candidates = sourcePackages.flatMap((sourcePackage) => sourcePackage.occurrences);
  const result = groupReadingSourceOccurrences(candidates);
  const outputRoot = resolve(projectRoot, "data/reading/import-packages");

  for (const staleMonth of ["2026-05", "2026-06"]) {
    const staleDirectory = join(outputRoot, staleMonth);
    try {
      for (const name of await readdir(staleDirectory)) {
        if (name.endsWith(".json")) await unlink(join(staleDirectory, name));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const module of ["ctw", "rdl", "rap"] as const) {
    const directory = join(outputRoot, module);
    await mkdir(directory, { recursive: true });
    for (const name of await readdir(directory)) {
      if (name.endsWith(".json")) await unlink(join(directory, name));
    }
  }
  for (const packageData of result.packages) {
    await writeJson(
      join(outputRoot, packageData.item.module, `${packageData.item.logicalItemId}.json`),
      packageData
    );
  }

  const ranks = computeReadingDisplayRanks(result.packages.map((packageData) => packageData.item));
  const inventory = result.packages.map((packageData) => ({
    logicalItemId: packageData.item.logicalItemId,
    module: packageData.item.module,
    title: packageData.item.title,
    firstSeenDate: packageData.item.firstSeenDate,
    firstSeenSourceLabel: packageData.item.firstSeenSourceLabel,
    firstSeenSourceOrder: packageData.item.firstSeenSourceOrder,
    dynamicDisplayLabel: ranks.get(packageData.item.logicalItemId)?.label,
    occurrenceCount: packageData.occurrences.length,
    occurrences: packageData.occurrences.map((occurrence) => ({
      sourceLabel: occurrence.sourceLabel,
      occurrenceDate: occurrence.occurrenceDate,
      sourceModule: occurrence.sourceModule,
      sourceOrder: occurrence.sourceOrder
    }))
  }));

  const report = {
    ...result.report,
    months: monthReport(candidates, result.packages),
    crossMonthDuplicateGroups: result.packages
      .filter((packageData) => new Set(packageData.occurrences.map((item) => item.yearMonth)).size > 1)
      .map((packageData) => ({
        logicalItemId: packageData.item.logicalItemId,
        module: packageData.item.module,
        title: packageData.item.title,
        occurrences: packageData.occurrences.map((item) => item.sourceLabel)
      }))
  };
  await writeJson(resolve(projectRoot, "data/reading/reports/reading-dedup-report.json"), report);
  await writeJson(resolve(projectRoot, "data/reading/reports/reading-logical-inventory.json"), {
    schemaVersion: 1,
    itemCount: inventory.length,
    items: inventory
  });
  console.log(JSON.stringify(report, null, 2));
}

function monthReport(
  candidates: ReadingSourceOccurrenceCandidate[],
  packages: ReadingImportPackage[]
) {
  const months = ["2026-05", "2026-06"];
  return Object.fromEntries(months.map((month) => {
    const monthCandidates = candidates.filter((candidate) => candidate.source.yearMonth === month);
    const firstSeen = packages.filter((packageData) => packageData.item.firstSeenDate.startsWith(month));
    const mergedIntoEarlier = packages.flatMap((packageData) =>
      packageData.occurrences.filter((occurrence) =>
        occurrence.yearMonth === month && !packageData.item.firstSeenDate.startsWith(month)
      ).map(() => packageData.item.module)
    );
    const rawCounts = moduleCounts(monthCandidates.map((candidate) => candidate.module));
    const newCounts = moduleCounts(firstSeen.map((packageData) => packageData.item.module));
    const earlierCounts = moduleCounts(mergedIntoEarlier);
    return [month, {
      sourceSetCount: new Set(monthCandidates.map((candidate) => candidate.source.sourceLabel)).size,
      rawOccurrenceCounts: rawCounts,
      newLogicalItemCounts: newCounts,
      mergedIntoEarlierLogicalItemCounts: earlierCounts,
      duplicateOccurrenceWithinMonthCounts: {
        ctw: rawCounts.ctw - newCounts.ctw - earlierCounts.ctw,
        rdl: rawCounts.rdl - newCounts.rdl - earlierCounts.rdl,
        rap: rawCounts.rap - newCounts.rap - earlierCounts.rap
      }
    }];
  }));
}

function moduleCounts(modules: ReadingModule[]): Record<ReadingModule, number> {
  return {
    ctw: modules.filter((module) => module === "ctw").length,
    rdl: modules.filter((module) => module === "rdl").length,
    rap: modules.filter((module) => module === "rap").length
  };
}

async function jsonFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await jsonFiles(target));
    else if (entry.isFile() && entry.name.endsWith(".json")) result.push(target);
  }
  return result.sort();
}

async function writeJson(file: string, value: unknown) {
  await mkdir(resolve(file, ".."), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
