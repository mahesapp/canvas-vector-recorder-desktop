import type { TraceOptions, TraceResult, TraceDiagnostics } from './engine';
export type GridAxis = {
    period: number;
    positions: number[];
    edgeShare: number;
};
type Quantize = (p: Uint8ClampedArray, count: number) => {
    labels: Int16Array;
    palette: number[][];
};
function axis(energy: Float64Array): GridAxis | undefined {
    const n = energy.length, mean = energy.reduce((a, b) => a + b, 0) / n;
    if (mean < 1)
        return;
    const peaks: number[] = [];
    for (let i = 0; i < n; i++)
        if (energy[i] > mean * 1.8) {
            let weight = 0, position = 0;
            while (i < n && energy[i] > mean * 1.3) {
                weight += energy[i];
                position += (i + 1) * energy[i];
                i++;
            }
            peaks.push(position / weight);
        }
    if (peaks.length < 5)
        return;
    const gaps = peaks.slice(1).map((p, i) => p - peaks[i]).sort((a, b) => a - b), period = gaps[Math.floor(gaps.length / 2)];
    if (period < 2.5 || period > 96 || gaps.filter(d => Math.abs(d / period - Math.round(d / period)) < .12).length < gaps.length * .85)
        return;
    let phase = peaks[0] % period;
    // Refine phase using all detected boundaries, not one possibly blurred edge.
    for (let pass = 0; pass < 2; pass++) {
        let sum = 0;
        for (const p of peaks)
            sum += p - (phase + Math.round((p - phase) / period) * period);
        phase += sum / peaks.length;
    }
    phase = (phase % period + period) % period;
    const positions = [0];
    for (let x = phase; x < n + 1; x += period)
        if (x >= period * .4 && x <= n + 1 - period * .4)
            positions.push(+x.toFixed(5));
    positions.push(n + 1);
    if (positions.length < 7 || peaks.length / (positions.length - 2) < .65)
        return;
    let near = 0, total = 0;
    for (let i = 0, k = 0; i < n; i++) {
        while (k + 1 < positions.length && positions[k + 1] < i + 1)
            k++;
        const d = Math.min(Math.abs(i + 1 - positions[k]), Math.abs(i + 1 - (positions[k + 1] ?? Infinity)));
        total += energy[i];
        if (d <= Math.max(.65, period * .18))
            near += energy[i];
    }
    if (near / total < .85)
        return;
    return { period, positions, edgeShare: near / total };
}
/** Detect the source grid before reducing colors or simplifying raster stairs. */
export function detectPixelGrid(p: Uint8ClampedArray, w: number, h: number) {
    if (w < 24 || h < 24)
        return;
    const gx = new Float64Array(w - 1), gy = new Float64Array(h - 1);
    const delta = (a: number, b: number) => { const aa = p[a + 3] >= 128, ba = p[b + 3] >= 128; if (aa !== ba)
        return 300; if (!aa)
        return 0; return Math.abs(p[a] - p[b]) + Math.abs(p[a + 1] - p[b + 1]) + Math.abs(p[a + 2] - p[b + 2]); };
    let diagonal = 0, edge = 0;
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4, dx = x + 1 < w ? delta(i, i + 4) : 0, dy = y + 1 < h ? delta(i, i + w * 4) : 0;
            if (x + 1 < w)
                gx[x] += dx;
            if (y + 1 < h)
                gy[y] += dy;
            diagonal += Math.min(dx, dy);
            edge += Math.max(dx, dy);
        }
    if (!edge || diagonal / edge > .3)
        return;
    const X = axis(gx), Y = axis(gy);
    if (!X || !Y || X.period / Y.period < .8 || X.period / Y.period > 1.25)
        return;
    const cols = X.positions.length - 1, rows = Y.positions.length - 1;
    if (cols * rows > 65536)
        return;
    return { x: X, y: Y, cols, rows };
}
export function tracePixelGrid(p: Uint8ClampedArray, w: number, h: number, o: TraceOptions, quantize: Quantize, diagnostics: () => TraceDiagnostics): TraceResult | undefined {
    const grid = detectPixelGrid(p, w, h);
    if (!grid)
        return;
    const { cols, rows, x: X, y: Y } = grid, cells = new Uint8ClampedArray(cols * rows * 4);
    let tested = 0, bad = 0;
    for (let y = 0; y < rows; y++)
        for (let x = 0; x < cols; x++) {
            const x0 = Math.max(0, Math.ceil(X.positions[x] + .22 * (X.positions[x + 1] - X.positions[x]) - .5)), x1 = Math.min(w, Math.ceil(X.positions[x + 1] - .22 * (X.positions[x + 1] - X.positions[x]) - .5));
            const y0 = Math.max(0, Math.ceil(Y.positions[y] + .22 * (Y.positions[y + 1] - Y.positions[y]) - .5)), y1 = Math.min(h, Math.ceil(Y.positions[y + 1] - .22 * (Y.positions[y + 1] - Y.positions[y]) - .5));
            const bins = new Map<number, {
                n: number;
                r: number;
                g: number;
                b: number;
            }>();
            let visible = 0, count = 0;
            for (let yy = y0; yy < y1; yy++)
                for (let xx = x0; xx < x1; xx++) {
                    const i = (yy * w + xx) * 4;
                    count++;
                    if (p[i + 3] < 128)
                        continue;
                    visible++;
                    const key = (p[i] >> 3) << 10 | (p[i + 1] >> 3) << 5 | p[i + 2] >> 3, a = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
                    a.n++;
                    a.r += p[i];
                    a.g += p[i + 1];
                    a.b += p[i + 2];
                    bins.set(key, a);
                }
            if (!count || visible > 0 && visible < count * .8)
                return;
            if (!visible)
                continue;
            const mode = [...bins.values()].sort((a, b) => b.n - a.n)[0], color = [mode.r / mode.n, mode.g / mode.n, mode.b / mode.n];
            cells.set([...color, 255], (y * cols + x) * 4);
            for (let yy = y0; yy < y1; yy++)
                for (let xx = x0; xx < x1; xx++) {
                    const i = (yy * w + xx) * 4;
                    if (p[i + 3] < 128)
                        continue;
                    tested++;
                    if (Math.max(...color.map((c, k) => Math.abs(p[i + k] - c))) > 12)
                        bad++;
                }
        }
    if (!tested || bad / tested > .015)
        return;
    const { labels, palette } = quantize(cells, o.colors), mode = o.whiteMode ?? (o.removeWhite ? 'all' : 'none'), white = palette.map(c => c.every(v => v >= 245));
    if (mode === 'all')
        for (let i = 0; i < labels.length; i++)
            if (white[labels[i]])
                labels[i] = -1;
    if (mode === 'background') {
        const queue: number[] = [], seen = new Uint8Array(labels.length), add = (i: number) => { if (!seen[i] && white[labels[i]]) {
            seen[i] = 1;
            queue.push(i);
        } };
        for (let x = 0; x < cols; x++) {
            add(x);
            add((rows - 1) * cols + x);
        }
        for (let y = 0; y < rows; y++) {
            add(y * cols);
            add(y * cols + cols - 1);
        }
        for (let r = 0; r < queue.length; r++) {
            const i = queue[r], x = i % cols;
            labels[i] = -1;
            for (const j of [x ? i - 1 : -1, x + 1 < cols ? i + 1 : -1, i >= cols ? i - cols : -1, i + cols < labels.length ? i + cols : -1])
                if (j >= 0)
                    add(j);
        }
    }
    const stride = cols + 1, edges = palette.map(() => new Map<number, {
        dir: number;
        used: boolean;
    }[]>()), DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
    const at = (x: number, y: number) => x < 0 || y < 0 || x >= cols || y >= rows ? -1 : labels[y * cols + x];
    const add = (k: number, x: number, y: number, dir: number) => { const key = y * stride + x, list = edges[k].get(key) ?? []; list.push({ dir, used: false }); edges[k].set(key, list); };
    for (let y = 0; y < rows; y++)
        for (let x = 0; x < cols; x++) {
            const k = at(x, y);
            if (k < 0)
                continue;
            if (at(x, y - 1) !== k)
                add(k, x, y, 0);
            if (at(x + 1, y) !== k)
                add(k, x + 1, y, 1);
            if (at(x, y + 1) !== k)
                add(k, x + 1, y + 1, 2);
            if (at(x - 1, y) !== k)
                add(k, x, y + 1, 3);
        }
    let paths = '', contours = 0, segments = 0;
    const colors: string[] = [];
    for (let k = 0; k < palette.length; k++) {
        let data = '';
        for (const [start, list] of edges[k])
            for (const first of list) {
                if (first.used)
                    continue;
                let x = start % stride, y = Math.floor(start / stride), edge = first;
                const corners: {
                    x: number;
                    y: number;
                    dir: number;
                }[] = [];
                for (let guard = 0; guard < 4 * labels.length + 4; guard++) {
                    edge.used = true;
                    const prev = corners[corners.length - 1];
                    if (!prev || prev.dir !== edge.dir)
                        corners.push({ x, y, dir: edge.dir });
                    x += DX[edge.dir];
                    y += DY[edge.dir];
                    if (y * stride + x === start)
                        break;
                    const next = edges[k].get(y * stride + x);
                    let found: typeof edge | undefined;
                    for (const turn of [1, 0, 3, 2]) {
                        found = next?.find(e => !e.used && e.dir === (edge.dir + turn) % 4);
                        if (found)
                            break;
                    }
                    if (!found)
                        throw Error('Batas grid terputus.');
                    edge = found;
                }
                if (corners.length > 1 && corners[0].dir === corners[corners.length - 1].dir)
                    corners.shift();
                if (corners.length < 4)
                    continue;
                data += corners.map((p, i) => `${i ? 'L' : 'M'}${+X.positions[p.x].toFixed(4)} ${+Y.positions[p.y].toFixed(4)}`).join('') + 'Z';
                contours++;
                segments += corners.length;
            }
        if (data) {
            const color = '#' + palette[k].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
            colors.push(color);
            paths += `<path fill="${color}" fill-rule="nonzero" d="${data}"/>`;
        }
    }
    if (!paths)
        return;
    return { width: w, height: h, colors, paths: colors.length, contours, segments, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${paths}</svg>`, diagnostics: { ...diagnostics(), pixelGridCells: cols * rows } };
}
