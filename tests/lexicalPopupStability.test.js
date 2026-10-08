const test=require('node:test');const assert=require('node:assert/strict');
const {lexicalPopupPosition,lexicalPopupNaturalHeight}=require('../lib/lexical/position.ts');
test('old constrained outer-height measurement reproduces the BAS/RAP above/below feedback cycle',()=>{
  const anchor={left:200,right:250,top:180,bottom:200},viewport={width:800,height:600};
  const intrinsic=450;let outer=intrinsic;const sides=[];
  for(let i=0;i<6;i++){const p=lexicalPopupPosition(anchor,{width:448,height:outer},viewport);sides.push(p.placement);outer=Math.min(intrinsic,p.maxHeight);}
  assert.deepEqual(sides,['below','below','below','below','below','below']);
  // Original policy flipped whenever outer > below, even when above was smaller.
  let measured=intrinsic;const old=[];
  for(let i=0;i<6;i++){const flip=measured>384;old.push(flip?'above':'below');measured=Math.min(intrinsic,flip?164:384)+2;}
  assert.deepEqual(old,['above','below','above','below','above','below']);
});
test('unconstrained content height stays stable after maxHeight, save feedback growth, viewport changes',()=>{
  for(const top of [20,180,460,560]) {
    const anchor={left:200,right:250,top,bottom:top+20},viewport={width:800,height:600};let side;
    for(const contentHeight of [416,442,442,442,390]) {
      let p;
      for(let i=0;i<20;i++){
        const h=lexicalPopupNaturalHeight({scrollHeight:contentHeight},{offsetHeight:120,clientHeight:118});
        const next=lexicalPopupPosition(anchor,{width:448,height:h},viewport,side);
        if(p)assert.deepEqual(next,p);p=next;side=p.placement;
        assert.ok(p.top>=8);assert.ok(p.top+Math.min(h,p.maxHeight)<=592);
      }
    }
  }
});
