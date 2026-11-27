import {
  boundsHeight,
  boundsWidth,
  type PathCommand,
} from './vectorPathData';
import {
  VectorDocumentOps,
  type PathfinderOp,
  type ReorderAction,
  type StrokeCap,
  type StrokeJoin,
  type VectorDocument,
  type VectorNode,
  type VectorPathNode,
} from './vectorDocument';
import {
  canGroup,
  canPathfinder,
  canUngroup,
  getSelectedPaths,
  type AppearanceTarget,
  type EditorState,
} from './vectorEditorState';

const QUICK_PALETTE = [
  '#000000', '#ffffff', '#6b7280', '#ef4444',
  '#f97316', '#facc15', '#22c55e', '#14b8a6',
  '#0b57d0', '#6366f1', '#ec4899', '#78350f',
];

const ASPECT_RATIOS: ReadonlyArray<{ label: string; w: number; h: number }> = [
  { label: '1:1', w: 1, h: 1 },
  { label: '4:5', w: 4, h: 5 },
  { label: '4:3', w: 4, h: 3 },
  { label: '3:2', w: 3, h: 2 },
  { label: '16:9', w: 16, h: 9 },
  { label: '9:16', w: 9, h: 16 },
];

export function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const clean = VectorDocumentOps.normalizeHex(hex) ?? '#0b57d0';
  const r = Number.parseInt(clean.slice(1, 3), 16) / 255;
  const g = Number.parseInt(clean.slice(3, 5), 16) / 255;
  const b = Number.parseInt(clean.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 1e-6) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
  }
  const s = max <= 1e-6 ? 0 : d / max;
  return { h, s, v: max };
}

export function hsvToHex(h: number, s: number, v: number): string {
  const hh = ((h % 360) + 360) % 360;
  const ss = Math.max(0, Math.min(1, s));
  const vv = Math.max(0, Math.min(1, v));
  const c = vv * ss;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = vv - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 60) [r, g, b] = [c, x, 0];
  else if (hh < 120) [r, g, b] = [x, c, 0];
  else if (hh < 180) [r, g, b] = [0, c, x];
  else if (hh < 240) [r, g, b] = [0, x, c];
  else if (hh < 300) [r, g, b] = [x, 0, c];
  else[r, g, b] = [c, 0, x];
  const toHex = (n: number): string => Math.max(0, Math.min(255, Math.round((n + m) * 255))).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function inlineSvg(svgMarkup: string): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 've-icon-wrap';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.innerHTML = svgMarkup;
  return wrap;
}

const ICONS = {
  duplicate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>',
  group: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><path d="M14 5h4a2 2 0 0 1 2 2v4"/><path d="M5 14v4a2 2 0 0 0 2 2h4"/></svg>',
  ungroup: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/><path d="M15 3h6v6"/><path d="M9 21H3v-6"/></svg>',
  flipH: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="M8 7l-5 5 5 5V7z"/><path d="M16 7l5 5-5 5V7z"/></svg>',
  flipV: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h18"/><path d="M7 8l5-5 5 5H7z"/><path d="M7 16l5 5 5-5H7z"/></svg>',
  rotLeft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  rotRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
  front: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2" fill="currentColor" fill-opacity="0.18"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/></svg>',
  forward: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M6 11l6-6 6 6"/></svg>',
  backward: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M6 13l6 6 6-6"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="12" height="12" rx="2"/><path d="M20 8v10a2 2 0 0 1-2 2H8"/></svg>',
  pathTrim: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="11" height="11" rx="1.5" fill="currentColor" fill-opacity="0.15"/><rect x="10" y="10" width="11" height="11" rx="1.5" fill="currentColor" fill-opacity="0.35"/></svg>',
  pathUnite: '<svg viewBox="0 0 24 24" fill="currentColor" fill-opacity="0.25" stroke="currentColor" stroke-width="1.8"><path d="M4.5 3h9a1.5 1.5 0 0 1 1.5 1.5V10h4.5a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-8a1.5 1.5 0 0 1-1.5-1.5V15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3Z"/></svg>',
  pathMinus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4.5 3h9A1.5 1.5 0 0 1 15 4.5V10h-3.5A1.5 1.5 0 0 0 10 11.5V15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3Z" fill="currentColor" fill-opacity="0.3"/><rect x="10" y="10" width="11" height="11" rx="1.5" stroke-dasharray="3 2"/></svg>',
  pathIntersect: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="12" height="12" rx="1.5" stroke-dasharray="3 2"/><rect x="9" y="9" width="12" height="12" rx="1.5" stroke-dasharray="3 2"/><rect x="9" y="9" width="6" height="6" fill="currentColor" fill-opacity="0.4"/></svg>',
  pathExclude: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="12" height="12" rx="1.5" fill="currentColor" fill-opacity="0.25"/><rect x="9" y="9" width="12" height="12" rx="1.5" fill="currentColor" fill-opacity="0.25"/><rect x="9" y="9" width="6" height="6" fill="var(--m3-surface, #fff)"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-6.5 0-10-8-10-8a18.4 18.4 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M1 1l22 22"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  unlock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>',
  chevUp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>',
  chevDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  chevRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
};

