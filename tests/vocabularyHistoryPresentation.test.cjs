const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const ts = require('typescript'), React = require('react'), { renderToStaticMarkup: render } = require('react-dom/server');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
function compile(file, mocks) {
  const filename = path.join(__dirname, '..', file), previous = Module._load;
  Module._load = function(name, parent, main) { return Object.hasOwn(mocks, name) ? mocks[name] : previous.call(this, name, parent, main); };
  try {
    const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
    m._compile(ts.transpileModule(read(file), { fileName: filename, compilerOptions: {
      module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true
    } }).outputText, filename); return m.exports;
  } finally { Module._load = previous; }
}
const Link = ({ href, children, ...props }) => React.createElement('a', { ...props, href }, children);
const rows = compile('components/shared/PracticeHistoryRows.tsx', {
  '@/components/teacher/TeacherUI': compile('components/teacher/TeacherUI.tsx', { 'next/link': Link })
});
const review = require('../lib/lexical/wordbookReview.ts');
const shared = { 'next/link': Link, 'next/navigation': {}, '@/components/StudentDataCache': {},
  '@/components/shared/PracticeHistoryRows': rows, './StudentUI': {}, '@/lib/studentNavigation': {},
  '@/lib/lexical/wordbookReview': review, '@/lib/lexical/wordbookReviewLocal': {} };
const wordbook = compile('components/student/WordbookReview.tsx', { ...shared,
  './StudentWordbook': {}, '@/lib/cacheInvalidation': {}, './StudentDateSelection': {}, '@/lib/studentDates': {},
  './WordbookReviewWorkspace': {}, './useWordbookLocalReview': {}, '@/lib/lexical/wordbookReviewRequest': {}, './WordbookReviewSetup.module.css': {},
  './WordbookReviewHistory.module.css': { history: 'review-history', row: 'review-row', title: 'review-title', stats: 'review-stats', progress: 'review-progress', accuracy: 'review-accuracy', actions: 'review-actions' } });
const session = (id, changes = {}) => ({ session_id: id, domain: 'reading', source_types: ['ctw', 'rdl', 'rap'], mode: 'random',
  settings: {}, started_at: '2026-10-16T02:00:00Z', status: 'completed', total: 10, answered: 10, summary: { correct: 8 }, ...changes });
const history = items => ({ items, total: items.length, page: 1, pageSize: 10 });
const list = items => render(React.createElement(wordbook.WordbookReviewHistoryList, { history: history(items), showPartialAccuracy: true }));

