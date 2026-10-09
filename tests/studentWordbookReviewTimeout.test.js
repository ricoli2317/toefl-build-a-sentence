const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewRpc } = require('../lib/lexical/wordbookReview.server.ts');

test('production statement timeout has a public timeout error, not installation advice or private diagnostics, and never auto-retries', async () => {
  let calls = 0;
  const args = { p_student: 'offline-student', p_settings: { domain: 'reading' } };
  const db = { rpc: async (name, passed) => {
    calls++;
    assert.equal(name, 'wordbook_review_availability');
    assert.equal(passed, args);
    return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout: private detail' } };
  } };
  await assert.rejects(reviewRpc(db, 'wordbook_review_availability', args), e => {
    assert.equal(e.code, 'REVIEW_TIMEOUT');
    assert.equal(e.status, 503);
    assert.match(e.message, /超时/);
    assert.doesNotMatch(e.message, /安装|private detail|57014/);
    return true;
  });
  assert.equal(calls, 1);
});
