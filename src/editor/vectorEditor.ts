import './editor.css';
import { PlanarPathBooleanEngine } from './pathBooleanEngine';
import { VectorDocumentOps, type VectorDocument } from './vectorDocument';
import { VectorSvgCodec } from './vectorSvgCodec';
import {
  canRedo,
  canUndo,
  createEditorState,
  EditorReducer,
  type EditorPanel,
  type EditorState,
} from './vectorEditorState';
import { EditorCanvasController } from './editorCanvas';
import {
  renderAppearancePanel,
  renderArrangePanel,
  renderCanvasPanel,
  renderLayersPanel,
} from './editorPanels';

const NOTICE_MESSAGES: Record<string, string> = {
  cannot_delete_last_path: 'At least one path must remain in the vector.',
  eyedropper_select_first: 'Select an object first, then pick a color.',
  pathfinder_empty_result: 'No resulting shape from this operation.',
};

const PANEL_TITLES: Record<Exclude<EditorPanel, 'NONE'>, string> = {
  CANVAS: 'Canvas',
  APPEARANCE: 'Style',
  ARRANGE: 'Arrange',
  LAYERS: 'Layers',
};

export interface VectorEditorSaveResult {
  readonly svg: string;
  readonly document: VectorDocument;
}

export class VectorEditorController {
  private readonly root: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly statsEl: HTMLElement;
  private readonly undoBtn: HTMLButtonElement;
  private readonly redoBtn: HTMLButtonElement;
  private readonly fitBtn: HTMLButtonElement;
  private readonly wireframeInput: HTMLInputElement;
  private readonly zoomBadge: HTMLElement;
  private readonly saveBtn: HTMLButtonElement;
  private readonly closeBtn: HTMLButtonElement;

  private readonly toolSelectBtn: HTMLButtonElement;
  private readonly toolMultiBtn: HTMLButtonElement;
  private readonly toolEyedropperBtn: HTMLButtonElement;
  private readonly panelButtons: Map<Exclude<EditorPanel, 'NONE'>, HTMLButtonElement>;

  private readonly stageContainer: HTMLElement;
  private readonly selectionStrip: HTMLElement;
  private readonly selectionCountEl: HTMLElement;
  private readonly stripDuplicateBtn: HTMLButtonElement;
  private readonly stripDeleteBtn: HTMLButtonElement;
  private readonly stripClearBtn: HTMLButtonElement;
  private readonly noticeBar: HTMLElement;

  private readonly inspectorEl: HTMLElement;
  private readonly inspectorTitleEl: HTMLElement;
  private readonly inspectorBodyEl: HTMLElement;
  private readonly inspectorCloseBtn: HTMLButtonElement;

  private readonly discardModal: HTMLElement;
  private readonly discardKeepBtn: HTMLButtonElement;
  private readonly discardConfirmBtn: HTMLButtonElement;

  private readonly canvasController: EditorCanvasController;

