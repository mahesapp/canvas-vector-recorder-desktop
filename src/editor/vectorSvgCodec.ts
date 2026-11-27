import {
  AffineMatrix,
  VectorPathOps,
  type AffineMatrix2D,
  type PathCommand,
} from './vectorPathData.ts';
import {
  parseColorWithAlpha,
  VectorDocumentOps,
  type FillRule,
  type StrokeCap,
  type StrokeJoin,
  type VectorDocument,
  type VectorGroupNode,
  type VectorNode,
  type VectorPathNode,
} from './vectorDocument.ts';

export const CANVAS_BG_ID = 'mv-canvas-bg';

interface InheritedStyle {
  fill: string | null;
  fillRule: FillRule;
  stroke: string | null;
  strokeWidth: number;
  strokeCap: StrokeCap;
  strokeJoin: StrokeJoin;
  opacity: number;
  visible: boolean;
  transform: AffineMatrix2D;
  clipCommands: readonly PathCommand[] | null;
}

interface GroupFrame {
  readonly isWrapper: boolean;
  readonly id: string;
  readonly name: string;
  readonly opacity: number;
  readonly visible: boolean;
  readonly clipCommands: readonly PathCommand[] | null;
  readonly children: VectorNode[];
}

function unescapeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseAttributes(text: string, start: number, end: number): Record<string, string> {
  const attrs: Record<string, string> = {};
  let i = start;
  while (i < end) {
    while (i < end && /\s/.test(text[i])) i++;
    if (i >= end) break;
    const keyStart = i;
    while (i < end && text[i] !== '=' && !/\s/.test(text[i])) i++;
    const key = text.slice(keyStart, i);
    while (i < end && /\s/.test(text[i])) i++;
    if (i >= end || text[i] !== '=') {
      while (i < end && !/\s/.test(text[i])) i++;
      continue;
    }
    i++;
    while (i < end && /\s/.test(text[i])) i++;
    if (i >= end) break;
    const quote = text[i];
    if (quote === '"' || quote === "'") {
      i++;
      const valStart = i;
      while (i < end && text[i] !== quote) i++;
      attrs[key] = unescapeXml(text.slice(valStart, i));
      if (i < end) i++;
    } else {
      const valStart = i;
      while (i < end && !/\s/.test(text[i])) i++;
      attrs[key] = unescapeXml(text.slice(valStart, i));
    }
  }
  return attrs;
}

function mergeInlineStyle(attrs: Record<string, string>): Record<string, string> {
  if (!attrs.style) return attrs;
  const merged = { ...attrs };
  for (const decl of attrs.style.split(';')) {
    const colon = decl.indexOf(':');
    if (colon <= 0) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const value = decl.slice(colon + 1).trim();
    if (prop && value) merged[prop] = value;
  }
  return merged;
}

