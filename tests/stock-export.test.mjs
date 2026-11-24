import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { Window } from 'happy-dom';
import { moduleUrl } from './helpers/tracing-module.mjs';
const { stockSvg, checkStockSize } = await import(await moduleUrl('stock-export'));
const { generatePostScript, parseSvgDimensions } = await import(await moduleUrl('eps-export'));
const { batchZip } = await import(await moduleUrl('batch-zip'));
const { tracingSvgPaths } = await import(await moduleUrl('svg-paths'));
const { exportDefaults, exportSource, initGlobalExportSettings, validateExportSettings } = await import(await moduleUrl('export-settings'));
const { traceRaster } = await import(await moduleUrl('engine'));
// Run the production browser export path; only the native host is simulated.
let renderer = ts.transpileModule(await readFile(new URL('../src/tracing/export-render.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const host = 'data:text/javascript;base64,' + Buffer.from('export const isTauri=()=>false;export const invoke=()=>{throw new Error("Unexpected native export");};').toString('base64');
renderer = renderer.replaceAll("'@tauri-apps/api/core'", JSON.stringify(host));
for (const [, dependency] of renderer.matchAll(/from ['"]\.\/([^'"]+)['"]/g)) {
  renderer = renderer.replaceAll(`'./${dependency}'`, JSON.stringify(await moduleUrl(dependency)));
}
const { renderExport } = await import('data:text/javascript;base64,' + Buffer.from(renderer).toString('base64'));

test('stock exports fit 15–65 MP while preserving geometry and centering EPS', () => {
  for (const [w,h] of [[1024,1024],[2048,1529],[10000,10000],[2400,32]]) {
    const original = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path fill="#000000" d="M0 0L${w} 0L${w} ${h}Z"/></svg>`;
    const svg = stockSvg(original);
    const { width, height } = parseSvgDimensions(svg);
    assert.ok(width * height >= 15_000_000 && width * height <= 65_000_000);
    assert.equal(svg.match(/<path.*$/)[0], original.match(/<path.*$/)[0]);
    assert.match(svg, new RegExp(`viewBox="0 0 ${w} ${h}"`));
    assert.match(generatePostScript(svg), new RegExp(`%%BoundingBox: 0 0 ${width} ${height}`));
    assert.equal(stockSvg(svg), svg);
  }
  const svg = stockSvg('<svg width="1024" height="1024" viewBox="0 0 1024 1024"><path d="M0 0L1024 0L1024 1024Z"/></svg>');
  assert.match(generatePostScript(svg), /3\.7822 3\.7822 scale/);
});

test('stock export rejects invalid dimensions and files above 45 MB', () => {
  for (const box of ['0 0 0 4', '0 0 NaN 4', '1 0 4 4']) assert.throws(() => stockSvg(`<svg viewBox="${box}"></svg>`));
  checkStockSize(new Uint8Array(45_000_000));
  assert.throws(() => checkStockSize(new Uint8Array(45_000_001)), /45 MB/);
  assert.throws(() => batchZip([{ filename: 'large.eps', svg: '', bytes: new Uint8Array(45_000_001) }]), /45 MB/);
});

test('browser export layout preserves underpaint clipping in SVG and EPS', async () => {
  const domain = 'M1 1L7 1L7 7L1 7ZM3 3L3 5L5 5L5 3Z';
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8"><defs><clipPath id="seam" clipPathUnits="userSpaceOnUse"><path clip-rule="nonzero" d="${domain}"/></clipPath></defs><path fill="#ff0000" fill-rule="evenodd" clip-path="url(#seam)" d="M0 0L8 0L8 8L0 8Z"/></svg>`;
  for (const removeWhiteBackground of [true, false]) {
    const settings = { minMp:15, maxMp:65, ratio:'4:5', artworkScale:1.3, removeWhiteBackground };
    const svg = await renderExport(source, settings, 'svg', 'clipped');
    assert.match(svg, /<clipPath id="seam" clipPathUnits="userSpaceOnUse">/);
    const paths = tracingSvgPaths(svg);
    assert.equal(paths.length, removeWhiteBackground ? 1 : 2, 'definitions are not painted');
    assert.equal(paths.at(-1).clip, domain);
    assert.match(paths.at(-1).original, /transform="matrix\(/);
    assert.doesNotMatch(svg.match(/<defs>[\s\S]*?<\/defs>/)[0], /transform=/, 'clip uses the painted path coordinate system');
    const eps = await renderExport(source, settings, 'eps', 'clipped');
    assert.equal(eps.match(/\nclip\n/g)?.length, 1);
    assert.equal(eps.match(/setrgbcolor/g)?.length, removeWhiteBackground ? 1 : 2);
    assert.match(eps, /3 3 moveto\n3 5 lineto\n5 5 lineto\n5 3 lineto\nclosepath\nclip\n/);
    assert.ok(eps.indexOf('concat\n') < eps.indexOf('\nclip\n'));
  }
});

test('browser export preserves editable gradient definitions, scale and EPS shading', async () => {
  const source='<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8"><defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="8" y2="0"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs><path fill="url(#g)" fill-rule="evenodd" d="M0 0L8 0L8 8L0 8Z"/></svg>';
  const s={minMp:15,maxMp:65,ratio:'4:5',artworkScale:1.3,removeWhiteBackground:true};
  const svg=await renderExport(source,s,'svg','gradient'),paths=tracingSvgPaths(svg);
  assert.equal(paths.length,1);assert.equal(paths[0].gradient.kind,'linear');assert.match(paths[0].original,/transform="matrix\(/);
  assert.match(svg,/<linearGradient/);const eps=await renderExport(source,s,'eps','gradient');
  assert.match(eps,/\/ShadingType 2/);assert.match(eps,/\/Coords \[0 0 8 0\]/);assert.ok(eps.indexOf('concat\n')<eps.indexOf('shfill'));assert.doesNotMatch(eps,/\bcolorimage\b/);
});

test('export color limits count gradient stops and disable gradients on the retraced copy', async () => {
  const svg='<svg width="8" height="8" viewBox="0 0 8 8"><defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="8" y2="0"><stop offset="0" stop-color="#ff0000"/><stop offset="0.5" stop-color="#00ff00"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs><path fill="url(#g)" d="M0 0L8 0L8 8L0 8Z"/></svg>';
  const config={mode:'manual',resolution:512,options:{colors:8,tolerance:.8,minArea:0,smooth:true,removeWhite:false,whiteMode:'none'}},item={config,output:{result:{svg}}};let applied;
  const runner=async copy=>{applied=copy.config.options;return {result:{svg:'flattened'}};};
  assert.equal(await exportSource(item,{...exportDefaults,maxColors:3},runner),svg);assert.equal(applied,undefined);
  assert.equal(await exportSource(item,{...exportDefaults,maxColors:2},runner),'flattened');assert.equal(applied.gradients,false);assert.equal(applied.colors,2);assert.equal(item.config.options.gradients,undefined);
});

test('global maximum colors retraces only exports exceeding the limit and preserves item settings', async () => {
  const width = 32, height = 32, pixels = new Uint8ClampedArray(width * height * 4);
  const palette = [[255,0,0,255], [0,255,0,255], [0,0,255,255], [255,255,0,255]];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set(palette[Math.floor(x / 8)], (y * width + x) * 4);
  const options = { colors: 4, tolerance: .8, minArea: 0, smooth: false, removeWhite: false, whiteMode: 'none' };
  const result = traceRaster(pixels, width, height, options);
  const item = { config: { mode: 'auto', resolution: 512, options }, output: { result, auto: { resolution: 1024, options: { ...options, tolerance: .35 } } } };
  const snapshot = structuredClone(item);
  const calls = [];
  const runner = async (copy, signal) => {
    assert.equal(signal.aborted, false);
    calls.push(copy.config);
    return { result: traceRaster(pixels, width, height, copy.config.options) };
  };
  assert.equal(await exportSource(item, exportDefaults, runner), result.svg);
  assert.equal(calls.length, 0);
  const svg = await exportSource(item, { ...exportDefaults, maxColors: 2 }, runner);
  assert.ok(new Set(tracingSvgPaths(svg).map(path => path.color)).size <= 2);
  assert.deepEqual(calls, [{ mode: 'manual', resolution: 1024, options: { ...options, tolerance: .35, colors: 2 } }]);
  assert.deepEqual(item, snapshot, 'export retains the completed result and per-item configuration');
  const manual = { config: { ...item.config, mode: 'manual' }, output: { result } };
  await exportSource(manual, { ...exportDefaults, maxColors: 2 }, runner);
  assert.equal(calls[1].resolution, 512);
  for (const maxColors of [1, 17, 2.5, NaN]) assert.throws(() => validateExportSettings({ ...exportDefaults, maxColors }), /Maksimum warna/);
});

test('global maximum colors restores legacy settings, validates and persists changes', async () => {
  const dom = new Window();
  const previous = Object.fromEntries(['window', 'document', 'localStorage'].map(key => [key, globalThis[key]]));
  Object.assign(globalThis, { window: dom, document: dom.document, localStorage: dom.localStorage });
  try {
    const oldSettings = { minMp: 20, maxMp: 60, ratio: '4:5', artworkScale: .8, removeWhiteBackground: false };
    dom.localStorage.setItem('cvr-offline-export-settings', JSON.stringify(oldSettings));
    const root = dom.document.createElement('div'), read = initGlobalExportSettings(root);
    assert.deepEqual(read(), { ...oldSettings, maxColors: 16 });
    const control = root.querySelector('#traceExportMaxColors');
    control.value = '4'; control.dispatchEvent(new dom.Event('input', { bubbles: true }));
    const reopened = dom.document.createElement('div');
    assert.equal(initGlobalExportSettings(reopened)().maxColors, 4);
    control.value = '1'; control.dispatchEvent(new dom.Event('input', { bubbles: true }));
    assert.match(root.querySelector('#traceExportError').textContent, /Maksimum warna/);
    assert.throws(read, /Maksimum warna/);
    assert.equal(JSON.parse(dom.localStorage.getItem('cvr-offline-export-settings')).maxColors, 4);
  } finally {
    Object.assign(globalThis, previous);
    await dom.happyDOM.close();
  }
});
