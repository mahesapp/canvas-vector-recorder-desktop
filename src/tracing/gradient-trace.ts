import type { TraceOptions, TraceResult } from './engine';
import { gradientColor, gradientDefinition, type GradientPaint } from './gradient-paint';
import { tracingSvgPaths } from './svg-paths';
type Sample = {
    x: number;
    y: number;
    c: number[];
};
type Model = {
    mean: number[];
    paint?: GradientPaint;
    predict: (x: number, y: number) => number[];
    hidden: boolean;
};
type Trace = (p: Uint8ClampedArray, w: number, h: number, o: TraceOptions) => TraceResult;
const color = (rgb: number[]) => '#' + rgb.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const dist = (a: number[], b: number[]) => a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0);
function regression(samples: Sample[], coordinate: (p: Sample) => number) {
    let t = 0, tt = 0;
    const sum = [0, 0, 0], tc = [0, 0, 0];
    for (const p of samples) {
        const u = coordinate(p);
        t += u;
        tt += u * u;
        for (let k = 0; k < 3; k++) {
            sum[k] += p.c[k];
            tc[k] += u * p.c[k];
        }
    }
    const n = samples.length, d = tt - t * t / n;
    if (d < 1e-8)
        return;
    const b = tc.map((v, k) => (v - t * sum[k] / n) / d), a = sum.map((v, k) => (v - b[k] * t) / n);
    let error = 0;
    for (const p of samples) {
        const u = coordinate(p);
        error += dist(p.c, a.map((v, k) => Math.max(0, Math.min(255, v + b[k] * u))));
    }
    return { a, b, error };
}
function gradientModel(samples: Sample[], box: number[], id: string): GradientPaint | undefined {
    const [x0, y0, x1, y1] = box, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, L = Math.max(x1 - x0, y1 - y0);
    const mean = [0, 1, 2].map(k => samples.reduce((s, p) => s + p.c[k], 0) / samples.length), flat = samples.reduce((s, p) => s + dist(p.c, mean), 0);
    if (flat < samples.length * 48)
        return;
    let best: {
        paint: GradientPaint;
        error: number;
    } | undefined;
    for (let i = 0; i < 24; i++) {
        const angle = i * Math.PI / 24, ux = Math.cos(angle), uy = Math.sin(angle), at = (p: Sample) => ((p.x - cx) * ux + (p.y - cy) * uy) / L, fit = regression(samples, at);
        if (!fit)
            continue;
        const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => ((x - cx) * ux + (y - cy) * uy) / L), lo = Math.min(...corners), hi = Math.max(...corners);
        const paint: GradientPaint = { id, kind: 'linear', coords: [cx + ux * lo * L, cy + uy * lo * L, cx + ux * hi * L, cy + uy * hi * L], stops: [{ offset: 0, color: color(fit.a.map((v, k) => v + fit.b[k] * lo)) }, { offset: 1, color: color(fit.a.map((v, k) => v + fit.b[k] * hi)) }] };
        const error = samples.reduce((s, p) => s + dist(p.c, gradientColor(paint, p.x, p.y).map(v => v * 255)), 0);
        if (!best || error < best.error)
            best = { paint, error };
    }
    // Concentric radial model with an optimized center and saturation radius.
    let radial: {
        x: number;
        y: number;
        r: number;
        fit: NonNullable<ReturnType<typeof regression>>;
    } | undefined;
    const test = (x: number, y: number, r: number) => { if (r < 4)
        return; const fit = regression(samples, p => Math.min(1, Math.hypot(p.x - x, p.y - y) / r)); if (fit && (!radial || fit.error < radial.fit.error))
        radial = { x, y, r, fit }; };
    for (const x of [x0, cx, x1])
        for (const y of [y0, cy, y1])
            for (const r of [.35, .6, 1])
                test(x, y, L * r);
    for (let pass = 0; pass < 5 && radial; pass++) {
        const q: {
            x: number;
            y: number;
            r: number;
            fit: NonNullable<ReturnType<typeof regression>>;
        } = radial, step = L * .2 / 2 ** pass;
        for (const d of [-1, 1]) {
            test(q.x + d * step, q.y, q.r);
            test(q.x, q.y + d * step, q.r);
            test(q.x, q.y, q.r + d * step);
        }
    }
    if (radial) {
        const q = radial, paint: GradientPaint = { id, kind: 'radial', coords: [q.x, q.y, q.r], stops: [{ offset: 0, color: color(q.fit.a) }, { offset: 1, color: color(q.fit.a.map((v, k) => v + q.fit.b[k])) }] }, error = samples.reduce((s, p) => s + dist(p.c, gradientColor(paint, p.x, p.y).map(v => v * 255)), 0);
        if (!best || error < best.error)
            best = { paint, error };
    }
    if (!best || best.error > flat * .12 || Math.sqrt(best.error / (samples.length * 3)) > 4)
        return;
    let bad = 0;
    for (const p of samples)
        if (dist(p.c, gradientColor(best.paint, p.x, p.y).map(v => v * 255)) > 24 ** 2)
            bad++;
    return bad > Math.max(1, samples.length * .002) ? undefined : best.paint;
}
/** Segment smooth source fields, fit opaque paints and trace the same fields.
 * Unexplained accents veto the proposal. The caller scores the exported SVG.
 */
