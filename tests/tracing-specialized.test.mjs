import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './helpers/tracing-module.mjs';
const { traceRaster } = await import(await moduleUrl('engine'));
const { fitRoundedRectangle, fitGeometricPolygon, fitCircularArc } = await import(await moduleUrl('geometry-shapes'));
const { detectPixelGrid } = await import(await moduleUrl('pixel-grid'));
const { tracingSvgPaths } = await import(await moduleUrl('svg-paths'));
const { gradientColor, readGradients } = await import(await moduleUrl('gradient-paint'));
const { evaluateSvgScene } = await import(await moduleUrl('scene-quality'));
const { generatePostScript } = await import(await moduleUrl('eps-export'));
const { strokeSelfIntersects } = await import(await moduleUrl('stroke-regularizer'));
const options={colors:8,tolerance:.8,minArea:4,smooth:true,removeWhite:false,whiteMode:'none'};
function raster(w,h,pixel){const p=new Uint8ClampedArray(w*h*4);for(let y=0;y<h;y++)for(let x=0;x<w;x++)p.set(pixel(x,y),(y*w+x)*4);return p;}
function rounded(w,h,r,angle=0){const p=[];for(const [cx,cy,start] of [[w-r,r,-Math.PI/2],[w-r,h-r,0],[r,h-r,Math.PI/2],[r,r,Math.PI]])for(let i=0;i<=24;i++){const t=start+Math.PI/2*i/24,x=cx+r*Math.cos(t),y=cy+r*Math.sin(t);p.push([20+x*Math.cos(angle)-y*Math.sin(angle),20+x*Math.sin(angle)+y*Math.cos(angle)]);}p.push(p[0]);return p;}
const palette=[[230,30,40,255],[30,180,60,255],[40,70,220,255]];
const grid=(w=64,h=64)=>raster(w,h,(x,y)=>palette[(Math.floor(x/8)+Math.floor(y/8))%3]);

test('geometry recognizes rotated rounded rectangles and capsules as lines and cubic arcs',()=>{
  for(const raw of [rounded(60,30,8),rounded(60,30,8,37*Math.PI/180),rounded(60,24,12)]){
    const result=fitRoundedRectangle(raw);assert.ok(result);assert.ok(result.length<=8);assert.equal(strokeSelfIntersects(result),false);
    assert.deepEqual(result[0].from,result.at(-1).to);assert.ok(result.some(c=>c.controls));
  }
  assert.equal(fitRoundedRectangle([[0,0],[1,0],[1,1],[0,0]]),undefined);
});

test('polygon reconstruction retains sharp sides and rejects a curved outline',()=>{
  const p=[];for(const [a,b] of [[[0,0],[60,0]],[[60,0],[60,30]],[[60,30],[0,30]],[[0,30],[0,0]]])for(let i=0;i<20;i++)p.push(a.map((v,k)=>v+(b[k]-v)*i/20));p.push(p[0]);
  const result=fitGeometricPolygon(p);assert.equal(result.length,4);assert.ok(result.every(c=>!c.controls));
  assert.equal(fitGeometricPolygon(rounded(60,30,12)),undefined);
});

test('shared circular arcs keep both junction endpoints exactly in either direction',()=>{
  const p=Array.from({length:81},(_,i)=>{const a=.2+1.5*i/80;return [30+20*Math.cos(a),30+20*Math.sin(a)];});
  for(const raw of [p,[...p].reverse()]){const result=fitCircularArc(raw);assert.ok(result);assert.deepEqual(result[0].from,raw[0]);assert.deepEqual(result.at(-1).to,raw.at(-1));assert.equal(strokeSelfIntersects(result),false);}
  assert.equal(fitCircularArc(Array.from({length:40},(_,i)=>[i,0])),undefined);
});

