import { createHash } from "node:crypto";
import { CEFR_LEVELS, IRREGULAR_FORM_TYPES, VOCABULARY_POS, normalizeVocabularySpelling,
  type ReviewedVocabulary } from "./model.ts";
import { exactKeys } from "./input.ts";

export const REVIEWED_SOURCE_SHA256 = "09480ce1a52a79906082df9cd0503396c4b334850587f8c95e8629ce63eb38c6";
const text = (value: unknown, max = 10000): value is string => typeof value === "string"
  && value.trim().length > 0 && value.length <= max && !value.includes("\0");
const spelling = (value: unknown): value is string => text(value, 200)
  && /^[A-Za-z]+(?:[-' ][A-Za-z]+)*$/.test(value);
export function validateReviewedRows(value: unknown): ReviewedVocabulary[] {
  if (!Array.isArray(value) || !value.length || value.length > 100000) throw new Error("Expected non-empty vocabulary array");
  const seen = new Set<string>();
  for (const [index, row] of Array.from(value.entries())) {
    const fail = (): never => { throw new Error(`Invalid vocabulary row ${index + 1}`); };
    if (!exactKeys(row, ["word", "list_id", "cefr", "senses", "irregular_forms"]) || !spelling(row.word)
      || typeof row.list_id !== "string" || !/^List (?:0[1-9]|[1-9]\d{1,5})$/.test(row.list_id)
      || !CEFR_LEVELS.includes(row.cefr as never) || !Array.isArray(row.senses) || !row.senses.length
      || row.senses.length > 100 || !Array.isArray(row.irregular_forms)) fail();
    // No trimming, POS remapping, content repair or old-file fallback.
    const key = normalizeVocabularySpelling(row.word);
    if (seen.has(key)) throw new Error(`Duplicate base form: ${row.word}`);
    seen.add(key);
    for (const sense of row.senses) {
      if (!exactKeys(sense, ["pos", "meaning_zh", "example_en"]) || !VOCABULARY_POS.includes(sense.pos as never)
        || !text(sense.meaning_zh) || !text(sense.example_en)) fail();
    }
    const forms = new Set<string>();
    for (const form of row.irregular_forms) {
      if (!exactKeys(form, ["form_type", "answers"]) || !IRREGULAR_FORM_TYPES.includes(form.form_type as never)
        || !Array.isArray(form.answers) || !form.answers.length || form.answers.length > 20
        || !form.answers.every(spelling) || new Set(form.answers).size !== form.answers.length
        || forms.has(form.form_type as string)) fail();
      forms.add(form.form_type as string);
    }
  }
  return value as ReviewedVocabulary[];
}
export function loadVocabularySource(bytes: Buffer, mode: "initial" | "append") {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (mode === "initial" && sha256 !== REVIEWED_SOURCE_SHA256) throw new Error("Initial import requires the exact CEFR-reviewed attachment (SHA-256 mismatch)");
  const rows = validateReviewedRows(JSON.parse(bytes.toString("utf8")));
  if (mode === "initial") {
    if (rows.length !== 1032 || rows.filter(row => row.irregular_forms.length).length !== 47) throw new Error("Initial counts mismatch");
    rows.forEach((row, index) => {
      if (row.list_id !== `List ${String(Math.floor(index / 50) + 1).padStart(2, "0")}`) throw new Error("Initial List/order mismatch");
    });
  }
  return { rows, sha256 };
}

// Generates SQL only; never connects to any database. Allocation is performed
// under a table lock at execution, not from a stale exported max-list number.
export function buildVocabularyImportSql(rows: ReviewedVocabulary[], sha256: string, mode: "initial" | "append") {
  validateReviewedRows(rows);
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid SHA-256");
  if (mode === "initial" && sha256 !== REVIEWED_SOURCE_SHA256) throw new Error("Unreviewed initial input");
  const literal = JSON.stringify(rows).replace(/'/g, "''");
  let tag = "$ctw_import$", suffix = 0;
  while (literal.includes(tag)) tag = `$ctw_import_${++suffix}$`;
  return `-- Generated CTW vocabulary ${mode} import; source SHA-256: ${sha256}
-- Run manually as postgres AFTER ctw_vocabulary_v1_migration.sql. Atomic; no legacy writes.
begin;
set local lock_timeout = '10s';
set local statement_timeout = '120s';
set local standard_conforming_strings = on;
lock table public.ctw_vocabulary_entries in share row exclusive mode;
do ${tag}
declare
  payload jsonb := '${literal}'::jsonb;
  item jsonb; n integer; slot integer; added integer := 0; skipped integer := 0;
begin
  if '${mode}' = 'initial' then
    if exists(select 1 from public.ctw_vocabulary_entries) then raise exception 'CTW_VOCAB_INITIAL_REQUIRES_EMPTY_TABLE'; end if;
    if jsonb_array_length(payload) <> 1032 then raise exception 'CTW_VOCAB_INITIAL_COUNT_MISMATCH'; end if;
    n := 1; slot := 0;
  else
    if not exists(select 1 from public.ctw_vocabulary_entries) then raise exception 'CTW_VOCAB_INITIAL_IMPORT_REQUIRED'; end if;
    if (select count(*) from public.ctw_vocabulary_entries where source_sha256 = '${REVIEWED_SOURCE_SHA256}') <> 1032 then
      raise exception 'CTW_VOCAB_REVIEWED_BASELINE_REQUIRED';
    end if;
    -- Refuse damaged/gapped historical List layouts instead of silently reordering them.
    if exists(select 1 from public.ctw_vocabulary_entries group by list_number
      having min(list_position) <> 1 or max(list_position) <> count(*)
        or (list_number < (select max(list_number) from public.ctw_vocabulary_entries) and count(*) <> 50))
      or (select min(list_number) <> 1 or max(list_number) <> count(distinct list_number) from public.ctw_vocabulary_entries) then
      raise exception 'CTW_VOCAB_LIST_LAYOUT_INVALID';
    end if;
    select list_number, list_position into n, slot from public.ctw_vocabulary_entries
      order by list_number desc, list_position desc limit 1;
  end if;
  for item in select value from jsonb_array_elements(payload) loop
    if exists(select 1 from public.ctw_vocabulary_entries where normalized_word = lower(item->>'word')) then
      skipped := skipped + 1; continue; -- Never update reviewed or historical content.
    end if;
    if slot = 50 then n := n + 1; slot := 0; end if;
    slot := slot + 1;
    if '${mode}' = 'initial' and item->>'list_id' <> ('List ' || lpad(n::text,2,'0')) then
      raise exception 'CTW_VOCAB_INITIAL_LIST_MISMATCH';
    end if;
    insert into public.ctw_vocabulary_entries(word,list_number,list_position,cefr,senses,irregular_forms,source_sha256)
      values(item->>'word',n,slot,item->>'cefr',item->'senses',item->'irregular_forms','${sha256}');
    added := added + 1;
  end loop;
  raise notice 'CTW vocabulary: added %, skipped existing %', added, skipped;
end;
${tag};
commit;
`;
}
