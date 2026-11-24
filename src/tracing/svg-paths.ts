import { readGradients, gradientColor, type GradientPaint } from './gradient-paint';
/** The local path, clip and opaque gradient subset produced by tracing. */
export function tracingSvgPaths(svg: string) {
  const gradients = readGradients(svg);
  const clips = new Map<string, string>();
  for (const match of svg.matchAll(/<clipPath\b([^>]*)>([\s\S]*?)<\/clipPath>/g)) {
    const id = match[1].match(/\bid="([^"]+)"/)?.[1], data = match[2].match(/\bd="([^"]+)"/)?.[1];
    if (id && data) clips.set(id, data);
  }
  const painted = svg.replace(/<defs\b[^>]*>[\s\S]*?<\/defs>/g, '');
  const paths: { color: string; gradient?: GradientPaint; data: string; clip?: string; evenodd: boolean; original: string }[] = [];
  for (const match of painted.matchAll(/<path\b([^>]*?)\/?>/g)) {
    const fill = match[1].match(/\bfill="([^"]+)"/)?.[1], data = match[1].match(/\bd="([^"]+)"/)?.[1];
    const id = fill?.match(/^url\(#([\w-]+)\)$/)?.[1], gradient = id ? gradients.get(id) : undefined;
    if (id && !gradient) throw new Error('Gradasi SVG tidak tersedia.');
    let color = fill && /^#[0-9a-f]{6}$/i.test(fill) ? fill : undefined;
    if (gradient) { const c=gradient.kind==='linear'?[(gradient.coords[0]+gradient.coords[2])/2,(gradient.coords[1]+gradient.coords[3])/2]:[gradient.coords[0]+gradient.coords[2]/2,gradient.coords[1]];color='#'+gradientColor(gradient,...c as [number,number]).map(v=>Math.round(v*255).toString(16).padStart(2,'0')).join(''); }
    if (!color || !data) continue;
    const clipId = match[1].match(/\bclip-path="url\(#([^)]*)\)"/)?.[1];
    if (clipId && !clips.has(clipId)) throw new Error('Clip SVG tidak tersedia.');
    paths.push({ color, ...(gradient ? { gradient } : {}), data, clip: clipId ? clips.get(clipId) : undefined, evenodd: /fill-rule="evenodd"/.test(match[1]), original: match[0] });
  }
  return paths;
}
