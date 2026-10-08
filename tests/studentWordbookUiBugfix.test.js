const assert=require('node:assert/strict');const test=require('node:test');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const ts=require('typescript'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const dates=require('../lib/studentDates.ts');
const {wordbookPos,twoLinePrefix}=require('../lib/lexical/wordbookPresentation.ts');
function compile(file,mocks) {
  const filename=path.join(__dirname,'..',file);const old=Module._load;
  Module._load=function(request,parent,isMain){return Object.hasOwn(mocks,request)?mocks[request]:old.call(this,request,parent,isMain);};
  try {const m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{fileName:filename,compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText,filename);return m.exports;}finally{Module._load=old;}
}
const {StudentDateSelection}=compile('components/student/StudentDateSelection.tsx',{
  '@/components/teacher/TeacherPopover':{TeacherPopover:({children})=>children(()=>{})},'@/lib/studentDates':dates,react:{...React,useLayoutEffect:React.useEffect}
});
test('wordbook date bounds are local July 2026 through dynamic today; invalid/reversed drafts cannot be applied',()=>{
  const bounds={min:'2026-07-01',max:'2026-10-08'};
  for(const draft of [{start:'2026-06-30',end:''},{start:'2026-10-09',end:''},{start:'2026-02-30',end:''},{start:'2026-10-08',end:'2026-07-01'},{start:'',end:'2026-08-01'}])assert.equal(dates.boundedDateDraft(draft,bounds),null);
  assert.deepEqual(dates.boundedDateDraft({start:'2026-07-01',end:'2026-10-08'},bounds),{start:'2026-07-01',end:'2026-10-08'});
  assert.equal(dates.formatDateInputValue(dates.boundedCalendarMonth(new Date(2026,5,15),bounds)),'2026-07-01');
  assert.equal(dates.formatDateInputValue(dates.boundedCalendarMonth(new Date(2027,0,15),bounds)),'2026-10-01');
  assert.equal(dates.formatDateInputValue(dates.boundedCalendarMonth(new Date(2026,7,15),bounds)),'2026-08-01');
  // History keeps its existing reversed-range normalization, no July limit.
  assert.deepEqual(dates.normalizeDateDraft({start:'2026-06-02',end:'2026-06-01'},''),{start:'2026-06-01',end:'2026-06-02'});
});
test('bounded calendar disables arrows at both endpoints and dates after today, leaves historical middle months enabled',()=>{
  const bounds={min:'2026-07-01',max:'2026-10-08'};
  const render=month=>renderToStaticMarkup(React.createElement(StudentDateSelection,{draft:{start:'',end:''},onDraftChange(){},onApply(){},bounds,activity:{month:new Date(2026,month,1),dates:[],onMonthChange(){},showToday:true}}));
  assert.match(render(6),/aria-label="上个月" disabled=""/);assert.doesNotMatch(render(6),/aria-label="下个月" disabled/);
  assert.match(render(9),/aria-label="下个月" disabled=""/);assert.match(render(9),/aria-label="2026-10-09"[^>]*disabled/);
  assert.doesNotMatch(render(7),/aria-label="[上下]个月" disabled/);assert.match(render(7),/>今天<\/button>/);
});
test('history default form has no date bounds, Today/month UI or changed day/range controls',()=>{
  const html=renderToStaticMarkup(React.createElement(StudentDateSelection,{draft:{start:'2026-06-01',end:'2026-06-02'},onDraftChange(){},onApply(){}}));
  assert.doesNotMatch(html,/min="|max="|今天|有收藏活动/);assert.match(html,/查看范围统计/);
});
test('Reading calendar primary-button shadow follows its theme without modifying shared history or Writing styles',()=>{
  const component=fs.readFileSync(path.join(__dirname,'../components/student/StudentWordbook.tsx'),'utf8');
  const css=fs.readFileSync(path.join(__dirname,'../components/student/StudentWordbook.module.css'),'utf8');
  assert.match(component,/domain === "reading" \? styles\.readingDateControls : ""/);
  assert.match(css,/\.readingDateControls :global\(\.teacher-button-primary\) \{ box-shadow: 0 5px 14px color-mix\(in srgb, var\(--student-primary\) 18%, transparent\); \}/);
});
test('actual wordbook tab handler clears applied single/range and unsubmitted dates in both domains while preserving sort',()=>{
  const hooks=[];let cursor=0;
  const hookReact={...React,useRef:value=>({current:value}),useEffect(){},useMemo:fn=>fn(),useState(initial){const i=cursor++;if(!(i in hooks))hooks[i]=typeof initial==='function'?initial():initial;return[hooks[i],value=>{hooks[i]=typeof value==='function'?value(hooks[i]):value;}];}};
  const {StudentWordbook}=compile('components/student/StudentWordbook.tsx',{
    react:hookReact,'@/components/StudentDataCache':{useStudentDataCache:()=>({getSession:()=>null,sessionReady:false,studentId:null})},
    '@/components/shared/ConfirmDialog':{ConfirmDialog:()=>null},'@/lib/lexical/wordbookManagement':require('../lib/lexical/wordbookManagement.ts'),
    '@/components/student/StudentUI':{StudentNavigation:()=>null},'@/components/student/StudentDateSelection':{StudentDateSelection:()=>null},
    './WordbookExample':{WordbookExample:()=>null},'@/lib/lexical/wordbookPresentation':{wordbookPos},
    '@/lib/studentNavigation':{STUDENT_ROUTES:{home:'/student/sets'}},'@/lib/studentDates':dates,
    '@/lib/lexical/wordbookList':require('../lib/lexical/wordbookList.ts'),'./StudentWordbook.module.css':{}
  });
  const render=()=>{cursor=0;return StudentWordbook();};render();
  for(const end of ['2026-07-10','2026-08-10']){
    hooks[0]='reading';hooks[1]={reading:{start:'2026-07-10',end,sort:'oldest',page:3},writing:{start:'2026-09-01',end:'2026-09-20',sort:'newest',page:2}};
    hooks[2]={start:'2026-08-01',end:'2026-09-01'};hooks[3]=new Date(2026,6,1);
    render().props.children[1].props.children[1].props.onClick();
    assert.equal(hooks[0],'writing');assert.deepEqual(hooks[2],{start:'',end:''});
    for(const domain of ['reading','writing']){assert.equal(hooks[1][domain].start,'');assert.equal(hooks[1][domain].end,'');assert.equal(hooks[1][domain].page,1);}
    assert.equal(hooks[1].reading.sort,'oldest');assert.equal(hooks[1].writing.sort,'newest');
    assert.equal(dates.formatDateInputValue(hooks[3]),dates.formatDateInputValue(dates.startOfLocalDay()));
    render().props.children[1].props.children[0].props.onClick();assert.equal(hooks[0],'reading');assert.equal(hooks[1].reading.start,'');
  }
});
test('POS maps the actual corpus types, preserves unknowns and keeps snapshots untouched',()=>{
  const map={noun:'n.',verb:'v.',adjective:'adj.',adverb:'adv.',pronoun:'pron.',preposition:'prep.',conjunction:'conj.',interjection:'interj.','phrasal verb':'phr. v.',proper_noun:'prop. n.',determiner:'det.',auxiliary:'aux.',particle:'part.',numeral:'num.',modal:'modal',other:'other'};
  for(const [raw,display] of Object.entries(map))assert.equal(wordbookPos(raw),display);
  assert.equal(wordbookPos('unclassified type'),'unclassified type');assert.equal(wordbookPos(null),'—');
});
test('two-line prefix handles Chinese, English, long tokens, punctuation, whitespace and whole emoji graphemes',()=>{
  for(const text of ['中文例句包含标点。完整原文不会被修改。','A very long English example with punctuation!','supercalifragilisticexpialidocious','👨‍👩‍👧‍👦😀中文原文\n第二行\n第三行']){
    const segments=s=>[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(s)];
    const fits=(s,toggle)=>segments(s).length+(toggle?3:0)<=12;
    const prefix=twoLinePrefix(text,fits);assert.notEqual(prefix,null);assert.ok(text.startsWith(prefix));assert.ok(fits(prefix,true));
    const validEnds=new Set([0,...segments(text).map(g=>g.index+g.segment.length)]);assert.ok(validEnds.has(prefix.length));
  }
  assert.equal(twoLinePrefix('Short.',()=>true),null);
});
