// Formal immutable approved493 dataset checks. No draft, export or simulation dependency.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const file = 'data/wordbook-review/fixed-pool-v2.full-review.json';
const text = fs.readFileSync(file, 'utf8'), pool = JSON.parse(text);
const manifest = JSON.parse(fs.readFileSync('data/wordbook-review/fixed-pool-v2.install-manifest.json', 'utf8'));

test('approved493 hash locks the exact original90, unchanged123 and new280; rejected492 is not an installation input', () => {
  assert.equal(manifest.dataset, file);
  assert.equal(manifest.total, 493);
  assert.equal(crypto.createHash('sha256').update(text).digest('hex'), manifest.approvedDatasetSha256);
  assert.equal(manifest.approvedDatasetSha256, 'b94b9fd17d02d8a7b91125eba803a1f3181b9d86b26401f512ca09f4aa14b352');
  assert.equal(pool.length, 493);
  assert.equal(pool.filter(r => r.origin === 'new-academic-expansion').length, 280);
  const original90 = pool.filter(r => r.original_sample_id);
  assert.equal(original90.length, 90);
  assert.ok(original90.every(r => r.approval_status === 'USER_APPROVED_90'));
  assert.equal(new Set(original90.map(r => r.original_sample_id)).size, 90);
  const carried = pool.filter(r => r.origin === 'carried-forward-v1');
  assert.equal(carried.length, 123);
  assert.ok(carried.every(r => ['adverb', 'preposition', 'conjunction', 'pronoun'].includes(r.pos)));
  assert.deepEqual(Object.fromEntries(Object.keys(manifest.byPos).map(pos =>
    [pos, pool.filter(r => r.pos === pos).length])),
  { noun: 150, verb: 120, adjective: 100, adverb: 60, preposition: 27, conjunction: 16, pronoun: 20 });
});

test('complete pool preserves source provenance and academic breadth with unique standalone same-POS words/meanings', () => {
  assert.equal(new Set(pool.map(r => r.pool_id)).size, 493);
  assert.equal(new Set(pool.map(r => r.pos + '|' + r.meaning)).size, 493);
  assert.equal(new Set(pool.map(r => r.pos + '|' + r.english.toLowerCase())).size, 493);
  for (const r of pool) {
    assert.match(r.meaning, /^[一-龥]{1,12}$/);
    assert.match(r.english, /^[A-Za-z]+$/);
    assert.doesNotMatch(r.raw_pos, /proper/i);
    assert.ok(r.definition_en && r.canonical_entry_id && r.occurrence_id && r.source_type && r.source_item_id && r.content_block_id);
  }
  const content = pool.filter(r => ['noun', 'verb', 'adjective'].includes(r.pos));
  assert.equal(content.length, 370);
  assert.equal(content.filter(r => r.lexical_category === '通用学术').length, 207);
  const specialist = content.filter(r => r.lexical_category === '学科专业');
  assert.equal(specialist.length, 163);
  assert.equal(new Set(specialist.map(r => r.subject)).size, 9);
  for (const subject of new Set(specialist.map(r => r.subject))) {
    assert.ok(specialist.filter(r => r.subject === subject).length / specialist.length < 0.2);
  }
});
