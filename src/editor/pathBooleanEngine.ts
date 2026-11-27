import {
  VectorPathOps,
  type PathCommand,
  type Vec2,
} from './vectorPathData.ts';
import type {
  FillRule,
  PathBooleanEngine,
  PathBooleanPart,
  PathfinderOp,
} from './vectorDocument.ts';

interface RawSegment {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

interface FlattenedPart {
  readonly rings: Vec2[][];
  readonly fillRuleEvenOdd: boolean;
  readonly clipRings: Vec2[][] | null;
}

interface FlattenedOperand {
  readonly parts: FlattenedPart[];
}

function closeRing(poly: Vec2[], eps: number): Vec2[] {
  const out: Vec2[] = [];
  for (const pt of poly) {
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(pt.x - prev.x, pt.y - prev.y) > eps) {
      out.push(pt);
    }
  }
  while (out.length >= 2) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) <= eps) {
      out.pop();
    } else {
      break;
    }
  }
  return out;
}

function pointInPart(part: FlattenedPart, x: number, y: number): boolean {
  if (part.clipRings && !VectorPathOps.isPointInsidePolylines(part.clipRings, x, y, false)) {
    return false;
  }
  return VectorPathOps.isPointInsidePolylines(part.rings, x, y, part.fillRuleEvenOdd);
}

function pointInOperand(operand: FlattenedOperand, x: number, y: number): boolean {
  for (const part of operand.parts) {
    if (pointInPart(part, x, y)) return true;
  }
  return false;
}

function evaluateOp(op: PathfinderOp, inside: readonly boolean[]): boolean {
  switch (op) {
    case 'UNITE':
      return inside.some(Boolean);
    case 'INTERSECT':
      return inside.every(Boolean);
    case 'MINUS_FRONT':
    case 'TRIM':
      if (!inside[0]) return false;
      for (let i = 1; i < inside.length; i++) {
        if (inside[i]) return false;
      }
      return true;
    case 'EXCLUDE': {
      let count = 0;
      for (const v of inside) if (v) count++;
      return (count & 1) === 1;
    }
  }
}

function distSqPointToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-12) return (px - ax) * (px - ax) + (py - ay) * (py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const qx = ax + t * dx;
  const qy = ay + t * dy;
  return (px - qx) * (px - qx) + (py - qy) * (py - qy);
}

function simplifyRing(ring: Vec2[], eps: number): Vec2[] {
  if (ring.length < 3) return ring;
  let pts = ring;
  let changed = true;
  let guard = 0;
  while (changed && pts.length >= 3 && guard++ < 4) {
    changed = false;
    const next: Vec2[] = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const prev = pts[(i - 1 + n) % n];
      const cur = pts[i];
      const nxt = pts[(i + 1) % n];
      const dx = nxt.x - prev.x;
      const dy = nxt.y - prev.y;
      const len = Math.hypot(dx, dy);
      if (len <= eps) {
        changed = true;
        continue;
      }
      const perpDist = Math.abs((cur.x - prev.x) * dy - (cur.y - prev.y) * dx) / len;
      // Check cur actually lies between prev and nxt along segment before removing.
      const dot = (cur.x - prev.x) * dx + (cur.y - prev.y) * dy;
      if (perpDist <= eps && dot >= -eps * len && dot <= len * len + eps * len) {
        changed = true;
        continue;
      }
      next.push(cur);
    }
    pts = next;
  }
  return pts;
}

function ringSignedArea(ring: readonly Vec2[]): number {
  let area = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    area += a.x * b.y - b.x * a.y;
  }
  return area * 0.5;
}

/**
 * Pure TypeScript 2D planar-arrangement boolean engine supporting UNITE,
 * MINUS_FRONT, INTERSECT, EXCLUDE, and TRIM across arbitrary multi-contour
 * paths with evenodd/nonzero fill rules and clip paths.
 */