test('one full-width practice-history shell keeps all attempts and compact rows, never per-record cards', () => {
  const items = [session('one'), session('two'), session('three', { status: 'active', answered: 4, summary: { correct: 3 } })];
  const html = list(items);
  assert.equal((html.match(/teacher-card overflow-hidden p-0/g) ?? []).length, 1);
  assert.equal((html.match(/gap-x-4 gap-y-3 py-3/g) ?? []).length, items.length);
  assert.equal((html.match(/<h2 /g) ?? []).length, items.length);
  for (const s of items) assert.match(html, new RegExp(`/student/wordbook/review/${s.session_id}`));
  for (const value of ['随机数量', 'CTW', 'RDL', 'RAP', '8/10', '3/10', '80%', '75%', '查看结果', '恢复复习']) assert.ok(html.includes(value), value);
  assert.doesNotMatch(html, /Reading|Writing/);
  assert.doesNotMatch(html, /进度|答对|review-correct/);
  assert.equal((html.match(/class="review-stats"><span class="review-progress">/g) ?? []).length, items.length);
  assert.doesNotMatch(html, /text-2xl|text-xl|sm:p-6/);
  assert.doesNotMatch(html, /已完成|未完成|成绩待完成/);
  assert.equal((html.match(/role="img"/g) ?? []).length, items.length);
  assert.match(html, /aria-label="当前正确率 75%"/);
  assert.match(html, /bg-gradient-to-r from-\[#b69aff\] to-student-primary/);
});

test('wordbook history omits Reading/Writing badges while retaining source badges and actual review names', () => {
  const html = list([session('writing', { domain: 'writing', source_types: ['bas', 'write_email', 'academic_discussion'] }),
    session('date', { mode: 'date', settings: { start: '2026-10-15' } }), session('retry', { mode: 'retry' })]);
  for (const value of ['BAS', 'WE', 'AD', '指定日期', '错词再练']) assert.ok(html.includes(value), value);
  assert.doesNotMatch(html, /Reading|Writing/);
});

test('history titles use setting-mode names independent of random counts, single dates or date ranges', () => {
  const html = list([
    session('random-ten'), session('random-thirty-five', { total: 35, answered: 35 }),
    session('date', { mode: 'date', settings: { start: '2026-10-15' } }),
    session('range', { mode: 'range', settings: { start: '2026-10-12', end: '2026-10-14' } }),
    session('retry', { mode: 'retry' })
  ]);
  const titles = [...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map(match=>match[1]);
  assert.deepEqual(titles, ['随机数量', '随机数量', '指定日期', '指定日期', '错词再练']);
});

test('empty history remains inside the same shell; original practice history markup is unchanged by extraction', () => {
  assert.match(list([]), /还没有复习记录。/);
  const actual = render(React.createElement(rows.PracticeHistoryRows, null, React.createElement(rows.PracticeHistoryRow, null, 'record')));
  assert.equal(actual, '<section class="teacher-card overflow-hidden p-0"><div class="divide-y divide-student-border px-5"><div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 py-3">record</div></div></section>');
  assert.match(read('components/student/StudentPracticeHistory.tsx'), /<PracticeHistoryRows>/);
  assert.match(read('components/student/StudentPracticeHistory.tsx'), /<PracticeHistoryRow>/);
});

test('both editions use the same compact card and automatic content-width grid without a column limit', () => {
  const ui = read('components/student/CtwVocabulary.tsx'), css = read('components/student/CtwVocabulary.module.css');
  assert.match(css, /repeat\(auto-fill, minmax\(min\(100%, 14rem\), 1fr\)\)/);
  assert.doesNotMatch(css, /@media|grid-template-columns:\s*repeat\([1-9]/);
  assert.match(ui, /<CtwVocabularyListCard/);
  assert.match(ui, /<AssignmentStatusBadge/);
  assert.match(ui, /rangeLabel=\{ctwHistoryTitle\} badges=\{ctwHistoryBadges\}/);
  assert.match(ui, /return session.source \? listLabel\(session.source.listNumber\)/);
  assert.match(ui, /session.source.group.replace\("-", "–"\)/);
  assert.match(ui, /items: \[\.\.\.extra, \.\.\.\(shown\?\.items \?\? \[\]\)\]/);
  assert.match(css, /\.card \.status\s*\{\s*font-size: 0\.875rem/);
  assert.match(css, /\.best strong\s*\{\s*font-size: 1\.5rem/);
});

test('history opts into content-width aligned columns without changing the original practice-history layout', () => {
  const css = read('components/student/WordbookReviewHistory.module.css');
  assert.match(css, /container-type: inline-size/);
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\) 17rem 11rem/);
  assert.match(css, /@container \(min-width: 52rem\)/);
  assert.doesNotMatch(read('components/student/StudentPracticeHistory.tsx'), /WordbookReviewHistory\.module/);
  const html = render(React.createElement(rows.PracticeHistoryAccuracy, { value: null, label: '当前正确率' }));
  assert.match(html, /当前正确率 —/);
  assert.doesNotMatch(html, /0%/);
});

test('actual CTW history renders List-only titles, edition/retry badges and every independent completed or active attempt', () => {
  const items = [session('mixed', { source: { kind: 'list', listNumber: 1 } }),
    session('cefr', { source: { kind: 'cefr_list', group: 'C1-C2', listNumber: 2 } }),
    session('active', { source: { kind: 'cefr_list', group: 'A1', listNumber: 1 }, status: 'active', answered: 4, summary: { correct: 3 } }),
    session('retry', { source: { kind: 'list', listNumber: 1 }, mode: 'retry' })];
  const { CtwVocabularyHistory } = compile('components/student/CtwVocabulary.tsx', { ...shared,
    '@/components/StudentDataCache': {}, '@/components/shared/ConfirmDialog': {}, '@/components/assignments/AssignmentPresentation': {},
    './StudentUI': { StudentNavigation: () => null }, './WordbookReview': wordbook, './CtwVocabularyReviewResult': {},
    './useCtwVocabulary': { useVocabularyRequest: () => ({ studentId: 'owner' }), useVocabularyRead: () => ({ data: history(items) }) },
    './useCtwReview': {}, '@/lib/ctw-vocabulary/review': {},
    '@/lib/ctw-vocabulary/round': require('../lib/ctw-vocabulary/round.ts'),
    '@/lib/studentNavigation': { STUDENT_ROUTES: {} }, './CtwVocabulary.module.css': {} });
  const html = render(React.createElement(CtwVocabularyHistory));
  assert.deepEqual([...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map(m=>m[1]), ['List 01','List 02','List 01','List 01']);
  for (const value of ['乱序版', 'C1–C2', 'A1', '错词再练', '当前正确率', '75%', '/session/active', '/results/mixed', '/results/cefr', '/results/retry']) assert.ok(html.includes(value), value);
  assert.equal((html.match(/teacher-card overflow-hidden p-0/g) ?? []).length,1);
});

test('all existing role entry points reference the shared implementations; teacher-only access stays intact', () => {
  assert.match(read('app/student/ctw-vocabulary/page.tsx'), /<CtwVocabularyCatalog/);
  assert.match(read('app/student/ctw-vocabulary/history/page.tsx'), /<CtwVocabularyHistory/);
  assert.match(read('app/student/wordbook/review/history/page.tsx'), /<WordbookReviewHistory/);
  assert.match(read('components/teacher/TeacherStudentWordbook.tsx'), /<WordbookReviewHistoryView/);
  assert.match(read('app/teacher/students/[studentId]/wordbook/review/history/page.tsx'), /<TeacherOnly>/);
  assert.match(read('lib/accountPermissions.ts'), /role === "student" \|\| role === "teacher" \|\| role === "admin"/);
});
