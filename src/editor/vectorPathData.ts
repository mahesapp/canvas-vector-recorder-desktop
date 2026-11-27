export type PathCommand =
  | { readonly type: 'M'; readonly x: number; readonly y: number }
  | { readonly type: 'L'; readonly x: number; readonly y: number }
  | {
      readonly type: 'C';
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly x3: number;
      readonly y3: number;
    }
  | { readonly type: 'Z' };

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export interface Bounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export function boundsWidth(b: Bounds): number {
  return b.right - b.left;
}

export function boundsHeight(b: Bounds): number {
  return b.bottom - b.top;
}

export function boundsCenterX(b: Bounds): number {
  return (b.left + b.right) * 0.5;
}

export function boundsCenterY(b: Bounds): number {
  return (b.top + b.bottom) * 0.5;
}

export function boundsContains(b: Bounds, x: number, y: number, slop = 0): boolean {
  return x >= b.left - slop && x <= b.right + slop && y >= b.top - slop && y <= b.bottom + slop;
}

export function boundsUnion(a: Bounds, b: Bounds): Bounds {
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

/** 2D affine matrix: x' = a*x + c*y + tx, y' = b*x + d*y + ty. */
export interface AffineMatrix2D {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly tx: number;
  readonly ty: number;
}

export const AffineMatrix = {
  IDENTITY: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 } as AffineMatrix2D,

  isIdentity(m: AffineMatrix2D): boolean {
    return (
      Math.abs(m.a - 1) < 1e-6 &&
      Math.abs(m.b) < 1e-6 &&
      Math.abs(m.c) < 1e-6 &&
      Math.abs(m.d - 1) < 1e-6 &&
      Math.abs(m.tx) < 1e-6 &&
      Math.abs(m.ty) < 1e-6
    );
  },

  mapPoint(m: AffineMatrix2D, x: number, y: number): Vec2 {
    return {
      x: m.a * x + m.c * y + m.tx,
      y: m.b * x + m.d * y + m.ty,
    };
  },

  multiply(m: AffineMatrix2D, other: AffineMatrix2D): AffineMatrix2D {
    return {
      a: m.a * other.a + m.c * other.b,
      b: m.b * other.a + m.d * other.b,
      c: m.a * other.c + m.c * other.d,
      d: m.b * other.c + m.d * other.d,
      tx: m.a * other.tx + m.c * other.ty + m.tx,
      ty: m.b * other.tx + m.d * other.ty + m.ty,
    };
  },

  averageScale(m: AffineMatrix2D): number {
    return (Math.hypot(m.a, m.b) + Math.hypot(m.c, m.d)) * 0.5;
  },

  translation(dx: number, dy: number): AffineMatrix2D {
    return { a: 1, b: 0, c: 0, d: 1, tx: dx, ty: dy };
  },

  scaleAround(sx: number, sy: number, cx: number, cy: number): AffineMatrix2D {
    return {
      a: sx,
      b: 0,
      c: 0,
      d: sy,
      tx: cx * (1 - sx),
      ty: cy * (1 - sy),
    };
  },

  rotationAround(degrees: number, cx: number, cy: number): AffineMatrix2D {
    const rad = (degrees * Math.PI) / 180;
    const cosV = Math.cos(rad);
    const sinV = Math.sin(rad);
    return {
      a: cosV,
      b: sinV,
      c: -sinV,
      d: cosV,
      tx: cx - cosV * cx + sinV * cy,
      ty: cy - sinV * cx - cosV * cy,
    };
  },

  flipHorizontalAround(cx: number): AffineMatrix2D {
    return AffineMatrix.scaleAround(-1, 1, cx, 0);
  },

  flipVerticalAround(cy: number): AffineMatrix2D {
    return AffineMatrix.scaleAround(1, -1, 0, cy);
  },

  parseSvgTransform(raw: string | undefined | null): AffineMatrix2D {
    if (!raw || !raw.trim()) return AffineMatrix.IDENTITY;
    let acc: AffineMatrix2D = AffineMatrix.IDENTITY;
    const regex = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(raw)) !== null) {
      const fn = match[1].toLowerCase();
      const nums = match[2]
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(Number)
        .filter(Number.isFinite);
      let next: AffineMatrix2D | null = null;
      if (fn === 'matrix' && nums.length >= 6) {
        next = { a: nums[0], b: nums[1], c: nums[2], d: nums[3], tx: nums[4], ty: nums[5] };
      } else if (fn === 'translate' && nums.length >= 1) {
        next = AffineMatrix.translation(nums[0], nums[1] ?? 0);
      } else if (fn === 'scale' && nums.length >= 1) {
        const sx = nums[0];
        const sy = nums[1] ?? sx;
        next = { a: sx, b: 0, c: 0, d: sy, tx: 0, ty: 0 };
      } else if (fn === 'rotate' && nums.length >= 1) {
        next = AffineMatrix.rotationAround(nums[0], nums[1] ?? 0, nums[2] ?? 0);
      } else if (fn === 'skewx' && nums.length >= 1) {
        next = { a: 1, b: 0, c: Math.tan((nums[0] * Math.PI) / 180), d: 1, tx: 0, ty: 0 };
      } else if (fn === 'skewy' && nums.length >= 1) {
        next = { a: 1, b: Math.tan((nums[0] * Math.PI) / 180), c: 0, d: 1, tx: 0, ty: 0 };
      }
      if (next) {
        acc = AffineMatrix.multiply(acc, next);
      }
    }
    return acc;
  },
};

