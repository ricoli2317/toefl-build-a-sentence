const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const root = path.join(__dirname,'..');
const read = file => fs.readFileSync(path.join(root,file),'utf8');
function compile(file,mocks,expose = []) {
  let source = read(file);
  // Test-only exports of actual private components, not copied replacement renderers.
  for (const name of expose) source = source.replace(`function ${name}(`,`export function ${name}(`);
  const filename = path.join(root,file);
  const js = ts.transpileModule(source,{ fileName:filename,compilerOptions:{ jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true } }).outputText;
  const original = Module._load;
  Module._load = function(request,parent,isMain) { return Object.hasOwn(mocks,request) ? mocks[request] : original.call(this,request,parent,isMain); };
  try { const loaded = new Module(filename,module); loaded.filename = filename;loaded.paths = Module._nodeModulePaths(root);loaded._compile(js,filename);return loaded.exports; }
  finally { Module._load = original; }
}
const react = { ...React,useLayoutEffect:React.useEffect };
const lexical = compile('components/lexical/LexicalLookup.tsx',{
  react,'@/lib/supabase/client':{},'@/lib/lexical/selection':require('../lib/lexical/selection.ts'),
  '@/lib/lexical/lookup':require('../lib/lexical/lookup.ts'),'@/lib/lexical/position':require('../lib/lexical/position.ts')
});
const mocks = Object.fromEntries([...read('components/reading/ReadingPractice.tsx').matchAll(/from "(@\/[^\"]+)"/g)].map(match => [match[1],{}]));
Object.assign(mocks,{ react,'next/navigation':{},'@/components/lexical/LexicalLookup':lexical,
  '@/lib/reading/practiceState':require('../lib/reading/practiceState.ts'),
  '@/lib/reading/rapInteraction':require('../lib/reading/rapInteraction.ts'),
  '@/lib/reading/rdlSelection':require('../lib/reading/rdlSelection.ts'),
  '@/lib/reading/materialTypes':require('../lib/reading/materialTypes.ts'),
  '@/lib/reading/correctionResult':require('../lib/reading/correctionResult.ts'),
  '@/components/reading/ReadingCorrectionAnswerValue':compile('components/reading/ReadingCorrectionAnswerValue.tsx',{})
});
const reading = compile('components/reading/ReadingPractice.tsx',mocks,['CtwPracticeWorkspace','ChoiceOptionList','RapPracticeWorkspace','RdlPracticeWorkspace']);
const render = (Component,props) => renderToStaticMarkup(React.createElement(Component,props));
const strip = html => html.replace(/<[^>]+>/g,'');

test('actual CTW result renderer restores wrong, empty and correct submitted slots, with lookup only on normal text and bottom correct words', () => {
  const slots = [
    { slotId:'wrong',slotOrder:1,paragraphId:'p',prefix:'w',missingLength:4 },
    { slotId:'empty',slotOrder:2,paragraphId:'p',prefix:'r',missingLength:5 },
    { slotId:'correct',slotOrder:3,paragraphId:'p',prefix:'w',missingLength:4 }
  ];
  const reviewItems = slots.map((s,i) => ({ ...s,answerId:s.slotId,isAnswered:i !== 1,isCorrect:i === 2 }));
  const answers = ['write','reduce','while'];
  const reviewPresentations = Object.fromEntries(slots.map((s,i) => [s.slotId,{ studentAnswer:['wrong','','while'][i],correctAnswer:{ kind:'ctw_word',parts:[{ text:answers[i],emphasized:false }] } }]));
  const question = { questionId:'q',questionType:'ctw',stem:'Fill in the missing letters in the paragraph.',slots,paragraphs:[{ paragraphId:'p',paragraphOrder:1,
    segments:[{ kind:'text',text:'We ' },{ kind:'blank',slotId:'wrong' },{ kind:'text',text:' and ' },{ kind:'blank',slotId:'empty' },{ kind:'text',text:' ' },{ kind:'blank',slotId:'correct' },{ kind:'text',text:' today.' }] }] };
  const html = render(reading.CtwPracticeWorkspace,{ question,readOnly:true,lookupEnabled:true,answerKeyOnly:false,
    answer:{ kind:'ctw',slots:{ wrong:Array.from('rong'),empty:['','','','',''],correct:Array.from('hile') } },reviewItems,reviewPresentations,selectedReviewItem:null,onAnswerChange:() => { throw new Error('readonly must not edit'); } });
  const passage = html.slice(html.indexOf('data-testid="ctw-passage"'),html.indexOf('data-testid="ctw-readonly-answer-zone"'));
  assert.match(strip(passage),/We wrong and r while today\./);
  assert.doesNotMatch(strip(passage),/write|reduce/);
  assert.equal((passage.match(/data-lexical-exclude="true"/g) ?? []).length,3);
  assert.equal((passage.match(/data-filled="false"/g) ?? []).length,5);
  assert.match(passage,/data-lexical-block="paragraph:p"/);
  assert.match(passage,/segmentIndex&amp;quot;|segmentIndex&quot;/);
  const bottom = html.slice(html.indexOf('data-testid="ctw-readonly-answer-zone"'));
  assert.equal((bottom.match(/data-lexical-block="paragraph:p"/g) ?? []).length,3);
  assert.equal((bottom.match(/data-lexical-ctw-anchor=/g) ?? []).length,3);
  for (const word of answers) assert.ok(bottom.includes(`>${word}</span>`));
  assert.ok(strip(bottom).includes('wrong')); assert.ok(strip(bottom).includes('未作答'));
  const heading = html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/)?.[0];
  assert.ok(heading);
  assert.doesNotMatch(heading,/data-lexical-/);
});