interface ColorPickerOptions {
  currentHex: string | null;
  documentSwatches: readonly string[];
  allowNone: boolean;
  onPreview: (hex: string | null) => void;
  onCommit: (hex: string | null) => void;
}

function createColorPickerSection(opts: ColorPickerOptions): HTMLElement {
  const root = el('div', 've-color-picker');
  const normalized = VectorDocumentOps.normalizeHex(opts.currentHex);
  let hsv = hexToHsv(normalized ?? '#0b57d0');
  let activeHex = normalized;

  // 1. Quick & document swatches
  const swatchRow = el('div', 've-swatch-strip');
  if (opts.allowNone) {
    const noneBtn = el('button', `ve-chip${normalized === null ? ' is-selected' : ''}`, 'None');
    noneBtn.type = 'button';
    noneBtn.addEventListener('click', () => opts.onCommit(null));
    swatchRow.append(noneBtn);
  }
  const merged = Array.from(new Set([...opts.documentSwatches, ...QUICK_PALETTE]));
  for (const hex of merged) {
    const btn = el('button', `ve-swatch-dot${normalized === hex ? ' is-selected' : ''}`);
    btn.type = 'button';
    btn.style.backgroundColor = hex;
    btn.title = hex.toUpperCase();
    btn.setAttribute('aria-label', `Select color ${hex.toUpperCase()}`);
    btn.addEventListener('click', () => opts.onCommit(hex));
    swatchRow.append(btn);
  }
  root.append(swatchRow);

  // 2. HSV sliders
  const previewDot = el('input', 've-native-color');
  previewDot.type = 'color';
  previewDot.value = normalized ?? '#0b57d0';
  previewDot.setAttribute('aria-label', 'Pick custom color');

  const hexInput = el('input', 've-hex-input');
  hexInput.type = 'text';
  hexInput.maxLength = 7;
  hexInput.spellcheck = false;
  hexInput.autocomplete = 'off';
  hexInput.value = (normalized ?? '#0b57d0').toUpperCase();
  hexInput.setAttribute('aria-label', 'HEX color');

  const makeSlider = (
    labelText: string,
    min: number,
    max: number,
    step: number,
    initial: number,
    onDrag: (value: number) => void,
  ): { row: HTMLElement; input: HTMLInputElement } => {
    const row = el('div', 've-slider-row');
    row.append(el('span', 've-slider-label', labelText));
    const input = el('input', 've-range');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(initial);
    input.addEventListener('input', () => {
      onDrag(Number(input.value));
      const nextHex = hsvToHex(hsv.h, hsv.s, hsv.v);
      activeHex = nextHex;
      previewDot.value = nextHex;
      hexInput.value = nextHex.toUpperCase();
      opts.onPreview(nextHex);
    });
    input.addEventListener('change', () => {
      const nextHex = hsvToHex(hsv.h, hsv.s, hsv.v);
      activeHex = nextHex;
      opts.onCommit(nextHex);
    });
    row.append(input);
    return { row, input };
  };

  const hueSlider = makeSlider('Hue', 0, 360, 1, Math.round(hsv.h), v => { hsv = { ...hsv, h: v }; });
  const satSlider = makeSlider('Sat', 0, 100, 1, Math.round(hsv.s * 100), v => { hsv = { ...hsv, s: v / 100 }; });
  const valSlider = makeSlider('Light', 0, 100, 1, Math.round(hsv.v * 100), v => { hsv = { ...hsv, v: v / 100 }; });
  root.append(hueSlider.row, satSlider.row, valSlider.row);

  // 3. Live swatch + HEX input
  const hexRow = el('div', 've-hex-row');
  previewDot.addEventListener('input', () => {
    const valid = VectorDocumentOps.normalizeHex(previewDot.value);
    if (!valid) return;
    activeHex = valid;
    hsv = hexToHsv(valid);
    hueSlider.input.value = String(Math.round(hsv.h));
    satSlider.input.value = String(Math.round(hsv.s * 100));
    valSlider.input.value = String(Math.round(hsv.v * 100));
    hexInput.value = valid.toUpperCase();
    opts.onPreview(valid);
  });
  previewDot.addEventListener('change', () => {
    const valid = VectorDocumentOps.normalizeHex(previewDot.value);
    if (valid) opts.onCommit(valid);
  });

  hexInput.addEventListener('input', () => {
    const valid = VectorDocumentOps.normalizeHex(hexInput.value);
    if (!valid) return;
    activeHex = valid;
    hsv = hexToHsv(valid);
    hueSlider.input.value = String(Math.round(hsv.h));
    satSlider.input.value = String(Math.round(hsv.s * 100));
    valSlider.input.value = String(Math.round(hsv.v * 100));
    previewDot.value = valid;
    opts.onCommit(valid);
  });
  hexInput.addEventListener('blur', () => {
    hexInput.value = (activeHex ?? '#0b57d0').toUpperCase();
  });

  hexRow.append(previewDot, hexInput);
  root.append(hexRow);
  return root;
}

