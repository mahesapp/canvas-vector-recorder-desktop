import {
  AffineMatrix,
  boundsCenterX,
  boundsCenterY,
  boundsHeight,
  boundsUnion,
  boundsWidth,
  VectorPathOps,
  type AffineMatrix2D,
  type Bounds,
  type PathCommand,
} from './vectorPathData.ts';

export type StrokeCap = 'butt' | 'round' | 'square';
export type StrokeJoin = 'miter' | 'round' | 'bevel';
export type FillRule = 'evenodd' | 'nonzero';

export type ReorderAction =
  | 'BRING_TO_FRONT'
  | 'BRING_FORWARD'
  | 'SEND_BACKWARD'
  | 'SEND_TO_BACK';

export type PathfinderOp =
  | 'TRIM'
  | 'UNITE'
  | 'MINUS_FRONT'
  | 'INTERSECT'
  | 'EXCLUDE';

export interface PathBooleanPart {
  readonly commands: readonly PathCommand[];
  readonly fillRule: FillRule;
  readonly clipCommands: readonly PathCommand[] | null;
}

export interface PathBooleanEngine {
  /**
   * Combines ordered operands from bottom-most (index 0) to top-most (last index).
   * Returns null when the resulting geometry is empty.
   */
  combine(operands: readonly (readonly PathBooleanPart[])[], op: PathfinderOp): PathCommand[] | null;
}

export interface VectorPathNode {
  readonly kind: 'path';
  readonly id: string;
  readonly name: string;
  readonly commands: readonly PathCommand[];
  readonly clipCommands: readonly PathCommand[] | null;
  readonly fillHex: string | null;
  readonly fillRule: FillRule;
  readonly strokeHex: string | null;
  readonly strokeWidth: number;
  readonly strokeCap: StrokeCap;
  readonly strokeJoin: StrokeJoin;
  readonly opacity: number;
  readonly visible: boolean;
  readonly locked: boolean;
}

export interface VectorGroupNode {
  readonly kind: 'group';
  readonly id: string;
  readonly name: string;
  readonly children: readonly VectorNode[];
  readonly clipCommands: readonly PathCommand[] | null;
  readonly opacity: number;
  readonly visible: boolean;
  readonly locked: boolean;
}

export type VectorNode = VectorPathNode | VectorGroupNode;

export interface VectorDocument {
  readonly exportWidth: number;
  readonly exportHeight: number;
  readonly viewBoxWidth: number;
  readonly viewBoxHeight: number;
  readonly nodes: readonly VectorNode[];
  readonly backgroundHex: string | null;
  readonly artworkScalePercent: number;
}

export interface DocumentStats {
  readonly paths: number;
  readonly segments: number;
  readonly colors: readonly string[];
}

