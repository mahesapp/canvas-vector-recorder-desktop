import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './helpers/tracing-module.mjs';
const { compressionNoise, twoToneEvidence, cohereNoisyLabels } = await import(await moduleUrl('source-analysis'));
const { quantize, traceRaster } = await import(await moduleUrl('engine'));
const { chooseAutoTrace, traceAutoFinal, autoCandidates } = await import(await moduleUrl('auto-trace'));
const { evaluateSvgScene } = await import(await moduleUrl('scene-quality'));
const { findSceneDefects, localRefinementAllows } = await import(await moduleUrl('scene-defects'));
const options = { colors: 8, tolerance: .8, minArea: 4, smooth: true, removeWhite: false, whiteMode: 'none' };
function raster(w, h, pixel) {
  const result = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) result.set(pixel(x, y), (y * w + x) * 4);
  return result;
}
const inks = [[180,30,60],[245,230,190]];
const logo = (w=48,h=48) => raster(w,h,(x,y)=>[...inks[x>=12&&x<36&&y>=12&&y<36?0:1],255]);

test('compression evidence distinguishes clean edges, noisy artwork, flat grain and alpha', () => {
  const clean=raster(48,48,x=>x<24?[30,30,30,255]:[230,230,230,255]);
  const noisy=raster(48,48,(x,y)=>{const v=(x<24?30:230)+(x*7+y*11)%9-4;return [v,v,v,255];});
  assert.equal(compressionNoise(clean,48,48).detected,false);
  assert.equal(compressionNoise(noisy,48,48).detected,true);
  assert.equal(compressionNoise(raster(48,48,(x,y)=>[60+(x+y)%9,60,60,255]),48,48).detected,false);
  assert.equal(compressionNoise(raster(48,48,()=>[60,60,60,128]),48,48).samples,0);
});

test('two-tone evidence accepts colored antialias and vetoes small accents and broad gradients', () => {
  const source=logo();
  assert.equal(twoToneEvidence(source,48,48,quantize(source,2).palette),true);
  const antialias=raster(48,48,x=>{const t=Math.max(0,Math.min(1,(x-22)/3));return [...inks[0].map((v,c)=>v*(1-t)+inks[1][c]*t),255];});
  assert.equal(twoToneEvidence(antialias,48,48,inks),true);
  const accent=source.slice();accent.set([10,100,240,255],(20*48+20)*4);accent.set([10,100,240,255],(20*48+21)*4);
  assert.equal(twoToneEvidence(accent,48,48,inks),false);
  const ramp=raster(48,48,x=>[...inks[0].map((v,c)=>v+(inks[1][c]-v)*x/47),255]);
  assert.equal(twoToneEvidence(ramp,48,48,inks),false);
  assert.equal(twoToneEvidence(raster(8,8,()=>[0,0,0,0]),8,8,inks),false);
});

function components(labels,w,h) {
  const seen=new Uint8Array(labels.length), counts=new Map();
  for(let s=0;s<labels.length;s++) { if(seen[s])continue;const value=labels[s],queue=[s];seen[s]=1;counts.set(value,(counts.get(value)||0)+1);
    for(let r=0;r<queue.length;r++){const p=queue[r],x=p%w;for(const q of [x?p-1:-1,x+1<w?p+1:-1,p>=w?p-w:-1,p+w<labels.length?p+w:-1])if(q>=0&&!seen[q]&&labels[q]===value){seen[q]=1;queue.push(q);}}
  } return counts;
}

test('coherent labels remove ambiguous boundary chatter while preserving components, source and protected pixels', () => {
  const w=20,h=16,palette=[[60,60,60],[100,100,100]];
  const source=raster(w,h,(x,y)=>{const v=x<7?65:x>12?95:(x===9&&y%2===0||x>=10&&!(x===10&&y%2))?82:78;return [v,v,v,255];});
  const labels=Int16Array.from({length:w*h},(_,p)=>source[p*4]<=80?0:1), before=labels.slice(), original=source.slice();
  const protectedPixels=new Uint8Array(w*h);protectedPixels[6*w+9]=1;
  const changed=cohereNoisyLabels(source,labels,palette,w,h,protectedPixels);
  assert.ok(changed>0);assert.deepEqual(components(labels,w,h),components(before,w,h));
  assert.equal(labels[6*w+9],before[6*w+9]);assert.deepEqual(source,original);
});

test('coherent labels preserve exact colors, thin ink, alpha and enclosed holes', () => {
  const w=16,h=16,palette=[[60,60,60],[100,100,100],[210,30,40]];
  const source=raster(w,h,(x,y)=>x===8?[210,30,40,255]:x>4&&x<7&&y>4&&y<7?[0,0,0,0]:x<8?[60,60,60,255]:[100,100,100,255]);
  const labels=Int16Array.from({length:w*h},(_,p)=>!source[p*4+3]?-1:source[p*4]===210?2:source[p*4]===60?0:1), original=labels.slice();
  assert.equal(cohereNoisyLabels(source,labels,palette,w,h),0);assert.deepEqual(labels,original);
});