test('production rounded geometry reduces both source error and segment count',()=>{
  const w=96,h=64,r=8,pixels=raster(w,h,(x,y)=>{let n=0;for(let dy=0;dy<4;dy++)for(let dx=0;dx<4;dx++){const X=Math.abs(x+(dx+.5)/4-48)-35+r,Y=Math.abs(y+(dy+.5)/4-32)-16+r;if(Math.hypot(Math.max(X,0),Math.max(Y,0))+Math.min(0,Math.max(X,Y))-r<0)n++;}return [255-235*n/16,255-195*n/16,255-95*n/16,255];});
  const o={...options,colors:2,minArea:0,pixelArt:false,gradients:false},before=traceRaster(pixels,w,h,{...o,geometry:false}),after=traceRaster(pixels,w,h,o);
  assert.ok(after.diagnostics.geometricShapes>0);assert.ok(after.segments<before.segments);assert.equal(after.paths,before.paths);assert.equal(after.contours,before.contours);
  assert.ok(evaluateSvgScene(after.svg,pixels,w,h).error<evaluateSvgScene(before.svg,pixels,w,h).error);
});

test('pixel grid traces a three-color checker as three compound orthogonal vector paths',()=>{
  const pixels=grid(),original=pixels.slice(),found=detectPixelGrid(pixels,64,64);assert.equal(found.cols,8);assert.equal(found.rows,8);
  const result=traceRaster(pixels,64,64,options);assert.equal(result.diagnostics.pixelGridCells,64);assert.equal(result.paths,3);assert.doesNotMatch(result.svg,/C|<image/);
  assert.ok(evaluateSvgScene(result.svg,pixels,64,64).error<1e-25);assert.deepEqual(pixels,original);
  assert.equal(result.width,64);assert.equal(result.height,64);
});

test('pixel art preserves holes, transparent RGB and white artwork',()=>{
  const pixels=grid();for(let y=24;y<32;y++)for(let x=24;x<32;x++)pixels.set([255,0,255,0],(y*64+x)*4);
  for(let y=32;y<40;y++)for(let x=32;x<40;x++)pixels.set([255,255,255,255],(y*64+x)*4);
  for(const whiteMode of ['none','background','all']){
    const result=traceRaster(pixels,64,64,{...options,whiteMode,removeWhite:whiteMode!=='none'});
    assert.ok(result.diagnostics.pixelGridCells>0);assert.ok(evaluateSvgScene(result.svg,pixels,64,64,whiteMode!=='none').error<1e-20);
    assert.equal(result.colors.includes('#ffffff'),whiteMode!=='all');
  }
});

test('grid detection rejects logos, smooth gradients, nonperiodic shapes and disabled mode',()=>{
  const logo=raster(64,64,(x,y)=>Math.hypot(x-32,y-32)<20?palette[0]:[255,255,255,255]);
  assert.equal(detectPixelGrid(logo,64,64),undefined);
  assert.equal(detectPixelGrid(raster(64,64,(x,y)=>[x*4,y*4,50,255]),64,64),undefined);
  const result=traceRaster(grid(),64,64,{...options,pixelArt:false,gradients:false,smooth:false});assert.equal(result.diagnostics.pixelGridCells,undefined);
});