const NAMED_COLORS: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  lime: '#00ff00',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  cyan: '#00ffff',
  aqua: '#00ffff',
  magenta: '#ff00ff',
  fuchsia: '#ff00ff',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
  maroon: '#800000',
  navy: '#000080',
  purple: '#800080',
  teal: '#008080',
  olive: '#808000',
  orange: '#ffa500',
  pink: '#ffc0cb',
  brown: '#a52a2a',
  gold: '#ffd700',
  indigo: '#4b0082',
  violet: '#ee82ee',
  coral: '#ff7f50',
  crimson: '#dc143c',
  khaki: '#f0e68c',
  lavender: '#e6e6fa',
  salmon: '#fa8072',
  skyblue: '#87ceeb',
  steelblue: '#4682b4',
  tan: '#d2b48c',
  tomato: '#ff6347',
  turquoise: '#40e0d0',
  wheat: '#f5deb3',
  whitesmoke: '#f5f5f5',
};

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${clampByte(r).toString(16).padStart(2, '0')}${clampByte(g).toString(16).padStart(2, '0')}${clampByte(b).toString(16).padStart(2, '0')}`;
}

export function parseColorWithAlpha(raw: string | null | undefined): { hex: string | null; alpha: number } {
  if (!raw) return { hex: null, alpha: 1 };
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed === 'none' || trimmed === 'transparent' || trimmed.startsWith('url(')) {
    return { hex: null, alpha: 1 };
  }
  if (trimmed.startsWith('#')) {
    const body = trimmed.slice(1);
    if (/^[0-9a-f]{6}$/.test(body)) {
      return { hex: `#${body}`, alpha: 1 };
    }
    if (/^[0-9a-f]{3}$/.test(body)) {
      return { hex: `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`, alpha: 1 };
    }
    if (/^[0-9a-f]{4}$/.test(body)) {
      const a = Number.parseInt(`${body[3]}${body[3]}`, 16) / 255;
      return { hex: `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`, alpha: a };
    }
    if (/^[0-9a-f]{8}$/.test(body)) {
      const a = Number.parseInt(body.slice(6, 8), 16) / 255;
      return { hex: `#${body.slice(0, 6)}`, alpha: a };
    }
    return { hex: null, alpha: 1 };
  }
  const rgbMatch = /^rgba?\(\s*([^)]+)\s*\)$/.exec(trimmed);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const parseChannel = (token: string): number => {
        if (token.endsWith('%')) return (Number.parseFloat(token) / 100) * 255;
        return Number.parseFloat(token);
      };
      const r = parseChannel(parts[0]);
      const g = parseChannel(parts[1]);
      const b = parseChannel(parts[2]);
      let alpha = 1;
      if (parts.length >= 4) {
        const aRaw = parts[3];
        alpha = aRaw.endsWith('%') ? Number.parseFloat(aRaw) / 100 : Number.parseFloat(aRaw);
        if (!Number.isFinite(alpha)) alpha = 1;
        alpha = Math.max(0, Math.min(1, alpha));
      }
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
        return { hex: rgbToHex(r, g, b), alpha };
      }
    }
    return { hex: null, alpha: 1 };
  }
  if (NAMED_COLORS[trimmed]) {
    return { hex: NAMED_COLORS[trimmed], alpha: 1 };
  }
  return { hex: null, alpha: 1 };
}

function countTotalPaths(nodes: readonly VectorNode[]): number {
  let total = 0;
  for (const node of nodes) {
    if (node.kind === 'path') total++;
    else total += countTotalPaths(node.children);
  }
  return total;
}

function mapSelectedPaths(
  doc: VectorDocument,
  selectedIds: ReadonlySet<string>,
  transform: (path: VectorPathNode) => VectorPathNode,
): VectorDocument {
  if (selectedIds.size === 0) return doc;
  const applyAll = (node: VectorNode): VectorNode =>
    node.kind === 'path'
      ? transform(node)
      : { ...node, children: node.children.map(applyAll) };
  const visit = (node: VectorNode): VectorNode => {
    if (selectedIds.has(node.id) && !node.locked) return applyAll(node);
    if (node.kind === 'group' && !node.locked) {
      return { ...node, children: node.children.map(visit) };
    }
    return node;
  };
  return { ...doc, nodes: doc.nodes.map(visit) };
}

