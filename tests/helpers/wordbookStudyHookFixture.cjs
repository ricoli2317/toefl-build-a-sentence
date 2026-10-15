// Real React hook lifecycle, in-memory storage and no network/credentials.
// Optional renderer lives in external test dependencies, not application code.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const {createRequire}=require('node:module');
const engine=require('../../lib/lexical/wordbookReviewLocal.ts');
const model=require('../../lib/lexical/wordbookReview.ts');
const {randomUUID}=require('node:crypto');
const owner='00000000-0000-4000-8000-000000000001',session='00000000-0000-4000-8000-000000000010';
function round(){return{session:{session_id:session,domain:'reading',total:3,answered:0,status:'active'},summary:{},
  composition:{spellingPos:3,meaningChoice:0},flow:{phase:'study',position:1},cards:['one','two','three'].map((word,index)=>({
    itemId:`00000000-0000-4000-8000-00000000000${index+2}`,position:index+1,kind:'spelling_pos',sourceTypes:['ctw'],prompt:word,
    options:[{id:'noun',label:'n.'}],targetForms:[word],expected:{expression:word,pos:'noun',standardPos:'noun',meaning:'词义',
      definitionEn:null,correctOptionId:null,examples:[]}}))};}
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
async function mount({request,adapter,initial,source}={}){
  const rendererPath=process.env.WORDBOOK_REVIEW_REACT_RENDERER||'react-test-renderer';
  const renderer=require(rendererPath),React=createRequire(require.resolve(rendererPath))('react');
  const memory=new Map(),localStorage={getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,value),removeItem:key=>memory.delete(key)};
  const window=new EventTarget(),locks=new Map();
  const navigator={locks:{request(name,work){const job=(locks.get(name)||Promise.resolve()).catch(()=>{}).then(work);locks.set(name,job);return job;}}};
  const namespace=adapter?.namespace||'wordbook-review';
  if(initial)engine.saveLocalReview(localStorage,initial,namespace);
  const cache={getEntry:()=>undefined,invalidate:()=>{}},exports={};
  const mocks={react:React,'@/lib/lexical/wordbookReviewLocal':engine,
    '@/lib/lexical/wordbookReviewRequest':require('../../lib/lexical/wordbookReviewRequest.ts'),
    '@/lib/cacheInvalidation':{publishCacheInvalidation:()=>{}},
    '@/components/StudentDataCache':{useStudentDataCache:()=>cache},
    './StudentWordbook':{wordbookReadCacheKey:url=>url}};
  vm.runInNewContext(ts.transpileModule(source??fs.readFileSync(path.join(__dirname,'../../components/student/useWordbookLocalReview.ts'),'utf8'),
    {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports,localStorage,window,navigator,AbortController,
    crypto:{randomUUID},Date,setTimeout:(...args)=>setTimeout(...args),clearTimeout:timer=>clearTimeout(timer),
    require:name=>{if(!Object.hasOwn(mocks,name))throw Error('Unexpected hook dependency '+name);return mocks[name];}});
  const calls=[],send=async(url,body,signal)=>{calls.push({url,body});return request?request(url,body,signal):body?{acknowledged:body.command.id}:round();};
  let value,root;function Probe(){value=exports.useWordbookLocalReview(owner,session,send,adapter);return null;}
  await renderer.act(async()=>{root=renderer.create(React.createElement(Probe));});
  return{get value(){return value;},calls,storage:localStorage,window,namespace,owner,session,
    act:renderer.act,
    async action(name,answer){await renderer.act(async()=>{await value.action(name,answer);});},
    async storageEvent(local){engine.saveLocalReview(localStorage,local,namespace);await renderer.act(async()=>{
      window.dispatchEvent(Object.assign(new Event('storage'),{key:engine.localReviewKey(owner,session,namespace)}));});},
    async wake(type){await renderer.act(async()=>{window.dispatchEvent(new Event(type));});},
    async close(){await renderer.act(async()=>root.unmount());}};
}
module.exports={mount,round,deferred,owner,session,engine,model};
