import { mkdir, rename, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { loadCompletedLexicalAgentData, lexicalAgentPaths } from "./agentProtocol.ts";
import { assessLexicalCompletion } from "./completion.ts";
import type { ConsolidatedEntrySeed } from "./consolidate.ts";
import { LEXICAL_GENERATION_VERSION, type LexicalBlockWork, type LexicalOccurrenceArtifact } from "./generationTypes.ts";
import { LEXICAL_CURRENT_AGENT_PROVENANCE } from "./provenance.ts";
import { qaEntries, qaLexicalBlock, qaOccurrenceSemantics, type LexicalBlockQa } from "./qa.ts";

const SOURCE_TYPES = ["ctw", "rdl", "rap", "bas", "write_email", "academic_discussion"] as const;

async function writeAtomic(filePath: string, contents: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, filePath);
}

async function writeJson(filePath: string, value: unknown) {
  await writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeJsonl(filePath: string, values: unknown[]) {
  await writeAtomic(filePath, values.map((value) => JSON.stringify(value)).join("\n") + (values.length ? "\n" : ""));
}

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function writeCsv(filePath: string, headers: string[], rows: Array<Record<string, unknown>>) {
  const lines = [headers.join(","), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))];
  await writeAtomic(filePath, `${lines.join("\n")}\n`);
}

function blockKey(sourceType: string, sourceItemId: string, contentBlockId: string) {
  return `${sourceType}:${sourceItemId}:${contentBlockId}`;
}