export interface CanvasPanelHandlers {
  onApplyRatio: (rw: number, rh: number) => void;
  onPreviewMegapixels: (mp: number) => void;
  onCommitFromSnapshot: (before: VectorDocument) => void;
  onResize: (w: number, h: number) => void;
  onPreviewArtworkScale: (base: VectorDocument, pct: number) => void;
  onPreviewBackground: (hex: string | null) => void;
  onCommitBackground: (hex: string | null) => void;
}

export function renderCanvasPanel(state: EditorState, handlers: CanvasPanelHandlers): HTMLElement {
  const doc = state.document;
  const docSwatches = VectorDocumentOps.collectSwatches(doc).map(s => s.hex);
  const root = el('div', 've-panel-body');

  // 1. Asset / Object Scale (-50% .. +150%)
  const scaleDelta = Math.round(doc.artworkScalePercent);
  const scaleSign = scaleDelta > 0 ? '+' : '';
  const scaleHeader = el('div', 've-panel-row-between');
  scaleHeader.append(el('span', 've-section-title', 'Object scale'));
  const scaleRight = el('div', 've-inline-actions');
  const scaleValue = el('strong', 've-value-text', `${scaleSign}${scaleDelta}% (${100 + scaleDelta}%)`);
  scaleRight.append(scaleValue);
  if (scaleDelta !== 0) {
    const resetScaleBtn = el('button', 've-link-btn', 'Reset');
    resetScaleBtn.type = 'button';
    resetScaleBtn.addEventListener('click', () => {
      const snapshot = doc;
      handlers.onPreviewArtworkScale(snapshot, 0);
      handlers.onCommitFromSnapshot(snapshot);
    });
    scaleRight.append(resetScaleBtn);
  }
  scaleHeader.append(scaleRight);
  root.append(scaleHeader);

  let scaleBaseDoc: VectorDocument | null = null;
  const scaleInput = el('input', 've-range');
  scaleInput.type = 'range';
  scaleInput.min = '-50';
  scaleInput.max = '150';
  scaleInput.step = '1';
  scaleInput.value = String(Math.max(-50, Math.min(150, scaleDelta)));
  scaleInput.addEventListener('input', () => {
    const next = Math.round(Number(scaleInput.value));
    if (!scaleBaseDoc) scaleBaseDoc = doc;
    const s = next > 0 ? '+' : '';
    scaleValue.textContent = `${s}${next}% (${100 + next}%)`;
    handlers.onPreviewArtworkScale(scaleBaseDoc, next);
  });
  scaleInput.addEventListener('change', () => {
    if (scaleBaseDoc) {
      const snap = scaleBaseDoc;
      scaleBaseDoc = null;
      handlers.onCommitFromSnapshot(snap);
    }
  });
  root.append(scaleInput);

  const scaleTicks = el('div', 've-slider-ticks');
  ['-50%', '0%', '+50%', '+150%'].forEach(t => scaleTicks.append(el('span', '', t)));
  root.append(scaleTicks);

  root.append(el('hr', 've-divider'));

  // 2. Aspect Ratio presets
  root.append(el('span', 've-section-title', 'Aspect ratio'));
  const ratioRow = el('div', 've-chip-wrap');
  const currentAspect = doc.exportWidth / Math.max(1, doc.exportHeight);
  for (const ratio of ASPECT_RATIOS) {
    const selected = Math.abs(currentAspect - ratio.w / ratio.h) < 0.015;
    const btn = el('button', `ve-chip${selected ? ' is-selected' : ''}`, ratio.label);
    btn.type = 'button';
    btn.addEventListener('click', () => handlers.onApplyRatio(ratio.w, ratio.h));
    ratioRow.append(btn);
  }
  root.append(ratioRow);

  // 3. Artboard MP slider (20–65 MP)
  const mpDouble = VectorDocumentOps.canvasMegapixels(doc);
  const sliderMp = Math.max(20, Math.min(65, Math.round(mpDouble)));
  const mpHeader = el('div', 've-panel-row-between');
  mpHeader.append(el('span', 've-section-title', 'Artboard'));
  const mpValue = el('strong', 've-value-text', `${mpDouble.toFixed(1)} MP · ${doc.exportWidth} × ${doc.exportHeight} px`);
  mpHeader.append(mpValue);
  root.append(mpHeader);

  let mpStartDoc: VectorDocument | null = null;
  const mpInput = el('input', 've-range');
  mpInput.type = 'range';
  mpInput.min = '20';
  mpInput.max = '65';
  mpInput.step = '1';
  mpInput.value = String(sliderMp);
  mpInput.addEventListener('input', () => {
    const nextMp = Math.max(20, Math.min(65, Math.round(Number(mpInput.value))));
    if (!mpStartDoc) mpStartDoc = doc;
    const previewDoc = VectorDocumentOps.applyCanvasMegapixels(doc, nextMp);
    mpValue.textContent = `${VectorDocumentOps.canvasMegapixels(previewDoc).toFixed(1)} MP · ${previewDoc.exportWidth} × ${previewDoc.exportHeight} px`;
    widthInput.value = String(previewDoc.exportWidth);
    heightInput.value = String(previewDoc.exportHeight);
    handlers.onPreviewMegapixels(nextMp);
  });
  mpInput.addEventListener('change', () => {
    if (mpStartDoc) {
      const snap = mpStartDoc;
      mpStartDoc = null;
      handlers.onCommitFromSnapshot(snap);
    }
  });
  root.append(mpInput);

  const mpTicks = el('div', 've-slider-ticks');
  mpTicks.append(el('span', '', '20 MP'), el('span', '', '65 MP'));
  root.append(mpTicks);

  // 4. Custom Width × Height px
  const sizeRow = el('div', 've-size-row');
  const widthInput = el('input', 've-num-input');
  widthInput.type = 'number';
  widthInput.min = '16';
  widthInput.max = '32768';
  widthInput.value = String(doc.exportWidth);
  widthInput.setAttribute('aria-label', 'Width');

  const heightInput = el('input', 've-num-input');
  heightInput.type = 'number';
  heightInput.min = '16';
  heightInput.max = '32768';
  heightInput.value = String(doc.exportHeight);
  heightInput.setAttribute('aria-label', 'Height');

  const applySizeBtn = el('button', 'primary ve-apply-btn', 'Apply');
  applySizeBtn.type = 'button';
  applySizeBtn.disabled = true;

  const syncSizeButton = (): void => {
    const w = Number.parseInt(widthInput.value, 10);
    const h = Number.parseInt(heightInput.value, 10);
    const valid = Number.isInteger(w) && Number.isInteger(h) && w >= 16 && w <= 32768 && h >= 16 && h <= 32768;
    applySizeBtn.disabled = !valid || (w === doc.exportWidth && h === doc.exportHeight);
  };
  widthInput.addEventListener('input', syncSizeButton);
  heightInput.addEventListener('input', syncSizeButton);
  applySizeBtn.addEventListener('click', () => {
    const w = Number.parseInt(widthInput.value, 10);
    const h = Number.parseInt(heightInput.value, 10);
    if (Number.isInteger(w) && Number.isInteger(h) && w >= 16 && w <= 32768 && h >= 16 && h <= 32768) {
      handlers.onResize(w, h);
    }
  });

  const wWrap = el('label', 've-field-label', 'Width');
  wWrap.append(widthInput);
  const hWrap = el('label', 've-field-label', 'Height');
  hWrap.append(heightInput);
  sizeRow.append(wWrap, el('span', 've-times-sep', '×'), hWrap, applySizeBtn);
  root.append(sizeRow);

  root.append(el('hr', 've-divider'));

  // 5. Background: Transparent vs Color
  root.append(el('span', 've-section-title', 'Background'));
  const bgSeg = el('div', 've-segmented');
  const transBtn = el('button', `ve-seg-btn${doc.backgroundHex === null ? ' is-selected' : ''}`, 'Transparent');
  transBtn.type = 'button';
  transBtn.addEventListener('click', () => handlers.onCommitBackground(null));

  const colorBtn = el('button', `ve-seg-btn${doc.backgroundHex !== null ? ' is-selected' : ''}`, 'Color');
  colorBtn.type = 'button';
  colorBtn.addEventListener('click', () => {
    if (doc.backgroundHex === null) handlers.onCommitBackground('#ffffff');
  });

  bgSeg.append(transBtn, colorBtn);
  root.append(bgSeg);

  if (doc.backgroundHex !== null) {
    let bgBeforeDoc: VectorDocument | null = null;
    root.append(
      createColorPickerSection({
        currentHex: doc.backgroundHex,
        documentSwatches: docSwatches,
        allowNone: false,
        onPreview: hex => {
          if (!hex) return;
          if (!bgBeforeDoc) bgBeforeDoc = doc;
          handlers.onPreviewBackground(hex);
        },
        onCommit: hex => {
          if (!hex) return;
          if (bgBeforeDoc) {
            const snap = bgBeforeDoc;
            bgBeforeDoc = null;
            handlers.onPreviewBackground(hex);
            handlers.onCommitFromSnapshot(snap);
          } else {
            handlers.onCommitBackground(hex);
          }
        },
      }),
    );
  }

  return root;
}