export const VectorDocumentOps = {
  normalizeHex(hex: string | null | undefined): string | null {
    if (!hex || hex === 'none') return null;
    const trimmed = hex.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
    return parseColorWithAlpha(trimmed).hex;
  },

  boundsOf(node: VectorNode): Bounds | null {
    if (node.kind === 'path') {
      const base = VectorPathOps.computeBounds(node.commands);
      if (!base) return null;
      const pad = node.strokeHex !== null && node.strokeWidth > 0 ? node.strokeWidth * 0.5 : 0;
      return pad > 0
        ? { left: base.left - pad, top: base.top - pad, right: base.right + pad, bottom: base.bottom + pad }
        : base;
    }
    let acc: Bounds | null = null;
    for (const child of node.children) {
      const b = VectorDocumentOps.boundsOf(child);
      if (!b) continue;
      acc = acc === null ? b : boundsUnion(acc, b);
    }
    return acc;
  },

  selectionBounds(doc: VectorDocument, selectedIds: ReadonlySet<string>): Bounds | null {
    if (selectedIds.size === 0) return null;
    let acc: Bounds | null = null;
    const visit = (node: VectorNode): void => {
      if (selectedIds.has(node.id)) {
        const b = VectorDocumentOps.boundsOf(node);
        if (b) acc = acc === null ? b : boundsUnion(acc, b);
        return;
      }
      if (node.kind === 'group') {
        for (const child of node.children) visit(child);
      }
    };
    for (const node of doc.nodes) visit(node);
    return acc;
  },

  hitTestTopmost(doc: VectorDocument, x: number, y: number, hitSlop: number): string | null {
    const hitNode = (node: VectorNode): boolean => {
      if (!node.visible || node.locked) return false;
      if (node.kind === 'path') {
        return VectorPathOps.hitTest(
          node.commands,
          x,
          y,
          node.fillRule === 'evenodd',
          node.fillHex !== null,
          node.strokeHex !== null ? node.strokeWidth : 0,
          hitSlop,
        );
      }
      for (let i = node.children.length - 1; i >= 0; i--) {
        if (hitNode(node.children[i])) return true;
      }
      return false;
    };
    for (let i = doc.nodes.length - 1; i >= 0; i--) {
      if (hitNode(doc.nodes[i])) return doc.nodes[i].id;
    }
    return null;
  },

  hitTestColor(doc: VectorDocument, x: number, y: number, hitSlop: number): string | null {
    const findColor = (node: VectorNode): string | null => {
      if (!node.visible) return null;
      if (node.kind === 'path') {
        const hit = VectorPathOps.hitTest(
          node.commands,
          x,
          y,
          node.fillRule === 'evenodd',
          node.fillHex !== null,
          node.strokeHex !== null ? node.strokeWidth : 0,
          hitSlop,
        );
        return hit ? (node.fillHex ?? node.strokeHex) : null;
      }
      for (let i = node.children.length - 1; i >= 0; i--) {
        const found = findColor(node.children[i]);
        if (found) return found;
      }
      return null;
    };
    for (let i = doc.nodes.length - 1; i >= 0; i--) {
      const found = findColor(doc.nodes[i]);
      if (found) return found;
    }
    return null;
  },

  collectSwatches(doc: VectorDocument): Array<{ hex: string; count: number }> {
    const counts = new Map<string, number>();
    const visit = (node: VectorNode): void => {
      if (node.kind === 'path') {
        const fill = VectorDocumentOps.normalizeHex(node.fillHex);
        if (fill) counts.set(fill, (counts.get(fill) ?? 0) + 1);
        if (node.strokeWidth > 0) {
          const stroke = VectorDocumentOps.normalizeHex(node.strokeHex);
          if (stroke) counts.set(stroke, (counts.get(stroke) ?? 0) + 1);
        }
      } else {
        for (const child of node.children) visit(child);
      }
    };
    for (const node of doc.nodes) visit(node);
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([hex, count]) => ({ hex, count }));
  },

  findNode(doc: VectorDocument, nodeId: string): VectorNode | null {
    const findIn = (nodes: readonly VectorNode[]): VectorNode | null => {
      for (const node of nodes) {
        if (node.id === nodeId) return node;
        if (node.kind === 'group') {
          const found = findIn(node.children);
          if (found) return found;
        }
      }
      return null;
    };
    return findIn(doc.nodes);
  },

  selectedPathNodes(doc: VectorDocument, selectedIds: ReadonlySet<string>): VectorPathNode[] {
    const result: VectorPathNode[] = [];
    const collectAllPaths = (node: VectorNode): void => {
      if (node.kind === 'path') result.push(node);
      else for (const child of node.children) collectAllPaths(child);
    };
    const visit = (node: VectorNode): void => {
      if (selectedIds.has(node.id)) {
        collectAllPaths(node);
      } else if (node.kind === 'group') {
        for (const child of node.children) visit(child);
      }
    };
    for (const node of doc.nodes) visit(node);
    return result;
  },

  canGroup(doc: VectorDocument, selectedIds: ReadonlySet<string>): boolean {
    let count = 0;
    for (const node of doc.nodes) {
      if (selectedIds.has(node.id)) count++;
    }
    return count >= 2;
  },

  canUngroup(doc: VectorDocument, selectedIds: ReadonlySet<string>): boolean {
    return doc.nodes.some(node => selectedIds.has(node.id) && node.kind === 'group');
  },

  canPathfinder(doc: VectorDocument, selectedIds: ReadonlySet<string>): boolean {
    let count = 0;
    for (const node of doc.nodes) {
      if (selectedIds.has(node.id) && !node.locked) count++;
    }
    return count >= 2;
  },

  applyPathfinder(
    doc: VectorDocument,
    selectedIds: ReadonlySet<string>,
    op: PathfinderOp,
    engine: PathBooleanEngine,
    newId: string,
    newName: string,
  ): { document: VectorDocument; selectedIds: Set<string> } {
    const selectedIndices: number[] = [];
    for (let i = 0; i < doc.nodes.length; i++) {
      const n = doc.nodes[i];
      if (selectedIds.has(n.id) && !n.locked) selectedIndices.push(i);
    }
    if (selectedIndices.length < 2) return { document: doc, selectedIds: new Set() };

    const collectParts = (node: VectorNode): PathBooleanPart[] => {
      if (!node.visible) return [];
      if (node.kind === 'path') {
        return [{ commands: node.commands, fillRule: node.fillRule, clipCommands: node.clipCommands }];
      }
      return node.children.flatMap(collectParts);
    };

    const firstPath = (node: VectorNode): VectorPathNode | null => {
      if (node.kind === 'path') return node;
      for (const child of node.children) {
        const found = firstPath(child);
        if (found) return found;
      }
      return null;
    };

    const lastPath = (node: VectorNode): VectorPathNode | null => {
      if (node.kind === 'path') return node;
      for (let i = node.children.length - 1; i >= 0; i--) {
        const found = lastPath(node.children[i]);
        if (found) return found;
      }
      return null;
    };

    const selectedNodes = selectedIndices.map(idx => doc.nodes[idx]);
    const operands = selectedNodes.map(collectParts);
    if (operands.some(parts => parts.length === 0)) {
      return { document: doc, selectedIds: new Set() };
    }

    if (op === 'TRIM') {
      const replacementByIndex = new Map<number, VectorNode | null>();
      const survivingIds = new Set<string>();
      const topIndex = selectedIndices[selectedIndices.length - 1];
      const topNode = selectedNodes[selectedNodes.length - 1];
      replacementByIndex.set(topIndex, topNode);
      survivingIds.add(topNode.id);

      for (let pos = 0; pos < selectedIndices.length - 1; pos++) {
        const docIdx = selectedIndices[pos];
        const node = selectedNodes[pos];
        const cutOperands = operands.slice(pos);
        const trimmedCommands = engine.combine(cutOperands, 'MINUS_FRONT');
        if (!trimmedCommands || !trimmedCommands.some(c => c.type === 'L' || c.type === 'C')) {
          replacementByIndex.set(docIdx, null);
        } else {
          const style = firstPath(node);
          if (!style) continue;
          const trimmedId = `${newId}_${pos}`;
          replacementByIndex.set(docIdx, {
            kind: 'path',
            id: trimmedId,
            name: node.name,
            commands: trimmedCommands,
            clipCommands: null,
            fillHex: style.fillHex,
            fillRule: 'evenodd',
            strokeHex: style.strokeHex,
            strokeWidth: style.strokeWidth,
            strokeCap: style.strokeCap,
            strokeJoin: style.strokeJoin,
            opacity: style.opacity,
            visible: true,
            locked: false,
          });
          survivingIds.add(trimmedId);
        }
      }

      const nextNodes: VectorNode[] = [];
      for (let i = 0; i < doc.nodes.length; i++) {
        if (replacementByIndex.has(i)) {
          const rep = replacementByIndex.get(i);
          if (rep) nextNodes.push(rep);
        } else {
          nextNodes.push(doc.nodes[i]);
        }
      }
      if (countTotalPaths(nextNodes) === 0) return { document: doc, selectedIds: new Set() };
      return { document: { ...doc, nodes: nextNodes }, selectedIds: survivingIds };
    }

    const resultCommands = engine.combine(operands, op);
    if (!resultCommands || !resultCommands.some(c => c.type === 'L' || c.type === 'C')) {
      return { document: doc, selectedIds: new Set() };
    }

    const styleSource = op === 'MINUS_FRONT'
      ? firstPath(selectedNodes[0])
      : lastPath(selectedNodes[selectedNodes.length - 1]);
    if (!styleSource) return { document: doc, selectedIds: new Set() };

    const combinedNode: VectorPathNode = {
      kind: 'path',
      id: newId,
      name: newName,
      commands: resultCommands,
      clipCommands: null,
      fillHex: styleSource.fillHex,
      fillRule: 'evenodd',
      strokeHex: styleSource.strokeHex,
      strokeWidth: styleSource.strokeWidth,
      strokeCap: styleSource.strokeCap,
      strokeJoin: styleSource.strokeJoin,
      opacity: styleSource.opacity,
      visible: true,
      locked: false,
    };

    const selectedIndexSet = new Set(selectedIndices);
    const anchorIndex = op === 'MINUS_FRONT'
      ? selectedIndices[0]
      : selectedIndices[selectedIndices.length - 1];
    const nextNodes: VectorNode[] = [];
    for (let i = 0; i < doc.nodes.length; i++) {
      if (i === anchorIndex) nextNodes.push(combinedNode);
      else if (!selectedIndexSet.has(i)) nextNodes.push(doc.nodes[i]);
    }
    return { document: { ...doc, nodes: nextNodes }, selectedIds: new Set([newId]) };
  },

  transformSelected(
    doc: VectorDocument,
    selectedIds: ReadonlySet<string>,
    matrix: AffineMatrix2D,
    scaleStroke = true,
  ): VectorDocument {
    if (selectedIds.size === 0) return doc;
    const strokeScale = scaleStroke ? Math.max(0.05, AffineMatrix.averageScale(matrix)) : 1;
    const transformAll = (node: VectorNode): VectorNode => {
      if (node.kind === 'path') {
        return {
          ...node,
          commands: VectorPathOps.transform(node.commands, matrix),
          clipCommands: node.clipCommands ? VectorPathOps.transform(node.clipCommands, matrix) : null,
          strokeWidth:
            node.strokeWidth > 0 && scaleStroke
              ? Math.max(0.1, Math.min(256, node.strokeWidth * strokeScale))
              : node.strokeWidth,
        };
      }
      return {
        ...node,
        children: node.children.map(transformAll),
        clipCommands: node.clipCommands ? VectorPathOps.transform(node.clipCommands, matrix) : null,
      };
    };
    const visit = (node: VectorNode): VectorNode => {
      if (selectedIds.has(node.id) && !node.locked) return transformAll(node);
      if (node.kind === 'group' && !node.locked) {
        return { ...node, children: node.children.map(visit) };
      }
      return node;
    };
    return { ...doc, nodes: doc.nodes.map(visit) };
  },

  deleteSelected(
    doc: VectorDocument,
    selectedIds: ReadonlySet<string>,
  ): { document: VectorDocument; removed: boolean } {
    if (selectedIds.size === 0) return { document: doc, removed: false };
    const filterList = (nodes: readonly VectorNode[]): VectorNode[] => {
      const out: VectorNode[] = [];
      for (const node of nodes) {
        if (selectedIds.has(node.id) && !node.locked) continue;
        if (node.kind === 'group') {
          const kept = node.locked ? node.children : filterList(node.children);
          if (kept.length > 0) out.push({ ...node, children: kept });
        } else {
          out.push(node);
        }
      }
      return out;
    };
    const nextNodes = filterList(doc.nodes);
    if (countTotalPaths(nextNodes) === 0) return { document: doc, removed: false };
    return { document: { ...doc, nodes: nextNodes }, removed: true };
  },

  duplicateSelected(
    doc: VectorDocument,
    selectedIds: ReadonlySet<string>,
    offsetX: number,
    offsetY: number,
    idGen: () => string,
  ): { document: VectorDocument; selectedIds: Set<string> } {
    if (selectedIds.size === 0) return { document: doc, selectedIds: new Set() };
    const shift = AffineMatrix.translation(offsetX, offsetY);
    const newSelected = new Set<string>();

    const cloneNode = (node: VectorNode): VectorNode => {
      if (node.kind === 'path') {
        return {
          ...node,
          id: idGen(),
          name: `${node.name} Copy`,
          commands: VectorPathOps.transform(node.commands, shift),
          clipCommands: node.clipCommands ? VectorPathOps.transform(node.clipCommands, shift) : null,
          locked: false,
        };
      }
      return {
        ...node,
        id: idGen(),
        name: `${node.name} Copy`,
        children: node.children.map(cloneNode),
        clipCommands: node.clipCommands ? VectorPathOps.transform(node.clipCommands, shift) : null,
        locked: false,
      };
    };

    const duplicateInList = (nodes: readonly VectorNode[]): VectorNode[] => {
      const out: VectorNode[] = [];
      for (const node of nodes) {
        if (selectedIds.has(node.id)) {
          out.push(node);
          const cloned = cloneNode(node);
          newSelected.add(cloned.id);
          out.push(cloned);
        } else if (node.kind === 'group') {
          out.push({ ...node, children: duplicateInList(node.children) });
        } else {
          out.push(node);
        }
      }
      return out;
    };

    return {
      document: { ...doc, nodes: duplicateInList(doc.nodes) },
      selectedIds: newSelected,
    };
  },

  groupSelected(
    doc: VectorDocument,
    selectedIds: ReadonlySet<string>,
    groupId: string,
    groupName: string,
  ): { document: VectorDocument; selectedIds: Set<string> } {
    const selectedTop = doc.nodes.filter(n => selectedIds.has(n.id));
    if (selectedTop.length < 2) return { document: doc, selectedIds: new Set(selectedIds) };
    let insertIndex = -1;
    for (let i = doc.nodes.length - 1; i >= 0; i--) {
      if (selectedIds.has(doc.nodes[i].id)) {
        insertIndex = i;
        break;
      }
    }
    const remainingBefore = doc.nodes.slice(0, insertIndex + 1).filter(n => !selectedIds.has(n.id));
    const remainingAfter = doc.nodes.slice(insertIndex + 1).filter(n => !selectedIds.has(n.id));
    const group: VectorGroupNode = {
      kind: 'group',
      id: groupId,
      name: groupName,
      children: selectedTop,
      clipCommands: null,
      opacity: 1,
      visible: true,
      locked: false,
    };
    return {
      document: { ...doc, nodes: [...remainingBefore, group, ...remainingAfter] },
      selectedIds: new Set([groupId]),
    };
  },

  ungroupSelected(
    doc: VectorDocument,
    selectedIds: ReadonlySet<string>,
  ): { document: VectorDocument; selectedIds: Set<string> } {
    if (!VectorDocumentOps.canUngroup(doc, selectedIds)) {
      return { document: doc, selectedIds: new Set(selectedIds) };
    }
    const nextSelected = new Set<string>();
    const nextNodes: VectorNode[] = [];

    const applyOpacity = (node: VectorNode, factor: number): VectorNode => {
      if (factor >= 0.999) return node;
      const nextOpacity = Math.max(0, Math.min(1, node.opacity * factor));
      return { ...node, opacity: nextOpacity };
    };

    for (const node of doc.nodes) {
      if (selectedIds.has(node.id) && node.kind === 'group' && !node.locked) {
        for (const child of node.children) {
          const adjusted = applyOpacity(child, node.opacity);
          nextNodes.push(adjusted);
          nextSelected.add(adjusted.id);
        }
      } else {
        nextNodes.push(node);
        if (selectedIds.has(node.id)) nextSelected.add(node.id);
      }
    }
    return { document: { ...doc, nodes: nextNodes }, selectedIds: nextSelected };
  },

  reorderSelected(doc: VectorDocument, selectedIds: ReadonlySet<string>, action: ReorderAction): VectorDocument {
    if (selectedIds.size === 0 || doc.nodes.length < 2) return doc;
    const nodes = [...doc.nodes];
    switch (action) {
      case 'BRING_TO_FRONT': {
        const moving = nodes.filter(n => selectedIds.has(n.id));
        if (moving.length === 0) return doc;
        const rest = nodes.filter(n => !selectedIds.has(n.id));
        return { ...doc, nodes: [...rest, ...moving] };
      }
      case 'SEND_TO_BACK': {
        const moving = nodes.filter(n => selectedIds.has(n.id));
        if (moving.length === 0) return doc;
        const rest = nodes.filter(n => !selectedIds.has(n.id));
        return { ...doc, nodes: [...moving, ...rest] };
      }
      case 'BRING_FORWARD': {
        for (let i = nodes.length - 2; i >= 0; i--) {
          if (selectedIds.has(nodes[i].id) && !selectedIds.has(nodes[i + 1].id)) {
            const tmp = nodes[i];
            nodes[i] = nodes[i + 1];
            nodes[i + 1] = tmp;
          }
        }
        return { ...doc, nodes };
      }
      case 'SEND_BACKWARD': {
        for (let i = 1; i < nodes.length; i++) {
          if (selectedIds.has(nodes[i].id) && !selectedIds.has(nodes[i - 1].id)) {
            const tmp = nodes[i];
            nodes[i] = nodes[i - 1];
            nodes[i - 1] = tmp;
          }
        }
        return { ...doc, nodes };
      }
    }
  },

  moveTopLevelNode(doc: VectorDocument, nodeId: string, moveUpInLayersPanel: boolean): VectorDocument {
    const index = doc.nodes.findIndex(n => n.id === nodeId);
    if (index < 0) return doc;
    // Higher index = painted later = closer to the top in the Layers panel.
    const target = moveUpInLayersPanel ? index + 1 : index - 1;
    if (target < 0 || target >= doc.nodes.length) return doc;
    const mutable = [...doc.nodes];
    const tmp = mutable[index];
    mutable[index] = mutable[target];
    mutable[target] = tmp;
    return { ...doc, nodes: mutable };
  },

  setFill(doc: VectorDocument, selectedIds: ReadonlySet<string>, fillHex: string | null): VectorDocument {
    const normalized = VectorDocumentOps.normalizeHex(fillHex);
    return mapSelectedPaths(doc, selectedIds, path => ({ ...path, fillHex: normalized }));
  },

  setStroke(
    doc: VectorDocument,
    selectedIds: ReadonlySet<string>,
    strokeHex: string | null,
    strokeWidth: number | null = null,
    strokeCap: StrokeCap | null = null,
    strokeJoin: StrokeJoin | null = null,
  ): VectorDocument {
    const normalized = VectorDocumentOps.normalizeHex(strokeHex);
    return mapSelectedPaths(doc, selectedIds, path => {
      const nextWidth = strokeWidth ?? (normalized !== null && path.strokeWidth <= 0 ? 2 : path.strokeWidth);
      return {
        ...path,
        strokeHex: normalized,
        strokeWidth: Math.max(0, Math.min(128, nextWidth)),
        strokeCap: strokeCap ?? path.strokeCap,
        strokeJoin: strokeJoin ?? path.strokeJoin,
      };
    });
  },

  setOpacity(doc: VectorDocument, selectedIds: ReadonlySet<string>, opacity: number): VectorDocument {
    const clamped = Math.max(0, Math.min(1, opacity));
    const visit = (node: VectorNode): VectorNode => {
      if (selectedIds.has(node.id) && !node.locked) {
        return { ...node, opacity: clamped };
      }
      if (node.kind === 'group' && !node.locked) {
        return { ...node, children: node.children.map(visit) };
      }
      return node;
    };
    return { ...doc, nodes: doc.nodes.map(visit) };
  },

  toggleVisible(doc: VectorDocument, nodeId: string): VectorDocument {
    const visit = (node: VectorNode): VectorNode => {
      if (node.id === nodeId) return { ...node, visible: !node.visible };
      if (node.kind === 'group') return { ...node, children: node.children.map(visit) };
      return node;
    };
    return { ...doc, nodes: doc.nodes.map(visit) };
  },

  toggleLocked(doc: VectorDocument, nodeId: string): VectorDocument {
    const visit = (node: VectorNode): VectorNode => {
      if (node.id === nodeId) return { ...node, locked: !node.locked };
      if (node.kind === 'group') return { ...node, children: node.children.map(visit) };
      return node;
    };
    return { ...doc, nodes: doc.nodes.map(visit) };
  },

  setCanvasBackground(doc: VectorDocument, hex: string | null): VectorDocument {
    return { ...doc, backgroundHex: VectorDocumentOps.normalizeHex(hex) };
  },

  resizeCanvas(doc: VectorDocument, newWidth: number, newHeight: number): VectorDocument {
    const w = Math.max(16, Math.min(32768, Math.round(newWidth)));
    const h = Math.max(16, Math.min(32768, Math.round(newHeight)));
    if (w === doc.exportWidth && h === doc.exportHeight) return doc;

    const oldAspect = doc.viewBoxWidth / Math.max(1e-4, doc.viewBoxHeight);
    const newAspect = w / h;
    if (Math.abs(oldAspect - newAspect) < 1e-3) {
      return { ...doc, exportWidth: w, exportHeight: h };
    }

    const maxSide = Math.max(16, doc.viewBoxWidth, doc.viewBoxHeight);
    const newVw = newAspect >= 1 ? maxSide : Math.max(1, maxSide * newAspect);
    const newVh = newAspect >= 1 ? Math.max(1, maxSide / newAspect) : maxSide;

    const allIds = new Set(doc.nodes.map(n => n.id));
    const artBounds = VectorDocumentOps.selectionBounds(doc, allIds);
    let transformedNodes = doc.nodes;
    if (artBounds && boundsWidth(artBounds) > 0 && boundsHeight(artBounds) > 0) {
      const fitScale = Math.min(1, (newVw * 0.92) / boundsWidth(artBounds), (newVh * 0.92) / boundsHeight(artBounds));
      const cx = boundsCenterX(artBounds);
      const cy = boundsCenterY(artBounds);
      const toCenter = AffineMatrix.translation(newVw * 0.5 - cx, newVh * 0.5 - cy);
      const matrix =
        fitScale < 0.999
          ? AffineMatrix.multiply(toCenter, AffineMatrix.scaleAround(fitScale, fitScale, cx, cy))
          : toCenter;
      transformedNodes = VectorDocumentOps.transformSelected(doc, allIds, matrix, fitScale < 0.999).nodes;
    }

    return {
      ...doc,
      exportWidth: w,
      exportHeight: h,
      viewBoxWidth: newVw,
      viewBoxHeight: newVh,
      nodes: transformedNodes,
    };
  },

  applyCanvasRatio(doc: VectorDocument, ratioW: number, ratioH: number): VectorDocument {
    if (ratioW <= 0 || ratioH <= 0) return doc;
    const area = Math.max(256, doc.exportWidth * doc.exportHeight);
    const aspect = ratioW / ratioH;
    const nextW = Math.max(16, Math.min(32768, Math.round(Math.sqrt(area * aspect))));
    const nextH = Math.max(16, Math.min(32768, Math.round(Math.sqrt(area / aspect))));
    return VectorDocumentOps.resizeCanvas(doc, nextW, nextH);
  },

  applyCanvasMegapixels(doc: VectorDocument, megapixels: number): VectorDocument {
    const clampedMp = Math.max(20, Math.min(65, Math.round(megapixels)));
    const area = clampedMp * 1_000_000;
    const aspect = doc.exportWidth / Math.max(1, doc.exportHeight);
    const nextW = Math.max(16, Math.min(32768, Math.round(Math.sqrt(area * aspect))));
    const nextH = Math.max(16, Math.min(32768, Math.round(Math.sqrt(area / aspect))));
    return { ...doc, exportWidth: nextW, exportHeight: nextH };
  },

  canvasMegapixels(doc: VectorDocument): number {
    return (doc.exportWidth * doc.exportHeight) / 1_000_000;
  },

  applyArtworkScalePercent(doc: VectorDocument, targetDeltaPercent: number): VectorDocument {
    const clamped = Math.max(-50, Math.min(150, targetDeltaPercent));
    const oldScale = Math.max(0.1, 1 + doc.artworkScalePercent / 100);
    const newScale = Math.max(0.1, 1 + clamped / 100);
    const factor = newScale / oldScale;
    if (Math.abs(factor - 1) < 1e-4) {
      return { ...doc, artworkScalePercent: clamped };
    }
    const cx = doc.viewBoxWidth * 0.5;
    const cy = doc.viewBoxHeight * 0.5;
    const matrix = AffineMatrix.scaleAround(factor, factor, cx, cy);
    const strokeScale = Math.max(0.05, factor);
    const scaleAll = (node: VectorNode): VectorNode => {
      if (node.kind === 'path') {
        return {
          ...node,
          commands: VectorPathOps.transform(node.commands, matrix),
          clipCommands: node.clipCommands ? VectorPathOps.transform(node.clipCommands, matrix) : null,
          strokeWidth:
            node.strokeWidth > 0 ? Math.max(0.1, Math.min(256, node.strokeWidth * strokeScale)) : node.strokeWidth,
        };
      }
      return {
        ...node,
        children: node.children.map(scaleAll),
        clipCommands: node.clipCommands ? VectorPathOps.transform(node.clipCommands, matrix) : null,
      };
    };
    return {
      ...doc,
      nodes: doc.nodes.map(scaleAll),
      artworkScalePercent: clamped,
    };
  },

  countStats(doc: VectorDocument): DocumentStats {
    let paths = 0;
    let segments = 0;
    const colors: string[] = [];
    const seen = new Set<string>();
    const addColor = (hex: string | null | undefined): void => {
      const n = VectorDocumentOps.normalizeHex(hex);
      if (n && !seen.has(n)) {
        seen.add(n);
        colors.push(n);
      }
    };
    const visit = (node: VectorNode): void => {
      if (node.kind === 'path') {
        paths++;
        for (const cmd of node.commands) {
          if (cmd.type === 'L' || cmd.type === 'C') segments++;
        }
        addColor(node.fillHex);
        if (node.strokeWidth > 0) addColor(node.strokeHex);
      } else {
        for (const child of node.children) visit(child);
      }
    };
    for (const node of doc.nodes) visit(node);
    addColor(doc.backgroundHex);
    return { paths, segments, colors };
  },
};
