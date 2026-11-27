import {
  AffineMatrix,
  boundsCenterX,
  boundsCenterY,
  type AffineMatrix2D,
  type PathCommand,
} from './vectorPathData';
import {
  VectorDocumentOps,
  type FillRule,
  type VectorNode,
  type VectorPathNode,
} from './vectorDocument';
import {
  getSelectionBounds,
  type EditorState,
} from './vectorEditorState';

type HandleKind =
  | 'NONE'
  | 'ROTATE'
  | 'CORNER_TL'
  | 'CORNER_TR'
  | 'CORNER_BL'
  | 'CORNER_BR'
  | 'EDGE_T'
  | 'EDGE_R'
  | 'EDGE_B'
  | 'EDGE_L'
  | 'BODY';

interface CachedPath {
  readonly commands: readonly PathCommand[];
  readonly clipCommands: readonly PathCommand[] | null;
  readonly fillRule: FillRule;
  readonly path: Path2D;
  readonly clipPath: Path2D | null;
}

export interface EditorCanvasCallbacks {
  onTapSelect: (hitId: string | null, shiftKey: boolean) => void;
  onCommitTransform: (matrix: AffineMatrix2D, scaleStroke: boolean) => void;
  onPickColor: (hex: string) => void;
  onZoomChange?: (zoomPercent: number) => void;
}

function commandsToPath2D(commands: readonly PathCommand[]): Path2D {
  const path = new Path2D();
  for (const cmd of commands) {
    switch (cmd.type) {
      case 'M':
        path.moveTo(cmd.x, cmd.y);
        break;
      case 'L':
        path.lineTo(cmd.x, cmd.y);
        break;
      case 'C':
        path.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x3, cmd.y3);
        break;
      case 'Z':
        path.closePath();
        break;
    }
  }
  return path;
}

export class EditorCanvasController {
  private readonly container: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly feedbackBadge: HTMLElement;
  private readonly eyedropperLoupe: HTMLElement;
  private readonly eyedropperSwatch: HTMLElement;
  private readonly eyedropperLabel: HTMLElement;
  private readonly callbacks: EditorCanvasCallbacks;

  private state: EditorState | null = null;
  private wireframe = false;
  private viewportWidth = 0;
  private viewportHeight = 0;
  private dpr = 1;
  private panX = 0;
  private panY = 0;
  private zoom = 1;
  private lockedBaseScale = 0;

  private liveMatrix: AffineMatrix2D | null = null;
  private liveFeedback: string | null = null;
  private readonly pathCache = new Map<string, CachedPath>();

  private activePointerId: number | null = null;
  private dragHandle: HandleKind = 'NONE';
  private startScreenX = 0;
  private startScreenY = 0;
  private lastScreenX = 0;
  private lastScreenY = 0;
  private startDocX = 0;
  private startDocY = 0;
  private startScale = 1;
  private startOx = 0;
  private startOy = 0;
  private movedPastSlop = false;
  private pendingMatrix: AffineMatrix2D | null = null;
  private pendingScaleStroke = true;
  private eyedropperHex: string | null = null;

  private readonly resizeObserver: ResizeObserver;
  private rafId: number | null = null;

  private static readonly HANDLE_RADIUS = 5.5;
  private static readonly HANDLE_HIT_RADIUS = 14;
  private static readonly ROTATE_STEM = 26;
  private static readonly DRAG_SLOP = 4;

