import {
  AffineMatrix,
  boundsCenterX,
  boundsCenterY,
  type AffineMatrix2D,
  type Bounds,
} from './vectorPathData.ts';
import {
  VectorDocumentOps,
  type PathBooleanEngine,
  type PathfinderOp,
  type ReorderAction,
  type StrokeCap,
  type StrokeJoin,
  type VectorDocument,
  type VectorPathNode,
} from './vectorDocument.ts';

export type EditorTool = 'SELECT' | 'EYEDROPPER';

export type EditorPanel =
  | 'NONE'
  | 'CANVAS'
  | 'APPEARANCE'
  | 'ARRANGE'
  | 'LAYERS';

export type AppearanceTarget = 'FILL' | 'STROKE';

export interface EditorState {
  readonly document: VectorDocument;
  readonly selectedIds: ReadonlySet<string>;
  readonly activeTool: EditorTool;
  readonly activePanel: EditorPanel;
  readonly appearanceTarget: AppearanceTarget;
  readonly multiSelectMode: boolean;
  readonly undoStack: readonly VectorDocument[];
  readonly redoStack: readonly VectorDocument[];
  readonly dirty: boolean;
  readonly noticeKey: string | null;
  readonly nextIdSeed: number;
}

export function createEditorState(document: VectorDocument, activePanel: EditorPanel = 'CANVAS'): EditorState {
  return {
    document,
    selectedIds: new Set<string>(),
    activeTool: 'SELECT',
    activePanel,
    appearanceTarget: 'FILL',
    multiSelectMode: false,
    undoStack: [],
    redoStack: [],
    dirty: false,
    noticeKey: null,
    nextIdSeed: 1,
  };
}

export function canUndo(state: EditorState): boolean {
  return state.undoStack.length > 0;
}

export function canRedo(state: EditorState): boolean {
  return state.redoStack.length > 0;
}

export function getSelectionBounds(state: EditorState): Bounds | null {
  return VectorDocumentOps.selectionBounds(state.document, state.selectedIds);
}

export function getSelectedPaths(state: EditorState): VectorPathNode[] {
  return VectorDocumentOps.selectedPathNodes(state.document, state.selectedIds);
}

export function canGroup(state: EditorState): boolean {
  return VectorDocumentOps.canGroup(state.document, state.selectedIds);
}

export function canUngroup(state: EditorState): boolean {
  return VectorDocumentOps.canUngroup(state.document, state.selectedIds);
}

export function canPathfinder(state: EditorState): boolean {
  return VectorDocumentOps.canPathfinder(state.document, state.selectedIds);
}

const MAX_HISTORY = 50;

function pushHistory(state: EditorState, nextDoc: VectorDocument): EditorState {
  if (nextDoc === state.document) return state;
  const history = [...state.undoStack, state.document].slice(-MAX_HISTORY);
  return {
    ...state,
    document: nextDoc,
    undoStack: history,
    redoStack: [],
    dirty: true,
  };
}

