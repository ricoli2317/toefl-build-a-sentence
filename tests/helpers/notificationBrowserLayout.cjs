const assert=require('node:assert/strict');
const {deflateSync}=require('node:zlib');
function png(width=1600,height=800){
 const crc=bytes=>{let n=0xffffffff;for(const byte of bytes){n^=byte;for(let j=0;j<8;j++)n=(n>>>1)^((n&1)?0xedb88320:0);}return(n^0xffffffff)>>>0;};
 const chunk=(type,body)=>{const tag=Buffer.from(type),size=Buffer.alloc(4),checksum=Buffer.alloc(4);size.writeUInt32BE(body.length);checksum.writeUInt32BE(crc(Buffer.concat([tag,body])));return Buffer.concat([size,tag,body,checksum]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
 const pixels=Buffer.alloc((width*3+1)*height);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const at=y*(width*3+1)+1+x*3;pixels[at]=70;pixels[at+1]=100+(Math.floor(y/80)%2)*60;pixels[at+2]=210;}
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
async function geometry(page,dialog,label){
 const bounds=await dialog.boundingBox();assert.ok(bounds,label+' visible');
 const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth}));
 assert.ok(Math.abs(bounds.width-viewport.width*.8)<2,`${label}: expected 80vw, got ${bounds.width}/${viewport.width}`);
 assert.ok(bounds.height<=viewport.height*.9+1,`${label}: exceeds 90vh`);
 if(viewport.overflow){const overflow=await dialog.evaluate(el=>({documentWidth:document.documentElement.scrollWidth,viewport:innerWidth,dialogWidth:el.scrollWidth,offenders:Array.from(document.body.querySelectorAll('*')).filter(n=>{const b=n.getBoundingClientRect();return b.width>0&&b.right>innerWidth+1;}).slice(0,8).map(n=>({tag:n.tagName,className:typeof n.className==='string'?n.className:'',insideDialog:el.contains(n),right:n.getBoundingClientRect().right}))}));assert.fail(label+' document overflow: '+JSON.stringify(overflow));}
 const data=await dialog.evaluate(el=>({overflow:el.scrollWidth>el.clientWidth+1,bodyOverflow:getComputedStyle(el.querySelector('[data-notification-scroll]')).overflowY,
   body:el.querySelector('[data-notification-scroll]').getBoundingClientRect().toJSON(),footer:el.querySelector('footer')?.getBoundingClientRect().toJSON()}));
 assert.equal(data.overflow,false,label+' dialog overflow');assert.equal(data.bodyOverflow,'auto');
 if(data.footer)assert.ok(data.footer.bottom<=bounds.y+bounds.height+1,label+' footer outside panel');
 return{label,viewport:viewport.width,width:bounds.width,height:bounds.height};
}
module.exports={png,geometry};
