// Reproducible paired Auto audit against a Git revision, on identical RGBA.
// node tests/tracing-source-quality.mjs [baseline-ref=HEAD] [max-side=128]
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { moduleUrl } from './helpers/tracing-module.mjs';
const ref = process.argv[2] ?? 'HEAD', side = Number(process.argv[3] ?? 128);
if (!Number.isInteger(side) || side < 32 || side > 192) throw Error('Audit side must be 32–192.');
const baselineCache = new Map();
async function baselineUrl(name) {
  if (baselineCache.has(name)) return baselineCache.get(name);
  const source = execFileSync('git', ['show', `${ref}:src/tracing/${name}.ts`], { encoding: 'utf8' });
  let js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const [, dependency] of js.matchAll(/from ['"]\.\/([^'"]+)['"]/g)) js = js.replaceAll(`'./${dependency}'`, `'${await baselineUrl(dependency)}'`).replaceAll(`"./${dependency}"`, `"${await baselineUrl(dependency)}"`);
  const url = 'data:text/javascript;base64,' + Buffer.from(js).toString('base64'); baselineCache.set(name, url); return url;
}
const before = await import(await baselineUrl('auto-trace')), after = await import(await moduleUrl('auto-trace'));
const { resizeRaster } = await import(await moduleUrl('auto-raster'));
const { evaluateSvgScene } = await import(await moduleUrl('scene-quality'));
const { recommendAutoSettings } = await import(await moduleUrl('auto-settings'));
function raster(width, height, pixel) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set(pixel(x,y), (y*width+x)*4);
  return { pixels, width, height };
}
async function bmp(path) {
  const b=await readFile(path),width=b.readInt32LE(18),signedHeight=b.readInt32LE(22),height=Math.abs(signedHeight),bits=b.readUInt16LE(28),offset=b.readUInt32LE(10),stride=Math.ceil(width*bits/32)*4;
  const compression=b.readUInt32LE(30),bgra=compression===3&&bits===32&&b.readUInt32LE(14)>=56&&b.length>=70&&[0xff0000,0xff00,0xff,0xff000000].every((mask,i)=>b.readUInt32LE(54+i*4)===mask);
  if(b.toString('ascii',0,2)!=='BM'||width<1||height<1||![24,32].includes(bits)||compression!==0&&!bgra||offset+stride*height>b.length)throw Error(`Unsupported BMP: ${path}`);
  return raster(width,height,(x,y)=>{const i=offset+(signedHeight<0?y:height-1-y)*stride+x*bits/8;return [b[i+2],b[i+1],b[i],bgra?b[i+3]:255];});
}
const walnut=gunzipSync(await readFile(new URL('./fixtures/walnut-contour-source.rgba.gz',import.meta.url)));
const fixtures = [
  ['sparkle',{width:28,height:28,pixels:new Uint8ClampedArray(await readFile(new URL('./fixtures/sparkle-source-28x28.rgba',import.meta.url)))}],
  ['walnut',{width:walnut.readUInt32BE(0),height:walnut.readUInt32BE(4),pixels:new Uint8ClampedArray(walnut.subarray(8))}],
  ['doodle',await bmp('RND/tracing-quality/shipping-regions-v8/source.bmp')],
  ['barong',await bmp('RND/tracing-quality/barong-lines-v10/source.bmp')],
  ['colored-logo',raster(96,96,(x,y)=>{const t=Math.max(0,Math.min(1,Math.hypot(x+.5-48,y+.5-48)-27));return [30+(245-30)*t,65+(235-65)*t,160+(210-160)*t,255];})],
  ['noisy-art',raster(96,96,(x,y)=>{const c=x<48?[45,60,90]:[230,220,200],n=(x*7+y*11)%9-4;return [...c.map(v=>v+n),255];})],
];
const output='build/source-analysis-audit';await mkdir(output,{recursive:true});const report=[];
for(const [name,source] of fixtures) {
  const input=resizeRaster(source.pixels,source.width,source.height,side),recommendation=recommendAutoSettings(input.pixels,input.width,input.height,Math.max(source.width,source.height));
  const results={};
  for(const [label,engine] of [['before',before],['after',after]]) {
    const start=performance.now(),out=engine.traceAuto(input.pixels,input.width,input.height,undefined,undefined,undefined,'none',Math.max(source.width,source.height));
    const metrics=evaluateSvgScene(out.result.svg,input.pixels,input.width,input.height);
    results[label]={ms:performance.now()-start,svgSha256:createHash('sha256').update(out.result.svg).digest('hex'),options:out.auto.options,attempted:out.auto.selection.attempted,error:metrics.error,edgeError:metrics.edgeError,detailError:metrics.detailError,paths:out.result.paths,contours:out.result.contours,segments:out.result.segments,diagnostics:out.result.diagnostics};
    await writeFile(`${output}/${name}-${label}.svg`,out.result.svg);
  }
  const record={name,width:input.width,height:input.height,sourceSha256:createHash('sha256').update(input.pixels).digest('hex'),evidence:{sourceNoisy:recommendation.sourceNoisy,twoTone:recommendation.twoTone},...results};
  report.push(record);console.log(JSON.stringify({name,evidence:record.evidence,before:{error:results.before.error,segments:results.before.segments,ms:Math.round(results.before.ms)},after:{error:results.after.error,segments:results.after.segments,ms:Math.round(results.after.ms)}}));
}
await writeFile(`${output}/report.json`,JSON.stringify({baseline:ref,side,scope:'Paired working rasters; single-run timing, not a performance benchmark',fixtures:report},null,2)+'\n');