function gradientRaster(kind,w=64,h=64){return raster(w,h,(x,y)=>{const t=kind==='linear'?(x+.5)/w:Math.min(1,Math.hypot(x+.5-w/2,y+.5-h/2)/(w*.4375));return [220-190*t,40+120*t,60+150*t,255];});}
test('production traces linear and radial paints as editable gradients rather than color bands',()=>{
  for(const kind of ['linear','radial']){const pixels=gradientRaster(kind),original=pixels.slice(),result=traceRaster(pixels,64,64,{...options,colors:4});
    assert.equal(result.diagnostics.gradientRegions,1);assert.equal(result.paths,1);assert.equal(result.segments,4);
    assert.match(result.svg,new RegExp(`<${kind}Gradient`));assert.doesNotMatch(result.svg,/<image/);
    const metrics=evaluateSvgScene(result.svg,pixels,64,64);assert.ok(metrics.error<1e-5);assert.equal(result.diagnostics.sceneErrorAfter,metrics.error);assert.deepEqual(pixels,original);
    assert.ok(result.colors.every(c=>/^#[0-9a-f]{6}$/i.test(c)));
  }
});

test('gradient proposals retain a coherent contrasting two-pixel accent and allow opt-out',()=>{
  const pixels=gradientRaster('linear');pixels.set([0,255,0,255],(30*64+30)*4);pixels.set([0,255,0,255],(30*64+31)*4);
  const withDetail=traceRaster(pixels,64,64,{...options,minArea:0});assert.ok(withDetail.colors.some(c=>c==='#00ff00'));
  const disabled=traceRaster(gradientRaster('linear'),64,64,{...options,gradients:false,pixelArt:false});assert.doesNotMatch(disabled.svg,/<(?:linear|radial)Gradient/);
});

test('gradient regions preserve opaque backdrops, source alpha and antialiased silhouettes',()=>{
  for(const kind of ['rectangle','transparent','circle']){const pixels=raster(64,64,(x,y)=>{const t=Math.max(0,Math.min(1,(x-12)/40)),rgb=[220-190*t,40+120*t,60+150*t],alpha=kind==='circle'?Math.max(0,Math.min(1,22.5-Math.hypot(x+.5-32,y+.5-32))):x>=12&&x<52&&y>=12&&y<52?1:0;return kind==='transparent'?[...rgb,255*alpha]:[...rgb.map(c=>c*alpha+255*(1-alpha)),255];});
    const result=traceRaster(pixels,64,64,{...options,minArea:0});assert.equal(result.diagnostics.gradientRegions,1);assert.ok(evaluateSvgScene(result.svg,pixels,64,64).error<1e-5);assert.equal(result.paths,kind==='transparent'?1:2);
  }
});

test('gradient parser and evaluator support multiple stops and even-odd transparent holes',()=>{
  const svg='<svg><defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="8" y2="0"><stop offset="0" stop-color="#ff0000"/><stop offset="0.5" stop-color="#00ff00"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs><path fill="url(#g)" fill-rule="evenodd" d="M0 0L8 0L8 8L0 8ZM2 2L6 2L6 6L2 6Z"/></svg>';
  const g=readGradients(svg).get('g'),p=raster(8,8,(x,y)=>x>=2&&x<6&&y>=2&&y<6?[200,0,200,0]:[...gradientColor(g,x+.5,y+.5).map(v=>v*255),255]);
  assert.ok(evaluateSvgScene(svg,p,8,8).error<1e-5);assert.equal(tracingSvgPaths(svg).length,1);
  const eps=generatePostScript(svg);assert.match(eps,/\/ShadingType 2/);assert.match(eps,/\/FunctionType 3/);assert.match(eps,/\/Bounds \[0.5\]/);assert.match(eps,/eoclip\nnewpath\n/);assert.match(eps,/shfill/);
  assert.throws(()=>tracingSvgPaths(svg.replace('url(#g)','url(#missing)')),/Gradasi/);
  assert.throws(()=>readGradients(svg.replace('x2="8"','x2="NaN"')),/Koordinat/);
  assert.throws(()=>readGradients(svg.replace('offset="0.5"','offset="0"')),/Warna/);
});

test('EPS gradients retain path transform and clipping and never become raster images',()=>{
  for(const kind of ['linear','radial']){const result=traceRaster(gradientRaster(kind),64,64,options),svg=result.svg.replace('<path ', '<path transform="matrix(2 0 0 3 10 20)" '),eps=generatePostScript(svg);
    assert.match(eps,/\[2 0 0 3 10 20\] concat/);assert.match(eps,new RegExp(`/ShadingType ${kind==='linear'?2:3}`));assert.doesNotMatch(eps,/\b(?:image|colorimage)\b/);
    assert.ok(eps.indexOf('concat\n')<eps.indexOf('shfill'));
  }
});
