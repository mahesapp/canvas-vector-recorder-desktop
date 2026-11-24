export type GradientStop = {
    offset: number;
    color: string;
};
export type GradientPaint = {
    id: string;
    kind: 'linear' | 'radial';
    coords: number[];
    stops: GradientStop[];
};
const hex = /^#[0-9a-f]{6}$/i;
export function gradientColor(g: GradientPaint, x: number, y: number): number[] {
    const c = g.coords;
    const t = g.kind === 'radial' ? Math.hypot(x - c[0], y - c[1]) / c[2] : ((x - c[0]) * (c[2] - c[0]) + (y - c[1]) * (c[3] - c[1])) / ((c[2] - c[0]) ** 2 + (c[3] - c[1]) ** 2);
    let a = g.stops[0], b = g.stops[g.stops.length - 1];
    for (let i = 1; i < g.stops.length; i++)
        if (t <= g.stops[i].offset) {
            a = g.stops[i - 1];
            b = g.stops[i];
            break;
        }
    const f = Math.max(0, Math.min(1, (t - a.offset) / (b.offset - a.offset)));
    return [1, 3, 5].map(k => (parseInt(a.color.slice(k, k + 2), 16) * (1 - f) + parseInt(b.color.slice(k, k + 2), 16) * f) / 255);
}
export function readGradients(svg: string) {
    const gradients = new Map<string, GradientPaint>();
    for (const m of svg.matchAll(/<(linear|radial)Gradient\b([^>]*)>([\s\S]*?)<\/\1Gradient>/g)) {
        const attr = (name: string) => m[2].match(new RegExp(`\\b${name}="([^"]+)"`))?.[1];
        const id = attr('id'), kind = m[1] as 'linear' | 'radial';
        if (!id || !/^[\w-]+$/.test(id) || gradients.has(id) || attr('gradientUnits') !== 'userSpaceOnUse')
            throw new Error('Definisi gradasi SVG tidak valid.');
        const coords = (kind === 'linear' ? ['x1', 'y1', 'x2', 'y2'] : ['cx', 'cy', 'r']).map(k => Number(attr(k) ?? NaN));
        if (!coords.every(Number.isFinite) || (kind === 'radial' ? coords[2] <= 0 : Math.hypot(coords[2] - coords[0], coords[3] - coords[1]) < 1e-6))
            throw new Error('Koordinat gradasi SVG tidak valid.');
        const stops = [...m[3].matchAll(/<stop\b([^>]*)\/?\s*>/g)].map(s => ({ offset: Number(s[1].match(/\boffset="([^"]+)"/)?.[1] ?? NaN), color: s[1].match(/\bstop-color="([^"]+)"/)?.[1] ?? '' }));
        if (stops.length < 2 || stops.length > 32 || stops[0].offset !== 0 || stops[stops.length - 1].offset !== 1 || stops.some((s, i) => !Number.isFinite(s.offset) || !hex.test(s.color) || i > 0 && s.offset <= stops[i - 1].offset))
            throw new Error('Warna gradasi SVG tidak valid.');
        gradients.set(id, { id, kind, coords, stops });
    }
    return gradients;
}
export function gradientDefinition(g: GradientPaint) {
    const attrs = g.kind === 'linear' ? ['x1', 'y1', 'x2', 'y2'] : ['cx', 'cy', 'r'];
    return `<${g.kind}Gradient id="${g.id}" gradientUnits="userSpaceOnUse" ${attrs.map((k, i) => `${k}="${+g.coords[i].toFixed(4)}"`).join(' ')}>${g.stops.map(s => `<stop offset="${s.offset}" stop-color="${s.color}"/>`).join('')}</${g.kind}Gradient>`;
}
/** PostScript LanguageLevel 3 axial/radial shadings, in path user space. */
export function gradientPostScript(g: GradientPaint) {
    const f = (n: number) => String(+n.toFixed(6)), rgb = (s: GradientStop) => [1, 3, 5].map(k => f(parseInt(s.color.slice(k, k + 2), 16) / 255)).join(' ');
    const functions = g.stops.slice(1).map((s, i) => `<< /FunctionType 2 /Domain [0 1] /C0 [${rgb(g.stops[i])}] /C1 [${rgb(s)}] /N 1 >>`);
    const fn = functions.length === 1 ? functions[0] : `<< /FunctionType 3 /Domain [0 1] /Functions [${functions.join(' ')}] /Bounds [${g.stops.slice(1, -1).map(s => f(s.offset)).join(' ')}] /Encode [${functions.map(() => '0 1').join(' ')}] >>`;
    const c = g.coords, coords = g.kind === 'linear' ? c : [c[0], c[1], 0, c[0], c[1], c[2]];
    return `<< /ShadingType ${g.kind === 'linear' ? 2 : 3} /ColorSpace /DeviceRGB /Coords [${coords.map(f).join(' ')}] /Extend [true true] /Function ${fn} >> shfill\n`;
}
