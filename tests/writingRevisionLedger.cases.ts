import test from 'node:test';
import assert from 'node:assert/strict';
import { Schema, Fragment, Slice } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { history, closeHistory, undo, redo } from '@tiptap/pm/history';
// Accepted transaction-ledger assertions, promoted from the standalone PoC.
// Exercise the formal shared modules directly; no demo app or local server.
import { textDocument, textPosition, exportDocument } from '../lib/writingRevisionDocument.ts';
import { transactionRevisionExtension, transactionRevisionKey, restoreDeletion } from '../lib/writingRevisionPlugin.ts';
import { ledgerParts, originalProjection, type Ledger } from '../lib/writingRevisionLedger.ts';

const schema = new Schema({ nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*', group: 'block' }, text: { group: 'inline' } } });
function harness(original: string, current = original) {
  const ext = transactionRevisionExtension(original, []);
  const plugins = ext.config.addProseMirrorPlugins!.call({} as never);
  let state = EditorState.create({ schema, doc: schema.nodeFromJSON(textDocument(current)), plugins: [history({ depth: 1000 }), ...plugins] });
  const ledger = () => transactionRevisionKey.getState(state)!.ledger;
  const dispatch = (tr: EditorState['tr']) => {
    state = state.applyTransaction(tr).state;
    assert.equal(ledger().text, exportDocument(state.doc)); assert.equal(originalProjection(ledger()), original);
    const parts=ledgerParts(ledger());
    assert.equal(parts.filter(p=>p.kind!=='deleted').map(p=>p.text).join(''),ledger().text);
    assert.equal(parts.filter(p=>p.kind!=='added').map(p=>p.text).join(''),original,'visible revision stream preserves original order too');
  };
  const view = { get state() { return state; }, dispatch, focus() {} } as unknown as EditorView;
  return { ledger, get state() { return state; },
    edit(from: number, to: number, text: string) {
      dispatch(closeHistory(state.tr));
      const doc = schema.nodeFromJSON(textDocument(text));
      dispatch(state.tr.setSelection(TextSelection.create(state.doc, textPosition(ledger().text, from), textPosition(ledger().text, to)))
        .replaceSelection(new Slice(Fragment.from(doc.content), 1, 1)));
    },
    restore(id: string) { dispatch(closeHistory(state.tr)); return restoreDeletion(view, id); },
    undo() { return undo(state, dispatch); }, redo() { return redo(state, dispatch); },
    toggle(visible: boolean) { dispatch(state.tr.setMeta(transactionRevisionKey, { visible }).setMeta('addToHistory', false)); },
  };
}
const changed = (ledger: Ledger, kind: 'added' | 'deleted') => ledgerParts(ledger).filter(p => p.kind === kind).map(p => ({ text: p.text, at: p.currentFrom }));

test('single Backspace/Delete record only the actual final character, never the word', () => {
  for (const label of ['Backspace','Delete']) {
    const h=harness('interesting'); h.edit(10,11,'');
    assert.equal(h.ledger().text,'interestin',label);
    assert.deepEqual(changed(h.ledger(),'deleted'),[{text:'g',at:10}]); assert.deepEqual(changed(h.ledger(),'added'),[]);
  }
});
test('joining replacement remains exact for every typed character, including spaces/punctuation', () => {
  const original='I am interested in joining the club.'; const at=original.indexOf('joining'); const h=harness(original);
  let inserted=''; for(const char of 'taking part in,') {
    h.edit(at+inserted.length,at+inserted.length+(inserted?0:7),char);inserted+=char;
    assert.deepEqual(changed(h.ledger(),'deleted'),[{text:'joining',at}]);
    assert.deepEqual(changed(h.ledger(),'added'),[{text:inserted,at}]);
    assert.equal(h.ledger().text,original.slice(0,at)+inserted+original.slice(at+7));
  }
});
test('same text replacement is an operation, not an empty Diff',()=>{
  const h=harness('one two');h.edit(4,7,'two');assert.equal(h.ledger().text,'one two');
  assert.deepEqual(changed(h.ledger(),'deleted'),[{text:'two',at:4}]);assert.deepEqual(changed(h.ledger(),'added'),[{text:'two',at:4}]);
});
test('repeated-text copy/paste does not relocate old deletions or repaint surviving words',()=>{
  const text='The club helps. The club helps. The club helps.';const h=harness(text);h.edit(4,8,'');
  const deletion=h.ledger().deletions[0],valid=h.ledger().text;h.edit(valid.length,valid.length,valid);
  assert.deepEqual(h.ledger().deletions,[deletion]);assert.deepEqual(changed(h.ledger(),'added'),[{text:valid,at:valid.length}]);
});
test('new insertions can be edited/deleted without becoming original deletion records',()=>{
  const h=harness('A Z');h.edit(2,2,'hello');h.edit(3,5,'X');h.edit(3,3,'!');
  assert.deepEqual(changed(h.ledger(),'deleted'),[]);assert.deepEqual(changed(h.ledger(),'added'),[{text:'h!Xlo',at:2}]);
  h.edit(2,7,'');assert.equal(h.ledger().text,'A Z');assert.deepEqual(h.ledger().deletions,[]);
  h.edit(2,2,'again');assert.deepEqual(changed(h.ledger(),'added'),[{text:'again',at:2}]);
});
test('older deletion restore is independent, mapped, stable-ID and idempotent',()=>{
  const h=harness('first second third');h.edit(0,5,'');const first=h.ledger().deletions[0];
  h.edit(1,7,'');const second=h.ledger().deletions.find(d=>d.id!==first.id)!;
  h.edit(h.ledger().text.length,h.ledger().text.length,' NEW');
  const additions=changed(h.ledger(),'added');
  assert.equal(h.restore(first.id),true);assert.ok(h.ledger().text.startsWith('first '));
  assert.deepEqual(h.ledger().deletions.map(({id,text,sources})=>({id,text,sources})),[{id:second.id,text:second.text,sources:second.sources}]);
  assert.equal(changed(h.ledger(),'added')[0].text,additions[0].text);
  const once=h.ledger();assert.equal(h.restore(first.id),false);assert.deepEqual(h.ledger(),once);
  h.restore(second.id);assert.equal(h.ledger().text,'first second third NEW');
  h.edit(0,0,'X');assert.equal(h.ledger().text,'Xfirst second third NEW');
});
test('collapsed neighbouring deletion anchors restore in either order',()=>{
  for(const order of [[0,1,2],[2,0,1]]){
    const h=harness('abc');h.edit(1,2,'');h.edit(0,1,'');h.edit(0,1,'');const ids=h.ledger().deletions.map(d=>d.id);
    for(const i of order)h.restore(ids[i]);assert.equal(h.ledger().text,'abc');assert.deepEqual(h.ledger().deletions,[]);
  }
});
test('same-anchor insertions follow a deletion; non-coincident edits map it forward',()=>{
  const h=harness('first rest');h.edit(0,5,'');const id=h.ledger().deletions[0].id;h.edit(0,0,'NEW ');h.restore(id);
  assert.equal(h.ledger().text,'firstNEW  rest');
  const mapped=harness('A first rest');mapped.edit(2,7,'');const old=mapped.ledger().deletions[0];mapped.edit(0,0,'NEW ');
  assert.equal(mapped.ledger().deletions[0].position,old.position+4);mapped.restore(old.id);assert.equal(mapped.ledger().text,'NEW A first rest');
});
test('restore anchors map through earlier inserted paragraphs and source edits',()=>{
  const h=harness('first\n\nsecond\n\nthird');h.edit(7,13,'');const id=h.ledger().deletions[0].id;
  h.edit(0,0,'new\n\n');h.restore(id);assert.equal(h.ledger().text,'new\n\nfirst\n\nsecond\n\nthird');
});
test('whole paragraphs and terminal whitespace restore exactly',()=>{
  for(const original of ['A\n\nB\n','  text  \n\n','😀中文\n\n']){
    const h=harness(original);h.edit(0,original.length,'');const ids=h.ledger().deletions.map(d=>d.id);
    for(const id of ids)h.restore(id);assert.equal(h.ledger().text,original);
  }
});
test('Undo/Redo restores EXACT ledger and IDs along with text, including restoration',()=>{
  const h=harness('red green blue');h.edit(4,9,'');h.edit(0,0,'NEW ');const before=h.ledger(),id=before.deletions[0].id;
  h.restore(id);const restored=h.ledger();h.undo();assert.deepEqual(h.ledger(),before);h.redo();assert.deepEqual(h.ledger(),restored);
  h.undo();h.undo();h.undo();assert.equal(h.ledger().text,'red green blue');assert.deepEqual(h.ledger().deletions,[]);
});
test('visibility is not ledger/history state and remains local over Undo/Redo',()=>{
  const h=harness('abc');h.edit(1,2,'X');const before=h.ledger();h.toggle(false);assert.equal(h.ledger(),before);
  h.undo();assert.equal(transactionRevisionKey.getState(h.state)!.visible,false);h.redo();assert.deepEqual(h.ledger(),before);
});
test('IDs are not recycled after Undo followed by a different editing branch',()=>{
  const h=harness('abc');h.edit(1,2,'');const discarded=h.ledger().deletions[0].id;h.undo();h.edit(1,2,'');
  assert.notEqual(h.ledger().deletions[0].id,discarded);const before=h.ledger();assert.equal(h.restore(discarded),false);assert.equal(h.ledger(),before);
});
test('initial pre-revised import has explicit, lossless character provenance',()=>{
  const h=harness('interesting\n😀','interested\n🧑');assert.equal(h.ledger().text,'interested\n🧑');assert.equal(originalProjection(h.ledger()),'interesting\n😀');
});
test('500 deterministic mapped edits/restores + complete history roundtrip',()=>{
  const original='A repeated word, repeated word.\n\n中文😀 end.\n';const h=harness(original);let seed=17;
  const random=()=>seed=(seed*1664525+1013904223)>>>0;
  const states:Ledger[]=[h.ledger()];
  for(let i=0;i<500;i++){
    if(i%7===0&&h.ledger().deletions.length){h.restore(h.ledger().deletions[random()%h.ledger().deletions.length].id);}
    else{
      const points=[0];let at=0;for(const cp of h.ledger().text){at+=cp.length;points.push(at);}
      const a=points[random()%points.length],b=points[random()%points.length];const insert=['X',' ','\n','😀','中文','!?'][random()%6];
      h.edit(Math.min(a,b),Math.max(a,b),insert);
    }
    states.push(h.ledger());
  }
  for(let i=499;i>=0;i--){assert.equal(h.undo(),true);assert.deepEqual(h.ledger(),states[i]);}
  for(let i=1;i<=500;i++){assert.equal(h.redo(),true);assert.deepEqual(h.ledger(),states[i]);}
});
