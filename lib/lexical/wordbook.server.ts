import type { SupabaseClient } from "@supabase/supabase-js";
import type { LexicalLookupRequest, LexicalLookupResult } from "./lookup.ts";
import { authorizeLexicalSource, lookupAuthorizedSelection, type LexicalPageReaders } from "./lookup.server.ts";
import { canonicalSourceTextHash } from "./hash.ts";
import { extractWordbookContext, verifyWordbookOccurrence, WordbookError } from "./wordbookContext.ts";

export const wordbookDomain = (source: string): "reading" | "writing" => {
  if (["ctw", "rdl", "rap"].includes(source)) return "reading";
  if (["bas", "write_email", "academic_discussion"].includes(source)) return "writing";
  throw new WordbookError("INVALID_SOURCE", 400);
};
export async function readWordbookStatus(db: SupabaseClient, studentId: string, source: string, entryId: string) {
  const domain = wordbookDomain(source);
  const { data, error } = await db.from("student_wordbook_canonical_links").select("wordbook_entry_id")
    .eq("student_id", studentId).eq("domain", domain).eq("lexical_entry_id", entryId).maybeSingle();
  if (error) throw new Error("Wordbook status query failed");
  return { saved: Boolean(data), domain, available: true, wordbookEntryId: data?.wordbook_entry_id ?? null };
}
export async function addWordbookStatus(db: SupabaseClient, studentId: string, result: LexicalLookupResult) {
  if (result.status !== "matched") return result;
  try { return { ...result, wordbook: await readWordbookStatus(db, studentId, result.occurrence.source_type, result.entry.entry_id) }; }
  catch { return { ...result, wordbook: { available: false } }; } // Never break lookup when wordbook is unavailable.
}

export async function operateWordbook(db: SupabaseClient, client: SupabaseClient, studentId: string,
  selection: LexicalLookupRequest, entryId: string, occurrenceId: string, action: "save" | "remove" | "status", readers: LexicalPageReaders) {
  const source = await authorizeLexicalSource(client, db, studentId, selection, readers);
  const match = await lookupAuthorizedSelection(db, selection, source);
  if (match.status !== "matched") throw new WordbookError("LOOKUP_STALE");
  // Only the actual primary/containing result for this authorized selection is legal.
  const target = [match, ...(match.containingPhrases ?? [])].find(p => p.entry.entry_id === entryId && p.occurrence.occurrence_id === occurrenceId);
  if (!target) throw new WordbookError("LOOKUP_IDENTITY_MISMATCH", 403);
  if (action === "status") return readWordbookStatus(db, studentId, selection.sourceType, entryId);
  const [{ data: occurrence, error: occurrenceError }, { data: block, error: blockError }] = await Promise.all([
    db.from("lexical_occurrences").select("occurrence_id,entry_id,source_type,source_item_id,content_block_id,start_offset,end_offset,surface_text,sentence_id,context_text,context_pos,context_meaning_zh,context_definition_en,review_status,lexical_entries!inner(entry_id,canonical_expression,normalized_expression,expression_type,identity_variant,review_status)")
      .eq("occurrence_id", occurrenceId).maybeSingle(),
    db.from("lexical_source_blocks").select("block_kind,source_text_hash,generation_status")
      .eq("source_type", selection.sourceType).eq("source_item_id", source.sourceItemId).eq("content_block_id", source.contentBlockId).maybeSingle()
  ]);
  if (occurrenceError || blockError) throw new Error("Wordbook canonical query failed");
  const o = occurrence as any; const e = o?.lexical_entries;
  if (!o || !e || !block || o.entry_id !== entryId || e.entry_id !== entryId || o.source_type !== selection.sourceType
    || o.source_item_id !== source.sourceItemId || o.content_block_id !== source.contentBlockId
    || o.review_status === "disabled" || e.review_status === "disabled" || block.generation_status !== "generated"
    || block.source_text_hash !== canonicalSourceTextHash(source.text) || o.context_text !== source.text
    || o.start_offset !== target.occurrence.start_offset || o.end_offset !== target.occurrence.end_offset
    || o.surface_text !== target.occurrence.surface_text || e.canonical_expression !== target.entry.canonical_expression
    || e.expression_type !== target.entry.expression_type || o.context_pos !== target.occurrence.context_pos
    || o.context_meaning_zh !== target.occurrence.context_meaning_zh || o.context_definition_en !== target.occurrence.context_definition_en)
    throw new WordbookError("CANONICAL_CONTEXT_STALE");
  verifyWordbookOccurrence(source.text, o);
  let context;
  if (action === "save") {
    let sentences;
    const paragraph = /^passage:([^:]+):paragraph:([^:]+)$/.exec(source.contentBlockId);
    if (selection.sourceType === "rap" && paragraph) {
      const { data, error } = await db.from("reading_passage_sentences").select("sentence_id,sentence_text")
        .eq("passage_id", paragraph[1]).eq("paragraph_id", paragraph[2]).order("sentence_order");
      if (error) throw new Error("Wordbook sentence query failed");
      sentences = data ?? [];
    }
    context = extractWordbookContext(source.text, block.block_kind, o, sentences);
  }
  // Reconstructed server-only payload. Client sense/example/enrichment/domain are never forwarded.
  const expected = {
    entry_id: entryId, source_type: o.source_type, source_item_id: o.source_item_id, content_block_id: o.content_block_id,
    start_offset: o.start_offset, end_offset: o.end_offset, surface_text: o.surface_text,
    context_text: o.context_text, sentence_id: o.sentence_id,
    context_pos: o.context_pos, context_meaning_zh: o.context_meaning_zh, context_definition_en: o.context_definition_en,
    canonical_expression: e.canonical_expression, normalized_expression: e.normalized_expression,
    expression_type: e.expression_type, identity_variant: e.identity_variant,
    source_text_hash: block.source_text_hash, source_block_kind: block.block_kind, ...context
  };
  const { data, error } = await db.rpc("operate_student_wordbook_v1", {
    p_student_id: studentId, p_occurrence_id: occurrenceId, p_action: action, p_expected: expected
  });
  if (error) {
    if (error.message?.includes("WORDBOOK_CANONICAL_STALE")) throw new WordbookError("CANONICAL_CONTEXT_STALE");
    if (error.message?.includes("WORDBOOK_STUDENT_REQUIRED")) throw new WordbookError("STUDENT_REQUIRED", 403);
    throw new WordbookError("WORDBOOK_UNAVAILABLE", 503, "生词本暂时不可用，本次操作未确认。请稍后重试。");
  }
  if (!data || typeof data.saved !== "boolean" || data.domain !== wordbookDomain(selection.sourceType))
    throw new WordbookError("WORDBOOK_UNAVAILABLE", 503, "操作结果未确认，请刷新查词卡后重试。");
  return { ...data, available: true };
}