  private state: EditorState | null = null;
  private onSaveCallback: ((result: VectorEditorSaveResult) => void) | null = null;
  private readonly expandedGroups = new Set<string>();
  private noticeTimer: number | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.innerHTML = `
      <div class="ve-shell">
        <header class="ve-topbar">
          <div class="ve-topbar-left">
            <button type="button" class="ve-icon-btn" data-ve="close" title="Back (Esc)" aria-label="Back">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            </button>
            <div class="ve-heading">
              <strong data-ve="title">Vector Editor</strong>
              <span data-ve="stats" class="ve-stats"></span>
            </div>
          </div>
          <div class="ve-topbar-center">
            <button type="button" class="ve-icon-btn" data-ve="undo" title="Undo (Ctrl+Z)" aria-label="Undo" disabled>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"/></svg>
            </button>
            <button type="button" class="ve-icon-btn" data-ve="redo" title="Redo (Ctrl+Y)" aria-label="Redo" disabled>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5v0A5.5 5.5 0 0 0 9.5 20H13"/></svg>
            </button>
            <span class="ve-topbar-sep" aria-hidden="true"></span>
            <button type="button" class="ve-icon-btn" data-ve="fit" title="Fit to screen (0)" aria-label="Fit to screen">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
            </button>
            <span class="ve-zoom-badge" data-ve="zoom">100%</span>
            <span class="ve-topbar-sep" aria-hidden="true"></span>
            <label class="ve-wireframe-toggle" title="Toggle vector wireframe outline">
              <input type="checkbox" data-ve="wireframe">
              <span>Wireframe</span>
            </label>
          </div>
          <div class="ve-topbar-right">
            <button type="button" class="primary ve-save-btn" data-ve="save">Save</button>
          </div>
        </header>

        <div class="ve-body">
          <nav class="ve-dock" aria-label="Editor tools and panels">
            <button type="button" class="ve-dock-btn" data-ve-tool="SELECT" title="Select (V)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 4 7.07 17 2.51-7.39L21 11.07z"/></svg>
              <span>Select</span>
            </button>
            <button type="button" class="ve-dock-btn" data-ve-tool="MULTI" title="Multi-select (M)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/><path d="M14 5h5v5"/><path d="M10 19H5v-5"/></svg>
              <span>Multi</span>
            </button>
            <button type="button" class="ve-dock-btn" data-ve-tool="EYEDROPPER" title="Color picker (I)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/></svg>
              <span>Picker</span>
            </button>

            <span class="ve-dock-divider" aria-hidden="true"></span>

            <button type="button" class="ve-dock-btn" data-ve-panel="CANVAS" title="Canvas">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>
              <span>Canvas</span>
            </button>
            <button type="button" class="ve-dock-btn" data-ve-panel="APPEARANCE" title="Style (Fill, Stroke, Opacity)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2Z"/></svg>
              <span>Style</span>
            </button>
            <button type="button" class="ve-dock-btn" data-ve-panel="ARRANGE" title="Arrange, Pathfinder, Transform">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/></svg>
              <span>Arrange</span>
            </button>
            <button type="button" class="ve-dock-btn" data-ve-panel="LAYERS" title="Layers">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>
              <span>Layers</span>
            </button>
          </nav>

          <div class="ve-stage-wrap">
            <div class="ve-canvas-host" data-ve="canvasHost"></div>
            <div class="ve-selection-strip" data-ve="selectionStrip" hidden>
              <span class="ve-selection-count" data-ve="selectionCount">0 selected</span>
              <div class="ve-selection-actions">
                <button type="button" class="ve-strip-btn" data-ve="stripDuplicate" title="Duplicate (Ctrl+D)">Duplicate</button>
                <button type="button" class="ve-strip-btn is-destructive" data-ve="stripDelete" title="Delete (Del)">Delete</button>
                <button type="button" class="ve-strip-btn" data-ve="stripClear">Clear</button>
              </div>
            </div>
            <div class="ve-notice" data-ve="notice" role="status" aria-live="polite" hidden></div>
          </div>

          <aside class="ve-inspector" data-ve="inspector">
            <header class="ve-inspector-header">
              <h3 data-ve="inspectorTitle">Canvas</h3>
              <button type="button" class="ve-icon-btn ve-inspector-close" data-ve="inspectorClose" title="Close panel" aria-label="Close panel">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
              </button>
            </header>
            <div class="ve-inspector-body" data-ve="inspectorBody"></div>
          </aside>
        </div>

        <div class="ve-discard-modal" data-ve="discardModal" role="alertdialog" aria-modal="true" aria-labelledby="veDiscardTitle" hidden>
          <div class="ve-discard-card">
            <h2 id="veDiscardTitle">Discard edits?</h2>
            <p>You have unsaved vector edits. Discard them and go back?</p>
            <div class="ve-discard-actions">
              <button type="button" data-ve="discardKeep">Keep editing</button>
              <button type="button" class="ve-btn-danger" data-ve="discardConfirm">Discard</button>
            </div>
          </div>
        </div>
      </div>
    `;

    const q = <T extends HTMLElement>(sel: string): T => this.root.querySelector<T>(sel)!;
    this.titleEl = q('[data-ve="title"]');
    this.statsEl = q('[data-ve="stats"]');
    this.undoBtn = q('[data-ve="undo"]');
    this.redoBtn = q('[data-ve="redo"]');
    this.fitBtn = q('[data-ve="fit"]');
    this.wireframeInput = q('[data-ve="wireframe"]');
    this.zoomBadge = q('[data-ve="zoom"]');
    this.saveBtn = q('[data-ve="save"]');
    this.closeBtn = q('[data-ve="close"]');

