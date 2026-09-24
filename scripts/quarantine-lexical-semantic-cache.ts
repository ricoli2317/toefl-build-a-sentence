import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  classifySemanticCacheForQuarantine,
  type SemanticCacheStage
} from "../lib/lexical/quarantine.ts";

const ROOT = process.cwd();
const CHECKPOINT_ROOT = path.join(ROOT, "tmp", "lexical-v1", "checkpoints");
const QUARANTINE_ROOT = path.join(CHECKPOINT_ROOT, "quarantined");
const STAGES: SemanticCacheStage[] = ["annotation", "enrichment"];

type QuarantineRecord = {
  original_path: string;
  quarantined_path: string;
  stage: SemanticCacheStage;
  provider: string | null;
  model: string | null;
  generation_version: unknown;
  batch_identity: string;
  source_blocks: Array<{
    source_type: unknown;
    source_item_id: unknown;
    content_block_id: unknown;
    source_text_hash: unknown;
  }>;
  normalized_expression: unknown;
  expression_type: unknown;
  input_signature: unknown;
  original_timestamp: string;
  quarantine_reason: string;
};

async function writeJsonAtomic(filePath: string, value: unknown) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

async function main() {
  const recordsByGroup = new Map<string, QuarantineRecord[]>();
  for (const stage of STAGES) {
    const sourceDir = path.join(CHECKPOINT_ROOT, stage);
    let names: string[] = [];
    try {
      names = (await readdir(sourceDir)).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const name of names) {
      const sourcePath = path.join(sourceDir, name);
      const cache = JSON.parse(await readFile(sourcePath, "utf8")) as Record<string, unknown>;
      const classification = classifySemanticCacheForQuarantine(stage, cache);
      if (!classification.group || !classification.reason) continue;
      const targetDir = path.join(QUARANTINE_ROOT, classification.group, stage);
      const targetPath = path.join(targetDir, name);
      const fileStat = await stat(sourcePath);
      const blocks = Array.isArray(cache.blocks) ? cache.blocks : [];
      const record: QuarantineRecord = {
        original_path: path.relative(ROOT, sourcePath),
        quarantined_path: path.relative(ROOT, targetPath),
        stage,
        provider: classification.provider,
        model: classification.model,
        generation_version: cache.generation_version ?? null,
        batch_identity: name.replace(/\.json$/, ""),
        source_blocks: blocks.map((value) => {
          const block = value && typeof value === "object" && !Array.isArray(value)
            ? value as Record<string, unknown>
            : {};
          return {
            source_type: block.source_type ?? null,
            source_item_id: block.source_item_id ?? null,
            content_block_id: block.content_block_id ?? null,
            source_text_hash: block.source_text_hash ?? null
          };
        }),
        normalized_expression: cache.normalized_expression ?? null,
        expression_type: cache.expression_type ?? null,
        input_signature: cache.input_signature ?? null,
        original_timestamp: fileStat.mtime.toISOString(),
        quarantine_reason: classification.reason
      };
      await mkdir(targetDir, { recursive: true });
      await rename(sourcePath, targetPath);
      recordsByGroup.set(classification.group, [...(recordsByGroup.get(classification.group) ?? []), record]);
    }
  }

  for (const [group, records] of Array.from(recordsByGroup.entries())) {
    const groupDir = path.join(QUARANTINE_ROOT, group);
    await mkdir(groupDir, { recursive: true });
    await writeJsonAtomic(path.join(groupDir, "quarantine-manifest.json"), {
      quarantined_at: new Date().toISOString(),
      group,
      file_count: records.length,
      stage_counts: Object.fromEntries(STAGES.map((stage) => [
        stage,
        records.filter((record: QuarantineRecord) => record.stage === stage).length
      ])),
      records
    });
    console.log(`${group}: quarantined ${records.length} semantic checkpoint files.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
