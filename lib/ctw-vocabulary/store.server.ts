import type { SupabaseClient } from "@supabase/supabase-js";
import { CEFR_LEVELS, gradeVocabularySpelling, vocabularyAcceptedAnswers,
  type AttemptResult, type AttemptSubmission, type AttemptSummary, type GradedAnswer,
  type VocabularyCatalog, type VocabularyEntry } from "./model.ts";
import type { WordQuery } from "./input.ts";
import type { ListSource, VocabularyListCard } from "./model.ts";

export const WORD_COLUMNS = "entry_id,word,list_number,list_position,cefr,senses,irregular_forms,source_sha256";
export const SUMMARY_COLUMNS = "attempt_id,mode,submitted_at,answer_count,correct_count,list_numbers,cefr_levels";
const RESULT_COLUMNS = `${SUMMARY_COLUMNS},answers`;
export class VocabularyStoreError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export function databaseError(error: { code?: string; message?: string } | null) {
  if (!error) return;
  if (["42P01", "42883", "PGRST202", "PGRST205"].includes(error.code ?? ""))
    throw new VocabularyStoreError("CTW_VOCAB_UNAVAILABLE");
  if (error.message?.includes("CTW_VOCAB_LIST_NOT_FOUND")) throw new VocabularyStoreError("CTW_VOCAB_LIST_NOT_FOUND");
  if (error.message?.includes("CTW_VOCAB_INVALID_LIST_RESULT")) throw new VocabularyStoreError("CTW_VOCAB_INVALID_LIST_RESULT");
  const reviewCode = error.message?.match(/CTW_REVIEW_[A-Z_]+/)?.[0];
  if (reviewCode) throw new VocabularyStoreError(reviewCode);
  throw new VocabularyStoreError("CTW_VOCAB_DATABASE_ERROR");
}
export async function readVocabularyCatalog(client: SupabaseClient): Promise<VocabularyCatalog> {
  const { data, error } = await client.rpc("read_ctw_vocabulary_catalog_v1");
  databaseError(error);
  if (!data) throw new VocabularyStoreError("CTW_VOCAB_UNAVAILABLE");
  return data as VocabularyCatalog;
}
export async function readVocabularyWords(client: SupabaseClient, query: WordQuery) {
  let read = client.from("ctw_vocabulary_entries").select(WORD_COLUMNS)
    .order("list_number").order("list_position");
  if (query.list !== null) read = read.eq("list_number", query.list);
  if (query.cefr !== null) read = read.eq("cefr", query.cefr);
  const offset = (query.page - 1) * query.pageSize;
  const { data, error } = await read.range(offset, offset + query.pageSize);
  databaseError(error);
  return { items: (data ?? []).slice(0, query.pageSize) as VocabularyEntry[], page: query.page,
    pageSize: query.pageSize, hasMore: (data ?? []).length > query.pageSize };
}
export async function readVocabularyLists(client: SupabaseClient, edition: "mixed" | "cefr"): Promise<{ lists: VocabularyListCard[] }> {
  const { data, error } = await client.rpc("read_ctw_vocabulary_lists_v1", { p_edition: edition });
  databaseError(error);
  if (!data) throw new VocabularyStoreError("CTW_VOCAB_UNAVAILABLE");
  return data;
}
export async function startVocabularyList(client: SupabaseClient, source: ListSource): Promise<{ items: VocabularyEntry[] }> {
  const { data, error } = await client.rpc("start_ctw_vocabulary_list_v1", {
    p_edition: source.kind === "list" ? "mixed" : "cefr", p_group: source.kind === "list" ? "" : source.group, p_list: source.listNumber
  });
  databaseError(error);
  if (!data) throw new VocabularyStoreError("CTW_VOCAB_UNAVAILABLE");
  return data;
}
export async function readVocabularyHistory(client: SupabaseClient, studentId: string, query: { page: number; pageSize: number }) {
  const offset = (query.page - 1) * query.pageSize;
  const { data, error } = await client.from("student_ctw_vocabulary_attempts").select(SUMMARY_COLUMNS)
    .eq("student_id", studentId).order("submitted_at", { ascending: false }).order("attempt_id", { ascending: false })
    .range(offset, offset + query.pageSize);
  databaseError(error);
  return { items: (data ?? []).slice(0, query.pageSize) as AttemptSummary[], page: query.page,
    pageSize: query.pageSize, hasMore: (data ?? []).length > query.pageSize };
}
export async function readVocabularyResult(client: SupabaseClient, studentId: string, attemptId: string): Promise<AttemptResult> {
  const { data, error } = await client.from("student_ctw_vocabulary_attempts").select(RESULT_COLUMNS)
    .eq("student_id", studentId).eq("attempt_id", attemptId).maybeSingle();
  databaseError(error);
  if (!data) throw new VocabularyStoreError("CTW_VOCAB_RESULT_NOT_FOUND");
  return data as AttemptResult;
}