    this.toolSelectBtn = q('[data-ve-tool="SELECT"]');
    this.toolMultiBtn = q('[data-ve-tool="MULTI"]');
    this.toolEyedropperBtn = q('[data-ve-tool="EYEDROPPER"]');
    this.panelButtons = new Map([
      ['CANVAS', q<HTMLButtonElement>('[data-ve-panel="CANVAS"]')],
      ['APPEARANCE', q<HTMLButtonElement>('[data-ve-panel="APPEARANCE"]')],
      ['ARRANGE', q<HTMLButtonElement>('[data-ve-panel="ARRANGE"]')],
      ['LAYERS', q<HTMLButtonElement>('[data-ve-panel="LAYERS"]')],
    ]);

    this.stageContainer = q('[data-ve="canvasHost"]');
    this.selectionStrip = q('[data-ve="selectionStrip"]');
    this.selectionCountEl = q('[data-ve="selectionCount"]');
    this.stripDuplicateBtn = q('[data-ve="stripDuplicate"]');
    this.stripDeleteBtn = q('[data-ve="stripDelete"]');
    this.stripClearBtn = q('[data-ve="stripClear"]');
    this.noticeBar = q('[data-ve="notice"]');

    this.inspectorEl = q('[data-ve="inspector"]');
    this.inspectorTitleEl = q('[data-ve="inspectorTitle"]');
    this.inspectorBodyEl = q('[data-ve="inspectorBody"]');
    this.inspectorCloseBtn = q('[data-ve="inspectorClose"]');

    this.discardModal = q('[data-ve="discardModal"]');
    this.discardKeepBtn = q('[data-ve="discardKeep"]');
    this.discardConfirmBtn = q('[data-ve="discardConfirm"]');

    this.canvasController = new EditorCanvasController(this.stageContainer, {
      onTapSelect: (hitId, shiftKey) => {
        if (!this.state) return;
        const multi = this.state.multiSelectMode || shiftKey;
        if (hitId === null) {
          if (!multi) this.updateState(EditorReducer.clearSelection(this.state));
        } else if (multi) {
          this.updateState(EditorReducer.toggleSelection(this.state, hitId));
        } else {
          this.updateState(EditorReducer.selectSingle(this.state, hitId));
        }
      },
      onCommitTransform: (matrix, scaleStroke) => {
        if (!this.state) return;
        this.updateState(EditorReducer.commitTransform(this.state, matrix, scaleStroke));
      },
      onPickColor: hex => {
        if (!this.state) return;
        this.updateState(EditorReducer.applyPickedColor(this.state, hex));
      },
      onZoomChange: pct => {
        this.zoomBadge.textContent = `${pct}%`;
      },
    });