export function traceGradientRegions(p: Uint8ClampedArray, w: number, h: number, o: TraceOptions, trace: Trace): TraceResult | undefined {
    const N = w * h;
    if (N < 64 || N > 1024 ** 2)
        return;
    let gradual = 0, visible = 0;
    const step = Math.max(1, Math.floor(N / 40000));
    for (let q = 0; q + w < N; q += step) {
        if (p[q * 4 + 3] < 240)
            continue;
        visible++;
        const d = Math.max(...[0, 1, 2].map(k => Math.abs(p[q * 4 + k] - p[(q + w) * 4 + k]))), r = q % w + 1 < w ? Math.max(...[0, 1, 2].map(k => Math.abs(p[q * 4 + k] - p[(q + 1) * 4 + k]))) : 0;
        if (d > 0 && d <= 14 || r > 0 && r <= 14)
            gradual++;
    }
    if (gradual < Math.max(24, visible * .02))
        return;
    const labels = new Int32Array(N).fill(-1), queue = new Int32Array(N), regions: {
        pixels: Int32Array;
        box: number[];
        border: boolean;
    }[] = [];
    const near = (a: number, b: number) => Math.max(Math.abs(p[a * 4] - p[b * 4]), Math.abs(p[a * 4 + 1] - p[b * 4 + 1]), Math.abs(p[a * 4 + 2] - p[b * 4 + 2])) <= 18;
    for (let start = 0; start < N; start++) {
        if (labels[start] >= 0 || p[start * 4 + 3] < 128)
            continue;
        const id = regions.length;
        let end = 1, read = 0, x0 = w, y0 = h, x1 = 0, y1 = 0, border = false;
        queue[0] = start;
        labels[start] = id;
        while (read < end) {
            const j = queue[read++], x = j % w, y = Math.floor(j / w);
            x0 = Math.min(x0, x);
            y0 = Math.min(y0, y);
            x1 = Math.max(x1, x + 1);
            y1 = Math.max(y1, y + 1);
            if (!x || !y || x + 1 === w || y + 1 === h)
                border = true;
            for (const q of [x ? j - 1 : -1, x + 1 < w ? j + 1 : -1, y ? j - w : -1, y + 1 < h ? j + w : -1])
                if (q >= 0 && labels[q] < 0 && p[q * 4 + 3] >= 128 && near(j, q)) {
                    labels[q] = id;
                    queue[end++] = q;
                }
        }
        regions.push({ pixels: queue.slice(0, end), box: [x0, y0, x1, y1], border });
        if (regions.length > 4096)
            return;
    }
    const major = regions.map((r, i) => ({ r, i })).filter(({ r }) => r.pixels.length >= Math.max(16, N * .0005));
    if (!major.length || major.length > Math.min(16, o.colors))
        return;
    const models: Model[] = [], slot = new Int16Array(regions.length).fill(-1);
    let gradients = 0;
    for (const { r, i } of major) {
        const samples: Sample[] = [], step = Math.max(1, Math.floor(r.pixels.length / 4096));
        for (let n = 0; n < r.pixels.length; n += step) {
            const q = r.pixels[n], x = q % w, y = Math.floor(q / w);
            if (p[q * 4 + 3] < 240)
                continue;
            // Exclude antialias and junction pixels from paint estimation.
            if (x && y && x + 1 < w && y + 1 < h && [q - 1, q + 1, q - w, q + w].some(z => labels[z] !== i))
                continue;
            samples.push({ x: x + .5, y: y + .5, c: [p[q * 4], p[q * 4 + 1], p[q * 4 + 2]] });
        }
        if (samples.length < 8)
            return;
        const mean = [0, 1, 2].map(k => samples.reduce((s, q) => s + q.c[k], 0) / samples.length), paint = samples.length >= 48 ? gradientModel(samples, r.box, `trace-gradient-${gradients}`) : undefined;
        if (paint)
            gradients++;
        else if (samples.reduce((s, q) => s + dist(q.c, mean), 0) / samples.length > 64)
            return;
        const mode = o.whiteMode ?? (o.removeWhite ? 'all' : 'none'), white = !paint && mean.every(c => c >= 245), hidden = white && (mode === 'all' || mode === 'background' && r.border);
        slot[i] = models.length;
        models.push({ mean, paint, hidden, predict: paint ? (x, y) => gradientColor(paint, x, y).map(v => v * 255) : () => mean });
    }
    if (!gradients)
        return;
    const codes = models.map((_, k) => [32 + (k % 4) * 64, 32 + Math.floor(k / 4) * 64, 96 + (k % 2) * 64]), encoded = new Uint8ClampedArray(p.length);
    for (let q = 0; q < N; q++) {
        if (p[q * 4 + 3] < 128)
            continue;
        const x = q % w + .5, y = Math.floor(q / w) + .5, c = [p[q * 4], p[q * 4 + 1], p[q * 4 + 2]], predictions = models.map(m => m.predict(x, y));
        let a = slot[labels[q]], b = -1, best = Infinity, next = Infinity;
        for (let k = 0; k < models.length; k++) {
            const e = dist(c, predictions[k]);
            if (e < best) {
                next = best;
                b = a;
                best = e;
                a = k;
            }
            else if (e < next) {
                next = e;
                b = k;
            }
        }
        if (slot[labels[q]] < 0 && best > 12 ** 2) {
            const adjacent = new Set<number>();
            for (let dy = -2; dy <= 2; dy++)
                for (let dx = -2; dx <= 2; dx++) {
                    const xx = Math.floor(x) + dx, yy = Math.floor(y) + dy;
                    if (xx >= 0 && yy >= 0 && xx < w && yy < h && labels[yy * w + xx] >= 0)
                        adjacent.add(slot[labels[yy * w + xx]]);
                }
            if (!adjacent.has(a) || !adjacent.has(b))
                return;
        }
        let mix = 0;
        if (best > 4 ** 2 && b >= 0 && a !== b) {
            const A = predictions[a], B = predictions[b], v = B.map((n, k) => n - A[k]), den = dist(A, B), t = den ? v.reduce((s, n, k) => s + (c[k] - A[k]) * n, 0) / den : 0;
            if (t > 0 && t < .5 && dist(c, A.map((n, k) => n + t * v[k])) < 12 ** 2)
                mix = t;
        }
        if (best > 24 ** 2 && !mix)
            return; // A coherent detail must not disappear into a paint model.
        if (models[a].hidden)
            continue;
        const rgb = codes[a].map((n, k) => n * (1 - mix) + (b >= 0 ? codes[b][k] : n) * mix);
        encoded.set([...rgb, p[q * 4 + 3]], q * 4);
    }
    const shape = trace(encoded, w, h, { ...o, colors: models.length < 2 ? 2 : models.length, minArea: 0, whiteMode: 'none', removeWhite: false, noiseCleanup: false, localRefinement: false, gradients: false, pixelArt: false });
    const paths = tracingSvgPaths(shape.svg);
    let body = '';
    const used = new Set<string>(), colors = new Set<string>();
    for (const path of paths) {
        const rgb = [1, 3, 5].map(k => parseInt(path.color.slice(k, k + 2), 16));
        let owner = 0;
        for (let k = 1; k < codes.length; k++)
            if (dist(rgb, codes[k]) < dist(rgb, codes[owner]))
                owner = k;
        const m = models[owner];
        if (m.hidden)
            continue;
        const fill = m.paint ? `url(#${m.paint.id})` : color(m.mean);
        if (m.paint) {
            used.add(m.paint.id);
            m.paint.stops.forEach(s => colors.add(s.color));
        }
        else
            colors.add(fill);
        body += path.original.replace(/\bfill="[^"]+"/, `fill="${fill}"`);
    }
    const paints = models.flatMap(m => m.paint && used.has(m.paint.id) ? [m.paint] : []);
    if (!paints.length || colors.size > o.colors)
        return;
    return { ...shape, colors: [...colors], svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>${paints.map(gradientDefinition).join('')}</defs>${body}</svg>`, diagnostics: { ...shape.diagnostics, gradientRegions: paints.length } };
}
