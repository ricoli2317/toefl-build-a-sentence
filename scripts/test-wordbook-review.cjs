// Reproducible isolated SQL + UI-contract tests. No env file, browser or network.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const pglite = require.resolve('@electric-sql/pglite');
const files = [
  'tests/studentWordbookReview.test.js',
  'tests/studentWordbookReviewImmersive.test.cjs',
  'tests/studentWordbookReviewTiming.test.cjs',
  'tests/studentWordbookReviewTimeout.test.js',
  'tests/studentWordbookReviewPos7.test.js',
  'tests/studentWordbookReviewOccurrenceChoice.test.cjs',
  'tests/studentWordbookReviewLocalPosChoice.test.cjs',
  'tests/studentWordbookReviewAsciiDistractor.test.cjs',
  'tests/studentWordbookReviewFixedPool.test.cjs',
  'tests/studentWordbookReviewChoicePreference.test.cjs',
  'tests/studentWordbookReviewFixedPoolV2Install.test.cjs',
  'tests/wordbookFullPoolReview.test.cjs',
  'tests/wordbookReviewDelivery.test.cjs',
  'tests/studentWordbookContextSave.test.cjs',
  // Existing collection behavior under the source-evidence save upgrade.
  'tests/studentWordbookA2.test.js',
  // Shared calendar/history, wordbook management and Teacher lookup stay intact.
  'tests/studentWordbookA3.test.js',
  'tests/studentWordbookManagement.test.js',
  'tests/studentWordbookUiBugfix.test.js',
  'tests/teacherLexicalLookup.test.js',
  'tests/studentPracticeHistory.test.js'
];
const result = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
  '--experimental-strip-types', '--test', '--test-concurrency=1', ...files], {
  cwd: root, stdio: 'inherit', env: { ...process.env, WORDBOOK_SQL_TEST_PGLITE: pglite,
    WORDBOOK_SQL_TEST_A3: '1', WORDBOOK_SQL_TEST_BUGFIX: '1', WORDBOOK_SQL_TEST_REVIEW: '1' }
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