    this.bindEvents();
  }

  private bindEvents(): void {
    this.closeBtn.addEventListener('click', () => this.requestClose());
    this.undoBtn.addEventListener('click', () => {
      if (this.state) this.updateState(EditorReducer.undo(this.state));
    });
    this.redoBtn.addEventListener('click', () => {
      if (this.state) this.updateState(EditorReducer.redo(this.state));
    });
    this.fitBtn.addEventListener('click', () => this.canvasController.resetViewport());
    this.wireframeInput.addEventListener('change', () => {
      this.canvasController.setWireframe(this.wireframeInput.checked);
    });
    this.saveBtn.addEventListener('click', () => this.commitAndClose());

    this.toolSelectBtn.addEventListener('click', () => {
      if (!this.state) return;
      this.updateState({
        ...this.state,
        activeTool: 'SELECT',
        multiSelectMode: false,
      });
    });
    this.toolMultiBtn.addEventListener('click', () => {
      if (!this.state) return;
      const toggled = EditorReducer.toggleMultiSelectMode(this.state);
      this.updateState({
        ...toggled,
        activeTool: 'SELECT',
      });
    });
    this.toolEyedropperBtn.addEventListener('click', () => {
      if (!this.state) return;
      const nextTool = this.state.activeTool === 'EYEDROPPER' ? 'SELECT' : 'EYEDROPPER';
      this.updateState(EditorReducer.setTool(this.state, nextTool));
    });

    for (const [panel, btn] of this.panelButtons.entries()) {
      btn.addEventListener('click', () => {
        if (!this.state) return;
        this.updateState(EditorReducer.togglePanel(this.state, panel));
      });
    }

    this.inspectorCloseBtn.addEventListener('click', () => {
      if (!this.state) return;
      this.updateState(EditorReducer.setPanel(this.state, 'NONE'));
    });

    this.stripDuplicateBtn.addEventListener('click', () => {
      if (this.state) this.updateState(EditorReducer.duplicate(this.state));
    });
    this.stripDeleteBtn.addEventListener('click', () => {
      if (this.state) this.updateState(EditorReducer.delete(this.state));
    });
    this.stripClearBtn.addEventListener('click', () => {
      if (this.state) this.updateState(EditorReducer.clearSelection(this.state));
    });

    this.discardKeepBtn.addEventListener('click', () => {
      this.discardModal.hidden = true;
    });
    this.discardConfirmBtn.addEventListener('click', () => {
      this.discardModal.hidden = true;
      this.forceClose();
    });
    this.discardModal.addEventListener('click', e => {
      if (e.target === this.discardModal) this.discardModal.hidden = true;
    });

    window.addEventListener('keydown', this.onKeyDown);
  }

  isOpen(): boolean {
    return !this.root.hidden && this.state !== null;
  }

  open(svg: string, title: string, onSave: (result: VectorEditorSaveResult) => void): void {
    const doc = VectorSvgCodec.parse(svg);
    this.onSaveCallback = onSave;
    this.expandedGroups.clear();
    this.wireframeInput.checked = false;
    this.canvasController.setWireframe(false);
    this.canvasController.clearCache();
    this.discardModal.hidden = true;
    this.noticeBar.hidden = true;
    this.titleEl.textContent = title ? `Edit · ${title}` : 'Vector Editor';

    this.root.hidden = false;
    this.state = createEditorState(doc, 'CANVAS');
    this.renderAll(true);
    requestAnimationFrame(() => {
      this.canvasController.resetViewport();
    });
  }

  requestClose(): void {
    if (!this.state) return;
    if (this.state.dirty) {
      this.discardModal.hidden = false;
      this.discardKeepBtn.focus();
    } else {
      this.forceClose();
    }
  }

  forceClose(): void {
    this.discardModal.hidden = true;
    this.root.hidden = true;
    this.state = null;
    this.onSaveCallback = null;
    this.canvasController.clearCache();
  }

  private commitAndClose(): void {
    if (!this.state) return;
    const doc = this.state.document;
    const serialized = VectorSvgCodec.serialize(doc);
    const cb = this.onSaveCallback;
    this.forceClose();
    cb?.({ svg: serialized, document: doc });
  }

  private updateState(next: EditorState, rebuildInspector = true): void {
    let resolved = next;
    if (resolved.noticeKey) {
      const msg = NOTICE_MESSAGES[resolved.noticeKey];
      resolved = EditorReducer.clearNotice(resolved);
      if (msg) this.showNotice(msg);
    }
    this.state = resolved;
    this.renderAll(rebuildInspector);
  }

  private showNotice(message: string): void {
    this.noticeBar.textContent = message;
    this.noticeBar.hidden = false;
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => {
      this.noticeBar.hidden = true;
      this.noticeTimer = null;
    }, 3200);
  }

  private renderAll(rebuildInspector: boolean): void {
    const state = this.state;
    if (!state) return;

    this.canvasController.setState(state);

    // Header stats & undo/redo
    const stats = VectorDocumentOps.countStats(state.document);
    const pathLabel = stats.paths === 1 ? 'path' : 'paths';
    const colorLabel = stats.colors.length === 1 ? 'color' : 'colors';
    this.statsEl.textContent = `${stats.paths} ${pathLabel} · ${stats.colors.length} ${colorLabel} · ${state.document.exportWidth}×${state.document.exportHeight}`;
    this.undoBtn.disabled = !canUndo(state);
    this.redoBtn.disabled = !canRedo(state);

    // Dock states
    const selectActive = state.activeTool === 'SELECT' && !state.multiSelectMode;
    const multiActive = state.activeTool === 'SELECT' && state.multiSelectMode;
    const eyedropperActive = state.activeTool === 'EYEDROPPER';

    this.toolSelectBtn.classList.toggle('is-selected', selectActive);
    this.toolSelectBtn.setAttribute('aria-pressed', String(selectActive));
    this.toolMultiBtn.classList.toggle('is-selected', multiActive);
    this.toolMultiBtn.setAttribute('aria-pressed', String(multiActive));
    this.toolEyedropperBtn.classList.toggle('is-selected', eyedropperActive);
    this.toolEyedropperBtn.setAttribute('aria-pressed', String(eyedropperActive));

    for (const [panel, btn] of this.panelButtons.entries()) {
      const panelActive = state.activePanel === panel;
      btn.classList.toggle('is-selected', panelActive);
      btn.setAttribute('aria-pressed', String(panelActive));
    }

    // Selection strip
    const selCount = state.selectedIds.size;
    this.selectionStrip.hidden = selCount === 0;
    if (selCount > 0) {
      this.selectionCountEl.textContent = `${selCount} selected`;
    }

    // Inspector drawer
    if (state.activePanel === 'NONE') {
      this.inspectorEl.hidden = true;
      return;
    }

    this.inspectorEl.hidden = false;
    this.inspectorTitleEl.textContent = PANEL_TITLES[state.activePanel];

    if (rebuildInspector) {
      this.renderInspectorBody(state);
    }
  }

  private renderInspectorBody(state: EditorState): void {
    let content: HTMLElement;
    switch (state.activePanel) {
      case 'CANVAS':
        content = renderCanvasPanel(state, {
          onApplyRatio: (rw, rh) => {
            if (this.state) this.updateState(EditorReducer.applyCanvasRatio(this.state, rw, rh));
          },
          onPreviewMegapixels: mp => {
            if (this.state) this.updateState(EditorReducer.previewCanvasMegapixels(this.state, mp), false);
          },
          onCommitFromSnapshot: before => {
            if (this.state) this.updateState(EditorReducer.commitFromSnapshot(this.state, before), true);
          },
          onResize: (w, h) => {
            if (this.state) this.updateState(EditorReducer.resizeCanvas(this.state, w, h));
          },
          onPreviewArtworkScale: (base, pct) => {
            if (this.state) this.updateState(EditorReducer.previewArtworkScale(this.state, base, pct), false);
          },
          onPreviewBackground: hex => {
            if (this.state) this.updateState(EditorReducer.previewCanvasBackground(this.state, hex), false);
          },
          onCommitBackground: hex => {
            if (this.state) this.updateState(EditorReducer.setCanvasBackground(this.state, hex), true);
          },
        });
        break;

      case 'APPEARANCE':
        content = renderAppearancePanel(state, {
          onTargetChange: target => {
            if (this.state) this.updateState(EditorReducer.setAppearanceTarget(this.state, target));
          },
          onPreviewFill: hex => {
            if (this.state) this.updateState(EditorReducer.previewFill(this.state, hex), false);
          },
          onCommitFill: hex => {
            if (this.state) this.updateState(EditorReducer.setFill(this.state, hex), true);
          },
          onPreviewStroke: (hex, w, cap, join) => {
            if (this.state) this.updateState(EditorReducer.previewStroke(this.state, hex, w, cap, join), false);
          },
          onCommitStroke: (hex, w, cap, join) => {
            if (this.state) this.updateState(EditorReducer.setStroke(this.state, hex, w, cap, join), true);
          },
          onPreviewOpacity: opacity => {
            if (this.state) this.updateState(EditorReducer.previewOpacity(this.state, opacity), false);
          },
          onCommitFromSnapshot: before => {
            if (this.state) this.updateState(EditorReducer.commitFromSnapshot(this.state, before), true);
          },
        });
        break;

      case 'ARRANGE':
        content = renderArrangePanel(state, {
          onDuplicate: () => { if (this.state) this.updateState(EditorReducer.duplicate(this.state)); },
          onDelete: () => { if (this.state) this.updateState(EditorReducer.delete(this.state)); },
          onGroup: () => { if (this.state) this.updateState(EditorReducer.group(this.state)); },
          onUngroup: () => { if (this.state) this.updateState(EditorReducer.ungroup(this.state)); },
          onFlipH: () => { if (this.state) this.updateState(EditorReducer.flipHorizontal(this.state)); },
          onFlipV: () => { if (this.state) this.updateState(EditorReducer.flipVertical(this.state)); },
          onRotateLeft: () => { if (this.state) this.updateState(EditorReducer.rotate(this.state, -90)); },
          onRotateRight: () => { if (this.state) this.updateState(EditorReducer.rotate(this.state, 90)); },
          onReorder: action => { if (this.state) this.updateState(EditorReducer.reorder(this.state, action)); },
          onPathfinder: op => {
            if (this.state) this.updateState(EditorReducer.applyPathfinder(this.state, op, PlanarPathBooleanEngine));
          },
        });
        break;

      case 'LAYERS':
        content = renderLayersPanel(state, {
          expandedGroups: this.expandedGroups,
          onToggleExpand: gid => {
            if (this.expandedGroups.has(gid)) this.expandedGroups.delete(gid);
            else this.expandedGroups.add(gid);
            if (this.state) this.renderInspectorBody(this.state);
          },
          onSelectNode: (id, shift) => {
            if (this.state) this.updateState(EditorReducer.selectFromLayer(this.state, id, shift));
          },
          onMoveLayer: (id, up) => {
            if (this.state) this.updateState(EditorReducer.moveLayer(this.state, id, up));
          },
          onToggleVisible: id => {
            if (this.state) this.updateState(EditorReducer.toggleVisible(this.state, id));
          },
          onToggleLocked: id => {
            if (this.state) this.updateState(EditorReducer.toggleLocked(this.state, id));
          },
        });
        break;

      default:
        return;
    }

    const scrollTop = this.inspectorBodyEl.scrollTop;
    this.inspectorBodyEl.replaceChildren(content);
    this.inspectorBodyEl.scrollTop = scrollTop;
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.isOpen() || !this.state) return;

    if (!this.discardModal.hidden) {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.discardModal.hidden = true;
      }
      return;
    }

    const active = document.activeElement;
    const isTyping =
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLSelectElement;

    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();

    if (mod && key === 'z') {
      event.preventDefault();
      event.stopPropagation();
      this.updateState(event.shiftKey ? EditorReducer.redo(this.state) : EditorReducer.undo(this.state));
      return;
    }
    if (mod && key === 'y') {
      event.preventDefault();
      event.stopPropagation();
      this.updateState(EditorReducer.redo(this.state));
      return;
    }
    if (mod && key === 's') {
      event.preventDefault();
      event.stopPropagation();
      this.commitAndClose();
      return;
    }

    if (isTyping) return;

    if (mod && key === 'd') {
      event.preventDefault();
      this.updateState(EditorReducer.duplicate(this.state));
    } else if (mod && key === 'g') {
      event.preventDefault();
      this.updateState(event.shiftKey ? EditorReducer.ungroup(this.state) : EditorReducer.group(this.state));
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && this.state.selectedIds.size > 0) {
      event.preventDefault();
      this.updateState(EditorReducer.delete(this.state));
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (this.state.activeTool === 'EYEDROPPER') {
        this.updateState(EditorReducer.setTool(this.state, 'SELECT'));
      } else if (this.state.selectedIds.size > 0) {
        this.updateState(EditorReducer.clearSelection(this.state));
      } else {
        this.requestClose();
      }
    } else if (!mod && key === 'v') {
      this.updateState({ ...this.state, activeTool: 'SELECT', multiSelectMode: false });
    } else if (!mod && key === 'i') {
      this.updateState(EditorReducer.setTool(this.state, this.state.activeTool === 'EYEDROPPER' ? 'SELECT' : 'EYEDROPPER'));
    } else if (!mod && key === 'm') {
      const toggled = EditorReducer.toggleMultiSelectMode(this.state);
      this.updateState({ ...toggled, activeTool: 'SELECT' });
    } else if (!mod && event.key === '0') {
      this.canvasController.resetViewport();
    }
  };
}