function arcToCubics(
  x0: number,
  y0: number,
  rxIn: number,
  ryIn: number,
  xAxisRotationDeg: number,
  largeArc: boolean,
  sweep: boolean,
  x: number,
  y: number,
): Array<[number, number, number, number, number, number]> {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx < 1e-6 || ry < 1e-6 || (Math.abs(x - x0) < 1e-6 && Math.abs(y - y0) < 1e-6)) {
    return [];
  }

  const phi = (xAxisRotationDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  const dx = (x0 - x) * 0.5;
  const dy = (y0 - y) * 0.5;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;

  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    rx *= scale;
    ry *= scale;
  }

  const rxSq = rx * rx;
  const rySq = ry * ry;
  const x1pSq = x1p * x1p;
  const y1pSq = y1p * y1p;
  const num = Math.max(0, rxSq * rySq - rxSq * y1pSq - rySq * x1pSq);
  const den = rxSq * y1pSq + rySq * x1pSq;
  let sq = den > 1e-9 ? Math.sqrt(num / den) : 0;
  if (largeArc === sweep) sq = -sq;

  const cxp = sq * ((rx * y1p) / ry);
  const cyp = -sq * ((ry * x1p) / rx);
  const cx = cosPhi * cxp - sinPhi * cyp + (x0 + x) * 0.5;
  const cy = sinPhi * cxp + cosPhi * cyp + (y0 + y) * 0.5;

  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;

  const angle = (ax: number, ay: number, bx: number, by: number): number => {
    const dot = Math.max(-1, Math.min(1, ax * bx + ay * by));
    const sign = ax * by - ay * bx < 0 ? -1 : 1;
    return sign * Math.acos(dot);
  };

  const theta1 = angle(1, 0, ux, uy);
  let deltaTheta = angle(ux, uy, vx, vy);
  const tau = Math.PI * 2;
  if (!sweep && deltaTheta > 0) deltaTheta -= tau;
  else if (sweep && deltaTheta < 0) deltaTheta += tau;

  const segments = Math.max(1, Math.ceil(Math.abs(deltaTheta) / (Math.PI * 0.5)));
  const deltaSeg = deltaTheta / segments;
  const out: Array<[number, number, number, number, number, number]> = [];
  let curTheta = theta1;

  for (let s = 0; s < segments; s++) {
    const nextTheta = curTheta + deltaSeg;
    const alpha = (Math.tan(deltaSeg / 4) * 4) / 3;
    const cos1 = Math.cos(curTheta);
    const sin1 = Math.sin(curTheta);
    const cos2 = Math.cos(nextTheta);
    const sin2 = Math.sin(nextTheta);

    const mapPt = (px: number, py: number): [number, number] => {
      const sx = px * rx;
      const sy = py * ry;
      return [cosPhi * sx - sinPhi * sy + cx, sinPhi * sx + cosPhi * sy + cy];
    };

    const [c1x, c1y] = mapPt(cos1 - alpha * sin1, sin1 + alpha * cos1);
    const [c2x, c2y] = mapPt(cos2 + alpha * sin2, sin2 - alpha * cos2);
    const [ex, ey] = mapPt(cos2, sin2);
    out.push([c1x, c1y, c2x, c2y, ex, ey]);
    curTheta = nextTheta;
  }

  return out;
}

