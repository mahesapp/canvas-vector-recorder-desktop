import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { moduleUrl } from '../../../tests/helpers/tracing-module.mjs';
const { traceAuto } = await import(await moduleUrl('auto-trace'));
const { traceRaster } = await import(await moduleUrl('engine'));
const { resizeRaster } = await import(await moduleUrl('auto-raster'));
const { evaluateSvgScene } = await import(await moduleUrl('scene-quality'));
const directory = new URL('./', import.meta.url);
const python = process.env.PYTHON ?? 'python3';
const pixels = new Uint8ClampedArray(execFileSync(python, ['-c', 'from PIL import Image; import sys; sys.stdout.buffer.write(Image.open(sys.argv[1]).convert("RGBA").tobytes())', new URL('source.png', directory).pathname], { maxBuffer: 16_000_000 }));
const name = process.argv[2] ?? 'before';
const started = performance.now();
let result, auto, options;
if (process.argv[3] === 'manual') {
  options = { colors: 16, tolerance: .35, minArea: Number(process.argv[4] ?? 12), smooth: true, removeWhite: true, whiteMode: 'background' };
  const raster = resizeRaster(pixels, 1440, 1450, 1024);
  result = traceRaster(raster.pixels, raster.width, raster.height, options);
} else {
  const output = traceAuto(pixels, 1440, 1450, (value, label) => { if (value % 10 === 0) console.error(value, label); });
  result = output.result; auto = output.auto; options = auto.options;
}
const raster = resizeRaster(pixels, 1440, 1450, Math.max(result.width, result.height));
execFileSync(python, ['-c', 'from PIL import Image; import sys; Image.frombytes("RGBA",(int(sys.argv[1]),int(sys.argv[2])),sys.stdin.buffer.read()).save(sys.argv[3])', String(raster.width), String(raster.height), new URL('reference.png', directory).pathname], { input: raster.pixels });
const metrics = evaluateSvgScene(result.svg, raster.pixels, raster.width, raster.height, options.whiteMode !== 'none');
const report = { milliseconds: Math.round(performance.now() - started), auto, options, width: result.width, height: result.height, paths: result.paths, contours: result.contours, segments: result.segments, colors: result.colors, error: metrics.error, edgeError: metrics.edgeError, diagnostics: result.diagnostics };
await writeFile(new URL(`${name}.svg`, directory), result.svg);
await writeFile(new URL(`${name}.json`, directory), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
