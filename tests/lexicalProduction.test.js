const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildProductionDataset, validateProductionDataset, productionImportSql, productionId, occurrenceIdentity,
  ENTRY_COLUMNS, OCCURRENCE_COLUMNS, BLOCK_COLUMNS } = require('../lib/lexical/production.ts');
const { canonicalSourceTextHash } = require('../lib/lexical/hash.ts');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// Small OFFLINE contract fixture, not the production corpus. Release checks must
// neither depend on ignored tmp artifacts nor recreate/validate the 149k rows.
function fixture() {
  const text = 'It 😀 is green.';
  const entries = [
    { entry_key: 'word:it:pronoun', canonical_expression: 'it', normalized_expression: 'it', expression_type: 'word', lemma: 'it', review_target_id: 'pronoun' },
    { entry_key: 'word:it:abbreviation', canonical_expression: 'IT', normalized_expression: 'it', expression_type: 'word', lemma: 'IT', review_target_id: 'abbreviation' },
    { entry_key: 'word:green', canonical_expression: 'green', normalized_expression: 'green', expression_type: 'word', lemma: 'green' }
  ].map(e => ({ ...e, common_senses: [], derived_words: [], useful_patterns: [], review_status: 'generated', generation_version: 'lexical-v1' }));
  const block = { source_type: 'rap', source_item_id: 'fixture-item', content_block_id: 'fixture-block',
    block_kind: 'paragraph', text, source_text_hash: canonicalSourceTextHash(text) };
  const mapping = (start, end, key) => {
    const row = { ...block, start_offset: start, end_offset: end, surface_text: text.slice(start, end),
      consolidated_entry_key: key, mapping_status: 'consolidated', context_pos: 'adjective',
      context_meaning_zh: '环保的', context_definition_en: 'Good for the environment.', review_status: 'generated', generation_version: 'lexical-v1' };
    return { ...row, source_occurrence_id: occurrenceIdentity(row) };
  };
  return { entries, mappings: [mapping(0, 2, entries[0].entry_key), mapping(9, 14, entries[2].entry_key)],
    blocks: [block], exclusions: [], removed: [] };
}
test('offline row contract preserves UTF-16 spans, mapped IDs, homographs and minimal transport columns', () => {
  const input = fixture(); const built = validateProductionDataset(input);
  assert.equal(built.entries.length, 3); assert.equal(built.occurrences.length, 2); assert.equal(built.sourceBlocks.length, 1);
  for (const [key, value] of Object.entries(built.qa)) if (!['entries', 'occurrences', 'source_blocks'].includes(key)) assert.equal(value, 0, key);
  const ids = new Set(built.entries.map(e => e.entry_id));
  assert.ok(built.occurrences.every(o => ids.has(o.entry_id)));
  assert.equal(built.occurrences[1].surface_text, 'green');
  assert.equal(new Set(built.entries.map(e => e.entry_id)).size, 3);
  assert.deepEqual(built.entries.slice(0, 2).map(e => [e.canonical_expression, e.lemma, e.identity_variant]),
    [['it', 'it', 'pronoun'], ['IT', 'IT', 'abbreviation']]);
  assert.deepEqual(Object.keys(built.entries[0]), ENTRY_COLUMNS);
  assert.deepEqual(Object.keys(built.occurrences[0]), OCCURRENCE_COLUMNS);
  assert.deepEqual(Object.keys(built.sourceBlocks[0]), BLOCK_COLUMNS);
  assert.equal(productionId('entry', input.entries[0].entry_key), built.entries[0].entry_id);
  assert.equal(productionId('entry', input.entries[0].entry_key), productionId('entry', input.entries[0].entry_key));
  assert.notEqual(productionId('entry', 'key'), productionId('block', 'key'));
});
test('production entrypoint keeps the frozen corpus count gate; fixtures cannot be published', () => {
  assert.throws(() => buildProductionDataset(fixture()), /Expected 13043 entries/);
  const source = read('lib/lexical/production.ts');
  for (const guard of ['input.entries.length === 13043', 'input.mappings.length === 149411',
    'input.exclusions.length === 1 && input.removed.length === 754']) assert.ok(source.includes(guard));
  assert.match(source, /const data = buildProductionDataset\(/);
});
test('structural validator rejects orphans, duplicate identities, invalid UTF-16, changed slices and excluded/removed spans', () => {
  const input = fixture(); const row = input.mappings[0];
  const replace = replacement => ({ ...input, mappings: [replacement, input.mappings[1]] });
  assert.throws(() => validateProductionDataset(replace({ ...row, consolidated_entry_key: 'missing' })), /Missing entry mapping/);
  assert.throws(() => validateProductionDataset(replace(input.mappings[1])), /Duplicate occurrence/);
  const offset = end_offset => ({ ...row, end_offset, source_occurrence_id: occurrenceIdentity({ ...row, end_offset }) });
  assert.throws(() => validateProductionDataset(replace(offset(999999))), /UTF-16/);
  assert.throws(() => validateProductionDataset(replace(offset(4))), /UTF-16/); // splits 😀
  assert.throws(() => validateProductionDataset(replace({ ...row, surface_text: 'changed' })), /slice mismatch/);
  assert.throws(() => validateProductionDataset({ ...input, exclusions: [{ source_occurrence_id: row.source_occurrence_id }] }), /Excluded invalid/);
  assert.throws(() => validateProductionDataset({ ...input, removed: [{ original_value: row }] }), /Removed MWE/);
  assert.throws(() => validateProductionDataset({ ...input, blocks: [] }), /Missing canonical block/);
  assert.throws(() => validateProductionDataset({ ...input, blocks: [input.blocks[0], input.blocks[0]] }), /Duplicate canonical block/);
  assert.throws(() => validateProductionDataset({ ...input, blocks: [{ ...input.blocks[0], source_text_hash: 'changed' }] }), /hash mismatch/);
  assert.throws(() => validateProductionDataset({ ...input, entries: [input.entries[0], ...input.entries] }), /Duplicate entry key/);
  assert.throws(() => validateProductionDataset({ ...input, entries: [...input.entries, { ...input.entries[0], entry_key: 'other-key' }] }), /Duplicate production entry identity/);
});
test('import SQL is a staged single transaction with exact mismatch rejection, safe rerun and FK order; never executed here', () => {
  const built = validateProductionDataset(fixture());
  const sql = productionImportSql(built, read('supabase/lexical_v1_production_identity.sql'));
  assert.match(sql, /ON_ERROR_STOP on\nBEGIN;/); assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /CREATE TEMP TABLE stage_lexical_entries/); assert.match(sql, /FROM STDIN WITH \(FORMAT csv\)/);
  assert.match(sql, /LOCK TABLE public.lexical_entries/); assert.match(sql, /Non-identical destination/);
  assert.match(sql, /Import mismatch/); assert.match(sql, /Final corpus count mismatch/);
  assert.equal((sql.match(/ON CONFLICT DO NOTHING/g) ?? []).length, 3);
  assert.ok(sql.indexOf('INSERT INTO public.lexical_entries') < sql.indexOf('INSERT INTO public.lexical_source_blocks'));
  assert.ok(sql.indexOf('INSERT INTO public.lexical_source_blocks') < sql.indexOf('INSERT INTO public.lexical_occurrences'));
  assert.match(sql, /COMMIT;\n$/); assert.doesNotMatch(sql, /TRUNCATE|DELETE FROM|UPDATE public\./);
  assert.doesNotMatch(sql, /CREATE.*POLICY|GRANT.*authenticated|GRANT.*anon/);
  const input = fixture(); input.mappings[0].context_definition_en = 'A "quoted", multiline\ndefinition.';
  assert.match(productionImportSql(validateProductionDataset(input), ''), /"A ""quoted"", multiline\ndefinition\."/);
});
test('importer/finalizer retain artifact hash gates, explicit write opt-in and rollback handling without pipeline dependencies', () => {
  const importer = read('scripts/lexical-production-import.ts');
  assert.match(importer, /createHash\("sha256"\).*artifact.sha256/);
  assert.ok(importer.indexOf('Publication artifact changed') < importer.indexOf('spawnSync("psql"'));
  assert.ok(importer.indexOf('if (!process.argv.includes("--write"))') < importer.indexOf('process.env.SUPABASE_DB_URL'));
  assert.match(importer, /transaction was rolled back/); assert.match(importer, /PGPASSWORD: decodeURIComponent\(parsed.password\)/);
  const finalizer = read('lib/lexical/production.ts');
  assert.match(finalizer, /Successor artifact changed/); assert.match(finalizer, /Frozen dependency changed/);
  assert.match(finalizer, /assertConsolidationCompletion\(summary, SUCCESSOR\)/);
  assert.doesNotMatch(finalizer, /from "\.\/workflowManifest|from "\.\/.*[Ee]nrichment/);
});
