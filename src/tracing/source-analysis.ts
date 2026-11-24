import { canGrowTransitionLabel } from './transition-mixtures';

type RGB = number[];
export interface SourceDiagnostics { noiseScore: number; coherentLabelPixels: number }
const distance = (a: RGB, b: RGB) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** Source evidence only; never filter the raster used for fitting or scoring. */
export function compressionNoise(rgba: Uint8ClampedArray, width: number, height: number) {
  let noisyWindows = 0, edgeWindows = 0, samples = 0;
  const step = Math.max(1, Math.floor(Math.max(width, height) / 600));
  for (let y = 2; y < height - 2; y += step) for (let x = 2; x < width - 2; x += step) {
    let low = 255, high = 0, opaque = true;
    for (let dy = -2; dy <= 2 && opaque; dy++) for (let dx = -2; dx <= 2; dx++) {
      const p = ((y + dy) * width + x + dx) * 4;
      if (rgba[p + 3] !== 255) { opaque = false; break; }
      const value = (rgba[p] + 2 * rgba[p + 1] + rgba[p + 2]) / 4;
      low = Math.min(low, value); high = Math.max(high, value);
    }
    if (!opaque) continue;
    samples++;
    if (high - low > 24) edgeWindows++;
    else if (high - low >= 3) noisyWindows++;
  }
  const score = noisyWindows / Math.max(40, edgeWindows);
  // Flat texture alone supplies no evidence of compressed artwork edges.
  return { score, noisyWindows, edgeWindows, samples, detected: samples >= 64 && edgeWindows >= 8 && score > .25 };
}

/** Two opaque inks plus their antialias mixtures; coherent third colors veto it. */
export function twoToneEvidence(rgba: Uint8ClampedArray, width: number, height: number, palette: RGB[]) {
  if (palette.length !== 2) return false;
  const [a, b] = palette, axis = b.map((v, c) => v - a[c]), separation = distance(a, b);
  if (Math.max(...axis.map(Math.abs)) < 100) return false;
  const offAxis = new Uint8Array(width * height), endpoints = [0, 0];
  let visible = 0, flat = 0, explainedFlat = 0, unexplained = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x, i = p * 4;
    if (rgba[i + 3] < 240) continue;
    visible++;
    const color = [rgba[i], rgba[i + 1], rgba[i + 2]], da = distance(color, a), db = distance(color, b);
    if (Math.min(da, db) <= 24 ** 2) endpoints[da <= db ? 0 : 1]++;
    const t = Math.max(0, Math.min(1, axis.reduce((sum, v, c) => sum + (color[c] - a[c]) * v, 0) / separation));
    const residual = color.reduce((sum, v, c) => sum + (v - a[c] - t * axis[c]) ** 2, 0);
    if (residual > 28 ** 2) { offAxis[p] = 1; unexplained++; }
    if (x < 1 || y < 1 || x + 1 >= width || y + 1 >= height) continue;
    let stable = true;
    for (let dy = -1; dy <= 1 && stable; dy++) for (let dx = -1; dx <= 1; dx++) {
      const q = ((y + dy) * width + x + dx) * 4;
      if (rgba[q + 3] < 240 || [0, 1, 2].some(c => Math.abs(rgba[q + c] - color[c]) > 14)) { stable = false; break; }
    }
    if (stable) { flat++; if (Math.min(da, db) <= 40 ** 2) explainedFlat++; }
  }
  if (visible < 16 || endpoints.some(n => n < 4) || flat < 8 || explainedFlat / flat < .985 || unexplained > Math.max(2, visible * .0015)) return false;
  // Even a two-pixel accent is real evidence. Isolated compression outliers may pass.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x;
    if (offAxis[p] && (x + 1 < width && offAxis[p + 1] || y + 1 < height && offAxis[p + width])) return false;
  }
  return true;
}

/** Grow reliable labels through flat, ambiguous pixels without changing topology.
 * Crisp edges, alpha, exact-color pixels and protected details remain anchors.
 * This is an optional candidate, scored against the unchanged source by Auto.
 */
export function cohereNoisyLabels(rgba: Uint8ClampedArray, labels: Int16Array, palette: RGB[], width: number, height: number, protectedPixels?: Uint8Array) {
  const n = labels.length, first = new Int16Array(n).fill(-1), second = new Int16Array(n).fill(-1);
  const ambiguous = new Uint8Array(n), queue = new Int32Array(n);
  let end = 0, changed = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x, i = p * 4;
    if (labels[p] < 0 || rgba[i + 3] !== 255) continue;
    let best = Infinity, next = Infinity;
    for (let k = 0; k < palette.length; k++) {
      const c = palette[k], d = (rgba[i] - c[0]) ** 2 + (rgba[i + 1] - c[1]) ** 2 + (rgba[i + 2] - c[2]) ** 2;
      if (d < best) { next = best; second[p] = first[p]; best = d; first[p] = k; }
      else if (d < next) { next = d; second[p] = k; }
    }
    const runner = second[p], gap = runner < 0 ? 0 : distance(palette[first[p]], palette[runner]);
    let floating = !protectedPixels?.[p] && labels[p] === first[p] && best > 12 ** 2 && gap >= 16 ** 2 && gap <= 80 ** 2 && .5 + (next - best) / (2 * gap) < .68;
    if (floating) {
      if (!x || !y || x + 1 === width || y + 1 === height) floating = false;
      else for (let dy = -1; dy <= 1 && floating; dy++) for (let dx = -1; dx <= 1; dx++) {
        const q = ((y + dy) * width + x + dx) * 4;
        if (rgba[q + 3] !== 255 || [0, 1, 2].some(c => Math.abs(rgba[q + c] - rgba[i + c]) > 16)) { floating = false; break; }
      }
    }
    if (floating) ambiguous[p] = 1;
    else if (labels[p] === first[p] && (best <= 8 ** 2 || !gap || .5 + (next - best) / (2 * gap) >= .8)) queue[end++] = p;
  }
  for (let read = 0; read < end; read++) {
    const p = queue[read], x = p % width, label = labels[p];
    for (const q of [x ? p - 1 : -1, x + 1 < width ? p + 1 : -1, p >= width ? p - width : -1, p + width < n ? p + width : -1]) {
      if (q < 0 || !ambiguous[q] || label !== first[q] && label !== second[q]) continue;
      const old = labels[q];
      if (label !== old && (!canGrowTransitionLabel(labels, q, label, width, height) || !canGrowTransitionLabel(labels, q, old, width, height))) continue;
      ambiguous[q] = 0; labels[q] = label; queue[end++] = q;
      if (label !== old) changed++;
    }
  }
  return changed;
}
