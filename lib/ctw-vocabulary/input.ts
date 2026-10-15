import { CEFR_LEVELS, CEFR_GROUPS, IRREGULAR_FORM_TYPES, type AttemptSubmission, type Cefr, type SpellingMode, type RoundSource, type FormSpelling, type ListSource, type CefrGroup } from "./model.ts";

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class VocabularyInputError extends Error {
  constructor() { super("CTW_VOCAB_INVALID_INPUT"); }
}
export function exactKeys(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
export function parseAttemptSubmission(value: unknown): AttemptSubmission {
  if (!exactKeys(value, ["attemptId", "mode", "answers"], ["source"]) || typeof value.attemptId !== "string"
    || !UUID_PATTERN.test(value.attemptId) || !["base_form", "irregular"].includes(String(value.mode))
    || !Array.isArray(value.answers) || value.answers.length < 1 || value.answers.length > 200) {
    throw new VocabularyInputError();
  }
  const mode = value.mode as SpellingMode, seen = new Set<string>();
  const answers = value.answers.map(item => {
    if (!exactKeys(item, ["entryId", "spelling"], mode === "irregular" ? ["formType"] : ["irregularSpellings"])
      || typeof item.entryId !== "string" || !UUID_PATTERN.test(item.entryId)
      || typeof item.spelling !== "string" || Array.from(item.spelling).length > 200
      || item.spelling.includes("\0")
      || (mode === "irregular" && !IRREGULAR_FORM_TYPES.includes(item.formType as never))) {
      throw new VocabularyInputError();
    }
    const key = `${item.entryId.toLowerCase()}:${item.formType ?? ""}`;
    if (seen.has(key)) throw new VocabularyInputError();
    seen.add(key);
    const irregularSpellings = item.irregularSpellings === undefined ? undefined : parseFormSpellings(item.irregularSpellings);
    return { entryId: item.entryId.toLowerCase(), spelling: item.spelling,
      ...(irregularSpellings === undefined ? {} : { irregularSpellings }),
      ...(mode === "irregular" ? { formType: item.formType as typeof IRREGULAR_FORM_TYPES[number] } : {}) };
  });
  const source = value.source === undefined ? undefined : parseRoundSource(value.source);
  if (source && (mode !== "base_form" || answers.some(a => a.irregularSpellings === undefined))) throw new VocabularyInputError();
  return { attemptId: value.attemptId.toLowerCase(), mode, answers, ...(source ? { source } : {}) };
}

function parseFormSpellings(value: unknown): FormSpelling[] {
  if (!Array.isArray(value) || value.length > IRREGULAR_FORM_TYPES.length) throw new VocabularyInputError();
  const seen = new Set<string>();
  return value.map(item => {
    if (!exactKeys(item, ["formType", "spelling"]) || !IRREGULAR_FORM_TYPES.includes(item.formType as never)
      || typeof item.spelling !== "string" || Array.from(item.spelling).length > 200 || item.spelling.includes("\0")
      || seen.has(String(item.formType))) throw new VocabularyInputError();
    seen.add(String(item.formType));
    return item as FormSpelling;
  });
}
export function parseRoundSource(value: unknown): RoundSource {
  if (exactKeys(value, ["kind", "group", "listNumber"]) && value.kind === "cefr_list"
    && CEFR_GROUPS.includes(value.group as CefrGroup) && Number.isInteger(value.listNumber)
    && Number(value.listNumber) > 0 && Number(value.listNumber) <= 1000000)
    return { kind: "cefr_list", group: value.group as CefrGroup, listNumber: Number(value.listNumber) };
  if (exactKeys(value, ["kind", "listNumber"]) && value.kind === "list"
    && Number.isInteger(value.listNumber) && Number(value.listNumber) >= 1 && Number(value.listNumber) <= 1000000)
    return { kind: "list", listNumber: Number(value.listNumber) };
  if (exactKeys(value, ["kind", "levels"]) && value.kind === "cefr" && Array.isArray(value.levels)
    && value.levels.length > 0 && value.levels.length <= 6 && new Set(value.levels).size === value.levels.length
    && value.levels.every(level => CEFR_LEVELS.includes(level)))
    return { kind: "cefr", levels: CEFR_LEVELS.filter(level => (value.levels as unknown[]).includes(level)) };
  throw new VocabularyInputError();
}
export function parseListSource(value: unknown): ListSource {
  const source = parseRoundSource(value);
  if (source.kind === "cefr") throw new VocabularyInputError();
  return source;
}
export function parseListEdition(params: URLSearchParams) {
  queryKeys(params, ["edition"]);
  const edition = params.get("edition") ?? "mixed";
  if (edition !== "mixed" && edition !== "cefr") throw new VocabularyInputError();
  return edition;
}

function queryKeys(params: URLSearchParams, allowed: string[]) {
  params.forEach((_, key) => {
    if (!allowed.includes(key) || params.getAll(key).length !== 1) throw new VocabularyInputError();
  });
}
function integer(value: string | null, fallback: number, max: number) {
  if (value === null) return fallback;
  if (!/^[1-9]\d*$/.test(value) || Number(value) > max) throw new VocabularyInputError();
  return Number(value);
}
export type WordQuery = { list: number | null; cefr: Cefr | null; page: number; pageSize: number };
export function parseWordQuery(params: URLSearchParams): WordQuery {
  queryKeys(params, ["list", "cefr", "page", "pageSize"]);
  const cefr = params.get("cefr");
  if (cefr !== null && !CEFR_LEVELS.includes(cefr as Cefr)) throw new VocabularyInputError();
  return { list: params.has("list") ? integer(params.get("list"), 1, 1000000) : null,
    cefr: cefr as Cefr | null, page: integer(params.get("page"), 1, 10000),
    pageSize: integer(params.get("pageSize"), 50, 50) };
}
export function parseHistoryQuery(params: URLSearchParams) {
  queryKeys(params, ["page", "pageSize"]);
  return { page: integer(params.get("page"), 1, 10000), pageSize: integer(params.get("pageSize"), 20, 50) };
}
export function parseEmptyQuery(params: URLSearchParams) { queryKeys(params, []); }
