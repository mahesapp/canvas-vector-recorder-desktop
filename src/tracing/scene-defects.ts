import { SCENE_TILE, sceneAllows, type SceneMetrics } from './scene-quality';

export interface SceneDefectArea { x0: number; y0: number; x1: number; y1: number; tiles: number[]; error: number }
export interface LocalRefinementDiagnostics { localDefectAreas: number; localRefitChains: number; localRefitAccepted: number }

/** Group unusually bad tiles. These are residual areas, not semantic diagnoses.
 * Broad errors belong to palette/global fitting; this pass only targets local errors.
 */
export function findSceneDefects(metrics: SceneMetrics, width: number, height: number): SceneDefectArea[] {
  const columns = Math.ceil(width / SCENE_TILE), rows = Math.ceil(height / SCENE_TILE);
  if (metrics.tiles.length !== columns * rows || !Number.isFinite(metrics.error)) return [];
  const bad = new Uint8Array(metrics.tiles.length), seen = new Uint8Array(bad.length);
  let affected = 0;
  for (let i = 0; i < bad.length; i++) {
    const x = i % columns * SCENE_TILE, y = Math.floor(i / columns) * SCENE_TILE;
    const area = Math.min(SCENE_TILE, width - x) * Math.min(SCENE_TILE, height - y);
    if (Number.isFinite(metrics.tiles[i]) && metrics.tiles[i] > Math.max(.5, metrics.error * area * 8)) { bad[i] = 1; affected += area; }
  }
  if (!affected || affected > width * height * .35) return [];
  const areas: SceneDefectArea[] = [];
  for (let start = 0; start < bad.length; start++) {
    if (!bad[start] || seen[start]) continue;
    const tiles = [start]; seen[start] = 1;
    let x0 = width, y0 = height, x1 = 0, y1 = 0, error = 0;
    for (let read = 0; read < tiles.length; read++) {
      const p = tiles[read], x = p % columns, y = Math.floor(p / columns);
      x0 = Math.min(x0, x * SCENE_TILE); y0 = Math.min(y0, y * SCENE_TILE);
      x1 = Math.max(x1, Math.min(width, (x + 1) * SCENE_TILE)); y1 = Math.max(y1, Math.min(height, (y + 1) * SCENE_TILE)); error += metrics.tiles[p];
      for (const q of [x ? p - 1 : -1, x + 1 < columns ? p + 1 : -1, y ? p - columns : -1, y + 1 < rows ? p + columns : -1]) {
        if (q >= 0 && bad[q] && !seen[q]) { seen[q] = 1; tiles.push(q); }
      }
    }
    areas.push({ x0, y0, x1, y1, error, tiles });
  }
  return areas.sort((a, b) => b.error - a.error).slice(0, 4);
}

export function localRefinementAllows(before: SceneMetrics, after: SceneMetrics, areas: SceneDefectArea[]) {
  if (!areas.length || !sceneAllows(before, after) || after.error > before.error + 1e-9 || after.detailError > before.detailError + 1e-9 || after.edgeError > before.edgeError + 1e-9) return false;
  const tiles = new Set(areas.flatMap(a => a.tiles)); let oldError = 0, newError = 0;
  for (let i = 0; i < before.tiles.length; i++) {
    if (tiles.has(i)) { oldError += before.tiles[i]; newError += after.tiles[i]; }
    else if (after.tiles[i] > before.tiles[i] + .002) return false;
  }
  return oldError > 0 && newError < oldError * .85;
}
