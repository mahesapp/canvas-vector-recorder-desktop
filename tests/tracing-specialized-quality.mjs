// Paired production tracing with the three new mechanisms disabled/enabled.
// node tests/tracing-specialized-quality.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gunzipSync, deflateSync } from 'node:zlib';
import { moduleUrl } from './helpers/tracing-module.mjs';
const { traceRaster } = await import(await moduleUrl('engine'));
const { resizeRaster } = await import(await moduleUrl('auto-raster'));
const { evaluateSvgScene } = await import(await moduleUrl('scene-quality'));
const { generatePostScript } = await import(await moduleUrl('eps-export'));
const output='build/specialized-tracing';await mkdir(output,{recursive:true});
const options={colors:8,tolerance:.8,minArea:0,smooth:true,removeWhite:false,whiteMode:'none'};
function raster(width,height,pixel){const pixels=new Uint8ClampedArray(width*height*4);for(let y=0;y<height;y++)for(let x=0;x<width;x++)pixels.set(pixel(x,y),(y*width+x)*4);return {width,height,pixels};}
const cases=[
  ['rounded-rectangle',raster(96,64,(x,y)=>{let n=0;const r=8;for(let dy=0;dy<4;dy++)for(let dx=0;dx<4;dx++){const X=Math.abs(x+(dx+.5)/4-48)-35+r,Y=Math.abs(y+(dy+.5)/4-32)-16+r;if(Math.hypot(Math.max(X,0),Math.max(Y,0))+Math.min(0,Math.max(X,Y))-r<0)n++;}return [255-235*n/16,255-195*n/16,255-95*n/16,255];}),{colors:2}],
  ['pixel-art',raster(64,64,(x,y)=>[[230,30,40,255],[30,180,60,255],[40,70,220,255]][(Math.floor(x/8)+Math.floor(y/8))%3])],
  ...['linear','radial','gradient-object'].map(name=>[name,raster(64,64,(x,y)=>{const t=name==='radial'?Math.min(1,Math.hypot(x+.5-32,y+.5-32)/28):(x+.5)/64,rgb=[220-190*t,40+120*t,60+150*t],a=name==='gradient-object'?Math.max(0,Math.min(1,22.5-Math.hypot(x+.5-32,y+.5-32))):1;return [...rgb.map(c=>c*a+255*(1-a)),255];})]),
];
const walnut=gunzipSync(await readFile(new URL('./fixtures/walnut-contour-source.rgba.gz',import.meta.url)));
cases.push(['walnut',resizeRaster(new Uint8ClampedArray(walnut.subarray(8)),walnut.readUInt32BE(0),walnut.readUInt32BE(4),128)]);
for(const [name,path] of [['doodle','RND/tracing-quality/shipping-regions-v8/source.bmp'],['barong','RND/tracing-quality/barong-lines-v10/source.bmp']]){
  const b=await readFile(path),w=b.readInt32LE(18),signed=b.readInt32LE(22),h=Math.abs(signed),bits=b.readUInt16LE(28),offset=b.readUInt32LE(10),stride=Math.ceil(w*bits/32)*4,alpha=b.readUInt32LE(30)===3;
  if(![24,32].includes(bits))throw Error('Unsupported audit BMP.');const src=raster(w,h,(x,y)=>{const i=offset+(signed<0?y:h-1-y)*stride+x*bits/8;return [b[i+2],b[i+1],b[i],alpha?b[i+3]:255];});
  cases.push([name,resizeRaster(src.pixels,w,h,128)]);
}
function png(p,w,h){const crc=b=>{let c=-1;for(const v of b){c^=v;for(let k=0;k<8;k++)c=c>>>1^(c&1?0xedb88320:0);}return (c^-1)>>>0;};const chunk=(name,b)=>{const payload=Buffer.concat([Buffer.from(name),b]),header=Buffer.alloc(4),tail=Buffer.alloc(4);header.writeUInt32BE(b.length);tail.writeUInt32BE(crc(payload));return Buffer.concat([header,payload,tail]);};const header=Buffer.alloc(13);header.writeUInt32BE(w);header.writeUInt32BE(h,4);header[8]=8;header[9]=6;const rows=Buffer.alloc(h*(w*4+1));for(let y=0;y<h;y++)rows.set(p.subarray(y*w*4,(y+1)*w*4),y*(w*4+1)+1);return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);}
const report=[];
for(const [name,source,overrides] of cases){const {pixels,width,height}=source;await writeFile(`${output}/${name}-source.png`,png(pixels,width,height));const measurements={};
  for(const enabled of [false,true]){const label=enabled?'after':'before',o={...options,...overrides,geometry:enabled,pixelArt:enabled,gradients:enabled},start=performance.now(),result=traceRaster(pixels,width,height,o),metrics=evaluateSvgScene(result.svg,pixels,width,height);
    measurements[label]={error:metrics.error,edgeError:metrics.edgeError,detailError:metrics.detailError,paths:result.paths,contours:result.contours,segments:result.segments,bytes:result.svg.length,ms:performance.now()-start,geometry:result.diagnostics.geometricShapes??0,gridCells:result.diagnostics.pixelGridCells??0,gradients:result.diagnostics.gradientRegions??0};
    await writeFile(`${output}/${name}-${label}.svg`,result.svg);if(enabled)await writeFile(`${output}/${name}.eps`,generatePostScript(result.svg,name));}
  report.push({name,width,height,...measurements});console.log(JSON.stringify(report.at(-1)));
}
await writeFile(`${output}/report.json`,JSON.stringify({scope:'Identical working rasters; before disables geometry, pixelArt and gradients. Timings are single-run measurements.',cases:report},null,2)+'\n');
await writeFile(`${output}/index.html`,`<!doctype html><meta charset="utf-8"><title>Specialized tracing audit</title><style>body{font:15px system-ui;margin:32px;background:#eee;color:#222}section{background:white;padding:20px;margin:20px 0;border-radius:12px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}img{width:100%;height:220px;object-fit:contain;background:repeating-conic-gradient(#ddd 0 25%,white 0 50%) 0/16px 16px}pre{white-space:pre-wrap;font-size:12px}</style><h1>Geometri, pixel art, dan gradasi</h1><p>Kiri: sumber. Tengah: fitur baru dimatikan. Kanan: fitur baru diaktifkan.</p>${report.map(r=>`<section><h2>${r.name}</h2><div class="grid">${['source.png','before.svg','after.svg'].map(f=>`<img src="${r.name}-${f}">`).join('')}</div><pre>${JSON.stringify({before:r.before,after:r.after},null,2)}</pre><a href="${r.name}.eps">EPS</a></section>`).join('')}`);