  constructor(container: HTMLElement, callbacks: EditorCanvasCallbacks) {
    this.container = container;
    this.callbacks = callbacks;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 've-canvas';
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context is unavailable.');
    this.ctx = ctx;

    this.feedbackBadge = document.createElement('div');
    this.feedbackBadge.className = 've-live-feedback';
    this.feedbackBadge.hidden = true;

    this.eyedropperLoupe = document.createElement('div');
    this.eyedropperLoupe.className = 've-eyedropper-loupe';
    this.eyedropperLoupe.hidden = true;
    this.eyedropperSwatch = document.createElement('span');
    this.eyedropperSwatch.className = 've-eyedropper-swatch';
    this.eyedropperLabel = document.createElement('span');
    this.eyedropperLabel.className = 've-eyedropper-hex';
    this.eyedropperLoupe.append(this.eyedropperSwatch, this.eyedropperLabel);

    this.container.replaceChildren(this.canvas, this.feedbackBadge, this.eyedropperLoupe);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.container);
    this.handleResize();

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  setState(next: EditorState): void {
    const prevDoc = this.state?.document;
    this.state = next;
    if (
      prevDoc &&
      (prevDoc.viewBoxWidth !== next.document.viewBoxWidth || prevDoc.viewBoxHeight !== next.document.viewBoxHeight)
    ) {
      // Keep zoom stable across canvas resizes unless this is first load.
    }
    if (next.activeTool !== 'EYEDROPPER') {
      this.hideEyedropperLoupe();
    }
    this.scheduleRender();
  }

  setWireframe(enabled: boolean): void {
    this.wireframe = enabled;
    this.scheduleRender();
  }

  resetViewport(): void {
    this.panX = 0;
    this.panY = 0;
    this.zoom = 1;
    this.lockedBaseScale = 0;
    this.callbacks.onZoomChange?.(100);
    this.scheduleRender();
  }

  setZoomPercent(percent: number): void {
    const clamped = Math.max(25, Math.min(1200, percent));
    this.zoom = clamped / 100;
    this.callbacks.onZoomChange?.(Math.round(this.zoom * 100));
    this.scheduleRender();
  }

  getZoomPercent(): number {
    return Math.round(this.zoom * 100);
  }

  clearCache(): void {
    this.pathCache.clear();
  }

  destroy(): void {
    this.resizeObserver.disconnect();
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
    this.canvas.removeEventListener('wheel', this.onWheel);
  }

  private handleResize(): void {
    const rect = this.container.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    if (w !== this.viewportWidth || h !== this.viewportHeight) {
      this.viewportWidth = w;
      this.viewportHeight = h;
      this.canvas.width = Math.round(w * this.dpr);
      this.canvas.height = Math.round(h * this.dpr);
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
      if (this.lockedBaseScale === 0) {
        this.scheduleRender();
      } else {
        this.scheduleRender();
      }
    }
  }

  private viewportTransform(): { totalScale: number; originX: number; originY: number } {
    const doc = this.state?.document;
    const vw = Math.max(1, doc?.viewBoxWidth ?? 1024);
    const vh = Math.max(1, doc?.viewBoxHeight ?? 1024);
    const w = Math.max(1, this.viewportWidth);
    const h = Math.max(1, this.viewportHeight);
    const computedBase = Math.max(1e-4, Math.min((w * 0.84) / vw, (h * 0.84) / vh));
    const baseScale = this.lockedBaseScale > 0
      ? this.lockedBaseScale
      : (this.viewportWidth > 10 && this.viewportHeight > 10 ? (this.lockedBaseScale = computedBase) : computedBase);
    const totalScale = baseScale * this.zoom;
    const originX = w * 0.5 + this.panX - vw * totalScale * 0.5;
    const originY = h * 0.5 + this.panY - vh * totalScale * 0.5;
    return { totalScale, originX, originY };
  }

  private getOrBuildPath(node: VectorPathNode): CachedPath {
    const existing = this.pathCache.get(node.id);
    if (
      existing &&
      existing.commands === node.commands &&
      existing.clipCommands === node.clipCommands &&
      existing.fillRule === node.fillRule
    ) {
      return existing;
    }
    const created: CachedPath = {
      commands: node.commands,
      clipCommands: node.clipCommands,
      fillRule: node.fillRule,
      path: commandsToPath2D(node.commands),
      clipPath: node.clipCommands ? commandsToPath2D(node.clipCommands) : null,
    };
    this.pathCache.set(node.id, created);
    return created;
  }