test('readonly choice rows are selectable non-button radios; active choice rows retain their original buttons/handlers', () => {
  const props = { questionId:'q',labelledBy:'stem',options:[{ optionId:'opt',optionOrder:1,text:'green energy' }],selectedOptionId:'opt',onSelect:() => {} };
  const readonly = render(reading.ChoiceOptionList,{ ...props,readOnly:true });
  assert.doesNotMatch(readonly,/<button|\sdisabled=/); assert.match(readonly,/select-text/); assert.match(readonly,/aria-disabled="true"/);
  assert.match(readonly,/data-lexical-block="question:q:option:opt"/);
  const active = render(reading.ChoiceOptionList,{ ...props,readOnly:false });
  assert.match(active,/<button/); assert.doesNotMatch(active,/select-text|aria-disabled/);
});

test('RAP and RDL actual workspaces annotate the real canonical stem/options, RAP passage and passage title, without UI chrome in blocks', () => {
  const base = { answerKeyOnly:false,lookupEnabled:true,naturalFlow:true,readOnly:true,onAnswerChange:() => {},question:{ questionId:'q',questionType:'rap_multiple_choice',stem:'Choose green energy.',highlightRanges:[],options:[{ optionId:'opt',optionOrder:1,text:'green energy' }] } };
  const rap = render(reading.RapPracticeWorkspace,{ ...base,passage:{ passageId:'p',title:'Green World',paragraphs:[{ paragraphId:'para',paragraphOrder:1,text:'A green world.',sentences:[{ sentenceId:'s',sentenceOrder:1,text:'A green world.' }] }] } });
  for (const block of ['passage:p:title','passage:p:paragraph:para','question:q:stem','question:q:option:opt']) assert.ok(rap.includes(`data-lexical-block="${block}"`));
  assert.match(rap,/data-lexical-text="Green World"/);
  const rdl = render(reading.RdlPracticeWorkspace,{ ...base,question:{ ...base.question,questionType:'rdl' },material:{ materialId:'m',title:'Notice',materialType:'notice',imageUrl:'https://example.invalid/registered.png' } });
  for (const block of ['question:q:stem','question:q:option:opt']) assert.ok(rdl.includes(`data-lexical-block="${block}"`));
  assert.doesNotMatch(rap+rdl,/<button[^>]*disabled/);
});

test('BAS prompt/correct-answer annotations remain isolated from all submitted/empty sentence-building content', () => {
  const { QuestionDisplay } = compile('components/shared/QuestionDisplay.tsx',{
    '@/components/lexical/LexicalLookup':lexical,'@/lib/questionText':require('../lib/questionText.ts')
  });
  for (const placed of [[{ id:'a',text:'wrong' }],[{ id:'a',text:'wanted' }],[null]]) {
    const html = render(QuestionDisplay,{ answers:placed,readOnly:true,lexicalPrompt:true,options:[{ id:'a',text:'wanted' }],prompt:'She wanted to leave.',questionNumber:1,template:'She ___ to leave.' });
    assert.equal((html.match(/data-lexical-block=/g) ?? []).length,1);
    assert.match(html,/data-lexical-block="prompt"/);
    assert.doesNotMatch(html.slice(html.indexOf('practice-sentence-template')),/data-lexical-block=/);
  }
  assert.match(render(lexical.LexicalText,{ blockId:'final-sentence',text:'She wanted to leave.' }),/data-lexical-block="final-sentence"/);
  assert.match(read('components/PracticeResult.tsx'),/<LexicalText blockId="final-sentence"/);
  assert.match(read('components/PracticeSession.tsx'),/kind: "bas_prompt"/);
});