const CUBIC_STEPS = 8;

export const VectorPathOps = {
  /** Parses any valid SVG path `d` string into normalized absolute M / L / C / Z commands. */
  parse(d: string): PathCommand[] {
    const commands: PathCommand[] = [];
    const len = d.length;
    let i = 0;

    const skipWs = (): void => {
      while (i < len && (d[i] === ' ' || d[i] === ',' || d[i] === '\t' || d[i] === '\n' || d[i] === '\r')) {
        i++;
      }
    };

    const hasNextNumber = (): boolean => {
      skipWs();
      if (i >= len) return false;
      const ch = d[i];
      return (ch >= '0' && ch <= '9') || ch === '+' || ch === '-' || ch === '.';
    };

    const nextNumber = (): number => {
      skipWs();
      const start = i;
      if (i < len && (d[i] === '+' || d[i] === '-')) i++;
      while (i < len && d[i] >= '0' && d[i] <= '9') i++;
      if (i < len && d[i] === '.') {
        i++;
        while (i < len && d[i] >= '0' && d[i] <= '9') i++;
      }
      if (i < len && (d[i] === 'e' || d[i] === 'E')) {
        const expStart = i;
        i++;
        if (i < len && (d[i] === '+' || d[i] === '-')) i++;
        const digitsStart = i;
        while (i < len && d[i] >= '0' && d[i] <= '9') i++;
        if (digitsStart === i) i = expStart;
      }
      if (i === start) {
        throw new Error(`Invalid SVG path number at index ${i}.`);
      }
      const value = Number(d.slice(start, i));
      if (!Number.isFinite(value)) {
        throw new Error(`Invalid SVG path number: ${d.slice(start, i)}`);
      }
      return value;
    };

    const nextFlag = (): boolean => {
      skipWs();
      if (i >= len || (d[i] !== '0' && d[i] !== '1')) {
        throw new Error(`Invalid SVG arc flag at index ${i}.`);
      }
      const flag = d[i] === '1';
      i++;
      return flag;
    };

    let cmd = '';
    let curX = 0;
    let curY = 0;
    let startX = 0;
    let startY = 0;
    let lastCubicX: number | null = null;
    let lastCubicY: number | null = null;
    let lastQuadX: number | null = null;
    let lastQuadY: number | null = null;

    while (i < len) {
      skipWs();
      if (i >= len) break;
      const ch = d[i];
      if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) {
        cmd = ch;
        i++;
        if (cmd === 'Z' || cmd === 'z') {
          commands.push({ type: 'Z' });
          curX = startX;
          curY = startY;
          lastCubicX = null;
          lastCubicY = null;
          lastQuadX = null;
          lastQuadY = null;
          continue;
        }
      }
      if (!cmd) {
        throw new Error(`Invalid SVG path command: ${ch}`);
      }
      const rel = cmd >= 'a' && cmd <= 'z';
      const upper = cmd.toUpperCase();

      if (upper === 'M') {
        const nx = nextNumber();
        const ny = nextNumber();
        curX = rel ? curX + nx : nx;
        curY = rel ? curY + ny : ny;
        startX = curX;
        startY = curY;
        commands.push({ type: 'M', x: curX, y: curY });
        lastCubicX = null;
        lastCubicY = null;
        lastQuadX = null;
        lastQuadY = null;
        cmd = rel ? 'l' : 'L';
      } else if (upper === 'L') {
        const nx = nextNumber();
        const ny = nextNumber();
        curX = rel ? curX + nx : nx;
        curY = rel ? curY + ny : ny;
        commands.push({ type: 'L', x: curX, y: curY });
        lastCubicX = null;
        lastCubicY = null;
        lastQuadX = null;
        lastQuadY = null;
      } else if (upper === 'H') {
        const nx = nextNumber();
        curX = rel ? curX + nx : nx;
        commands.push({ type: 'L', x: curX, y: curY });
        lastCubicX = null;
        lastCubicY = null;
        lastQuadX = null;
        lastQuadY = null;
      } else if (upper === 'V') {
        const ny = nextNumber();
        curY = rel ? curY + ny : ny;
        commands.push({ type: 'L', x: curX, y: curY });
        lastCubicX = null;
        lastCubicY = null;
        lastQuadX = null;
        lastQuadY = null;
      } else if (upper === 'C') {
        const x1 = nextNumber();
        const y1 = nextNumber();
        const x2 = nextNumber();
        const y2 = nextNumber();
        const x3 = nextNumber();
        const y3 = nextNumber();
        const ax1 = rel ? curX + x1 : x1;
        const ay1 = rel ? curY + y1 : y1;
        const ax2 = rel ? curX + x2 : x2;
        const ay2 = rel ? curY + y2 : y2;
        const ax3 = rel ? curX + x3 : x3;
        const ay3 = rel ? curY + y3 : y3;
        commands.push({ type: 'C', x1: ax1, y1: ay1, x2: ax2, y2: ay2, x3: ax3, y3: ay3 });
        lastCubicX = ax2;
        lastCubicY = ay2;
        lastQuadX = null;
        lastQuadY = null;
        curX = ax3;
        curY = ay3;
      } else if (upper === 'S') {
        const x2 = nextNumber();
        const y2 = nextNumber();
        const x3 = nextNumber();
        const y3 = nextNumber();
        const ax1: number = lastCubicX !== null ? 2 * curX - lastCubicX : curX;
        const ay1: number = lastCubicY !== null ? 2 * curY - lastCubicY : curY;
        const ax2 = rel ? curX + x2 : x2;
        const ay2 = rel ? curY + y2 : y2;
        const ax3 = rel ? curX + x3 : x3;
        const ay3 = rel ? curY + y3 : y3;
        commands.push({ type: 'C', x1: ax1, y1: ay1, x2: ax2, y2: ay2, x3: ax3, y3: ay3 });
        lastCubicX = ax2;
        lastCubicY = ay2;
        lastQuadX = null;
        lastQuadY = null;
        curX = ax3;
        curY = ay3;
      } else if (upper === 'Q') {
        const qx = nextNumber();
        const qy = nextNumber();
        const ex = nextNumber();
        const ey = nextNumber();
        const aqx = rel ? curX + qx : qx;
        const aqy = rel ? curY + qy : qy;
        const aex = rel ? curX + ex : ex;
        const aey = rel ? curY + ey : ey;
        commands.push({
          type: 'C',
          x1: curX + (2 / 3) * (aqx - curX),
          y1: curY + (2 / 3) * (aqy - curY),
          x2: aex + (2 / 3) * (aqx - aex),
          y2: aey + (2 / 3) * (aqy - aey),
          x3: aex,
          y3: aey,
        });
        lastQuadX = aqx;
        lastQuadY = aqy;
        lastCubicX = null;
        lastCubicY = null;
        curX = aex;
        curY = aey;
      } else if (upper === 'T') {
        const ex = nextNumber();
        const ey = nextNumber();
        const aqx: number = lastQuadX !== null ? 2 * curX - lastQuadX : curX;
        const aqy: number = lastQuadY !== null ? 2 * curY - lastQuadY : curY;
        const aex = rel ? curX + ex : ex;
        const aey = rel ? curY + ey : ey;
        commands.push({
          type: 'C',
          x1: curX + (2 / 3) * (aqx - curX),
          y1: curY + (2 / 3) * (aqy - curY),
          x2: aex + (2 / 3) * (aqx - aex),
          y2: aey + (2 / 3) * (aqy - aey),
          x3: aex,
          y3: aey,
        });
        lastQuadX = aqx;
        lastQuadY = aqy;
        lastCubicX = null;
        lastCubicY = null;
        curX = aex;
        curY = aey;
      } else if (upper === 'A') {
        const rx = nextNumber();
        const ry = nextNumber();
        const rot = nextNumber();
        const largeArc = nextFlag();
        const sweep = nextFlag();
        const ex = nextNumber();
        const ey = nextNumber();
        const aex = rel ? curX + ex : ex;
        const aey = rel ? curY + ey : ey;
        const cubics = arcToCubics(curX, curY, rx, ry, rot, largeArc, sweep, aex, aey);
        if (cubics.length === 0) {
          commands.push({ type: 'L', x: aex, y: aey });
        } else {
          for (const [c1x, c1y, c2x, c2y, px, py] of cubics) {
            commands.push({ type: 'C', x1: c1x, y1: c1y, x2: c2x, y2: c2y, x3: px, y3: py });
          }
        }
        curX = aex;
        curY = aey;
        lastCubicX = null;
        lastCubicY = null;
        lastQuadX = null;
        lastQuadY = null;
      } else {
        throw new Error(`Unsupported SVG path command: ${cmd}`);
      }

      if (!hasNextNumber() && i < len) {
        skipWs();
      }
    }

    return commands;
  },

  /** Converts basic SVG primitive shapes into normalized PathCommand lists. */
  primitiveToCommands(tag: string, attrs: Record<string, string>): PathCommand[] | null {
    const num = (key: string, fallback = 0): number => {
      const raw = attrs[key];
      if (!raw) return fallback;
      const parsed = Number.parseFloat(raw);
      return Number.isFinite(parsed) ? parsed : fallback;
    };

    if (tag === 'rect') {
      const x = num('x', 0);
      const y = num('y', 0);
      const w = num('width', 0);
      const h = num('height', 0);
      if (w <= 0 || h <= 0) return null;
      let rx = num('rx', -1);
      let ry = num('ry', -1);
      if (rx < 0 && ry < 0) {
        return [
          { type: 'M', x, y },
          { type: 'L', x: x + w, y },
          { type: 'L', x: x + w, y: y + h },
          { type: 'L', x, y: y + h },
          { type: 'Z' },
        ];
      }
      if (rx < 0) rx = ry;
      if (ry < 0) ry = rx;
      rx = Math.min(rx, w * 0.5);
      ry = Math.min(ry, h * 0.5);
      const k = 0.5522847498;
      const ox = rx * k;
      const oy = ry * k;
      return [
        { type: 'M', x: x + rx, y },
        { type: 'L', x: x + w - rx, y },
        { type: 'C', x1: x + w - rx + ox, y1: y, x2: x + w, y2: y + ry - oy, x3: x + w, y3: y + ry },
        { type: 'L', x: x + w, y: y + h - ry },
        { type: 'C', x1: x + w, y1: y + h - ry + oy, x2: x + w - rx + ox, y2: y + h, x3: x + w - rx, y3: y + h },
        { type: 'L', x: x + rx, y: y + h },
        { type: 'C', x1: x + rx - ox, y1: y + h, x2: x, y2: y + h - ry + oy, x3: x, y3: y + h - ry },
        { type: 'L', x, y: y + ry },
        { type: 'C', x1: x, y1: y + ry - oy, x2: x + rx - ox, y2: y, x3: x + rx, y3: y },
        { type: 'Z' },
      ];
    }

    if (tag === 'circle' || tag === 'ellipse') {
      const cx = num('cx', 0);
      const cy = num('cy', 0);
      const rx = tag === 'circle' ? num('r', 0) : num('rx', 0);
      const ry = tag === 'circle' ? rx : num('ry', 0);
      if (rx <= 0 || ry <= 0) return null;
      const k = 0.5522847498;
      const ox = rx * k;
      const oy = ry * k;
      return [
        { type: 'M', x: cx + rx, y: cy },
        { type: 'C', x1: cx + rx, y1: cy + oy, x2: cx + ox, y2: cy + ry, x3: cx, y3: cy + ry },
        { type: 'C', x1: cx - ox, y1: cy + ry, x2: cx - rx, y2: cy + oy, x3: cx - rx, y3: cy },
        { type: 'C', x1: cx - rx, y1: cy - oy, x2: cx - ox, y2: cy - ry, x3: cx, y3: cy - ry },
        { type: 'C', x1: cx + ox, y1: cy - ry, x2: cx + rx, y2: cy - oy, x3: cx + rx, y3: cy },
        { type: 'Z' },
      ];
    }

    if (tag === 'line') {
      const x1 = num('x1', 0);
      const y1 = num('y1', 0);
      const x2 = num('x2', 0);
      const y2 = num('y2', 0);
      return [
        { type: 'M', x: x1, y: y1 },
        { type: 'L', x: x2, y: y2 },
      ];
    }

    if (tag === 'polygon' || tag === 'polyline') {
      const raw = attrs.points?.trim();
      if (!raw) return null;
      const nums = raw
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(Number)
        .filter(Number.isFinite);
      if (nums.length < 4) return null;
      const cmds: PathCommand[] = [{ type: 'M', x: nums[0], y: nums[1] }];
      for (let idx = 2; idx + 1 < nums.length; idx += 2) {
        cmds.push({ type: 'L', x: nums[idx], y: nums[idx + 1] });
      }
      if (tag === 'polygon') cmds.push({ type: 'Z' });
      return cmds;
    }

    return null;
  },

  formatNumber(value: number): string {
    if (!Number.isFinite(value)) return '0';
    const fixed = value.toFixed(3);
    let end = fixed.length;
    while (end > 0 && fixed[end - 1] === '0') end--;
    if (end > 0 && fixed[end - 1] === '.') end--;
    const trimmed = fixed.slice(0, end);
    return trimmed === '-0' || trimmed === '' ? '0' : trimmed;
  },

  format(commands: readonly PathCommand[]): string {
    let out = '';
    for (const cmd of commands) {
      switch (cmd.type) {
        case 'M':
          out += `M${VectorPathOps.formatNumber(cmd.x)} ${VectorPathOps.formatNumber(cmd.y)}`;
          break;
        case 'L':
          out += `L${VectorPathOps.formatNumber(cmd.x)} ${VectorPathOps.formatNumber(cmd.y)}`;
          break;
        case 'C':
          out += `C${VectorPathOps.formatNumber(cmd.x1)} ${VectorPathOps.formatNumber(cmd.y1)} ${VectorPathOps.formatNumber(cmd.x2)} ${VectorPathOps.formatNumber(cmd.y2)} ${VectorPathOps.formatNumber(cmd.x3)} ${VectorPathOps.formatNumber(cmd.y3)}`;
          break;
        case 'Z':
          out += 'Z';
          break;
      }
    }
    return out;
  },

  transform(commands: readonly PathCommand[], matrix: AffineMatrix2D): PathCommand[] {
    if (AffineMatrix.isIdentity(matrix)) return [...commands];
    return commands.map(cmd => {
      switch (cmd.type) {
        case 'M': {
          const p = AffineMatrix.mapPoint(matrix, cmd.x, cmd.y);
          return { type: 'M', x: p.x, y: p.y };
        }
        case 'L': {
          const p = AffineMatrix.mapPoint(matrix, cmd.x, cmd.y);
          return { type: 'L', x: p.x, y: p.y };
        }
        case 'C': {
          const p1 = AffineMatrix.mapPoint(matrix, cmd.x1, cmd.y1);
          const p2 = AffineMatrix.mapPoint(matrix, cmd.x2, cmd.y2);
          const p3 = AffineMatrix.mapPoint(matrix, cmd.x3, cmd.y3);
          return { type: 'C', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x3: p3.x, y3: p3.y };
        }
        case 'Z':
          return cmd;
      }
    });
  },

  computeBounds(commands: readonly PathCommand[]): Bounds | null {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let curX = 0;
    let curY = 0;

    const include = (x: number, y: number): void => {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    };

    for (const cmd of commands) {
      switch (cmd.type) {
        case 'M':
          curX = cmd.x;
          curY = cmd.y;
          include(curX, curY);
          break;
        case 'L':
          curX = cmd.x;
          curY = cmd.y;
          include(curX, curY);
          break;
        case 'C':
          for (let step = 1; step <= CUBIC_STEPS; step++) {
            const t = step / CUBIC_STEPS;
            const mt = 1 - t;
            const x =
              mt * mt * mt * curX +
              3 * mt * mt * t * cmd.x1 +
              3 * mt * t * t * cmd.x2 +
              t * t * t * cmd.x3;
            const y =
              mt * mt * mt * curY +
              3 * mt * mt * t * cmd.y1 +
              3 * mt * t * t * cmd.y2 +
              t * t * t * cmd.y3;
            include(x, y);
          }
          curX = cmd.x3;
          curY = cmd.y3;
          break;
        case 'Z':
          break;
      }
    }

    return Number.isFinite(minX) && Number.isFinite(minY)
      ? { left: minX, top: minY, right: maxX, bottom: maxY }
      : null;
  },

  flattenPolylines(commands: readonly PathCommand[], flatness?: number): Vec2[][] {
    const result: Vec2[][] = [];
    let current: Vec2[] = [];
    let startX = 0;
    let startY = 0;
    let curX = 0;
    let curY = 0;

    const pushCubicAdaptive = (
      x0: number,
      y0: number,
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      x3: number,
      y3: number,
      tolSq: number,
      depth: number,
    ): void => {
      const dx = x3 - x0;
      const dy = y3 - y0;
      const d1 = Math.abs((x1 - x3) * dy - (y1 - y3) * dx);
      const d2 = Math.abs((x2 - x3) * dy - (y2 - y3) * dx);
      const denom = dx * dx + dy * dy;
      if (depth >= 9 || (d1 + d2) * (d1 + d2) <= tolSq * Math.max(denom, 1e-6)) {
        current.push({ x: x3, y: y3 });
        return;
      }
      const x01 = (x0 + x1) * 0.5;
      const y01 = (y0 + y1) * 0.5;
      const x12 = (x1 + x2) * 0.5;
      const y12 = (y1 + y2) * 0.5;
      const x23 = (x2 + x3) * 0.5;
      const y23 = (y2 + y3) * 0.5;
      const x012 = (x01 + x12) * 0.5;
      const y012 = (y01 + y12) * 0.5;
      const x123 = (x12 + x23) * 0.5;
      const y123 = (y12 + y23) * 0.5;
      const x0123 = (x012 + x123) * 0.5;
      const y0123 = (y012 + y123) * 0.5;
      pushCubicAdaptive(x0, y0, x01, y01, x012, y012, x0123, y0123, tolSq, depth + 1);
      pushCubicAdaptive(x0123, y0123, x123, y123, x23, y23, x3, y3, tolSq, depth + 1);
    };

    for (const cmd of commands) {
      switch (cmd.type) {
        case 'M':
          if (current.length >= 2) result.push(current);
          current = [];
          curX = cmd.x;
          curY = cmd.y;
          startX = curX;
          startY = curY;
          current.push({ x: curX, y: curY });
          break;
        case 'L':
          curX = cmd.x;
          curY = cmd.y;
          current.push({ x: curX, y: curY });
          break;
        case 'C':
          if (flatness !== undefined) {
            pushCubicAdaptive(curX, curY, cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x3, cmd.y3, flatness * flatness, 0);
          } else {
            for (let step = 1; step <= CUBIC_STEPS; step++) {
              const t = step / CUBIC_STEPS;
              const mt = 1 - t;
              const px =
                mt * mt * mt * curX +
                3 * mt * mt * t * cmd.x1 +
                3 * mt * t * t * cmd.x2 +
                t * t * t * cmd.x3;
              const py =
                mt * mt * mt * curY +
                3 * mt * mt * t * cmd.y1 +
                3 * mt * t * t * cmd.y2 +
                t * t * t * cmd.y3;
              current.push({ x: px, y: py });
            }
          }
          curX = cmd.x3;
          curY = cmd.y3;
          break;
        case 'Z':
          if (current.length > 0 && (Math.abs(curX - startX) > 1e-4 || Math.abs(curY - startY) > 1e-4)) {
            current.push({ x: startX, y: startY });
          }
          curX = startX;
          curY = startY;
          break;
      }
    }
    if (current.length >= 2) result.push(current);
    return result;
  },

  isPointInsidePolylines(polylines: readonly (readonly Vec2[])[], x: number, y: number, fillRuleEvenOdd: boolean): boolean {
    let crossings = 0;
    let winding = 0;
    for (const poly of polylines) {
      if (poly.length < 3) continue;
      const n = poly.length;
      for (let i = 0; i < n; i++) {
        const p1 = poly[i];
        const p2 = poly[(i + 1) % n];
        const upward = p1.y <= y && p2.y > y;
        const downward = p1.y > y && p2.y <= y;
        if (upward || downward) {
          const vt = (y - p1.y) / (p2.y - p1.y);
          const intersectX = p1.x + vt * (p2.x - p1.x);
          if (x < intersectX) {
            crossings++;
            winding += upward ? 1 : -1;
          }
        }
      }
    }
    return fillRuleEvenOdd ? (crossings & 1) === 1 : winding !== 0;
  },

  hitTest(
    commands: readonly PathCommand[],
    x: number,
    y: number,
    fillRuleEvenOdd: boolean,
    hasFill: boolean,
    strokeWidth: number,
    hitSlop: number,
  ): boolean {
    const bounds = VectorPathOps.computeBounds(commands);
    if (!bounds) return false;
    const strokeRadius = strokeWidth * 0.5;
    const tolerance = Math.max(hitSlop, strokeRadius + hitSlop * 0.35);
    if (!boundsContains(bounds, x, y, tolerance)) return false;

    const polylines = VectorPathOps.flattenPolylines(commands);
    if (hasFill && VectorPathOps.isPointInsidePolylines(polylines, x, y, fillRuleEvenOdd)) {
      return true;
    }
    const edgeRadius = strokeWidth > 0 ? strokeRadius + hitSlop * 0.4 : hitSlop * 0.65;
    if (edgeRadius > 0) {
      const sqLimit = edgeRadius * edgeRadius;
      for (const poly of polylines) {
        for (let idx = 0; idx < poly.length - 1; idx++) {
          const a = poly[idx];
          const b = poly[idx + 1];
          if (distanceSquaredToSegment(x, y, a.x, a.y, b.x, b.y) <= sqLimit) {
            return true;
          }
        }
      }
    }
    return false;
  },
};

function distanceSquaredToSegment(
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
  if (lenSq <= 1e-8) {
    const ox = px - ax;
    const oy = py - ay;
    return ox * ox + oy * oy;
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const projX = ax + t * dx;
  const projY = ay + t * dy;
  const rx = px - projX;
  const ry = py - projY;
  return rx * rx + ry * ry;
}
