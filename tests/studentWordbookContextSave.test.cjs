const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');

function fixture({ saved = true, teacherReadonly = false } = {}) {
  const selection = { access: { kind: 'reading', attemptId: 'offline-attempt' }, sourceType: 'rap',
    sourceItemId: 'offline-item', contentBlockId: 'paragraph:p', blockText: 'A system.',
    startOffset: 2, endOffset: 8, selectedText: 'system' };
  const result = { status: 'matched', entry: { entry_id: 'offline-entry', canonical_expression: 'system' },
    occurrence: { occurrence_id: 'offline-occurrence', context_pos: 'noun', context_meaning_zh: '系统' },
    wordbook: { available: true, saved, domain: 'reading' } };
  const state = { selected: 'system', result }, calls = [];
  let stateIndex = 0, refIndex = 0;
  const react = { ...React, useEffect() {}, useLayoutEffect() {}, useCallback: fn => fn,
    useState: initial => [stateIndex++ === 0 ? state : initial, () => {}],
    useRef: initial => ({ current: refIndex++ === 6 ? selection : initial }) };
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync('components/lexical/LexicalLookup.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
  }).outputText;
  vm.runInNewContext(code, { exports, AbortController,
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body); calls.push(body);
      return { ok: true, json: async () => ({ saved: body.action !== 'remove', domain: 'reading' }) };
    },
    require(name) {
      if (name === 'react') return react;
      if (name === '@/lib/supabase/client') return { createBrowserSupabase: () => ({ auth: {
        getSession: async () => ({ data: { session: { access_token: 'offline-test-only' } } })
      } }) };
      if (name.startsWith('@/lib/lexical/')) return {};
      return require(name);
    }
  });
  const tree = exports.LexicalLookupProvider({ access: selection.access, sourceType: 'rap', teacherReadonly, children: null });
  function find(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.type === exports.LexicalLookupCard) return node;
    for (const child of React.Children.toArray(node.props?.children)) { const found = find(child); if (found) return found; }
    return null;
  }
  return { card: find(tree), calls, selection, exports, state };
}

test('saved entry can explicitly append the current verified source/context, while cancellation still removes', async () => {
  const f = fixture();
  f.card.props.onWordbookSaveContext();
  await new Promise(setImmediate);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].action, 'save');
  assert.equal(JSON.stringify(f.calls[0].selection), JSON.stringify(f.selection));
  assert.equal(f.calls[0].entryId, 'offline-entry');
  assert.equal(f.calls[0].occurrenceId, 'offline-occurrence');
  f.card.props.onWordbookSaveContext();
  await new Promise(setImmediate);
  assert.equal(f.calls[1].action, 'save');
  f.card.props.onWordbookToggle();
  await new Promise(setImmediate);
  assert.equal(f.calls[2].action, 'remove');
});

test('first save stays a save; teacher read-only cards expose neither mutation callback', async () => {
  const first = fixture({ saved: false });
  first.card.props.onWordbookToggle();
  await new Promise(setImmediate);
  assert.equal(first.calls[0].action, 'save');
  const teacher = fixture({ teacherReadonly: true });
  assert.equal(teacher.card.props.onWordbookSaveContext, undefined);
  assert.equal(teacher.card.props.onWordbookToggle, undefined);
  assert.equal(teacher.calls.length, 0);
});

test('context-save button is shown only on saved student cards, disables during save, and never appears for teachers', () => {
  const { renderToStaticMarkup } = require('react-dom/server');
  const render = f => renderToStaticMarkup(React.createElement(f.exports.LexicalLookupCard, f.card.props));
  const saved = fixture();
  assert.match(render(saved), /保存当前语境/);
  assert.match(render(saved), /已加入 · 取消收藏/);
  saved.state.wordbookBusy = true;
  assert.match(render(saved), /button[^>]*disabled=""[^>]*title="保存当前来源/);
  assert.doesNotMatch(render(fixture({ saved: false })), /保存当前语境/);
  assert.doesNotMatch(render(fixture({ teacherReadonly: true })), /保存当前语境|取消收藏|加入生词本/);
});
