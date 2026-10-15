import type { SupabaseClient } from "@supabase/supabase-js";
import { isDeepStrictEqual } from "node:util";
import type { ReviewCommand, ReviewHistory, ReviewRound } from "../lexical/wordbookReview.ts";
import { applyReviewAction, localReview, type LocalReview } from "../lexical/wordbookReviewLocal.ts";
import { CEFR_LEVELS, type ListSource, type VocabularyEntry } from "./model.ts";
import { exactKeys, parseListSource, UUID_PATTERN, VocabularyInputError } from "./input.ts";
import { databaseError, readVocabularyResult, VocabularyStoreError, WORD_COLUMNS } from "./store.server.ts";
import { createCtwReviewRound, ctwHistorySession, ctwMetadata, ctwRawAnswers, ctwSavedAnswers, legacyCtwReviewRound, projectCtwRound } from "./review.ts";

export type CtwReviewRow = { student_id: string; session_id: string; source: ListSource; state: LocalReview;
  revision: number; receipts: Record<string, ReviewCommand>; parent_session_id: string | null; phase: string };
const TABLE = "student_ctw_vocabulary_review_sessions";
export function parseCtwReviewStart(value: unknown) {
  if (!exactKeys(value, ["requestId", "source"], ["parent"]) || typeof value.requestId !== "string" || !UUID_PATTERN.test(value.requestId)
    || value.parent !== undefined && (typeof value.parent !== "string" || !UUID_PATTERN.test(value.parent))) throw new VocabularyInputError();
  return { requestId: value.requestId.toLowerCase(), source: parseListSource(value.source), ...(value.parent ? { parent: String(value.parent).toLowerCase() } : {}) };
}
export function parseCtwReviewCommand(value: unknown): ReviewCommand {
  if (!exactKeys(value, ["id", "action", "itemId"], ["answer"]) || typeof value.id !== "string" || !UUID_PATTERN.test(value.id)
    || typeof value.itemId !== "string" || !UUID_PATTERN.test(value.itemId)
    || !["study_next", "repeat", "start_test", "answer", "advance"].includes(String(value.action))) throw new VocabularyInputError();
  if (value.action === "answer") {
    if (!exactKeys(value.answer, ["spellings"]) || !value.answer.spellings || typeof value.answer.spellings !== "object" || Array.isArray(value.answer.spellings)
      || Object.keys(value.answer.spellings).length > 12 || Object.values(value.answer.spellings).some(s => typeof s !== "string" || s.length > 200 || s.includes("\0"))) throw new VocabularyInputError();
  } else if (value.answer !== undefined) throw new VocabularyInputError();
  return value as ReviewCommand;
}
async function row(client: SupabaseClient, owner: string, id: string): Promise<CtwReviewRow | null> {
  const { data, error } = await client.from(TABLE).select("*").eq("student_id", owner).eq("session_id", id).maybeSingle();
  databaseError(error); return data;
}
export async function readCtwReview(client: SupabaseClient, owner: string, id: string): Promise<ReviewRound> {
  const stored = await row(client, owner, id);
  if (stored) return projectCtwRound(stored.state);
  return legacyCtwReviewRound(await readVocabularyResult(client, owner, id));
}
async function listEntries(client: SupabaseClient, source: ListSource): Promise<VocabularyEntry[]> {
  if (source.kind === "list") {
    const { data, error } = await client.from("ctw_vocabulary_entries").select(WORD_COLUMNS).eq("list_number", source.listNumber).order("list_position").limit(50);
    databaseError(error); return data ?? [];
  }
  const { data: members, error } = await client.from("ctw_vocabulary_cefr_memberships").select("entry_id,list_position")
    .eq("cefr_group", source.group).eq("list_number", source.listNumber).order("list_position").limit(50);
  databaseError(error); if (!members?.length) return [];
  const { data, error: wordError } = await client.from("ctw_vocabulary_entries").select(WORD_COLUMNS).in("entry_id", members.map(m => m.entry_id));
  databaseError(wordError); const byId = new Map((data as VocabularyEntry[] ?? []).map(e => [e.entry_id, e]));
  return members.map(m => byId.get(m.entry_id)!).filter(Boolean);
}
export async function createCtwReview(client: SupabaseClient, service: SupabaseClient, owner: string, input: ReturnType<typeof parseCtwReviewStart>) {
  const previous = await row(client, owner, input.requestId);
  if (previous) {
    if (!isDeepStrictEqual(previous.source, input.source) || (previous.parent_session_id ?? undefined) !== input.parent) throw new VocabularyStoreError("CTW_REVIEW_CONFLICT");
    return projectCtwRound(previous.state);
  }
  // A v1 client may have saved the final batch but lost its ACK. Preserve that
  // immutable attempt rather than manufacturing a second session/result.
  try {
    const legacy = legacyCtwReviewRound(await readVocabularyResult(client, owner, input.requestId));
    if (input.parent || !isDeepStrictEqual(ctwMetadata(legacy).source, input.source)) throw new VocabularyStoreError("CTW_REVIEW_CONFLICT");
    return legacy;
  } catch (error) {
    if (!(error instanceof VocabularyStoreError) || error.code !== "CTW_VOCAB_RESULT_NOT_FOUND") throw error;
  }
  let entries: VocabularyEntry[];
  if (input.parent) {
    const parent = await readCtwReview(client, owner, input.parent);
    if (parent.session.status !== "completed" || !isDeepStrictEqual(ctwMetadata(parent).source, input.source)) throw new VocabularyStoreError("CTW_REVIEW_INVALID_PARENT");
    const wrongIds = parent.cards.filter(card => card.answer?.correct === false).map(card => card.itemId);
    if (!wrongIds.length) throw new VocabularyStoreError("CTW_REVIEW_INVALID_PARENT");
    // A retry is a NEW round: retain the old result unchanged, but teach/test
    // today's database standard, not a historical alternative-only answer set.
    const { data, error } = await client.from("ctw_vocabulary_entries").select(WORD_COLUMNS).in("entry_id", wrongIds);
    databaseError(error); const byId = new Map((data as VocabularyEntry[] ?? []).map(entry => [entry.entry_id, entry]));
    if (byId.size !== wrongIds.length) throw new VocabularyStoreError("CTW_VOCAB_ENTRY_NOT_FOUND");
    entries = wrongIds.map(id => byId.get(id)!);
  } else entries = await listEntries(client, input.source);
  if (!entries.length) throw new VocabularyStoreError("CTW_VOCAB_LIST_NOT_FOUND");
  const round = createCtwReviewRound(input.requestId, input.source, entries, input.parent);
  const { data, error } = await service.rpc("create_ctw_vocabulary_review_v1", {
    p_student: owner, p_session: input.requestId, p_source: input.source, p_state: localReview(owner, round), p_parent: input.parent ?? null
  });
  databaseError(error); if (!data) throw new VocabularyStoreError("CTW_VOCAB_DATABASE_ERROR");
  return projectCtwRound((data as CtwReviewRow).state);
}
export async function syncCtwReview(service: SupabaseClient, owner: string, id: string, command: ReviewCommand) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const stored = await row(service, owner, id);
    if (!stored) throw new VocabularyStoreError("CTW_REVIEW_NOT_FOUND");
    if (stored.receipts[command.id]) {
      if (!isDeepStrictEqual(stored.receipts[command.id], command)) throw new VocabularyStoreError("CTW_REVIEW_CONFLICT");
      return { acknowledged: command.id };
    }
    const card = stored.state.round.cards[stored.state.position - 1];
    if (command.action === "answer") {
      const actual = Object.keys(command.answer?.spellings ?? {}).sort();
      if (JSON.stringify(actual) !== JSON.stringify((card.spellingGroups ?? []).map(g => g.id).sort())) throw new VocabularyInputError();
    }
    // The browser owns the shared 1-second feedback deadline; delayed queued
    // commands must not start a second timer on the server.
    const next = applyReviewAction(stored.state, command, Number.MAX_SAFE_INTEGER - 2000);
    if (next === stored.state) throw new VocabularyStoreError("CTW_REVIEW_CONFLICT");
    next.queue = []; next.deadlines = {}; next.confirmed = Object.keys(next.answers).length;
    let finalRecord: unknown = null;
    if (next.phase === "result") {
      const requestAnswers = ctwRawAnswers(next), answers = ctwSavedAnswers(next);
      finalRecord = { request_answers: requestAnswers, answers,
        list_numbers: Array.from(new Set(answers.map(a => a.listNumber))).sort((a, b) => a - b),
        cefr_levels: CEFR_LEVELS.filter(level => answers.some(a => a.cefr === level)) };
    }
    const { data, error } = await service.rpc("sync_ctw_vocabulary_review_v1", {
      p_student: owner, p_session: id, p_revision: stored.revision, p_command: command, p_state: next, p_attempt: finalRecord
    });
    if (error?.message?.includes("CTW_REVIEW_REVISION")) continue;
    databaseError(error); return data as { acknowledged: string };
  }
  throw new VocabularyStoreError("CTW_REVIEW_CONFLICT");
}
export async function readCtwReviewHistory(client: SupabaseClient, page: number): Promise<ReviewHistory> {
  const { data, error } = await client.rpc("read_ctw_vocabulary_review_history_v1", { p_page: page, p_size: 10 });
  databaseError(error);
  return { ...data, items: (data.items as { session_id: string; source: ListSource; started_at: string; parent_session_id: string | null;
    status: "active" | "completed"; total: number; answered: number; correct: number }[]).map(item => ctwHistorySession({ ...item,
      summary: { correct: item.correct, incorrect: item.answered - item.correct, spellingCorrect: item.correct, spellingTotal: item.answered,
        posCorrect: 0, posTotal: 0, choiceCorrect: 0, choiceTotal: 0 } })) };
}
