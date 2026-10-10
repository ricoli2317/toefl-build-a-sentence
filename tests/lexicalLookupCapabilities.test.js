const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { lexicalLookupEnabled } = require('../lib/lexical/lookupCapabilities.ts');
const { readingLookupEnabled } = require('../lib/reading/lookupCapabilities.ts');
const read = file => fs.readFileSync(path.join(__dirname,'..',file),'utf8');

test('lookup fails closed without an explicit readonly page and practice cannot override it', () => {
  for (const mode of ['practice',undefined,null,'active','review']) {
    assert.equal(lexicalLookupEnabled(mode),false);
    assert.equal(lexicalLookupEnabled(mode,true),false);
  }
  assert.equal(lexicalLookupEnabled('readonly'),true);
  assert.equal(lexicalLookupEnabled('readonly',false),false);
  for (const type of ['ctw','rdl','rap']) {
    assert.equal(readingLookupEnabled('active',type),false);
    assert.equal(readingLookupEnabled('submitted_review',type),true);
  }
});

function openingTags(file,name) {
  const source = ts.createSourceFile(file,read(file),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const tags = [];
  const visit = node => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === name) tags.push(node);
    ts.forEachChild(node,visit);
  };
  visit(source);
  return tags;
}
function modeAttribute(tag) {
  return tag.attributes.properties.find(p=>ts.isJsxAttribute(p) && p.name.text === 'pageMode')?.initializer;
}

test('every shared provider integration declares page lifecycle, including readonly and teacher views', () => {
  const files = ['components/PracticeSession.tsx','components/writing/WritingPractice.tsx','components/reading/ReadingPractice.tsx',
    'components/PracticeResult.tsx','components/PracticeHistory.tsx','components/student/StudentWritingReview.tsx',
    'components/TeacherQuestionBank.tsx','components/teacher/TeacherWritingReviewWorkspace.tsx'];
  for (const file of files) {
    const tags = openingTags(file,'LexicalLookupProvider');assert.ok(tags.length,file);
    for (const tag of tags) assert.ok(modeAttribute(tag),file);
  }
  for (const file of ['components/PracticeSession.tsx']) {
    assert.equal(modeAttribute(openingTags(file,'LexicalLookupProvider')[0]).text,'practice');
  }
  assert.match(read('components/writing/WritingPractice.tsx'),/pageMode=\{readOnly && attempt.status === "submitted" \? "readonly" : "practice"\}/);
  for (const file of ['components/PracticeResult.tsx','components/PracticeHistory.tsx','components/student/StudentWritingReview.tsx']) {
    for (const tag of openingTags(file,'LexicalLookupProvider')) assert.equal(modeAttribute(tag).text,'readonly',file);
  }
});

test('Reading and Full Set declare practice even when a busy/pending/submitted-in-session workspace is readonly', () => {
  for (const file of ['components/reading/ReadingPractice.tsx','components/reading/ReadingFullSetRunner.tsx',
    'components/reading/ReadingFullSetWrongbookPractice.tsx','components/reading/ReadingWrongbookReview.tsx']) {
    for (const tag of openingTags(file,'ReadingWorkspaceRouter')) assert.ok(modeAttribute(tag),file);
  }
  for (const file of ['components/reading/ReadingFullSetRunner.tsx','components/reading/ReadingFullSetWrongbookPractice.tsx']) {
    for (const tag of openingTags(file,'ReadingWorkspaceRouter')) assert.equal(modeAttribute(tag).text,'practice');
  }
  const modes = openingTags('components/reading/ReadingPractice.tsx','ReadingWorkspaceRouter').map(tag=>modeAttribute(tag).text);
  assert.deepEqual(modes,['readonly','practice','practice','practice','readonly']);
});