export function gradeVocabularyBatch(entries: VocabularyEntry[], submission: AttemptSubmission): GradedAnswer[] {
  const byId = new Map(entries.map(entry => [entry.entry_id, entry]));
  return submission.answers.map((answer, index) => {
    const entry = byId.get(answer.entryId);
    if (!entry) throw new VocabularyStoreError("CTW_VOCAB_ENTRY_NOT_FOUND");
    try {
      const baseCorrect = gradeVocabularySpelling(entry, submission.mode, answer.spelling, answer.formType);
      const forms = answer.irregularSpellings;
      if (forms !== undefined && (forms.length !== entry.irregular_forms.length
        || entry.irregular_forms.some(form => !forms.some(a => a.formType === form.form_type))))
        throw new Error("Incomplete forms");
      if (submission.source?.kind === "list" && submission.source.listNumber !== entry.list_number
        || submission.source?.kind === "cefr" && !submission.source.levels.includes(entry.cefr)
        || submission.source?.kind === "cefr_list" && submission.source.group !== (entry.cefr === "C1" || entry.cefr === "C2" ? "C1-C2" : entry.cefr)) throw new Error("Invalid source");
      const irregularResults = forms?.map(form => ({ ...form,
        acceptedAnswers: vocabularyAcceptedAnswers(entry, "irregular", form.formType),
        correct: gradeVocabularySpelling(entry, "irregular", form.spelling, form.formType) }));
      return { ...answer, word: entry.word, listNumber: entry.list_number, listPosition: entry.list_position,
        cefr: entry.cefr, senses: entry.senses, sourceSha256: entry.source_sha256,
        acceptedAnswers: vocabularyAcceptedAnswers(entry, submission.mode, answer.formType),
        correct: baseCorrect && (irregularResults?.every(form => form.correct) ?? true),
        ...(irregularResults ? { baseCorrect, irregularResults } : {}),
        ...(index === 0 && submission.source ? { source: submission.source } : {}) };
    } catch { throw new VocabularyStoreError("CTW_VOCAB_INVALID_FORM_TYPE"); }
  });
}

type StoredAttempt = AttemptResult & { request_answers: AttemptSubmission["answers"] };
function acceptRetry(stored: StoredAttempt, submission: AttemptSubmission): AttemptResult {
  const canonical = (answers: AttemptSubmission["answers"]) => answers.map(answer =>
    [answer.entryId, answer.spelling, answer.formType ?? null, answer.irregularSpellings ?? null]);
  if (stored.mode !== submission.mode || JSON.stringify(canonical(stored.request_answers)) !== JSON.stringify(canonical(submission.answers)))
    throw new VocabularyStoreError("CTW_VOCAB_ATTEMPT_CONFLICT");
  if (JSON.stringify(stored.answers[0]?.source) !== JSON.stringify(submission.source))
    throw new VocabularyStoreError("CTW_VOCAB_ATTEMPT_CONFLICT");
  const { request_answers: _request, ...result } = stored;
  return result;
}
/** Called only AFTER authentication and strict request validation. Service key
 * stays server-side. One entry batch read + one atomic INSERT per completed round.
 * No word-level RPCs, no database grading, no POS choice, no student-supplied score.
 */
export async function saveVocabularyAttempt(service: SupabaseClient, studentId: string, submission: AttemptSubmission): Promise<AttemptResult> {
  const existing = () => service.from("student_ctw_vocabulary_attempts").select(`${RESULT_COLUMNS},request_answers`)
    .eq("student_id", studentId).eq("attempt_id", submission.attemptId).maybeSingle();
  const previous = await existing();
  databaseError(previous.error);
  if (previous.data) return acceptRetry(previous.data as StoredAttempt, submission);
  const ids = Array.from(new Set(submission.answers.map(answer => answer.entryId)));
  const { data: entries, error: readError } = await service.from("ctw_vocabulary_entries").select(WORD_COLUMNS).in("entry_id", ids);
  databaseError(readError);
  const answers = gradeVocabularyBatch((entries ?? []) as VocabularyEntry[], submission);
  const row = { student_id: studentId, attempt_id: submission.attemptId, mode: submission.mode,
    answer_count: answers.length, correct_count: answers.filter(answer => answer.correct).length,
    list_numbers: Array.from(new Set(answers.map(answer => answer.listNumber))).sort((a,b) => a-b),
    cefr_levels: CEFR_LEVELS.filter(level => answers.some(answer => answer.cefr === level)),
    request_answers: submission.answers, answers };
  const { data, error } = await service.from("student_ctw_vocabulary_attempts").insert(row).select(RESULT_COLUMNS).single();
  if (error?.code === "23505") {
    // Concurrent retry loses the insert race: return the same immutable result,
    // or report a conflict if that id was reused with different raw answers.
    const retry = await existing(); databaseError(retry.error);
    if (retry.data) return acceptRetry(retry.data as StoredAttempt, submission);
  }
  databaseError(error);
  if (!data) throw new VocabularyStoreError("CTW_VOCAB_DATABASE_ERROR");
  return data as AttemptResult;
}