export interface AppearancePanelHandlers {
  onTargetChange: (target: AppearanceTarget) => void;
  onPreviewFill: (hex: string | null) => void;
  onCommitFill: (hex: string | null) => void;
  onPreviewStroke: (hex: string | null, w: number | null, cap: StrokeCap | null, join: StrokeJoin | null) => void;
  onCommitStroke: (hex: string | null, w: number | null, cap: StrokeCap | null, join: StrokeJoin | null) => void;
  onPreviewOpacity: (opacity: number) => void;
  onCommitFromSnapshot: (before: VectorDocument) => void;
}

export function renderAppearancePanel(state: EditorState, handlers: AppearancePanelHandlers): HTMLElement {
  const selectedPaths = getSelectedPaths(state);
  if (selectedPaths.length === 0) {
    return createEmptySelectionNotice();
  }

  const doc = state.document;
  const sample = selectedPaths[0];
  const docSwatches = VectorDocumentOps.collectSwatches(doc).map(s => s.hex);
  const firstSelectedId = state.selectedIds.values().next().value as string | undefined;
  const selectedTopNode = firstSelectedId ? VectorDocumentOps.findNode(doc, firstSelectedId) : null;
  const currentOpacity = selectedTopNode?.opacity ?? sample.opacity;

  const root = el('div', 've-panel-body');

  // Fill / Stroke segmented control
  const seg = el('div', 've-segmented');
  const fillTab = el('button', `ve-seg-btn${state.appearanceTarget === 'FILL' ? ' is-selected' : ''}`, 'Fill');
  fillTab.type = 'button';
  fillTab.addEventListener('click', () => handlers.onTargetChange('FILL'));

  const strokeTab = el('button', `ve-seg-btn${state.appearanceTarget === 'STROKE' ? ' is-selected' : ''}`, 'Stroke');
  strokeTab.type = 'button';
  strokeTab.addEventListener('click', () => handlers.onTargetChange('STROKE'));

  seg.append(fillTab, strokeTab);
  root.append(seg);

  // Opacity slider
  const opRow = el('div', 've-panel-row-between');
  opRow.append(el('span', 've-section-title', 'Opacity'));
  const opVal = el('strong', 've-value-text', `${Math.round(currentOpacity * 100)}%`);
  opRow.append(opVal);
  root.append(opRow);

  let opStartDoc: VectorDocument | null = null;
  const opSlider = el('input', 've-range');
  opSlider.type = 'range';
  opSlider.min = '0';
  opSlider.max = '100';
  opSlider.step = '1';
  opSlider.value = String(Math.round(currentOpacity * 100));
  opSlider.addEventListener('input', () => {
    const pct = Math.round(Number(opSlider.value));
    if (!opStartDoc) opStartDoc = doc;
    opVal.textContent = `${pct}%`;
    handlers.onPreviewOpacity(pct / 100);
  });
  opSlider.addEventListener('change', () => {
    if (opStartDoc) {
      const snap = opStartDoc;
      opStartDoc = null;
      handlers.onCommitFromSnapshot(snap);
    }
  });
  root.append(opSlider);

  if (state.appearanceTarget === 'FILL') {
    let fillBeforeDoc: VectorDocument | null = null;
    root.append(
      createColorPickerSection({
        currentHex: sample.fillHex,
        documentSwatches: docSwatches,
        allowNone: true,
        onPreview: hex => {
          if (!fillBeforeDoc) fillBeforeDoc = doc;
          handlers.onPreviewFill(hex);
        },
        onCommit: hex => {
          if (fillBeforeDoc) {
            const snap = fillBeforeDoc;
            fillBeforeDoc = null;
            handlers.onPreviewFill(hex);
            handlers.onCommitFromSnapshot(snap);
          } else {
            handlers.onCommitFill(hex);
          }
        },
      }),
    );
  } else {
    // Stroke width
    const swRow = el('div', 've-panel-row-between');
    swRow.append(el('span', 've-section-title', 'Width'));
    const swVal = el('strong', 've-value-text', sample.strokeWidth.toFixed(1));
    swRow.append(swVal);
    root.append(swRow);

    let swStartDoc: VectorDocument | null = null;
    const swSlider = el('input', 've-range');
    swSlider.type = 'range';
    swSlider.min = '0';
    swSlider.max = '24';
    swSlider.step = '0.5';
    swSlider.value = String(Math.max(0, Math.min(24, sample.strokeWidth)));
    swSlider.addEventListener('input', () => {
      const w = Number(swSlider.value);
      if (!swStartDoc) swStartDoc = doc;
      swVal.textContent = w.toFixed(1);
      const hex = sample.strokeHex ?? '#000000';
      handlers.onPreviewStroke(w <= 0 ? null : hex, w, null, null);
    });
    swSlider.addEventListener('change', () => {
      if (swStartDoc) {
        const snap = swStartDoc;
        swStartDoc = null;
        handlers.onCommitFromSnapshot(snap);
      }
    });
    root.append(swSlider);

    // Cap chips
    root.append(el('span', 've-section-title', 'Cap'));
    const capRow = el('div', 've-chip-wrap');
    const caps: ReadonlyArray<{ value: StrokeCap; label: string }> = [
      { value: 'butt', label: 'Butt' },
      { value: 'round', label: 'Round' },
      { value: 'square', label: 'Square' },
    ];
    for (const c of caps) {
      const btn = el('button', `ve-chip${sample.strokeCap === c.value ? ' is-selected' : ''}`, c.label);
      btn.type = 'button';
      btn.addEventListener('click', () => handlers.onCommitStroke(sample.strokeHex ?? '#000000', null, c.value, null));
      capRow.append(btn);
    }
    root.append(capRow);

    // Join chips
    root.append(el('span', 've-section-title', 'Join'));
    const joinRow = el('div', 've-chip-wrap');
    const joins: ReadonlyArray<{ value: StrokeJoin; label: string }> = [
      { value: 'miter', label: 'Miter' },
      { value: 'round', label: 'Round' },
      { value: 'bevel', label: 'Bevel' },
    ];
    for (const j of joins) {
      const btn = el('button', `ve-chip${sample.strokeJoin === j.value ? ' is-selected' : ''}`, j.label);
      btn.type = 'button';
      btn.addEventListener('click', () => handlers.onCommitStroke(sample.strokeHex ?? '#000000', null, null, j.value));
      joinRow.append(btn);
    }
    root.append(joinRow);

    let strokeBeforeDoc: VectorDocument | null = null;
    root.append(
      createColorPickerSection({
        currentHex: sample.strokeHex,
        documentSwatches: docSwatches,
        allowNone: true,
        onPreview: hex => {
          if (!strokeBeforeDoc) strokeBeforeDoc = doc;
          if (hex === null) handlers.onPreviewStroke(null, 0, null, null);
          else handlers.onPreviewStroke(hex, sample.strokeWidth <= 0 ? 2 : sample.strokeWidth, null, null);
        },
        onCommit: hex => {
          if (strokeBeforeDoc) {
            const snap = strokeBeforeDoc;
            strokeBeforeDoc = null;
            if (hex === null) handlers.onPreviewStroke(null, 0, null, null);
            else handlers.onPreviewStroke(hex, sample.strokeWidth <= 0 ? 2 : sample.strokeWidth, null, null);
            handlers.onCommitFromSnapshot(snap);
          } else if (hex === null) {
            handlers.onCommitStroke(null, 0, null, null);
          } else {
            handlers.onCommitStroke(hex, sample.strokeWidth <= 0 ? 2 : sample.strokeWidth, null, null);
          }
        },
      }),
    );
  }

  return root;
}