  private sampleColorAt(docX: number, docY: number, totalScale: number): string | null {
    if (!this.state) return null;
    const doc = this.state.document;
    const hitColor = VectorDocumentOps.hitTestColor(doc, docX, docY, 8 / totalScale);
    if (hitColor) return hitColor;
    if (docX >= 0 && docX <= doc.viewBoxWidth && docY >= 0 && docY <= doc.viewBoxHeight) {
      return doc.backgroundHex;
    }
    return null;
  }

  private hitTestHandle(screenX: number, screenY: number): HandleKind {
    if (!this.state) return 'NONE';
    const selBounds = getSelectionBounds(this.state);
    if (!selBounds) return 'NONE';
    const { totalScale, originX, originY } = this.viewportTransform();
    const sLeft = originX + selBounds.left * totalScale;
    const sTop = originY + selBounds.top * totalScale;
    const sRight = originX + selBounds.right * totalScale;
    const sBottom = originY + selBounds.bottom * totalScale;
    const sMidX = (sLeft + sRight) * 0.5;
    const sMidY = (sTop + sBottom) * 0.5;

    const near = (hx: number, hy: number): boolean =>
      Math.hypot(screenX - hx, screenY - hy) <= EditorCanvasController.HANDLE_HIT_RADIUS;

    if (near(sMidX, sTop - EditorCanvasController.ROTATE_STEM)) return 'ROTATE';
    if (near(sLeft, sTop)) return 'CORNER_TL';
    if (near(sRight, sTop)) return 'CORNER_TR';
    if (near(sLeft, sBottom)) return 'CORNER_BL';
    if (near(sRight, sBottom)) return 'CORNER_BR';
    if (near(sMidX, sTop)) return 'EDGE_T';
    if (near(sRight, sMidY)) return 'EDGE_R';
    if (near(sMidX, sBottom)) return 'EDGE_B';
    if (near(sLeft, sMidY)) return 'EDGE_L';
    if (
      screenX >= sLeft - 6 &&
      screenX <= sRight + 6 &&
      screenY >= sTop - 6 &&
      screenY <= sBottom + 6
    ) {
      return 'BODY';
    }
    return 'NONE';
  }

  private cursorForHandle(handle: HandleKind): string {
    switch (handle) {
      case 'ROTATE':
        return 'grab';
      case 'CORNER_TL':
      case 'CORNER_BR':
        return 'nwse-resize';
      case 'CORNER_TR':
      case 'CORNER_BL':
        return 'nesw-resize';
      case 'EDGE_T':
      case 'EDGE_B':
        return 'ns-resize';
      case 'EDGE_L':
      case 'EDGE_R':
        return 'ew-resize';
      case 'BODY':
        return 'move';
      default:
        return 'default';
    }
  }

