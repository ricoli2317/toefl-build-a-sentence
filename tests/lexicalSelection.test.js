const assert = require('node:assert/strict');
const test = require('node:test');
const { domCanonicalLexicalSelection, rdlLexicalSelectionRect } = require('../lib/lexical/selection.ts');
const { lexicalPopupPosition, lexicalRangeRect } = require('../lib/lexical/position.ts');

test('popup is anchored below/above the real Range and clamped at viewport edges, including short/mobile viewports', () => {
  const rect = (left,top,width = 50,height = 20) => ({ left,top,right:left+width,bottom:top+height,width,height });
  let position = lexicalPopupPosition(rect(100,100),{ width:448,height:180 },{ width:800,height:600 });
  assert.equal(position.top,128); assert.equal(position.placement,'below');
  position = lexicalPopupPosition(rect(750,500),{ width:448,height:180 },{ width:800,height:600 });
  assert.equal(position.left,344); assert.equal(position.top,312); assert.equal(position.placement,'above');
  position = lexicalPopupPosition(rect(100,220),{ width:448,height:400 },{ width:800,height:600 });
  assert.equal(position.placement,'above'); assert.equal(position.top,8); assert.equal(position.maxHeight,204);
  for (const [viewport,anchor,panel] of [
    [{ width:320,height:220 },rect(300,160),{ width:448,height:600 }],
    [{ width:800,height:80 },rect(-10,20),{ width:448,height:600 }],
    [{ width:300,height:180,left:25,top:30 },rect(300,170),{ width:448,height:600 }]
  ]) {
    const p = lexicalPopupPosition(anchor,panel,viewport);
    assert.ok(p.left >= (viewport.left ?? 0)+8); assert.ok(p.top >= (viewport.top ?? 0)+8);
    assert.ok(p.left+p.width <= (viewport.left ?? 0)+viewport.width-8);
    assert.ok(p.top+Math.min(panel.height,p.maxHeight) <= (viewport.top ?? 0)+viewport.height-8);
  }
  const real = rect(30,40);
  assert.equal(lexicalRangeRect({ getBoundingClientRect:() => real }),real);
  assert.equal(lexicalRangeRect({ getBoundingClientRect:() => rect(0,0,0,0),getClientRects:() => [rect(0,0,0,0),real] }),real);
  assert.equal(lexicalRangeRect({ getBoundingClientRect:() => rect(0,0,0,0),getClientRects:() => [] }),null);
});

test('DOM selection carries passage/stem/option canonical identities and UTF-16 offsets; submitted slots/cross-block ranges are excluded', () => {
  // Minimal DOM Range fixture: exercise the production offset/identity code without a browser or new dependency.
  class Element {
    constructor(text,block,extra = {}) { this.textContent = text; this.dataset = { lexicalBlock:block,...extra };this.childNodes = []; }
    closest(selector) { return selector === '[data-lexical-block]' ? this : this.excluded ? this : null; }
    contains(node) { return node === this || node.parentElement === this; }
  }
  const previous = { Element:global.Element,document:global.document };
  global.Element = Element;
  global.document = { createRange() {
    let block; let offset = 0;
    return { selectNodeContents(node) { block = node; },setEnd(node,end) { offset = node === block ? block.textContent.length : node.baseOffset + end; },toString:() => block.textContent.slice(0,offset) };
  } };
  try {
    const region = { contains:() => true,querySelectorAll:() => [] };
    for (const contentBlockId of ['passage:p:paragraph:para','question:q:stem','question:q:option:opt']) {
      const element = new Element('A 😀 Center!',contentBlockId);
      const node = { parentElement:element,baseOffset:0 };
      const range = { startContainer:node,endContainer:node,startOffset:5,endOffset:12 };
      const selected = domCanonicalLexicalSelection(region,range);
      assert.equal(selected.contentBlockId,contentBlockId); assert.equal(selected.startOffset,5); assert.equal(selected.endOffset,12);
      assert.equal(selected.selectedText,'Center!'); assert.equal(selected.blockText,'A 😀 Center!');
      element.dataset.lexicalOffset = '100'; element.dataset.lexicalText = 'canonical paragraph';
      assert.equal(domCanonicalLexicalSelection(region,range).startOffset,105);
      element.excluded = true; assert.equal(domCanonicalLexicalSelection(region,range),null);
    }
    const normal = new Element('world','paragraph:p',{ lexicalCtwAnchor:JSON.stringify({ kind:'text',segmentIndex:2 }) });
    const correct = new Element('green','paragraph:p',{ lexicalCtwAnchor:JSON.stringify({ kind:'slot',slotId:'slot' }) });
    const textRange = element => ({ startContainer:{ parentElement:element,baseOffset:0 },endContainer:{ parentElement:element,baseOffset:0 },startOffset:0,endOffset:5 });
    assert.deepEqual(domCanonicalLexicalSelection(region,textRange(normal)).ctwAnchor,{ kind:'text',segmentIndex:2 });
    assert.deepEqual(domCanonicalLexicalSelection(region,textRange(correct)).ctwAnchor,{ kind:'slot',slotId:'slot' });
    const slot = new Element('wrong',undefined); slot.excluded = true;
    assert.equal(domCanonicalLexicalSelection(region,textRange(slot)),null);
    assert.equal(domCanonicalLexicalSelection({ ...region,querySelectorAll:() => [slot] },{ ...textRange(normal),intersectsNode:() => true }),null);
    assert.equal(domCanonicalLexicalSelection(region,{ ...textRange(normal),endContainer:{ parentElement:correct } }),null);
    const other = new Element('world','question:other:stem');
    assert.equal(domCanonicalLexicalSelection(region,{ ...textRange(normal),endContainer:{ parentElement:other } }),null);
    assert.equal(domCanonicalLexicalSelection({ ...region,querySelectorAll:selector => selector === '[data-lexical-block]' ? [other] : [] },
      { ...textRange(normal),intersectsNode:() => true }),null);
    assert.equal(domCanonicalLexicalSelection({ ...region,contains:() => false },textRange(normal)),null);
  } finally {
    for (const [key,value] of Object.entries(previous)) { if (value === undefined) delete global[key]; else global[key] = value; }
  }
});

test('RDL popup geometry comes from existing selected character hitboxes and is recalculated from the current image surface bounds', () => {
  const map = { lines:[{ words:[{ characters:[
    { globalIndex:0,bbox:{ x:0.1,y:0.2,width:0.05,height:0.1 } },
    { globalIndex:1,bbox:{ x:0.15,y:0.2,width:0.05,height:0.1 } }
  ] }] }] };
  const bounds = { left:20,top:40,width:400,height:200 };
  const rect = rdlLexicalSelectionRect(map,{ startIndex:0,endIndex:1 },bounds);
  assert.equal(rect.left,60); assert.equal(rect.top,80); assert.equal(rect.right,100); assert.ok(Math.abs(rect.bottom-100) < 1e-8);
  const scrolled = rdlLexicalSelectionRect(map,{ startIndex:0,endIndex:1 },{ ...bounds,top:10 });
  assert.equal(scrolled.top,50);
  assert.equal(rdlLexicalSelectionRect(map,{ startIndex:3,endIndex:4 },bounds),null);
});