export interface ArrangePanelHandlers {
  onDuplicate: () => void;
  onDelete: () => void;
  onGroup: () => void;
  onUngroup: () => void;
  onFlipH: () => void;
  onFlipV: () => void;
  onRotateLeft: () => void;
  onRotateRight: () => void;
  onReorder: (action: ReorderAction) => void;
  onPathfinder: (op: PathfinderOp) => void;
}

export function renderArrangePanel(state: EditorState, handlers: ArrangePanelHandlers): HTMLElement {
  if (state.selectedIds.size === 0) {
    return createEmptySelectionNotice();
  }

  const root = el('div', 've-panel-body');

  const makeActionGrid = (
    title: string,
    items: ReadonlyArray<{
      icon: string;
      label: string;
      enabled: boolean;
      destructive?: boolean;
      onClick: () => void;
    }>,
    cols = 2,
  ): void => {
    root.append(el('span', 've-section-title', title));
    const grid = el('div', `ve-action-grid ve-cols-${cols}`);
    for (const item of items) {
      const btn = el('button', `ve-action-tile${item.destructive ? ' is-destructive' : ''}`);
      btn.type = 'button';
      btn.disabled = !item.enabled;
      btn.append(inlineSvg(item.icon), el('span', '', item.label));
      btn.addEventListener('click', item.onClick);
      grid.append(btn);
    }
    root.append(grid);
  };

  makeActionGrid('Object', [
    { icon: ICONS.duplicate, label: 'Duplicate', enabled: true, onClick: handlers.onDuplicate },
    { icon: ICONS.trash, label: 'Delete', enabled: true, destructive: true, onClick: handlers.onDelete },
    { icon: ICONS.group, label: 'Group', enabled: canGroup(state), onClick: handlers.onGroup },
    { icon: ICONS.ungroup, label: 'Ungroup', enabled: canUngroup(state), onClick: handlers.onUngroup },
  ], 2);

  const pfEnabled = canPathfinder(state);
  makeActionGrid('Pathfinder', [
    { icon: ICONS.pathTrim, label: 'Trim', enabled: pfEnabled, onClick: () => handlers.onPathfinder('TRIM') },
    { icon: ICONS.pathUnite, label: 'Unite', enabled: pfEnabled, onClick: () => handlers.onPathfinder('UNITE') },
    { icon: ICONS.pathMinus, label: 'Minus', enabled: pfEnabled, onClick: () => handlers.onPathfinder('MINUS_FRONT') },
    { icon: ICONS.pathIntersect, label: 'Intersect', enabled: pfEnabled, onClick: () => handlers.onPathfinder('INTERSECT') },
    { icon: ICONS.pathExclude, label: 'Exclude', enabled: pfEnabled, onClick: () => handlers.onPathfinder('EXCLUDE') },
  ], 3);

  makeActionGrid('Transform', [
    { icon: ICONS.flipH, label: 'Flip H', enabled: true, onClick: handlers.onFlipH },
    { icon: ICONS.flipV, label: 'Flip V', enabled: true, onClick: handlers.onFlipV },
    { icon: ICONS.rotLeft, label: '-90°', enabled: true, onClick: handlers.onRotateLeft },
    { icon: ICONS.rotRight, label: '+90°', enabled: true, onClick: handlers.onRotateRight },
  ], 2);

  makeActionGrid('Order', [
    { icon: ICONS.front, label: 'Front', enabled: true, onClick: () => handlers.onReorder('BRING_TO_FRONT') },
    { icon: ICONS.forward, label: 'Forward', enabled: true, onClick: () => handlers.onReorder('BRING_FORWARD') },
    { icon: ICONS.backward, label: 'Backward', enabled: true, onClick: () => handlers.onReorder('SEND_BACKWARD') },
    { icon: ICONS.back, label: 'Back', enabled: true, onClick: () => handlers.onReorder('SEND_TO_BACK') },
  ], 2);

  return root;
}