  private screenPointFromEvent(event: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private updateEyedropperLoupe(screenX: number, screenY: number, hex: string | null): void {
    this.eyedropperHex = hex;
    this.eyedropperLoupe.hidden = false;
    this.eyedropperSwatch.style.backgroundColor = hex ?? 'transparent';
    this.eyedropperLabel.textContent = hex ? hex.toUpperCase() : '--';
    const left = Math.max(8, Math.min(this.viewportWidth - 110, screenX - 46));
    const top = Math.max(8, screenY - 56);
    this.eyedropperLoupe.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
  }

  private hideEyedropperLoupe(): void {
    this.eyedropperLoupe.hidden = true;
    this.eyedropperHex = null;
  }

  private updateFeedbackBadge(label: string | null): void {
    this.liveFeedback = label;
    if (label) {
      this.feedbackBadge.textContent = label;
      this.feedbackBadge.hidden = false;
    } else {
      this.feedbackBadge.hidden = true;
    }
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.state) return;
    if (event.pointerType === 'mouse' && event.button !== 0 && event.button !== 1) return;
    event.preventDefault();

    const pt = this.screenPointFromEvent(event);
    const { totalScale, originX, originY } = this.viewportTransform();

    if (this.state.activeTool === 'EYEDROPPER' && event.button === 0) {
      const hex = this.sampleColorAt((pt.x - originX) / totalScale, (pt.y - originY) / totalScale, totalScale);
      this.updateEyedropperLoupe(pt.x, pt.y, hex);
      this.activePointerId = event.pointerId;
      this.canvas.setPointerCapture(event.pointerId);
      return;
    }

    this.activePointerId = event.pointerId;
    this.canvas.setPointerCapture(event.pointerId);
    this.startScreenX = pt.x;
    this.startScreenY = pt.y;
    this.lastScreenX = pt.x;
    this.lastScreenY = pt.y;
    this.startScale = totalScale;
    this.startOx = originX;
    this.startOy = originY;
    this.startDocX = (pt.x - originX) / totalScale;
    this.startDocY = (pt.y - originY) / totalScale;
    this.movedPastSlop = false;
    this.pendingMatrix = null;
    this.pendingScaleStroke = true;

    // Middle mouse button always pans.
    if (event.button === 1) {
      this.dragHandle = 'NONE';
      this.canvas.style.cursor = 'grabbing';
      return;
    }

    this.dragHandle = this.hitTestHandle(pt.x, pt.y);
    if (this.dragHandle === 'NONE') {
      this.canvas.style.cursor = 'grabbing';
    } else {
      this.canvas.style.cursor = this.cursorForHandle(this.dragHandle);
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.state) return;
    const pt = this.screenPointFromEvent(event);

    if (this.state.activeTool === 'EYEDROPPER') {
      const { totalScale, originX, originY } = this.viewportTransform();
      const hex = this.sampleColorAt((pt.x - originX) / totalScale, (pt.y - originY) / totalScale, totalScale);
      this.canvas.style.cursor = 'crosshair';
      this.updateEyedropperLoupe(pt.x, pt.y, hex);
      return;
    }

    if (this.activePointerId !== event.pointerId) {
      const hover = this.hitTestHandle(pt.x, pt.y);
      this.canvas.style.cursor = this.cursorForHandle(hover);
      return;
    }

    event.preventDefault();
    const totalDist = Math.hypot(pt.x - this.startScreenX, pt.y - this.startScreenY);
    if (totalDist > EditorCanvasController.DRAG_SLOP) {
      this.movedPastSlop = true;
    }

    if (this.dragHandle === 'NONE') {
      if (this.movedPastSlop) {
        this.panX += pt.x - this.lastScreenX;
        this.panY += pt.y - this.lastScreenY;
        this.scheduleRender();
      }
      this.lastScreenX = pt.x;
      this.lastScreenY = pt.y;
      return;
    }

    const selBounds = getSelectionBounds(this.state);
    if (!this.movedPastSlop || !selBounds) {
      this.lastScreenX = pt.x;
      this.lastScreenY = pt.y;
      return;
    }

    const curDocX = (pt.x - this.startOx) / this.startScale;
    const curDocY = (pt.y - this.startOy) / this.startScale;

    switch (this.dragHandle) {
      case 'BODY': {
        const dx = curDocX - this.startDocX;
        const dy = curDocY - this.startDocY;
        this.pendingMatrix = AffineMatrix.translation(dx, dy);
        this.pendingScaleStroke = false;
        this.updateFeedbackBadge(null);
        break;
      }
      case 'ROTATE': {
        const cx = boundsCenterX(selBounds);
        const cy = boundsCenterY(selBounds);
        const a0 = Math.atan2(this.startDocY - cy, this.startDocX - cx);
        const a1 = Math.atan2(curDocY - cy, curDocX - cx);
        let deg = ((a1 - a0) * 180) / Math.PI;
        const nearest15 = Math.round(deg / 15) * 15;
        if (Math.abs(deg - nearest15) < 4) deg = nearest15;
        this.pendingMatrix = AffineMatrix.rotationAround(deg, cx, cy);
        this.pendingScaleStroke = false;
        this.updateFeedbackBadge(`${Math.round(deg)}°`);
        break;
      }
      case 'CORNER_TL':
      case 'CORNER_TR':
      case 'CORNER_BL':
      case 'CORNER_BR': {
        const anchorX =
          this.dragHandle === 'CORNER_TL' || this.dragHandle === 'CORNER_BL' ? selBounds.right : selBounds.left;
        const anchorY =
          this.dragHandle === 'CORNER_TL' || this.dragHandle === 'CORNER_TR' ? selBounds.bottom : selBounds.top;
        const origSpan = Math.max(1, Math.hypot(this.startDocX - anchorX, this.startDocY - anchorY));
        const curSpan = Math.max(1, Math.hypot(curDocX - anchorX, curDocY - anchorY));
        const s = Math.max(0.08, Math.min(12, curSpan / origSpan));
        this.pendingMatrix = AffineMatrix.scaleAround(s, s, anchorX, anchorY);
        this.pendingScaleStroke = true;
        this.updateFeedbackBadge(`${Math.round(s * 100)}%`);
        break;
      }
      case 'EDGE_L':
      case 'EDGE_R': {
        const anchorX = this.dragHandle === 'EDGE_L' ? selBounds.right : selBounds.left;
        const rawDx = this.startDocX - anchorX;
        const origDx = Math.abs(rawDx) < 1 ? (rawDx < 0 ? -1 : 1) : rawDx;
        const sx = Math.max(0.08, Math.min(12, (curDocX - anchorX) / origDx));
        this.pendingMatrix = AffineMatrix.scaleAround(sx, 1, anchorX, boundsCenterY(selBounds));
        this.pendingScaleStroke = true;
        this.updateFeedbackBadge(`${Math.round(sx * 100)}%`);
        break;
      }
      case 'EDGE_T':
      case 'EDGE_B': {
        const anchorY = this.dragHandle === 'EDGE_T' ? selBounds.bottom : selBounds.top;
        const rawDy = this.startDocY - anchorY;
        const origDy = Math.abs(rawDy) < 1 ? (rawDy < 0 ? -1 : 1) : rawDy;
        const sy = Math.max(0.08, Math.min(12, (curDocY - anchorY) / origDy));
        this.pendingMatrix = AffineMatrix.scaleAround(1, sy, boundsCenterX(selBounds), anchorY);
        this.pendingScaleStroke = true;
        this.updateFeedbackBadge(`${Math.round(sy * 100)}%`);
        break;
      }
    }

    this.liveMatrix = this.pendingMatrix;
    this.lastScreenX = pt.x;
    this.lastScreenY = pt.y;
    this.scheduleRender();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.activePointerId !== event.pointerId) return;
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
    this.activePointerId = null;