test('Auto measures the two-tone candidate and keeps the baseline when a candidate loses detail', () => {
  const pixels=logo(), calls=[];
  const selected=chooseAutoTrace(pixels,48,48,options,undefined,(_p,w,h,o)=>{calls.push(o);return traceRaster(pixels,w,h,o);});
  assert.ok(calls.some(o=>o.colors===2&&o.tolerance<=.35&&o.minArea===0));
  const baseline=traceRaster(pixels,48,48,options), actual=traceRaster(pixels,48,48,selected.options);
  assert.ok(evaluateSvgScene(actual.svg,pixels,48,48).error<=evaluateSvgScene(baseline.svg,pixels,48,48).error+1e-9);
  const rejected=chooseAutoTrace(pixels,48,48,options,undefined,(_p,w,h,o)=>o.colors===2?{...baseline,svg:baseline.svg.replaceAll('#b41e3c','#f5e6be'),segments:1}:baseline);
  assert.equal(rejected.index,0);
  const choices=autoCandidates(options,{twoTone:false,sourceNoisy:true});
  assert.equal(choices.filter(o=>o.noiseCleanup).length,1);assert.equal(choices[0].noiseCleanup,undefined);
});

test('full-resolution two-tone recheck rejects an accent missed by the preview', () => {
  const pixels=logo();pixels.set([10,100,240,255],(20*48+20)*4);pixels.set([10,100,240,255],(20*48+21)*4);
  const calls=[];
  const result=traceAutoFinal(pixels,48,48,1024,{...options,colors:2,tolerance:.35,minArea:0},options,undefined,(p,w,h,o)=>{calls.push(o.colors);return traceRaster(p,w,h,o);});
  assert.equal(calls[0],8);assert.equal(result.fallback,'quality');assert.ok(result.options.colors>2);
  assert.ok(result.result.colors.includes('#0a64f0'));
});

test('defect areas group adjacent bad tiles and exclude broad or insignificant error', () => {
  const tiles=new Float64Array(16);tiles[5]=12;tiles[6]=8;
  const metrics={error:20/(64*64*4),detailError:0,edgeError:.02,edgePixels:30,tiles};
  const areas=findSceneDefects(metrics,64,64);
  assert.equal(areas.length,1);assert.deepEqual(areas[0],{x0:16,y0:16,x1:48,y1:32,tiles:[5,6],error:20});
  assert.deepEqual(findSceneDefects({...metrics,tiles:new Float64Array(16).fill(20)},64,64),[]);
  assert.deepEqual(findSceneDefects({...metrics,tiles:new Float64Array(16).fill(.01)},64,64),[]);
  assert.deepEqual(findSceneDefects({...metrics,error:NaN},64,64),[]);
});

test('local repair requires a measured gain and preserves other tiles, protected detail and alpha error', () => {
  const tiles=new Float64Array(16);tiles[5]=12;tiles[6]=8;tiles[0]=.1;
  const before={error:.001,detailError:.02,edgeError:.02,edgePixels:30,tiles},areas=findSceneDefects(before,64,64);
  const improved=tiles.slice();improved[5]=8;improved[6]=5;
  const after={...before,error:.0008,edgeError:.015,tiles:improved};
  assert.equal(localRefinementAllows(before,after,areas),true);
  const outside=improved.slice();outside[0]+=.003;
  assert.equal(localRefinementAllows(before,{...after,tiles:outside},areas),false);
  assert.equal(localRefinementAllows(before,{...after,detailError:.0201},areas),false);
  assert.equal(localRefinementAllows(before,{...after,error:.0011},areas),false);
  assert.equal(localRefinementAllows(before,{...after,tiles:tiles.slice()},areas),false);
});

test('local shared-chain refit keeps the completed SVG when a proposal fails fidelity checks', () => {
  const w=128,h=128;
  const pixels=raster(w,h,(x,y)=>{let count=0;for(let dy=0;dy<3;dy++)for(let dx=0;dx<3;dx++) {const X=x+(dx+.5)/3-45,Y=y+(dy+.5)/3-45,a=Math.atan2(Y,X);if(Math.hypot(X,Y)<23+3*Math.sin(9*a))count++;}const t=count/9;return [245*(1-t)+30*t,235*(1-t)+65*t,210*(1-t)+160*t,255];});
  const o={...options,colors:2,tolerance:1.6,minArea:0},before=traceRaster(pixels,w,h,o),original=pixels.slice();
  const after=traceRaster(pixels,w,h,{...o,localRefinement:true});
  assert.ok(after.diagnostics.localDefectAreas>0);assert.ok(after.diagnostics.localRefitChains>0);
  assert.equal(after.paths,before.paths);assert.equal(after.contours,before.contours);assert.deepEqual(pixels,original);
  const a=evaluateSvgScene(before.svg,pixels,w,h),b=evaluateSvgScene(after.svg,pixels,w,h);
  assert.ok(b.error<=a.error+1e-9);assert.ok(b.edgeError<=a.edgeError+1e-9);assert.ok(b.detailError<=a.detailError+1e-9);
  if(!after.diagnostics.localRefitAccepted)assert.equal(after.svg,before.svg);
});