export const PlanarPathBooleanEngine: PathBooleanEngine = {
  combine(operands: readonly (readonly PathBooleanPart[])[], op: PathfinderOp): PathCommand[] | null {
    if (operands.length < 2) return null;

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const parts of operands) {
      for (const part of parts) {
        const b = VectorPathOps.computeBounds(part.commands);
        if (b) {
          if (b.left < minX) minX = b.left;
          if (b.top < minY) minY = b.top;
          if (b.right > maxX) maxX = b.right;
          if (b.bottom > maxY) maxY = b.bottom;
        }
      }
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;

    const diag = Math.max(1, Math.hypot(maxX - minX, maxY - minY));
    const flatness = Math.max(0.05, Math.min(0.65, diag * 0.0008));
    const snapEps = Math.max(1e-4, diag * 1e-6);

    const flatOperands: FlattenedOperand[] = [];
    const rawSegments: RawSegment[] = [];

    const addRingsSegments = (rings: Vec2[][]): void => {
      for (const ring of rings) {
        const n = ring.length;
        if (n < 3) continue;
        for (let i = 0; i < n; i++) {
          const a = ring[i];
          const b = ring[(i + 1) % n];
          if (Math.hypot(b.x - a.x, b.y - a.y) <= snapEps) continue;
          rawSegments.push({
            x1: a.x,
            y1: a.y,
            x2: b.x,
            y2: b.y,
            minX: Math.min(a.x, b.x),
            minY: Math.min(a.y, b.y),
            maxX: Math.max(a.x, b.x),
            maxY: Math.max(a.y, b.y),
          });
        }
      }
    };

    for (const operandParts of operands) {
      const parts: FlattenedPart[] = [];
      for (const part of operandParts) {
        const rings = VectorPathOps.flattenPolylines(part.commands, flatness)
          .map(poly => closeRing(poly, snapEps))
          .filter(ring => ring.length >= 3);
        if (rings.length === 0) continue;
        const clipRings = part.clipCommands
          ? VectorPathOps.flattenPolylines(part.clipCommands, flatness)
              .map(poly => closeRing(poly, snapEps))
              .filter(ring => ring.length >= 3)
          : null;
        parts.push({
          rings,
          fillRuleEvenOdd: part.fillRule === 'evenodd',
          clipRings: clipRings && clipRings.length > 0 ? clipRings : null,
        });
        addRingsSegments(rings);
        if (clipRings && clipRings.length > 0) addRingsSegments(clipRings);
      }
      if (parts.length === 0) return null;
      flatOperands.push({ parts });
    }

    if (rawSegments.length < 3) return null;

    // 1. Find all segment-segment split parameters t in [0, 1].
    const splits: number[][] = rawSegments.map(() => [0, 1]);
    const nSeg = rawSegments.length;
    const tEps = 1e-7;

    for (let i = 0; i < nSeg; i++) {
      const a = rawSegments[i];
      const dax = a.x2 - a.x1;
      const day = a.y2 - a.y1;
      const lenASq = dax * dax + day * day;

      for (let j = i + 1; j < nSeg; j++) {
        const b = rawSegments[j];
        if (
          a.maxX + snapEps < b.minX ||
          b.maxX + snapEps < a.minX ||
          a.maxY + snapEps < b.minY ||
          b.maxY + snapEps < a.minY
        ) {
          continue;
        }
        const dbx = b.x2 - b.x1;
        const dby = b.y2 - b.y1;
        const denom = dax * dby - day * dbx;
        const lenBSq = dbx * dbx + dby * dby;
        const scale = Math.sqrt(lenASq * lenBSq);

        if (Math.abs(denom) <= 1e-9 * scale) {
          // Parallel / collinear: project endpoints of each onto the other if within snapEps.
          const projA1 = ((b.x1 - a.x1) * dax + (b.y1 - a.y1) * day) / lenASq;
          const projA2 = ((b.x2 - a.x1) * dax + (b.y2 - a.y1) * day) / lenASq;
          const distB1 = Math.abs((b.x1 - a.x1) * day - (b.y1 - a.y1) * dax) / Math.sqrt(lenASq);
          if (distB1 <= snapEps * 2) {
            if (projA1 > tEps && projA1 < 1 - tEps) splits[i].push(projA1);
            if (projA2 > tEps && projA2 < 1 - tEps) splits[i].push(projA2);
            const projB1 = ((a.x1 - b.x1) * dbx + (a.y1 - b.y1) * dby) / lenBSq;
            const projB2 = ((a.x2 - b.x1) * dbx + (a.y2 - b.y1) * dby) / lenBSq;
            if (projB1 > tEps && projB1 < 1 - tEps) splits[j].push(projB1);
            if (projB2 > tEps && projB2 < 1 - tEps) splits[j].push(projB2);
          }
          continue;
        }

        const qpx = b.x1 - a.x1;
        const qpy = b.y1 - a.y1;
        const t = (qpx * dby - qpy * dbx) / denom;
        const u = (qpx * day - qpy * dax) / denom;
        const tTol = snapEps / Math.sqrt(lenASq);
        const uTol = snapEps / Math.sqrt(lenBSq);
        if (t >= -tTol && t <= 1 + tTol && u >= -uTol && u <= 1 + uTol) {
          const tc = Math.max(0, Math.min(1, t));
          const uc = Math.max(0, Math.min(1, u));
          if (tc > tEps && tc < 1 - tEps) splits[i].push(tc);
          if (uc > tEps && uc < 1 - tEps) splits[j].push(uc);
        }
      }
    }

    // 2. Snap vertices into a spatial hash grid and collect deduplicated undirected edges.
    const vertices: Vec2[] = [];
    const cellSize = snapEps * 4;
    const grid = new Map<string, number[]>();

    const getVertexId = (x: number, y: number): number => {
      const gx = Math.floor(x / cellSize);
      const gy = Math.floor(y / cellSize);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const bucket = grid.get(`${gx + dx},${gy + dy}`);
          if (!bucket) continue;
          for (const idx of bucket) {
            const v = vertices[idx];
            if (Math.hypot(v.x - x, v.y - y) <= snapEps * 2) {
              return idx;
            }
          }
        }
      }
      const id = vertices.length;
      vertices.push({ x, y });
      const key = `${gx},${gy}`;
      const bucket = grid.get(key);
      if (bucket) bucket.push(id);
      else grid.set(key, [id]);
      return id;
    };

    const undirectedEdges = new Map<string, [number, number]>();
    for (let i = 0; i < nSeg; i++) {
      const seg = rawSegments[i];
      const ts = splits[i].sort((a, b) => a - b);
      let prevId = getVertexId(seg.x1, seg.y1);
      for (let k = 1; k < ts.length; k++) {
        if (ts[k] - ts[k - 1] <= tEps) continue;
        const t = ts[k];
        const x = seg.x1 + (seg.x2 - seg.x1) * t;
        const y = seg.y1 + (seg.y2 - seg.y1) * t;
        const nextId = getVertexId(x, y);
        if (nextId !== prevId) {
          const lo = Math.min(prevId, nextId);
          const hi = Math.max(prevId, nextId);
          const key = `${lo}:${hi}`;
          if (!undirectedEdges.has(key)) {
            undirectedEdges.set(key, [lo, hi]);
          }
          prevId = nextId;
        }
      }
    }

    // 3. Classify each undirected edge by sampling left and right of its midpoint.
    interface DirectedEdge {
      readonly from: number;
      readonly to: number;
      readonly angle: number;
      used: boolean;
    }

    const directedEdges: DirectedEdge[] = [];
    const outgoing = new Map<number, DirectedEdge[]>();
    const insideLeft = new Array<boolean>(flatOperands.length);
    const insideRight = new Array<boolean>(flatOperands.length);
    const maxOffset = Math.max(1e-3, diag * 1e-4);

    for (const [u, v] of undirectedEdges.values()) {
      const pu = vertices[u];
      const pv = vertices[v];
      const dx = pv.x - pu.x;
      const dy = pv.y - pu.y;
      const len = Math.hypot(dx, dy);
      if (len <= snapEps * 2) continue;

      const mx = (pu.x + pv.x) * 0.5;
      const my = (pu.y + pv.y) * 0.5;
      // Left normal in screen coordinates (x right, y down): (-dy/len, dx/len)
      const nx = -dy / len;
      const ny = dx / len;

      // Clamp probe distance so we never step across another nearby edge.
      let probe = Math.min(maxOffset, len * 0.15);
      const searchPad = probe * 2.2;
      for (let s = 0; s < nSeg; s++) {
        const seg = rawSegments[s];
        if (
          mx + searchPad < seg.minX ||
          mx - searchPad > seg.maxX ||
          my + searchPad < seg.minY ||
          my - searchPad > seg.maxY
        ) {
          continue;
        }
        const dSq = distSqPointToSegment(mx, my, seg.x1, seg.y1, seg.x2, seg.y2);
        if (dSq > snapEps * snapEps * 9) {
          const d = Math.sqrt(dSq);
          if (d * 0.4 < probe) probe = Math.max(snapEps * 0.25, d * 0.4);
        }
      }

      const lx = mx + nx * probe;
      const ly = my + ny * probe;
      const rx = mx - nx * probe;
      const ry = my - ny * probe;

      for (let k = 0; k < flatOperands.length; k++) {
        insideLeft[k] = pointInOperand(flatOperands[k], lx, ly);
        insideRight[k] = pointInOperand(flatOperands[k], rx, ry);
      }

      const keepLeft = evaluateOp(op, insideLeft);
      const keepRight = evaluateOp(op, insideRight);
      if (keepLeft === keepRight) continue;

      // Orient edge so kept interior lies on the LEFT side of (from -> to).
      const from = keepLeft ? u : v;
      const to = keepLeft ? v : u;
      const pFrom = vertices[from];
      const pTo = vertices[to];
      const edge: DirectedEdge = {
        from,
        to,
        angle: Math.atan2(pTo.y - pFrom.y, pTo.x - pFrom.x),
        used: false,
      };
      directedEdges.push(edge);
      const list = outgoing.get(from);
      if (list) list.push(edge);
      else outgoing.set(from, [edge]);
    }

    if (directedEdges.length < 3) return null;

    // 4. Trace closed non-crossing boundary rings.
    const resultRings: Vec2[][] = [];
    const tau = Math.PI * 2;

    for (const startEdge of directedEdges) {
      if (startEdge.used) continue;
      const ring: Vec2[] = [];
      let current: DirectedEdge | null = startEdge;
      let steps = 0;
      const maxSteps = directedEdges.length + 2;

      while (current && !current.used && steps++ < maxSteps) {
        current.used = true;
        ring.push(vertices[current.from]);
        const nextVertex = current.to;
        if (nextVertex === startEdge.from) {
          break;
        }
        const candidates = outgoing.get(nextVertex);
        if (!candidates || candidates.length === 0) {
          current = null;
          break;
        }
        // Incoming vector from nextVertex back to current.from.
        const backAngle = Math.atan2(
          vertices[current.from].y - vertices[nextVertex].y,
          vertices[current.from].x - vertices[nextVertex].x,
        );
        // Choose unused outgoing edge with smallest positive CCW sweep from backAngle
        // (keeps interior on the left without crossing at degree-4 pinch vertices).
        let best: DirectedEdge | null = null;
        let bestDelta = Number.POSITIVE_INFINITY;
        for (const cand of candidates) {
          if (cand.used) continue;
          let delta = cand.angle - backAngle;
          while (delta <= 1e-9) delta += tau;
          while (delta > tau + 1e-9) delta -= tau;
          if (delta < bestDelta) {
            bestDelta = delta;
            best = cand;
          }
        }
        current = best;
      }

      if (ring.length >= 3) {
        const simplified = simplifyRing(ring, snapEps * 2);
        if (simplified.length >= 3 && Math.abs(ringSignedArea(simplified)) > snapEps * snapEps * 4) {
          resultRings.push(simplified);
        }
      }
    }

    if (resultRings.length === 0) return null;

    const commands: PathCommand[] = [];
    for (const ring of resultRings) {
      commands.push({ type: 'M', x: ring[0].x, y: ring[0].y });
      for (let i = 1; i < ring.length; i++) {
        commands.push({ type: 'L', x: ring[i].x, y: ring[i].y });
      }
      commands.push({ type: 'Z' });
    }
    return commands;
  },
};