function parseClipRef(attr: string | undefined): string | null {
  if (!attr) return null;
  const match = /url\(\s*#([^)\s'"]+)\s*\)/.exec(attr.trim());
  return match ? match[1] : null;
}

function parseStrokeCap(value: string | undefined, fallback: StrokeCap): StrokeCap {
  if (value === 'round' || value === 'square' || value === 'butt') return value;
  return fallback;
}

function parseStrokeJoin(value: string | undefined, fallback: StrokeJoin): StrokeJoin {
  if (value === 'round' || value === 'bevel' || value === 'miter') return value;
  return fallback;
}

function parseFillRule(value: string | undefined, fallback: FillRule): FillRule {
  if (value === 'nonzero' || value === 'evenodd') return value;
  return fallback;
}

function parseDimension(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const PRIMITIVE_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line']);
const SKIP_SUBTREE_TAGS = new Set(['title', 'desc', 'metadata', 'style', 'script', 'mask', 'pattern', 'marker', 'symbol']);

export const VectorSvgCodec = {
  CANVAS_BG_ID,

  isEditableSvg(svg: string | null | undefined): boolean {
    if (!svg || !svg.trim()) return false;
    return svg.includes('<svg') && /<(path|rect|circle|ellipse|polygon|polyline|line)\b/i.test(svg);
  },

  parse(svg: string): VectorDocument {
    if (!svg || svg.length > 12 * 1024 * 1024) {
      throw new Error('Invalid or oversized SVG.');
    }

    let exportWidth = 1024;
    let exportHeight = 1024;
    let viewBoxX = 0;
    let viewBoxY = 0;
    let viewBoxWidth = 1024;
    let viewBoxHeight = 1024;
    let backgroundHex: string | null = null;
    const clips = new Map<string, PathCommand[]>();

    const rootNodes: VectorNode[] = [];
    const tagStack: string[] = [];
    const styleStack: InheritedStyle[] = [];
    const groupStack: GroupFrame[] = [];
    let currentClipId: string | null = null;
    let skipDepth = 0;
    let svgDepth = 0;
    let pathCounter = 0;
    let groupCounter = 0;
    let seenRoot = false;
    const usedIds = new Set<string>();

    const uniqueId = (preferred: string | undefined, prefix: string, counter: number): string => {
      const candidate = preferred && preferred.trim() ? preferred.trim() : `${prefix}-${counter}`;
      if (!usedIds.has(candidate)) {
        usedIds.add(candidate);
        return candidate;
      }
      let suffix = 2;
      while (usedIds.has(`${candidate}-${suffix}`)) suffix++;
      const next = `${candidate}-${suffix}`;
      usedIds.add(next);
      return next;
    };

    const currentStyle = (): InheritedStyle =>
      styleStack[styleStack.length - 1] ?? {
        fill: '#000000',
        fillRule: 'nonzero',
        stroke: null,
        strokeWidth: 0,
        strokeCap: 'butt',
        strokeJoin: 'miter',
        opacity: 1,
        visible: true,
        transform: AffineMatrix.IDENTITY,
        clipCommands: null,
      };

    const targetList = (): VectorNode[] =>
      groupStack.length > 0 ? groupStack[groupStack.length - 1].children : rootNodes;

    let pos = 0;
    const len = svg.length;

    while (pos < len) {
      const lt = svg.indexOf('<', pos);
      if (lt < 0) break;

      if (svg.startsWith('<!--', lt)) {
        const commentEnd = svg.indexOf('-->', lt + 4);
        pos = commentEnd < 0 ? len : commentEnd + 3;
        continue;
      }
      if (svg.startsWith('<?', lt) || svg.startsWith('<!', lt)) {
        const end = svg.indexOf('>', lt + 2);
        pos = end < 0 ? len : end + 1;
        continue;
      }

      const gt = svg.indexOf('>', lt + 1);
      if (gt < 0) throw new Error('Unclosed SVG tag.');
      let inside = svg.slice(lt + 1, gt).trim();
      pos = gt + 1;
      if (!inside) continue;

      if (inside.startsWith('/')) {
        const closeTag = inside.slice(1).trim().toLowerCase();
        if (skipDepth > 0) {
          if (tagStack[tagStack.length - 1] === closeTag) {
            tagStack.pop();
            skipDepth--;
          }
          continue;
        }
        while (tagStack.length > 0) {
          const popped = tagStack.pop()!;
          if (popped === 'clippath') currentClipId = null;
          if (popped === 'svg') {
            svgDepth = Math.max(0, svgDepth - 1);
            styleStack.pop();
          }
          if (popped === 'g') {
            styleStack.pop();
            const frame = groupStack.pop();
            if (frame) {
              const parentList = targetList();
              if (frame.isWrapper) {
                for (const child of frame.children) parentList.push(child);
              } else if (frame.children.length > 0) {
                const groupNode: VectorGroupNode = {
                  kind: 'group',
                  id: frame.id,
                  name: frame.name,
                  children: frame.children,
                  clipCommands: frame.clipCommands,
                  opacity: frame.opacity,
                  visible: frame.visible,
                  locked: false,
                };
                parentList.push(groupNode);
              }
            }
          }
          if (popped === closeTag) break;
        }
        continue;
      }

      const selfClosing = inside.endsWith('/');
      if (selfClosing) inside = inside.slice(0, -1).trim();

      let nameEnd = 0;
      while (nameEnd < inside.length && !/\s/.test(inside[nameEnd])) nameEnd++;
      const tag = inside.slice(0, nameEnd).toLowerCase();
      const attrs = mergeInlineStyle(parseAttributes(inside, nameEnd, inside.length));

      if (skipDepth > 0) {
        if (!selfClosing) {
          tagStack.push(tag);
          skipDepth++;
        }
        continue;
      }

      if (SKIP_SUBTREE_TAGS.has(tag)) {
        if (!selfClosing) {
          tagStack.push(tag);
          skipDepth++;
        }
        continue;
      }

      if (tag === 'svg') {
        const parent = currentStyle();
        if (!seenRoot) {
          seenRoot = true;
          const vbParts = attrs.viewBox?.trim().split(/[\s,]+/).map(Number);
          if (vbParts && vbParts.length === 4 && vbParts.every(Number.isFinite) && vbParts[2] > 0 && vbParts[3] > 0) {
            viewBoxX = vbParts[0];
            viewBoxY = vbParts[1];
            viewBoxWidth = vbParts[2];
            viewBoxHeight = vbParts[3];
            exportWidth = Math.max(1, Math.round(parseDimension(attrs.width, viewBoxWidth)));
            exportHeight = Math.max(1, Math.round(parseDimension(attrs.height, viewBoxHeight)));
          } else {
            exportWidth = Math.max(1, Math.round(parseDimension(attrs.width, 1024)));
            exportHeight = Math.max(1, Math.round(parseDimension(attrs.height, 1024)));
            viewBoxWidth = exportWidth;
            viewBoxHeight = exportHeight;
          }
          const rootShift =
            Math.abs(viewBoxX) > 1e-4 || Math.abs(viewBoxY) > 1e-4
              ? AffineMatrix.translation(-viewBoxX, -viewBoxY)
              : AffineMatrix.IDENTITY;
          styleStack.push({ ...parent, transform: rootShift });
        } else {
          // Nested <svg> (e.g. from CVR's svg_asset wrapper): compute nested viewBox -> outer coordinate transform.
          const nx = Number.parseFloat(attrs.x ?? '0') || 0;
          const ny = Number.parseFloat(attrs.y ?? '0') || 0;
          const nw = parseDimension(attrs.width, viewBoxWidth);
          const nh = parseDimension(attrs.height, viewBoxHeight);
          let nestedMatrix = AffineMatrix.translation(nx, ny);
          const vbParts = attrs.viewBox?.trim().split(/[\s,]+/).map(Number);
          if (vbParts && vbParts.length === 4 && vbParts.every(Number.isFinite) && vbParts[2] > 0 && vbParts[3] > 0) {
            const sx = nw / vbParts[2];
            const sy = nh / vbParts[3];
            const scale = Math.min(sx, sy);
            const tx = (nw - vbParts[2] * scale) * 0.5 - vbParts[0] * scale;
            const ty = (nh - vbParts[3] * scale) * 0.5 - vbParts[1] * scale;
            nestedMatrix = AffineMatrix.multiply(
              nestedMatrix,
              AffineMatrix.multiply(AffineMatrix.translation(tx, ty), { a: scale, b: 0, c: 0, d: scale, tx: 0, ty: 0 }),
            );
          }
          styleStack.push({
            ...parent,
            transform: AffineMatrix.multiply(parent.transform, nestedMatrix),
          });
        }
        svgDepth++;
        if (!selfClosing) tagStack.push(tag);
        else {
          svgDepth = Math.max(0, svgDepth - 1);
          styleStack.pop();
        }
        continue;
      }

      if (tag === 'defs') {
        if (!selfClosing) tagStack.push(tag);
        continue;
      }

      if (tag === 'clippath') {
        currentClipId = attrs.id ?? null;
        if (!selfClosing) tagStack.push(tag);
        continue;
      }

      if (tag === 'g') {
        const parent = currentStyle();
        const localTransform = AffineMatrix.parseSvgTransform(attrs.transform);
        const combinedTransform = AffineMatrix.multiply(parent.transform, localTransform);
        const rawOpacity = attrs.opacity !== undefined ? Number.parseFloat(attrs.opacity) : 1;
        const opacity = Number.isFinite(rawOpacity) ? Math.max(0, Math.min(1, rawOpacity)) : 1;
        const visible = attrs.display !== 'none' && attrs.visibility !== 'hidden';
        const clipRef = parseClipRef(attrs['clip-path']);
        const clipCmds = clipRef ? clips.get(clipRef) ?? null : null;
        const transformedClip = clipCmds ? VectorPathOps.transform(clipCmds, combinedTransform) : null;

        const fillParsed = attrs.fill !== undefined ? parseColorWithAlpha(attrs.fill) : null;
        const strokeParsed = attrs.stroke !== undefined ? parseColorWithAlpha(attrs.stroke) : null;
        const strokeWidthRaw = attrs['stroke-width'] !== undefined ? Number.parseFloat(attrs['stroke-width']) : null;

        const isBackgroundGroup = attrs.id === 'background';
        const isWrapperGroup =
          isBackgroundGroup ||
          attrs.id === 'artwork-transform' ||
          attrs.id === 'artwork';

        if (selfClosing) continue;

        const nextStyle: InheritedStyle = {
          fill: fillParsed ? fillParsed.hex : parent.fill,
          fillRule: parseFillRule(attrs['fill-rule'], parent.fillRule),
          stroke: strokeParsed ? strokeParsed.hex : parent.stroke,
          strokeWidth: strokeWidthRaw !== null && Number.isFinite(strokeWidthRaw) ? Math.max(0, strokeWidthRaw) : parent.strokeWidth,
          strokeCap: parseStrokeCap(attrs['stroke-linecap'], parent.strokeCap),
          strokeJoin: parseStrokeJoin(attrs['stroke-linejoin'], parent.strokeJoin),
          opacity: isWrapperGroup ? parent.opacity * opacity : 1,
          visible: isWrapperGroup ? parent.visible && visible : true,
          transform: combinedTransform,
          clipCommands: isWrapperGroup ? (transformedClip ?? parent.clipCommands) : null,
        };
        styleStack.push(nextStyle);
        tagStack.push(tag);

        if (isWrapperGroup) {
          groupStack.push({
            isWrapper: true,
            id: attrs.id ?? '',
            name: '',
            opacity: 1,
            visible: true,
            clipCommands: null,
            children: [],
          });
        } else {
          groupCounter++;
          const gid = uniqueId(attrs.id, 'group', groupCounter);
          groupStack.push({
            isWrapper: false,
            id: gid,
            name: attrs['data-name'] || `Group ${groupCounter}`,
            opacity,
            visible,
            clipCommands: transformedClip,
            children: [],
          });
        }
        continue;
      }

      if (PRIMITIVE_TAGS.has(tag)) {
        const parent = currentStyle();
        const localTransform = AffineMatrix.parseSvgTransform(attrs.transform);
        const combinedTransform = AffineMatrix.multiply(parent.transform, localTransform);

        let rawCommands: PathCommand[] | null = null;
        if (tag === 'path') {
          if (attrs.d && attrs.d.trim()) {
            try {
              rawCommands = VectorPathOps.parse(attrs.d);
            } catch {
              rawCommands = null;
            }
          }
        } else {
          rawCommands = VectorPathOps.primitiveToCommands(tag, attrs);
        }

        if (tagStack[tagStack.length - 1] === 'clippath' && currentClipId && rawCommands) {
          const transformed = AffineMatrix.isIdentity(localTransform)
            ? rawCommands
            : VectorPathOps.transform(rawCommands, localTransform);
          clips.set(currentClipId, transformed);
          if (!selfClosing) tagStack.push(tag);
          continue;
        }

        if (
          rawCommands &&
          rawCommands.length > 0 &&
          (attrs.id === CANVAS_BG_ID || attrs.id === 'background-color') &&
          backgroundHex === null
        ) {
          const bgColor = parseColorWithAlpha(attrs.fill);
          backgroundHex = bgColor.hex;
          if (!selfClosing) tagStack.push(tag);
          continue;
        }

        if (rawCommands && rawCommands.length > 0) {
          const bakedCommands = VectorPathOps.transform(rawCommands, combinedTransform);
          const hasGeometry = bakedCommands.some(c => c.type === 'L' || c.type === 'C');
          if (hasGeometry) {
            const fillSpec =
              attrs.fill !== undefined
                ? parseColorWithAlpha(attrs.fill)
                : { hex: parent.fill, alpha: 1 };
            const strokeSpec =
              attrs.stroke !== undefined
                ? parseColorWithAlpha(attrs.stroke)
                : { hex: parent.stroke, alpha: 1 };

            const rawStrokeWidth =
              attrs['stroke-width'] !== undefined
                ? Number.parseFloat(attrs['stroke-width'])
                : strokeSpec.hex !== null && parent.strokeWidth <= 0 && attrs.stroke !== undefined
                  ? 1
                  : parent.strokeWidth;
            const scaleFactor = Math.max(0.01, AffineMatrix.averageScale(combinedTransform));
            const strokeWidth =
              strokeSpec.hex !== null && Number.isFinite(rawStrokeWidth) && rawStrokeWidth > 0
                ? rawStrokeWidth * scaleFactor
                : 0;

            const fillOpacity = attrs['fill-opacity'] !== undefined ? Number.parseFloat(attrs['fill-opacity']) : 1;
            const strokeOpacity = attrs['stroke-opacity'] !== undefined ? Number.parseFloat(attrs['stroke-opacity']) : 1;
            const elemOpacity = attrs.opacity !== undefined ? Number.parseFloat(attrs.opacity) : 1;
            const colorAlpha = fillSpec.hex !== null ? fillSpec.alpha : strokeSpec.alpha;
            const paintOpacity = fillSpec.hex !== null
              ? (Number.isFinite(fillOpacity) ? fillOpacity : 1)
              : (Number.isFinite(strokeOpacity) ? strokeOpacity : 1);
            const opacity = Math.max(
              0,
              Math.min(1, parent.opacity * (Number.isFinite(elemOpacity) ? elemOpacity : 1) * colorAlpha * paintOpacity),
            );
            const visible = parent.visible && attrs.display !== 'none' && attrs.visibility !== 'hidden';

            const clipRef = parseClipRef(attrs['clip-path']);
            const localClip = clipRef ? clips.get(clipRef) ?? null : null;
            const clipCommands = localClip
              ? VectorPathOps.transform(localClip, combinedTransform)
              : parent.clipCommands;

            if (fillSpec.hex !== null || (strokeSpec.hex !== null && strokeWidth > 0)) {
              pathCounter++;
              const node: VectorPathNode = {
                kind: 'path',
                id: uniqueId(attrs.id, 'path', pathCounter),
                name: attrs['data-name'] || `Path ${pathCounter}`,
                commands: bakedCommands,
                clipCommands,
                fillHex: fillSpec.hex,
                fillRule: parseFillRule(attrs['fill-rule'], parent.fillRule),
                strokeHex: strokeWidth > 0 ? strokeSpec.hex : null,
                strokeWidth,
                strokeCap: parseStrokeCap(attrs['stroke-linecap'], parent.strokeCap),
                strokeJoin: parseStrokeJoin(attrs['stroke-linejoin'], parent.strokeJoin),
                opacity,
                visible,
                locked: false,
              };
              targetList().push(node);
            }
          }
        }

        if (!selfClosing) tagStack.push(tag);
        continue;
      }

      if (!selfClosing) tagStack.push(tag);
    }

    if (!seenRoot || pathCounter === 0) {
      throw new Error('SVG contains no editable vector paths.');
    }

    return {
      exportWidth,
      exportHeight,
      viewBoxWidth,
      viewBoxHeight,
      nodes: rootNodes,
      backgroundHex,
      artworkScalePercent: 0,
    };
  },

  serialize(doc: VectorDocument): string {
    const clipDefs = new Map<string, string>();
    const clipIdByPath = new Map<string, string>();

    const registerClip = (commands: readonly PathCommand[] | null): string | null => {
      if (!commands || commands.length === 0) return null;
      const formatted = VectorPathOps.format(commands);
      const existing = clipIdByPath.get(formatted);
      if (existing) return existing;
      const id = `clip-${clipDefs.size}`;
      clipDefs.set(id, formatted);
      clipIdByPath.set(formatted, id);
      return id;
    };

    const collectClips = (nodes: readonly VectorNode[]): void => {
      for (const node of nodes) {
        if (node.kind === 'path') {
          registerClip(node.clipCommands);
        } else {
          registerClip(node.clipCommands);
          collectClips(node.children);
        }
      }
    };
    collectClips(doc.nodes);

    const width = Math.max(1, Math.round(doc.exportWidth));
    const height = Math.max(1, Math.round(doc.exportHeight));
    const vwStr = VectorPathOps.formatNumber(doc.viewBoxWidth);
    const vhStr = VectorPathOps.formatNumber(doc.viewBoxHeight);

    const parts: string[] = [
      `<?xml version="1.0" encoding="UTF-8"?>\n`,
      `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${width}" height="${height}" viewBox="0 0 ${vwStr} ${vhStr}">`,
    ];

    if (clipDefs.size > 0) {
      parts.push('<defs>');
      for (const [id, d] of clipDefs.entries()) {
        parts.push(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path clip-rule="nonzero" d="${d}"/></clipPath>`);
      }
      parts.push('</defs>');
    }

    const bgHex = VectorDocumentOps.normalizeHex(doc.backgroundHex);
    if (bgHex) {
      parts.push(
        `<path id="${CANVAS_BG_ID}" fill="${bgHex}" fill-rule="evenodd" d="M0 0L${vwStr} 0L${vwStr} ${vhStr}L0 ${vhStr}Z"/>`,
      );
    }

    const appendNodes = (nodes: readonly VectorNode[]): void => {
      for (const node of nodes) {
        if (node.kind === 'group') {
          if (node.children.length === 0) continue;
          let tag = '<g';
          if (node.opacity < 0.999) {
            tag += ` opacity="${VectorPathOps.formatNumber(node.opacity)}"`;
          }
          if (!node.visible) {
            tag += ' display="none"';
          }
          const cid = registerClip(node.clipCommands);
          if (cid) tag += ` clip-path="url(#${cid})"`;
          tag += '>';
          parts.push(tag);
          appendNodes(node.children);
          parts.push('</g>');
        } else {
          const fillHex = VectorDocumentOps.normalizeHex(node.fillHex);
          let tag = `<path fill="${fillHex ?? 'none'}"`;
          if (fillHex !== null || node.fillRule !== 'evenodd') {
            tag += ` fill-rule="${node.fillRule}"`;
          }
          const strokeHex = VectorDocumentOps.normalizeHex(node.strokeHex);
          if (strokeHex !== null && node.strokeWidth > 0) {
            tag += ` stroke="${strokeHex}" stroke-width="${VectorPathOps.formatNumber(node.strokeWidth)}"`;
            if (node.strokeCap !== 'butt') tag += ` stroke-linecap="${node.strokeCap}"`;
            if (node.strokeJoin !== 'miter') tag += ` stroke-linejoin="${node.strokeJoin}"`;
          }
          if (node.opacity < 0.999) {
            tag += ` opacity="${VectorPathOps.formatNumber(node.opacity)}"`;
          }
          if (!node.visible) {
            tag += ' display="none"';
          }
          const cid = registerClip(node.clipCommands);
          if (cid) tag += ` clip-path="url(#${cid})"`;
          tag += ` d="${VectorPathOps.format(node.commands)}"/>`;
          parts.push(tag);
        }
      }
    };

    appendNodes(doc.nodes);
    parts.push('</svg>');
    return parts.join('');
  },
};
