import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { moduleUrl } from './helpers/tracing-module.mjs';
const { cleanContour, contourBendEnergy, allowsContourCleanup, flatArtwork } = await import(await moduleUrl('contour-cleanup'));
const { fitWithSharedTangents, compactSmoothCurves, curveDeviation, traceRaster } = await import(await moduleUrl('engine'));
const { flattenStroke, strokeSelfIntersects } = await import(await moduleUrl('stroke-regularizer'));
const { evaluateSvgScene, sceneAllows } = await import(await moduleUrl('scene-quality'));
const adapter = { fit: fitWithSharedTangents, compact: compactSmoothCurves };
function lines(points) { return points.slice(1).map((to, i) => ({from:points[i],to})); }
function noisyArc() {
  return lines(Array.from({length:81}, (_, i) => {
    const angle=Math.PI*i/80, radius=80+.22*Math.sin(angle*32);
    return [100+radius*Math.cos(angle),20+radius*Math.sin(angle)];
  }));
}

test('bounded cleanup reduces broad arc chatter while preserving endpoints and symmetric deviation', () => {
  const input=noisyArc(), original=structuredClone(input), output=cleanContour(input,adapter);
  assert.notEqual(output,input);assert.ok(output.length<input.length);
  assert.ok(contourBendEnergy(output)<contourBendEnergy(input)*.7);
  assert.ok(curveDeviation(output,flattenStroke(input))<=.65);
  assert.ok(curveDeviation(input,flattenStroke(output))<=.65);
  assert.deepEqual(output[0].from,input[0].from);assert.deepEqual(output.at(-1).to,input.at(-1).to);
  assert.equal(strokeSelfIntersects(output),false);assert.deepEqual(input,original);
});

test('cleanup preserves an intentional corner and its straight leg', () => {
  const input=noisyArc(), corner=input.at(-1).to;input.push({from:corner,to:[corner[0],140]});
  const output=cleanContour(input,adapter);
  assert.ok(output.some(c=>c.to[0]===corner[0]&&c.to[1]===corner[1]));
  assert.ok(output.some(c=>c.from[0]===corner[0]&&c.from[1]===corner[1]));
  assert.ok(output.some(c=>!c.controls&&Math.abs(c.to[1]-c.from[1])>100));
});

test('long shallow arcs get gentle cleanup; small glyphs, narrow strokes and sharp polygons stay intact', () => {
  const shallow=lines(Array.from({length:121},(_,i)=>[i*2,20+6*Math.sin(Math.PI*i/120)+.14*Math.sin(Math.PI*i/2)]));
  const output=cleanContour(shallow,adapter);
  assert.notEqual(output,shallow);assert.ok(contourBendEnergy(output)<contourBendEnergy(shallow)*.7);
  assert.ok(curveDeviation(output,flattenStroke(shallow))<=.42);
  const small=noisyArc().map(c=>({from:c.from.map(v=>v*.2),to:c.to.map(v=>v*.2)}));
  assert.equal(cleanContour(small,adapter),small);
  const polygon=lines([[0,100],[50,0],[70,80],[80,20],[90,80],[150,0],[170,100],[0,100]]);
  assert.equal(cleanContour(polygon,adapter),polygon);
  const narrow=lines([...Array.from({length:61},(_,i)=>[i*2,20+.1*Math.sin(i)]),...Array.from({length:61},(_,i)=>[120-i*2,23+.1*Math.sin(60-i)]),[0,20]]);
  assert.equal(cleanContour(narrow,adapter),narrow);
});

test('cleanup fidelity budget never relaxes detail protection or accepts nonfinite metrics', () => {
  const before={error:.001,edgeError:.01,detailError:.01,tiles:new Float64Array([0]),edgePixels:1};
  const after={...before,error:.0011,edgeError:.011,detailError:.01005};
  assert.equal(allowsContourCleanup(before,after),true);assert.equal(sceneAllows(before,after),false);
  assert.equal(allowsContourCleanup(before,{...after,detailError:.0102}),false);
  assert.equal(allowsContourCleanup(before,{...after,error:.0013}),false);
  assert.equal(allowsContourCleanup(before,{...after,edgeError:.013}),false);
  assert.equal(allowsContourCleanup(before,{...after,tiles:new Float64Array([7])}),false);
  assert.equal(allowsContourCleanup(before,{...after,tiles:new Float64Array(0)}),false);
  assert.equal(allowsContourCleanup(before,{...after,error:NaN}),false);
});

test('photographic evidence and tiny sources do not qualify as flat artwork', () => {
  const photo=new Uint8ClampedArray(4096*4);
  for(let i=0;i<4096;i++)photo.set([(i>>>8)*16,((i>>>4)&15)*16,(i&15)*16,255],i*4);
  assert.equal(flatArtwork(photo),false);
  for(let i=0;i<photo.length;i+=4)photo.set([255,180,0,255],i);
  assert.equal(flatArtwork(photo),true);assert.equal(flatArtwork(photo.subarray(0,63*4)),false);
  photo.fill(0);assert.equal(flatArtwork(photo),false);
});

test('production walnut cleanup accepts a bounded smoother contour on the frozen 2x bitmap', async () => {
  const bytes=gunzipSync(await readFile(new URL('fixtures/walnut-contour-upscale.rgba.gz',import.meta.url)));
  const w=bytes.readInt32BE(0),h=bytes.readInt32BE(4),pixels=new Uint8ClampedArray(bytes.subarray(8));
  assert.equal(w,1024);assert.equal(h,1024);assert.equal(pixels.length,w*h*4);
  const options={colors:8,tolerance:3.2,minArea:96,smooth:true,removeWhite:true,whiteMode:'background'};
  const result=traceRaster(pixels,w,h,options),d=result.diagnostics,measured=evaluateSvgScene(result.svg,pixels,w,h,true);
  assert.ok(d.contourCleanupCandidates>0);assert.equal(d.contourCleanupAccepted,1);
  assert.ok(d.contourBendAfter<d.contourBendBefore*.7);
  assert.equal(d.sceneErrorAfter,measured.error);assert.equal(d.sceneEdgeAfter,measured.edgeError);
  assert.ok(d.contourDetailAfter<=d.contourDetailBefore*1.01+1e-9);
  assert.ok(result.paths>0);assert.ok(result.contours>=result.paths);
});

test('production cleanup keeps a rejected candidate and bypasses strict-detail and polygon modes', async () => {
  const bytes=gunzipSync(await readFile(new URL('fixtures/walnut-contour-source.rgba.gz',import.meta.url)));
  const w=bytes.readInt32BE(0),h=bytes.readInt32BE(4),pixels=new Uint8ClampedArray(bytes.subarray(8));
  const options={colors:8,tolerance:1.6,minArea:24,smooth:true,removeWhite:true,whiteMode:'background'};
  const result=traceRaster(pixels,w,h,options),d=result.diagnostics,measured=evaluateSvgScene(result.svg,pixels,w,h,true);
  assert.ok(d.contourCleanupCandidates>0);assert.equal(d.contourCleanupAccepted,0);
  assert.equal(d.sceneErrorAfter,measured.error);assert.equal(d.sceneEdgeAfter,measured.edgeError);
  const small=new Uint8ClampedArray(32*32*4).fill(255);
  for(let y=8;y<24;y++)for(let x=8;x<24;x++)small.set([0,0,0,255],(y*32+x)*4);
  for(const settings of [{...options,tolerance:.8},{...options,smooth:false}]) {
    const untouched=traceRaster(small,32,32,settings);assert.equal(untouched.diagnostics.contourCleanupCandidates,0);
  }
});
