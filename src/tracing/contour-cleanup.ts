import { geometricHypot } from './geometry-math';
import { flattenStroke, oppositeStrokeSides, strokeSelfIntersects, strokeWithin, type StrokeCurve, type StrokePoint, type StrokeFit } from './stroke-regularizer';
import type { SceneMetrics } from './scene-quality';

type Point = StrokePoint;
type Curve = StrokeCurve;
export interface ContourCleanupDiagnostics {
  contourCleanupCandidates: number; contourCleanupAccepted: number; contourCleanupChains: number;
  contourBendBefore: number; contourBendAfter: number; contourCandidateError: number;
  contourDetailBefore: number; contourDetailAfter: number;
}
export const contourCleanupDefaults: ContourCleanupDiagnostics = {
  contourCleanupCandidates: 0, contourCleanupAccepted: 0, contourCleanupChains: 0,
  contourBendBefore: 0, contourBendAfter: 0, contourCandidateError: 0, contourDetailBefore: 0, contourDetailAfter: 0,
};
const distance2 = (a: Point, b: Point) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
const mix = (a: Point, b: Point, t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const unit = (a: Point, b: Point): Point => { const d = geometricHypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / d, (b[1] - a[1]) / d]; };
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1];

/** Only the bounded cleanup candidate receives this raster fidelity budget.
 * Protected detail retains the old 1% limit, including in the standard pass. */
export function allowsContourCleanup(before: SceneMetrics, after: SceneMetrics) {
  if (![after.error, after.edgeError, after.detailError].every(Number.isFinite) || after.tiles.length !== before.tiles.length) return false;
  if (after.error > before.error * 1.2 + 1e-6 || after.edgeError > before.edgeError * 1.25 + 1e-5 || after.detailError > before.detailError * 1.01 + 1e-9) return false;
  return after.tiles.every((value, i) => Number.isFinite(value) && value <= before.tiles[i] * 1.25 + 6);
}

export function flatArtwork(rgba: Uint8ClampedArray) {
  const bins = new Int32Array(4096); let visible = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    bins[(rgba[i] >>> 4) * 256 + (rgba[i + 1] >>> 4) * 16 + (rgba[i + 2] >>> 4)]++; visible++;
  }
  if (visible < 64) return false;
  bins.sort(); let dominant = 0;
  for (let i = 0; i < 12; i++) dominant += bins[bins.length - 1 - i];
  return dominant >= visible * .8;
}

function stableCorner(points: Point[], index: number, n: number, closed: boolean) {
  const ends = [index, index];
  for (let side = 0; side < 2; side++) {
    const sign = side === 0 ? -1 : 1; let previous = index, length = 0;
    for (let step = 1; step < n; step++) {
      let j = index + sign * step; if (!closed && (j < 0 || j >= n)) break; j = (j + n) % n;
      length += Math.sqrt(distance2(points[previous], points[j])); previous = j;
      if (length >= 4) break;
    }
    ends[side] = previous;
  }
  return dot(unit(points[ends[0]], points[index]), unit(points[index], points[ends[1]])) < .9;
}

/** Arc-length curvature variation, excluding supported corner neighborhoods. */
export function contourBendEnergy(curves: Curve[]) {
  const raw = flattenStroke(curves); if (raw.length < 5) return 0;
  const closed = distance2(raw[0], raw[raw.length - 1]) < 1e-12;
  let length = 0; for (let i = 1; i < raw.length; i++) length += Math.sqrt(distance2(raw[i - 1], raw[i]));
  const n = Math.ceil(length); if (n < 12 || n > 8000) return 0;
  const points: Point[] = []; let edge = 1, travelled = 0;
  for (let k = 0; k <= (closed ? n - 1 : n); k++) {
    const target = length * k / n;
    while (edge < raw.length - 1 && travelled + Math.sqrt(distance2(raw[edge - 1], raw[edge])) < target) { travelled += Math.sqrt(distance2(raw[edge - 1], raw[edge])); edge++; }
    const d = Math.sqrt(distance2(raw[edge - 1], raw[edge])); points.push(mix(raw[edge - 1], raw[edge], d < 1e-12 ? 0 : (target - travelled) / d));
  }
  const corners: Point[] = [];
  for (let k = 0; k < curves.length - Number(!closed); k++) {
    const a = curves[k], b = curves[(k + 1) % curves.length], left = a.controls ? unit(a.controls[1], a.to) : unit(a.from, a.to), right = b.controls ? unit(b.from, b.controls[0]) : unit(b.from, b.to);
    if (dot(left, right) < .9) corners.push(a.to);
  }
  const count = points.length, curvature = new Float64Array(count), valid = new Uint8Array(count);
  for (let i = closed ? 0 : 3; i < count - (closed ? 0 : 3); i++) {
    if (corners.some(corner => distance2(corner, points[i]) < 36)) continue;
    const a = unit(points[(i - 2 + count) % count], points[i]), b = unit(points[i], points[(i + 2) % count]);
    curvature[i] = Math.atan2(a[0] * b[1] - a[1] * b[0], dot(a, b)); valid[i] = 1;
  }
  let energy = 0; for (let i = 1; i < count; i++) if (valid[i] && valid[i - 1]) energy += (curvature[i] - curvature[i - 1]) ** 2;
  return energy;
}