function countReasons(issues: Array<{ reasons: string[] }>) {
  const counts: Record<string, number> = {};
  for (const issue of issues) {
    for (const reason of Array.from(new Set(issue.reasons))) counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

function classifyReview(notes: string | null | undefined) {
  const value = notes?.toLocaleLowerCase("en-US") ?? "";
  if (value.includes("rdl_source")) return "RDL source";
  if (value.includes("pos")) return "POS";
  if (value.includes("lemma") || value.includes("base")) return "lemma/base";
  if (value.includes("boundary") || value.includes("mwe") || value.includes("phrase")) return "MWE boundary";
  if (value.includes("proper") || value.includes("entity")) return "proper noun";
  if (value.includes("merge") || value.includes("canonical")) return "merge conflict";
  if (value.includes("enrichment") || value.includes("derived") || value.includes("pattern")) return "enrichment";
  if (value.includes("sense")) return "sense";
  return "other";
}

function summarizeQa(
  sourceType: string,
  works: LexicalBlockWork[],
  occurrences: LexicalOccurrenceArtifact[],
  blockQa: LexicalBlockQa[],
  entries: ConsolidatedEntrySeed[]
) {
  const sourceOccurrences = sourceType === "overall" ? occurrences : occurrences.filter((value) => value.source_type === sourceType);
  const sourceQas = sourceType === "overall" ? blockQa : blockQa.filter((value) => value.sourceType === sourceType);
  const itemIds = new Set(works.map((work) => work.block.sourceItemId));
  const entryKeys = new Set(sourceOccurrences.map((occurrence) => occurrence.entry_key));
  const eligible = sourceQas.reduce((sum, qa) => sum + qa.eligibleTokens, 0);
  return {
    source_type: sourceType,
    items: itemIds.size,
    blocks: works.length,
    eligible_tokens: eligible,
    excluded_tokens: sourceQas.reduce((sum, qa) => sum + qa.excludedTokens, 0),
    layer_1: sourceOccurrences.filter((occurrence) => occurrence.layer === 1).length,
    layer_2: sourceOccurrences.filter((occurrence) => occurrence.layer === 2).length,
    unique_entries: entryKeys.size,
    needs_review: sourceQas.filter((qa) => qa.generationStatus === "needs_review").length,
    failed_blocks: sourceQas.filter((qa) => qa.generationStatus === "failed").length,
    missing_tokens: sourceQas.reduce((sum, qa) => sum + qa.missingTokens, 0),
    invalid_spans: sourceQas.reduce((sum, qa) => sum + qa.invalidSpans, 0),
    duplicate_exact_spans: sourceQas.reduce((sum, qa) => sum + qa.duplicateExactSpans, 0),
    coverage_percent: eligible === 0 ? 100 : sourceQas.reduce((sum, qa) => sum + qa.coveredLayer1, 0) / eligible * 100,
    reviewed_entries: entries.filter((entry) => entryKeys.has(entry.entry_key) && entry.review_status === "needs_review").length
  };
}

export async function finalizeLexicalAgentArtifacts(root = process.cwd()) {
  const paths = lexicalAgentPaths(root);
  const { works, occurrences, entries, stageCounts } = await loadCompletedLexicalAgentData(root);
  if (entries.some((entry) => !entry)) throw new Error("Missing enriched entry checkpoint.");
  const entryIssues = qaEntries(entries);
  const occurrenceIssues = qaOccurrenceSemantics(occurrences);
  const entryIssueByKey = new Map(entryIssues.map((issue) => [issue.entryKey, issue.reasons]));
  for (const entry of entries) {
    const reasons = entryIssueByKey.get(entry.entry_key);
    if (reasons?.length) {
      entry.review_status = "needs_review";
      entry.review_notes = [entry.review_notes, ...reasons].filter(Boolean).join("; ");
    }
  }
  const reviewEntryKeys = new Set(entries.filter((entry) => entry.review_status === "needs_review").map((entry) => entry.entry_key));
  const occurrencesByBlock = new Map<string, LexicalOccurrenceArtifact[]>();
  for (const occurrence of occurrences) {
    const key = blockKey(occurrence.source_type, occurrence.source_item_id, occurrence.content_block_id);
    occurrencesByBlock.set(key, [...(occurrencesByBlock.get(key) ?? []), occurrence]);
  }
  const blockQa = works.map((work) => {
    const key = blockKey(work.block.sourceType, work.block.sourceItemId, work.block.contentBlockId);
    const qa = qaLexicalBlock(work, occurrencesByBlock.get(key) ?? [], null);
    if (qa.generationStatus !== "failed" && (occurrencesByBlock.get(key) ?? []).some((occurrence) => reviewEntryKeys.has(occurrence.entry_key))) {
      qa.generationStatus = "needs_review";
      qa.reasons.push("entry_needs_review");
    }
    return qa;
  });
  const sourceBlocks = works.map((work) => {
    const qa = blockQa.find((value) =>
      value.sourceType === work.block.sourceType &&
      value.sourceItemId === work.block.sourceItemId &&
      value.contentBlockId === work.block.contentBlockId
    )!;
    return {
      source_type: work.block.sourceType,
      source_item_id: work.block.sourceItemId,
      content_block_id: work.block.contentBlockId,
      block_kind: work.block.blockKind,
      source_text_hash: work.sourceTextHash,
      generation_status: qa.generationStatus,
      generation_version: LEXICAL_GENERATION_VERSION,
      last_error: qa.generationStatus === "failed" ? qa.reasons.join("; ") : null
    };
  });
  const needsReview: Array<Record<string, unknown>> = [];
  for (const entry of entries.filter((value) => value.review_status === "needs_review")) needsReview.push({
    record_type: "entry", category: classifyReview(entry.review_notes), entry_key: entry.entry_key,
    source_type: "", source_item_id: "", content_block_id: "", expression: entry.canonical_expression, reason: entry.review_notes
  });
  for (const occurrence of occurrences.filter((value) => value.review_status === "needs_review")) needsReview.push({
    record_type: "occurrence", category: classifyReview(occurrence.review_notes), entry_key: occurrence.entry_key,
    source_type: occurrence.source_type, source_item_id: occurrence.source_item_id,
    content_block_id: occurrence.content_block_id, expression: occurrence.surface_text, reason: occurrence.review_notes
  });
  for (const qa of blockQa.filter((value) => value.generationStatus !== "generated")) needsReview.push({
    record_type: "block", category: classifyReview(qa.reasons.join("; ")), entry_key: "",
    source_type: qa.sourceType, source_item_id: qa.sourceItemId, content_block_id: qa.contentBlockId,
    expression: "", reason: qa.reasons.join("; ")
  });

  const bySourceType = SOURCE_TYPES.map((sourceType) => summarizeQa(
    sourceType,
    works.filter((work) => work.block.sourceType === sourceType),
    occurrences,
    blockQa,
    entries
  ));
  const blockKinds = Array.from(new Set(works.map((work) => work.block.blockKind))).sort().map((blockKind) => {
    const kindWorks = works.filter((work) => work.block.blockKind === blockKind);
    const keys = new Set(kindWorks.map((work) => blockKey(work.block.sourceType, work.block.sourceItemId, work.block.contentBlockId)));
    const kindOccurrences = occurrences.filter((occurrence) => keys.has(blockKey(occurrence.source_type, occurrence.source_item_id, occurrence.content_block_id)));
    const qas = blockQa.filter((qa) => qa.blockKind === blockKind);
    return {
      block_kind: blockKind,
      blocks: kindWorks.length,
      eligible_tokens: qas.reduce((sum, qa) => sum + qa.eligibleTokens, 0),
      excluded_tokens: qas.reduce((sum, qa) => sum + qa.excludedTokens, 0),
      layer_1: kindOccurrences.filter((occurrence) => occurrence.layer === 1).length,
      layer_2: kindOccurrences.filter((occurrence) => occurrence.layer === 2).length,
      needs_review_blocks: qas.filter((qa) => qa.generationStatus === "needs_review").length,
      failed_blocks: qas.filter((qa) => qa.generationStatus === "failed").length
    };
  });
  const semanticAudit = {
    audited_at: new Date().toISOString(),
    occurrence_issue_records: occurrenceIssues.length,
    occurrence_issue_counts: countReasons(occurrenceIssues),
    entry_issue_records: entryIssues.length,
    entry_issue_counts: countReasons(entryIssues)
  };
  const qaSummary = {
    generation_version: LEXICAL_GENERATION_VERSION,
    generated_at: new Date().toISOString(),
    provenance: LEXICAL_CURRENT_AGENT_PROVENANCE,
    agent_stage_batches: stageCounts,
    overall: summarizeQa("overall", works, occurrences, blockQa, entries),
    by_source_type: bySourceType,
    by_block_kind: blockKinds,
    expression_types: Object.fromEntries(["word", "phrase", "phrasal_verb", "idiom", "proper_noun"].map((type) => [
      type, occurrences.filter((occurrence) => occurrence.expression_type === type).length
    ])),
    mwe_by_source_type: Object.fromEntries(SOURCE_TYPES.map((sourceType) => [sourceType, Object.fromEntries(
      ["phrase", "phrasal_verb", "idiom", "proper_noun"].map((type) => [
        type, occurrences.filter((occurrence) => occurrence.source_type === sourceType && occurrence.layer === 2 && occurrence.expression_type === type).length
      ])
    )])),
    entries_with_derived_words: entries.filter((entry) => entry.derived_words.length > 0).length,
    entries_with_useful_patterns: entries.filter((entry) => entry.useful_patterns.length > 0).length,
    semantic_audit: semanticAudit,
    entry_qa_issues: entryIssues,
    failed_blocks: blockQa.filter((qa) => qa.generationStatus === "failed")
  };

  const cleanEntries = entries.map(({ sample_occurrences: _samples, entry_key: _key, ...entry }) => entry);
  const cleanOccurrences = occurrences.map(({ layer: _layer, expression_type: _type, canonical_expression: _canonical, normalized_expression: _normalized, lemma: _lemma, ...occurrence }) => occurrence);
  await Promise.all([
    writeJsonl(path.join(paths.outputRoot, "expression-candidates.jsonl"), occurrences.filter((occurrence) => occurrence.layer === 2)),
    writeJsonl(path.join(paths.outputRoot, "lexical-entries.jsonl"), cleanEntries),
    writeJsonl(path.join(paths.outputRoot, "lexical-occurrences.jsonl"), cleanOccurrences),
    writeJsonl(path.join(paths.outputRoot, "lexical-source-blocks.jsonl"), sourceBlocks),
    writeJsonl(path.join(paths.outputRoot, "needs-review.jsonl"), needsReview),
    writeCsv(path.join(paths.outputRoot, "needs-review.csv"), [
      "record_type", "category", "entry_key", "source_type", "source_item_id", "content_block_id", "expression", "reason"
    ], needsReview),
    writeJson(path.join(paths.outputRoot, "qa-summary.json"), qaSummary),
    writeCsv(path.join(paths.outputRoot, "qa-by-source-type.csv"), Object.keys(bySourceType[0]), bySourceType),
    writeCsv(path.join(paths.outputRoot, "qa-by-block-kind.csv"), Object.keys(blockKinds[0]), blockKinds)
  ]);

  const completion = assessLexicalCompletion(occurrences, entries, blockQa);
  const manifest = JSON.parse(await readFile(paths.manifest, "utf8")) as Record<string, unknown>;
  manifest.complete = completion.complete;
  manifest.import_ready = completion.complete;
  manifest.phase = completion.phase;
  manifest.current_source_type = null;
  manifest.current_batch_index = null;
  manifest.remaining_work = completion.remainingWork;
  manifest.stop_reason = completion.complete ? null : "Agent semantic checkpoints completed, but QA blockers remain.";
  manifest.blocking_issues = completion.blockingIssues;
  manifest.semantic_audit = semanticAudit;
  manifest.provenance = LEXICAL_CURRENT_AGENT_PROVENANCE;
  manifest.agent_progress = { stage: "finalize", completed_batches: stageCounts, pending_batches: 0, active_batch_id: null };
  manifest.corpus_counts = { ...(manifest.corpus_counts as object), qa: qaSummary };
  manifest.updated_at = new Date().toISOString();
  await writeJson(paths.manifest, manifest);
  return { completion, qaSummary };
}