export interface LayersPanelHandlers {
  expandedGroups: ReadonlySet<string>;
  onToggleExpand: (groupId: string) => void;
  onSelectNode: (nodeId: string, shiftKey: boolean) => void;
  onMoveLayer: (nodeId: string, moveUp: boolean) => void;
  onToggleVisible: (nodeId: string) => void;
  onToggleLocked: (nodeId: string) => void;
}

function drawLayerThumbnail(node: VectorNode): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.className = 've-layer-thumb';
  const size = 32;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.scale(dpr, dpr);

  // Mini checkerboard
  const tile = size / 4;
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      ctx.fillStyle = (c + r) % 2 === 0 ? '#ffffff' : '#e2e6ec';
      ctx.fillRect(c * tile, r * tile, tile, tile);
    }
  }

  const b = VectorDocumentOps.boundsOf(node);
  if (!b) return canvas;
  const bw = Math.max(1e-3, boundsWidth(b));
  const bh = Math.max(1e-3, boundsHeight(b));
  const pad = size * 0.12;
  const scale = Math.min((size - pad * 2) / bw, (size - pad * 2) / bh);
  const tx = (size - bw * scale) * 0.5 - b.left * scale;
  const ty = (size - bh * scale) * 0.5 - b.top * scale;

  const toPath2D = (cmds: readonly PathCommand[]): Path2D => {
    const p = new Path2D();
    for (const cmd of cmds) {
      if (cmd.type === 'M') p.moveTo(cmd.x, cmd.y);
      else if (cmd.type === 'L') p.lineTo(cmd.x, cmd.y);
      else if (cmd.type === 'C') p.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x3, cmd.y3);
      else p.closePath();
    }
    return p;
  };

  const renderPaths: VectorPathNode[] = [];
  const collect = (n: VectorNode): void => {
    if (n.kind === 'path') renderPaths.push(n);
    else for (const child of n.children) collect(child);
  };
  collect(node);

  ctx.save();
  ctx.translate(tx, ty);
  ctx.scale(scale, scale);
  for (const pn of renderPaths) {
    if (pn.opacity <= 0) continue;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, pn.opacity));
    if (pn.clipCommands) ctx.clip(toPath2D(pn.clipCommands), 'nonzero');
    const p = toPath2D(pn.commands);
    if (pn.fillHex) {
      ctx.fillStyle = pn.fillHex;
      ctx.fill(p, pn.fillRule);
    }
    if (pn.strokeHex && pn.strokeWidth > 0) {
      ctx.strokeStyle = pn.strokeHex;
      ctx.lineWidth = pn.strokeWidth;
      ctx.stroke(p);
    }
    ctx.restore();
  }
  ctx.restore();
  return canvas;
}