function quadratic(samples: number[][], radius: number): Point | undefined {
  const a = Array.from({ length: 3 }, () => new Float64Array(5));
  for (const s of samples) {
    const t = s[0] / radius, w = Math.exp(-2 * t * t), v = [1, t, t * t];
    for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) a[i][j] += w * v[i] * v[j]; a[i][3] += w * v[i] * s[1]; a[i][4] += w * v[i] * s[2]; }
  }
  for (let k = 0; k < 3; k++) {
    let pivot = k; for (let i = k + 1; i < 3; i++) if (Math.abs(a[i][k]) > Math.abs(a[pivot][k])) pivot = i;
    [a[k], a[pivot]] = [a[pivot], a[k]]; const d = a[k][k]; if (Math.abs(d) < 1e-9) return;
    for (let j = k; j < 5; j++) a[k][j] /= d;
    for (let i = 0; i < 3; i++) if (i !== k) { const f = a[i][k]; for (let j = k; j < 5; j++) a[i][j] -= f * a[k][j]; }
  }
  return [a[0][3], a[0][4]];
}

/** Port of mini-vectorizer 0.1.9's shared-chain cleanup. This only proposes
 * geometry; the engine must raster-check the complete exported SVG afterward. */
export function cleanContour(input: Curve[], adapter: StrokeFit): Curve[] {
  const radius = 4; let movement = .4, fit = .2;
  if (input.length < 5 || input.length > 256) return input;
  const closed = distance2(input[0].from, input[input.length - 1].to) < 1e-12, points: Point[] = [], corners = new Set<number>(), lineCorners = new Set<number>();
  for (let k = 0; k < input.length; k++) {
    const c = input[k]; if (!k) points.push(c.from);
    const dense = flattenStroke([c]); let length = 0;
    for (let i = 1; i < dense.length; i++) length += Math.sqrt(distance2(dense[i - 1], dense[i]));
    if (length > 2000 || points.length + length > 4000) return input;
    const steps = Math.max(1, Math.ceil(length)); let travelled = 0, edge = 1;
    for (let step = 1; step < steps; step++) {
      const target = length * step / steps;
      while (edge < dense.length - 1 && travelled + Math.sqrt(distance2(dense[edge - 1], dense[edge])) < target) { travelled += Math.sqrt(distance2(dense[edge - 1], dense[edge])); edge++; }
      const part = Math.sqrt(distance2(dense[edge - 1], dense[edge])); points.push(mix(dense[edge - 1], dense[edge], part < 1e-9 ? 0 : (target - travelled) / part));
    }
    points.push(c.to);
    if (k + 1 < input.length || closed) {
      const next = input[(k + 1) % input.length], a = c.controls ? unit(c.controls[1], c.to) : unit(c.from, c.to), b = next.controls ? unit(next.from, next.controls[0]) : unit(next.from, next.to);
      const line = !c.controls && !next.controls && distance2(c.from, c.to) >= 256 && distance2(next.from, next.to) >= 256;
      if (dot(a, b) < (line ? .985 : .90)) { corners.add(points.length - 1); if (line) lineCorners.add(points.length - 1); }
    }
  }
  const n = points.length - Number(closed); if (n < 16) return input;
  if (corners.delete(n)) corners.add(0); if (lineCorners.delete(n)) lineCorners.add(0);
  for (const index of corners) if (!lineCorners.has(index) && !stableCorner(points, index, n, closed)) corners.delete(index);
  if ([...corners].filter(index => stableCorner(points, index, n, closed)).length >= 3) return input;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) { minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]); maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]); }
  if (Math.max(maxX - minX, maxY - minY) < radius * 24) return input;
  if (Math.min(maxX - minX, maxY - minY) < radius * 12) { movement = .25; fit = .12; }
  if (closed) {
    let perimeter = 0, twiceArea = 0;
    for (let i = 0; i < points.length; i++) { const a = points[i], b = points[(i + 1) % points.length]; twiceArea += a[0] * b[1] - b[0] * a[1]; if (i) perimeter += Math.sqrt(distance2(points[i - 1], a)); }
    if (Math.abs(twiceArea) / Math.max(1, perimeter) < 5) return input;
  }
  if (!closed) { corners.add(0); corners.add(n - 1); }
  const original = points.slice(0, n), pairs = oppositeStrokeSides(original, closed, corners); let fair = original.map(p => [...p] as Point);
  for (let pass = 0; pass < 2; pass++) {
    const next = fair.map(p => [...p] as Point);
    for (let i = 0; i < n; i++) {
      if (corners.has(i)) continue;
      const samples = [[0, fair[i][0], fair[i][1]]];
      for (const sign of [-1, 1]) {
        let s = 0, previous = i;
        for (let step = 1; step <= Math.ceil(radius * 2); step++) {
          let j = i + sign * step; if (!closed && (j < 0 || j >= n)) break; j = (j + n) % n;
          s += Math.sqrt(distance2(fair[previous], fair[j])); if (s > radius) break;
          samples.push([sign * s, fair[j][0], fair[j][1]]); if (corners.has(j)) break; previous = j;
        }
      }
      if (samples.length < 7) continue;
      const target = quadratic(samples, radius); if (!target) continue;
      const value = mix(fair[i], target, .8), d = Math.sqrt(distance2(value, original[i])); next[i] = d > movement ? mix(original[i], value, movement / d) : value;
    }
    for (let i = 0; i < n; i++) {
      const j = pairs[i]; if (j <= i || pairs[j] !== i || corners.has(i) || corners.has(j)) continue;
      const normal = unit(original[i], original[j]), di = dot([next[i][0] - original[i][0], next[i][1] - original[i][1]], normal), dj = dot([next[j][0] - original[j][0], next[j][1] - original[j][1]], normal), correction = (dj - di) / 2;
      next[i] = [next[i][0] + correction * normal[0], next[i][1] + correction * normal[1]]; next[j] = [next[j][0] - correction * normal[0], next[j][1] - correction * normal[1]];
    }
    fair = next;
  }
  if (closed) fair.push(fair[0]);
  const cuts = new Set([0, fair.length - 1, ...corners]);
  if (closed) { let far = 1; for (let i = 2; i < n; i++) if (distance2(fair[0], fair[i]) > distance2(fair[0], fair[far])) far = i; cuts.add(far); }
  const boundaries = [...cuts].sort((a, b) => a - b), tangent = (i: number) => { const r = Math.min(3, Math.floor((n - 1) / 2)); return unit(fair[(i - r + n) % n], fair[(i + r) % n]); };
  let result: Curve[] = [];
  for (let k = 1; k < boundaries.length; k++) {
    const start = boundaries[k - 1], end = boundaries[k]; if (end <= start) continue;
    const left = corners.has(start % n) ? unit(fair[start], fair[start + 1]) : tangent(start % n), right = corners.has(end % n) ? unit(fair[end - 1], fair[end]) : tangent(end % n);
    result.push(...adapter.fit(fair.slice(start, end + 1), fit, left, [-right[0], -right[1]]));
  }
  result = adapter.compact(result, [...corners].map(i => fair[i]), Math.min(.2, fit));
  if (result.length > input.length || strokeSelfIntersects(result) || !strokeWithin(input, flattenStroke(result), movement + fit + .05) || !strokeWithin(result, points, movement + fit + .05)) return input;
  return contourBendEnergy(result) < contourBendEnergy(input) * .7 ? result : input;
}