export const EditorReducer = {
  selectSingle(state: EditorState, nodeId: string | null): EditorState {
    const next = nodeId === null ? new Set<string>() : new Set<string>([nodeId]);
    return { ...state, selectedIds: next };
  },

  toggleSelection(state: EditorState, nodeId: string): EditorState {
    const next = new Set(state.selectedIds);
    if (next.has(nodeId)) next.delete(nodeId);
    else next.add(nodeId);
    return { ...state, selectedIds: next };
  },

  selectFromLayer(state: EditorState, nodeId: string, additive = false): EditorState {
    const node = VectorDocumentOps.findNode(state.document, nodeId);
    if (node?.locked) return state;
    return state.multiSelectMode || additive
      ? EditorReducer.toggleSelection(state, nodeId)
      : EditorReducer.selectSingle(state, nodeId);
  },

  clearSelection(state: EditorState): EditorState {
    return { ...state, selectedIds: new Set<string>() };
  },

  setTool(state: EditorState, tool: EditorTool): EditorState {
    return { ...state, activeTool: tool };
  },

  togglePanel(state: EditorState, panel: EditorPanel): EditorState {
    return { ...state, activePanel: state.activePanel === panel ? 'NONE' : panel };
  },

  setPanel(state: EditorState, panel: EditorPanel): EditorState {
    return { ...state, activePanel: panel };
  },

  setAppearanceTarget(state: EditorState, target: AppearanceTarget): EditorState {
    return { ...state, appearanceTarget: target };
  },

  toggleMultiSelectMode(state: EditorState): EditorState {
    const nextMulti = !state.multiSelectMode;
    return {
      ...state,
      multiSelectMode: nextMulti,
      selectedIds: nextMulti ? state.selectedIds : new Set<string>(),
    };
  },

  commitTransform(state: EditorState, matrix: AffineMatrix2D, scaleStroke = true): EditorState {
    if (state.selectedIds.size === 0) return state;
    const nextDoc = VectorDocumentOps.transformSelected(state.document, state.selectedIds, matrix, scaleStroke);
    return pushHistory(state, nextDoc);
  },

  flipHorizontal(state: EditorState): EditorState {
    const bounds = getSelectionBounds(state);
    if (!bounds) return state;
    return EditorReducer.commitTransform(state, AffineMatrix.flipHorizontalAround(boundsCenterX(bounds)), false);
  },

  flipVertical(state: EditorState): EditorState {
    const bounds = getSelectionBounds(state);
    if (!bounds) return state;
    return EditorReducer.commitTransform(state, AffineMatrix.flipVerticalAround(boundsCenterY(bounds)), false);
  },

  rotate(state: EditorState, degrees: number): EditorState {
    const bounds = getSelectionBounds(state);
    if (!bounds) return state;
    return EditorReducer.commitTransform(
      state,
      AffineMatrix.rotationAround(degrees, boundsCenterX(bounds), boundsCenterY(bounds)),
      false,
    );
  },

  duplicate(state: EditorState): EditorState {
    if (state.selectedIds.size === 0) return state;
    let seed = state.nextIdSeed;
    const offset = Math.max(4, Math.min(28, Math.min(state.document.viewBoxWidth, state.document.viewBoxHeight) * 0.03));
    const { document: nextDoc, selectedIds: nextSelected } = VectorDocumentOps.duplicateSelected(
      state.document,
      state.selectedIds,
      offset,
      offset,
      () => `obj-dup-${seed++}`,
    );
    return { ...pushHistory(state, nextDoc), selectedIds: nextSelected, nextIdSeed: seed };
  },

  delete(state: EditorState): EditorState {
    if (state.selectedIds.size === 0) return state;
    const { document: nextDoc, removed } = VectorDocumentOps.deleteSelected(state.document, state.selectedIds);
    if (!removed) {
      return { ...state, noticeKey: 'cannot_delete_last_path' };
    }
    return { ...pushHistory(state, nextDoc), selectedIds: new Set<string>() };
  },

  group(state: EditorState): EditorState {
    if (!canGroup(state)) return state;
    const seed = state.nextIdSeed;
    const gid = `group-${seed}`;
    const { document: nextDoc, selectedIds: nextSelected } = VectorDocumentOps.groupSelected(
      state.document,
      state.selectedIds,
      gid,
      `Group ${seed}`,
    );
    return { ...pushHistory(state, nextDoc), selectedIds: nextSelected, nextIdSeed: seed + 1 };
  },

  ungroup(state: EditorState): EditorState {
    if (!canUngroup(state)) return state;
    const { document: nextDoc, selectedIds: nextSelected } = VectorDocumentOps.ungroupSelected(
      state.document,
      state.selectedIds,
    );
    return { ...pushHistory(state, nextDoc), selectedIds: nextSelected };
  },

  applyPathfinder(state: EditorState, op: PathfinderOp, engine: PathBooleanEngine): EditorState {
    if (!canPathfinder(state)) return state;
    const seed = state.nextIdSeed;
    const newId = `path-bool-${seed}`;
    const labelMap: Record<PathfinderOp, string> = {
      TRIM: `Trimmed ${seed}`,
      UNITE: `United ${seed}`,
      MINUS_FRONT: `Cut ${seed}`,
      INTERSECT: `Intersect ${seed}`,
      EXCLUDE: `Exclude ${seed}`,
    };
    const { document: nextDoc, selectedIds: createdIds } = VectorDocumentOps.applyPathfinder(
      state.document,
      state.selectedIds,
      op,
      engine,
      newId,
      labelMap[op],
    );
    if (createdIds.size === 0) {
      return { ...state, noticeKey: 'pathfinder_empty_result' };
    }
    return {
      ...pushHistory(state, nextDoc),
      selectedIds: createdIds,
      nextIdSeed: seed + 1,
    };
  },

  reorder(state: EditorState, action: ReorderAction): EditorState {
    if (state.selectedIds.size === 0) return state;
    const nextDoc = VectorDocumentOps.reorderSelected(state.document, state.selectedIds, action);
    return pushHistory(state, nextDoc);
  },

  moveLayer(state: EditorState, nodeId: string, moveUpInLayersPanel: boolean): EditorState {
    const nextDoc = VectorDocumentOps.moveTopLevelNode(state.document, nodeId, moveUpInLayersPanel);
    return pushHistory(state, nextDoc);
  },

  setFill(state: EditorState, fillHex: string | null): EditorState {
    if (state.selectedIds.size === 0) return state;
    const nextDoc = VectorDocumentOps.setFill(state.document, state.selectedIds, fillHex);
    return pushHistory(state, nextDoc);
  },

  previewFill(state: EditorState, fillHex: string | null): EditorState {
    if (state.selectedIds.size === 0) return state;
    const nextDoc = VectorDocumentOps.setFill(state.document, state.selectedIds, fillHex);
    return { ...state, document: nextDoc, dirty: true };
  },

  setStroke(
    state: EditorState,
    strokeHex: string | null,
    strokeWidth: number | null = null,
    strokeCap: StrokeCap | null = null,
    strokeJoin: StrokeJoin | null = null,
  ): EditorState {
    if (state.selectedIds.size === 0) return state;
    const nextDoc = VectorDocumentOps.setStroke(
      state.document,
      state.selectedIds,
      strokeHex,
      strokeWidth,
      strokeCap,
      strokeJoin,
    );
    return pushHistory(state, nextDoc);
  },

  previewStroke(
    state: EditorState,
    strokeHex: string | null,
    strokeWidth: number | null = null,
    strokeCap: StrokeCap | null = null,
    strokeJoin: StrokeJoin | null = null,
  ): EditorState {
    if (state.selectedIds.size === 0) return state;
    const nextDoc = VectorDocumentOps.setStroke(
      state.document,
      state.selectedIds,
      strokeHex,
      strokeWidth,
      strokeCap,
      strokeJoin,
    );
    return { ...state, document: nextDoc, dirty: true };
  },

  setOpacity(state: EditorState, opacity: number): EditorState {
    if (state.selectedIds.size === 0) return state;
    const nextDoc = VectorDocumentOps.setOpacity(state.document, state.selectedIds, opacity);
    return pushHistory(state, nextDoc);
  },

  previewOpacity(state: EditorState, opacity: number): EditorState {
    if (state.selectedIds.size === 0) return state;
    const nextDoc = VectorDocumentOps.setOpacity(state.document, state.selectedIds, opacity);
    return { ...state, document: nextDoc, dirty: true };
  },

  setCanvasBackground(state: EditorState, hex: string | null): EditorState {
    const nextDoc = VectorDocumentOps.setCanvasBackground(state.document, hex);
    return pushHistory(state, nextDoc);
  },

  previewCanvasBackground(state: EditorState, hex: string | null): EditorState {
    const nextDoc = VectorDocumentOps.setCanvasBackground(state.document, hex);
    return { ...state, document: nextDoc, dirty: true };
  },

  resizeCanvas(state: EditorState, width: number, height: number): EditorState {
    const nextDoc = VectorDocumentOps.resizeCanvas(state.document, width, height);
    return pushHistory(state, nextDoc);
  },

  applyCanvasRatio(state: EditorState, ratioW: number, ratioH: number): EditorState {
    const nextDoc = VectorDocumentOps.applyCanvasRatio(state.document, ratioW, ratioH);
    return pushHistory(state, nextDoc);
  },

  applyCanvasMegapixels(state: EditorState, megapixels: number): EditorState {
    const nextDoc = VectorDocumentOps.applyCanvasMegapixels(state.document, megapixels);
    return pushHistory(state, nextDoc);
  },

  previewCanvasMegapixels(state: EditorState, megapixels: number): EditorState {
    const nextDoc = VectorDocumentOps.applyCanvasMegapixels(state.document, megapixels);
    return { ...state, document: nextDoc, dirty: true };
  },

  previewArtworkScale(state: EditorState, baseDoc: VectorDocument, targetDeltaPercent: number): EditorState {
    const nextDoc = VectorDocumentOps.applyArtworkScalePercent(baseDoc, targetDeltaPercent);
    return { ...state, document: nextDoc, dirty: true };
  },

  commitFromSnapshot(state: EditorState, beforeDoc: VectorDocument): EditorState {
    if (beforeDoc === state.document) return state;
    const history = [...state.undoStack, beforeDoc].slice(-MAX_HISTORY);
    return {
      ...state,
      undoStack: history,
      redoStack: [],
      dirty: true,
    };
  },

  toggleVisible(state: EditorState, nodeId: string): EditorState {
    const nextDoc = VectorDocumentOps.toggleVisible(state.document, nodeId);
    const node = VectorDocumentOps.findNode(nextDoc, nodeId);
    const nextSel = new Set(state.selectedIds);
    if (node && !node.visible) nextSel.delete(nodeId);
    return { ...pushHistory(state, nextDoc), selectedIds: nextSel };
  },

  toggleLocked(state: EditorState, nodeId: string): EditorState {
    const nextDoc = VectorDocumentOps.toggleLocked(state.document, nodeId);
    const node = VectorDocumentOps.findNode(nextDoc, nodeId);
    const nextSel = new Set(state.selectedIds);
    if (node && node.locked) nextSel.delete(nodeId);
    return { ...pushHistory(state, nextDoc), selectedIds: nextSel };
  },

  applyPickedColor(state: EditorState, hex: string): EditorState {
    const normalized = VectorDocumentOps.normalizeHex(hex);
    if (!normalized) return state;
    if (state.selectedIds.size === 0) {
      return { ...state, activeTool: 'SELECT', noticeKey: 'eyedropper_select_first' };
    }
    const updated =
      state.appearanceTarget === 'STROKE'
        ? EditorReducer.setStroke(state, normalized)
        : EditorReducer.setFill(state, normalized);
    return { ...updated, activeTool: 'SELECT' };
  },

  undo(state: EditorState): EditorState {
    if (state.undoStack.length === 0) return state;
    const prev = state.undoStack[state.undoStack.length - 1];
    const nextUndo = state.undoStack.slice(0, -1);
    const nextRedo = [...state.redoStack, state.document].slice(-MAX_HISTORY);
    const validSelection = new Set<string>();
    for (const id of state.selectedIds) {
      if (VectorDocumentOps.findNode(prev, id) !== null) validSelection.add(id);
    }
    return {
      ...state,
      document: prev,
      selectedIds: validSelection,
      undoStack: nextUndo,
      redoStack: nextRedo,
      dirty: true,
    };
  },

  redo(state: EditorState): EditorState {
    if (state.redoStack.length === 0) return state;
    const next = state.redoStack[state.redoStack.length - 1];
    const nextRedo = state.redoStack.slice(0, -1);
    const nextUndo = [...state.undoStack, state.document].slice(-MAX_HISTORY);
    const validSelection = new Set<string>();
    for (const id of state.selectedIds) {
      if (VectorDocumentOps.findNode(next, id) !== null) validSelection.add(id);
    }
    return {
      ...state,
      document: next,
      selectedIds: validSelection,
      undoStack: nextUndo,
      redoStack: nextRedo,
      dirty: true,
    };
  },

  clearNotice(state: EditorState): EditorState {
    return { ...state, noticeKey: null };
  },
};
