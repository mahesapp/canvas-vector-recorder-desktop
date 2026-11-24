import { strokeSelfIntersects, type StrokeCurve as Curve, type StrokePoint as Point } from './stroke-regularizer';
const d2 = (a: Point, b: Point) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
const lineError = (p: Point, a: Point, b: Point) => { const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1))); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); };
function simplify(p: Point[], tol: number): Point[] {
    if (p.length <= 2)
        return p;
    let e = tol, k = -1;
    for (let i = 1; i < p.length - 1; i++) {
        const d = lineError(p[i], p[0], p[p.length - 1]);
        if (d > e) {
            e = d;
            k = i;
        }
    }
    return k < 0 ? [p[0], p[p.length - 1]] : [...simplify(p.slice(0, k + 1), tol).slice(0, -1), ...simplify(p.slice(k), tol)];
}
export function fitGeometricPolygon(raw: Point[]): Curve[] | undefined {
    if (raw.length < 12 || raw.length > 8000 || d2(raw[0], raw[raw.length - 1]) > 1e-12)
        return;
    let far = 1;
    for (let i = 2; i < raw.length - 1; i++)
        if (d2(raw[0], raw[i]) > d2(raw[0], raw[far]))
            far = i;
    const p = [...simplify(raw.slice(0, far + 1), .55).slice(0, -1), ...simplify(raw.slice(far), .55).slice(0, -1)];
    if (p.length < 3 || p.length > 12 || p.some((a, i) => d2(a, p[(i + 1) % p.length]) < 64))
        return;
    let sum = 0;
    for (const q of raw) {
        const e = Math.min(...p.map((a, i) => lineError(q, a, p[(i + 1) % p.length])));
        if (e > .6)
            return;
        sum += e * e;
    }
    const out = p.map((from, i) => ({ from, to: p[(i + 1) % p.length] }));
    if (Math.sqrt(sum / raw.length) > .24 || strokeSelfIntersects(out))
        return;
    return out;
}
/** Axis candidates come from measured sides, including rotated squares. */
export function fitRoundedRectangle(raw: Point[]): Curve[] | undefined {
    if (raw.length < 32 || raw.length > 8000 || d2(raw[0], raw[raw.length - 1]) > 1e-12)
        return;
    const points = raw.slice(0, -1), bins = new Float64Array(90);
    for (let i = 0; i < points.length; i++) {
        const a = points[i], b = points[(i + 5) % points.length], angle = ((Math.atan2(b[1] - a[1], b[0] - a[0]) % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
        bins[Math.min(89, Math.round(angle * 180 / Math.PI) % 90)] += Math.sqrt(d2(a, b));
    }
    const angles = [0, ...[...bins.keys()].sort((a, b) => bins[b] - bins[a]).slice(0, 4).map(k => k * Math.PI / 180)];
    let best: {
        angle: number;
        x0: number;
        y0: number;
        x1: number;
        y1: number;
        r: number;
        cost: number;
    } | undefined;
    for (const angle of angles) {
        const c = Math.cos(angle), s = Math.sin(angle), p = points.map(([x, y]) => [x * c + y * s, -x * s + y * c]);
        const xs = p.map(q => q[0]), ys = p.map(q => q[1]), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), hx = (x1 - x0) / 2, hy = (y1 - y0) / 2;
        if (Math.min(hx, hy) < 5)
            continue;
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
        const cost = (r: number) => { let sum = 0, max = 0; for (const q of p) {
            const u = Math.abs(q[0] - cx) - hx + r, v = Math.abs(q[1] - cy) - hy + r, e = Math.abs(Math.hypot(Math.max(0, u), Math.max(0, v)) + Math.min(0, Math.max(u, v)) - r);
            sum += e * e;
            max = Math.max(max, e);
        } return max <= .65 ? sum / p.length : Infinity; };
        let radius = 0, value = Infinity;
        for (let r = 0; r <= Math.min(hx, hy) + .001; r += Math.max(.25, Math.min(hx, hy) / 80)) {
            const e = cost(r);
            if (e < value) {
                value = e;
                radius = r;
            }
        }
        // A capsule's radius equals its short half-axis exactly.
        if (cost(Math.min(hx, hy)) < value) {
            radius = Math.min(hx, hy);
            value = cost(radius);
        }
        if (value <= .25 ** 2 && (!best || value < best.cost))
            best = { angle, x0, y0, x1, y1, r: radius, cost: value };
    }
    if (!best || best.r < 1)
        return;
    const { angle, x0, y0, x1, y1, r } = best, c = Math.cos(angle), s = Math.sin(angle), K = .5522847498307936;
    const world = (x: number, y: number): Point => [x * c - y * s, x * s + y * c];
    const out: Curve[] = [];
    let at = world(x0 + r, y0);
    const line = (x: number, y: number) => { const to = world(x, y); if (d2(at, to) > 1e-10)
        out.push({ from: at, to }); at = to; };
    const arc = (a: Point, b: Point, e: Point) => { const to = world(...e); out.push({ from: at, to, controls: [world(...a), world(...b)] }); at = to; };
    line(x1 - r, y0);
    arc([x1 - r + K * r, y0], [x1, y0 + r - K * r], [x1, y0 + r]);
    line(x1, y1 - r);
    arc([x1, y1 - r + K * r], [x1 - r + K * r, y1], [x1 - r, y1]);
    line(x0 + r, y1);
    arc([x0 + r - K * r, y1], [x0, y1 - r + K * r], [x0, y1 - r]);
    line(x0, y0 + r);
    arc([x0, y0 + r - K * r], [x0 + r - K * r, y0], [x0 + r, y0]);
    let area = 0;
    for (let i = 1; i < raw.length; i++)
        area += raw[i - 1][0] * raw[i][1] - raw[i][0] * raw[i - 1][1];
    return area >= 0 ? out : out.reverse().map(q => ({ from: q.to, to: q.from, controls: q.controls ? [q.controls[1], q.controls[0]] : undefined }));
}
/** Fit a shared open arc with both junction coordinates fixed. */
export function fitCircularArc(raw: Point[]): Curve[] | undefined {
    if (raw.length < 16)
        return;
    const a = raw[0], b = raw[raw.length - 1], dx = b[0] - a[0], dy = b[1] - a[1], chord = Math.hypot(dx, dy);
    if (chord < 8)
        return;
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, nx = -dy / chord, ny = dx / chord;
    let sum = 0, den = 0;
    for (const p of raw) {
        const x = p[0] - mx, y = p[1] - my, z = 2 * (x * nx + y * ny);
        sum += z * (x * x + y * y - chord * chord / 4);
        den += z * z;
    }
    if (den < 1e-6)
        return;
    const t = sum / den, cx = mx + t * nx, cy = my + t * ny, r = Math.hypot(chord / 2, t);
    let error = 0, travel = 0, turn = 0, prev = Math.atan2(a[1] - cy, a[0] - cx), first = prev;
    for (const p of raw) {
        const e = Math.abs(Math.hypot(p[0] - cx, p[1] - cy) - r);
        if (e > .6)
            return;
        error += e * e;
        const angle = Math.atan2(p[1] - cy, p[0] - cx);
        let d = angle - prev;
        while (d > Math.PI)
            d -= 2 * Math.PI;
        while (d < -Math.PI)
            d += 2 * Math.PI;
        turn += d;
        travel += Math.abs(d);
        prev = angle;
    }
    if (r < 8 || Math.sqrt(error / raw.length) > .24 || Math.abs(turn) < Math.PI / 4 || Math.abs(turn) > Math.PI * 1.9 || travel - Math.abs(turn) > .08)
        return;
    const out: Curve[] = [], n = Math.ceil(Math.abs(turn) / (Math.PI / 2)), step = turn / n;
    let from = a;
    for (let i = 0; i < n; i++) {
        const u = first + i * step, v = u + step, k = 4 / 3 * Math.tan(step / 4) * r, to: Point = i === n - 1 ? b : [cx + r * Math.cos(v), cy + r * Math.sin(v)];
        out.push({ from, to, controls: [[from[0] - k * Math.sin(u), from[1] + k * Math.cos(u)], [to[0] + k * Math.sin(v), to[1] - k * Math.cos(v)]] });
        from = to;
    }
    return out;
}