export function renderLayersPanel(state: EditorState, handlers: LayersPanelHandlers): HTMLElement {
  const root = el('div', 've-panel-body ve-layers-list');
  const topDown = [...state.document.nodes].reverse();

  const renderRow = (node: VectorNode, depth: number, indexInTopDown: number, totalTop: number): HTMLElement => {
    const selected = state.selectedIds.has(node.id);
    const row = el('div', `ve-layer-row${selected ? ' is-selected' : ''}${!node.visible ? ' is-hidden' : ''}`);
    if (depth > 0) row.style.marginLeft = `${depth * 18}px`;

    row.addEventListener('click', event => {
      handlers.onSelectNode(node.id, event.shiftKey);
    });

    if (node.kind === 'group') {
      const expanded = handlers.expandedGroups.has(node.id);
      const expBtn = el('button', 've-layer-icon-btn');
      expBtn.type = 'button';
      expBtn.title = expanded ? 'Collapse group' : 'Expand group';
      expBtn.append(inlineSvg(expanded ? ICONS.chevDown : ICONS.chevRight));
      expBtn.addEventListener('click', e => {
        e.stopPropagation();
        handlers.onToggleExpand(node.id);
      });
      row.append(expBtn);
    }

    row.append(drawLayerThumbnail(node));
    const nameEl = el('span', 've-layer-name', node.name);
    nameEl.title = node.name;
    row.append(nameEl);

    const actions = el('div', 've-layer-actions');
    if (depth === 0) {
      const upBtn = el('button', 've-layer-icon-btn');
      upBtn.type = 'button';
      upBtn.disabled = indexInTopDown <= 0;
      upBtn.title = 'Forward';
      upBtn.setAttribute('aria-label', 'Forward');
      upBtn.append(inlineSvg(ICONS.chevUp));
      upBtn.addEventListener('click', e => {
        e.stopPropagation();
        handlers.onMoveLayer(node.id, true);
      });

      const downBtn = el('button', 've-layer-icon-btn');
      downBtn.type = 'button';
      downBtn.disabled = indexInTopDown >= totalTop - 1;
      downBtn.title = 'Backward';
      downBtn.setAttribute('aria-label', 'Backward');
      downBtn.append(inlineSvg(ICONS.chevDown));
      downBtn.addEventListener('click', e => {
        e.stopPropagation();
        handlers.onMoveLayer(node.id, false);
      });
      actions.append(upBtn, downBtn);
    }

    const visBtn = el('button', `ve-layer-icon-btn${!node.visible ? ' is-muted' : ''}`);
    visBtn.type = 'button';
    visBtn.title = 'Toggle visibility';
    visBtn.setAttribute('aria-label', 'Toggle visibility');
    visBtn.append(inlineSvg(node.visible ? ICONS.eye : ICONS.eyeOff));
    visBtn.addEventListener('click', e => {
      e.stopPropagation();
      handlers.onToggleVisible(node.id);
    });

    const lockBtn = el('button', `ve-layer-icon-btn${node.locked ? ' is-active' : ''}`);
    lockBtn.type = 'button';
    lockBtn.title = 'Toggle lock';
    lockBtn.setAttribute('aria-label', 'Toggle lock');
    lockBtn.append(inlineSvg(node.locked ? ICONS.lock : ICONS.unlock));
    lockBtn.addEventListener('click', e => {
      e.stopPropagation();
      handlers.onToggleLocked(node.id);
    });

    actions.append(visBtn, lockBtn);
    row.append(actions);
    return row;
  };

  topDown.forEach((node, idx) => {
    root.append(renderRow(node, 0, idx, topDown.length));
    if (node.kind === 'group' && handlers.expandedGroups.has(node.id)) {
      const childrenTopDown = [...node.children].reverse();
      childrenTopDown.forEach((child, cIdx) => {
        root.append(renderRow(child, 1, cIdx, childrenTopDown.length));
      });
    }
  });

  return root;
}

function createEmptySelectionNotice(): HTMLElement {
  const box = el('div', 've-empty-notice');
  box.append(el('p', '', 'Select an object on the canvas or in Layers to edit its properties.'));
  return box;
}