    if (this.state?.activeTool === 'EYEDROPPER') {
      const picked = this.eyedropperHex;
      this.hideEyedropperLoupe();
      if (picked) this.callbacks.onPickColor(picked);
      return;
    }

    if (this.pendingMatrix) {
      const committed = this.pendingMatrix;
      const scaleStroke = this.pendingScaleStroke;
      this.pendingMatrix = null;
      this.liveMatrix = null;
      this.updateFeedbackBadge(null);
      this.callbacks.onCommitTransform(committed, scaleStroke);
    } else if (!this.movedPastSlop && this.state && event.button === 0) {
      const hitId = VectorDocumentOps.hitTestTopmost(
        this.state.document,
        this.startDocX,
        this.startDocY,
        10 / this.startScale,
      );
      this.callbacks.onTapSelect(hitId, event.shiftKey);
    }

    this.dragHandle = 'NONE';
    this.liveMatrix = null;
    this.updateFeedbackBadge(null);
    const pt = this.screenPointFromEvent(event);
    this.canvas.style.cursor = this.cursorForHandle(this.hitTestHandle(pt.x, pt.y));
    this.scheduleRender();
  };

  private readonly onPointerLeave = (): void => {
    if (this.activePointerId === null && this.state?.activeTool === 'EYEDROPPER') {
      this.hideEyedropperLoupe();
    }
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.state) return;
    event.preventDefault();
    const pt = this.screenPointFromEvent(event);
    const factor = Math.exp(-event.deltaY * 0.0014);
    const nextZoom = Math.max(0.25, Math.min(12, this.zoom * factor));
    const ratio = nextZoom / this.zoom;
    const focusX = pt.x - this.viewportWidth * 0.5;
    const focusY = pt.y - this.viewportHeight * 0.5;
    this.panX = this.panX * ratio + focusX * (1 - ratio);
    this.panY = this.panY * ratio + focusY * (1 - ratio);
    this.zoom = nextZoom;
    this.callbacks.onZoomChange?.(Math.round(this.zoom * 100));
    this.scheduleRender();
  };

  private scheduleRender(): void {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.render();
    });
  }

  private render(): void {
    const ctx = this.ctx;
    const state = this.state;
    const w = this.viewportWidth;
    const h = this.viewportHeight;
    if (!state || w <= 0 || h <= 0) return;

    const doc = state.document;
    const dark = document.documentElement.dataset.theme === 'dark';

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const { totalScale, originX, originY } = this.viewportTransform();
    const artW = doc.viewBoxWidth * totalScale;
    const artH = doc.viewBoxHeight * totalScale;

    // Artboard drop shadow.
    ctx.fillStyle = dark ? 'rgba(0, 0, 0, 0.42)' : 'rgba(0, 0, 0, 0.10)';
    ctx.fillRect(originX + 4, originY + 6, artW, artH);

    // Checkerboard clipped to artboard.
    ctx.save();
    ctx.beginPath();
    ctx.rect(originX, originY, artW, artH);
    ctx.clip();
    const tile = 14;
    const startCol = Math.max(0, Math.floor(-originX / tile));
    const endCol = Math.min(Math.ceil(artW / tile), Math.ceil((w - originX) / tile));
    const startRow = Math.max(0, Math.floor(-originY / tile));
    const endRow = Math.min(Math.ceil(artH / tile), Math.ceil((h - originY) / tile));
    const cEven = dark ? '#2a2c30' : '#ffffff';
    const cOdd = dark ? '#35383e' : '#e8ecf0';
    for (let c = startCol; c <= endCol; c++) {
      for (let r = startRow; r <= endRow; r++) {
        ctx.fillStyle = (c + r) % 2 === 0 ? cEven : cOdd;
        ctx.fillRect(originX + c * tile, originY + r * tile, tile, tile);
      }
    }
    ctx.restore();

    // Document content in viewBox space.
    ctx.save();
    ctx.translate(originX, originY);
    ctx.scale(totalScale, totalScale);

    if (doc.backgroundHex && !this.wireframe) {
      ctx.fillStyle = doc.backgroundHex;
      ctx.fillRect(0, 0, doc.viewBoxWidth, doc.viewBoxHeight);
    }

    const activeMatrix = this.liveMatrix;

    const drawNode = (node: VectorNode, parentAlpha: number, selectedSubtree: boolean): void => {
      if (!node.visible) return;
      const nodeSelected = selectedSubtree || state.selectedIds.has(node.id);
      const alpha = Math.max(0, Math.min(1, parentAlpha * node.opacity));
      if (alpha <= 0) return;

      if (node.kind === 'group') {
        const applyLive = !selectedSubtree && nodeSelected && activeMatrix !== null && !node.locked;
        ctx.save();
        if (applyLive && activeMatrix) {
          ctx.transform(activeMatrix.a, activeMatrix.b, activeMatrix.c, activeMatrix.d, activeMatrix.tx, activeMatrix.ty);
        }
        if (node.clipCommands) {
          ctx.clip(commandsToPath2D(node.clipCommands), 'nonzero');
        }
        for (const child of node.children) {
          drawNode(child, alpha, nodeSelected);
        }
        ctx.restore();
      } else {
        const cached = this.getOrBuildPath(node);
        const applyLive = !selectedSubtree && nodeSelected && activeMatrix !== null && !node.locked;
        ctx.save();
        if (applyLive && activeMatrix) {
          ctx.transform(activeMatrix.a, activeMatrix.b, activeMatrix.c, activeMatrix.d, activeMatrix.tx, activeMatrix.ty);
        }
        if (cached.clipPath) {
          ctx.clip(cached.clipPath, 'nonzero');
        }

        if (this.wireframe) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = dark ? '#8ab4f8' : '#1a73e8';
          ctx.lineWidth = 1.1 / totalScale;
          ctx.stroke(cached.path);
        } else {
          ctx.globalAlpha = alpha;
          if (node.fillHex) {
            ctx.fillStyle = node.fillHex;
            ctx.fill(cached.path, node.fillRule);
          }
          if (node.strokeHex && node.strokeWidth > 0) {
            ctx.strokeStyle = node.strokeHex;
            const strokeScale = activeMatrix && nodeSelected ? AffineMatrix.averageScale(activeMatrix) : 1;
            ctx.lineWidth = Math.max(0.05, node.strokeWidth * strokeScale);
            ctx.lineCap = node.strokeCap;
            ctx.lineJoin = node.strokeJoin;
            ctx.stroke(cached.path);
          }
        }
        ctx.restore();
      }
    };

    for (const node of doc.nodes) {
      drawNode(node, 1, false);
    }
    ctx.restore();

    // Crisp artboard border.
    ctx.strokeStyle = dark ? 'rgba(255, 255, 255, 0.22)' : 'rgba(0, 0, 0, 0.22)';
    ctx.lineWidth = 1;
    ctx.strokeRect(originX + 0.5, originY + 0.5, artW, artH);

    // Selection bounding box & transform handles.
    const bounds = getSelectionBounds(state);
    if (bounds) {
      const m = this.liveMatrix ?? AffineMatrix.IDENTITY;
      const toScreen = (dx: number, dy: number): { x: number; y: number } => {
        const tp = AffineMatrix.mapPoint(m, dx, dy);
        return { x: originX + tp.x * totalScale, y: originY + tp.y * totalScale };
      };
      const tl = toScreen(bounds.left, bounds.top);
      const tr = toScreen(bounds.right, bounds.top);
      const br = toScreen(bounds.right, bounds.bottom);
      const bl = toScreen(bounds.left, bounds.bottom);

      const guideColor = dark ? '#8ab4f8' : '#0b57d0';
      ctx.strokeStyle = guideColor;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(tl.x, tl.y);
      ctx.lineTo(tr.x, tr.y);
      ctx.lineTo(br.x, br.y);
      ctx.lineTo(bl.x, bl.y);
      ctx.closePath();
      ctx.stroke();

      const topMid = { x: (tl.x + tr.x) * 0.5, y: (tl.y + tr.y) * 0.5 };
      const rightMid = { x: (tr.x + br.x) * 0.5, y: (tr.y + br.y) * 0.5 };
      const bottomMid = { x: (bl.x + br.x) * 0.5, y: (bl.y + br.y) * 0.5 };
      const leftMid = { x: (tl.x + bl.x) * 0.5, y: (tl.y + bl.y) * 0.5 };

      const topDx = tr.x - tl.x;
      const topDy = tr.y - tl.y;
      const topLen = Math.max(1, Math.hypot(topDx, topDy));
      const nx = topDy / topLen;
      const ny = -topDx / topLen;
      const rotHandle = {
        x: topMid.x + nx * EditorCanvasController.ROTATE_STEM,
        y: topMid.y + ny * EditorCanvasController.ROTATE_STEM,
      };

      ctx.beginPath();
      ctx.moveTo(topMid.x, topMid.y);
      ctx.lineTo(rotHandle.x, rotHandle.y);
      ctx.stroke();

      const drawHandle = (pt: { x: number; y: number }, isCircle = false): void => {
        const r = EditorCanvasController.HANDLE_RADIUS;
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = guideColor;
        ctx.lineWidth = 1.6;
        if (isCircle) {
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, r * 1.15, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        } else {
          ctx.fillRect(pt.x - r, pt.y - r, r * 2, r * 2);
          ctx.strokeRect(pt.x - r, pt.y - r, r * 2, r * 2);
        }
      };

      drawHandle(tl);
      drawHandle(tr);
      drawHandle(br);
      drawHandle(bl);
      drawHandle(topMid);
      drawHandle(rightMid);
      drawHandle(bottomMid);
      drawHandle(leftMid);
      drawHandle(rotHandle, true);
    }

    ctx.restore();
  }
}
