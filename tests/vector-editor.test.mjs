import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { VectorPathOps, boundsWidth } from '../src/editor/vectorPathData.ts';
import { VectorDocumentOps } from '../src/editor/vectorDocument.ts';
import { VectorSvgCodec } from '../src/editor/vectorSvgCodec.ts';
import { PlanarPathBooleanEngine } from '../src/editor/pathBooleanEngine.ts';
import { createEditorState, EditorReducer } from '../src/editor/vectorEditorState.ts';

const sampleSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><defs><clipPath id="c0" clipPathUnits="userSpaceOnUse"><path clip-rule="nonzero" d="M0 0L100 0L100 100L0 100Z"/></clipPath></defs><path fill="#ff0000" fill-rule="evenodd" clip-path="url(#c0)" d="M10 10L50 10L50 50L10 50Z"/><path fill="#00ff00" fill-rule="evenodd" d="M60 60L90 60L90 90L60 90Z"/></svg>`;

const cvrRecordedSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="4000" height="4000" viewBox="0 0 4000 4000" color-interpolation="sRGB">
  <title>Editable vector artwork</title>
  <g id="background" aria-label="Background">
    <rect id="background-color" width="4000" height="4000" fill="#ffffff"/>
  </g>
  <g id="artwork-transform" aria-label="Artwork transform" transform="translate(200 200) scale(20)">
    <g id="artwork" aria-label="Artwork">
      <path id="shape-1" d="M 0 0 h 50 v 50 h -50 Z" fill="rgb(255, 0, 0)" fill-rule="nonzero" transform="matrix(1 0 0 1 10 10)"/>
      <circle cx="80" cy="80" r="20" fill="#00f"/>
    </g>
  </g>
</svg>`;

test('parse and serialize round-trip handles CVR recorded SVG with transforms and primitives', () => {
  assert.equal(VectorSvgCodec.isEditableSvg(cvrRecordedSvg), true);
  const doc = VectorSvgCodec.parse(cvrRecordedSvg);
  assert.equal(doc.exportWidth, 4000);
  assert.equal(doc.exportHeight, 4000);
  assert.equal(doc.backgroundHex, '#ffffff');
  assert.equal(doc.nodes.length, 2);
  assert.equal(doc.nodes[0].kind, 'path');
  assert.equal(doc.nodes[0].fillHex, '#ff0000');
  assert.equal(doc.nodes[1].kind, 'path');
  assert.equal(doc.nodes[1].fillHex, '#0000ff');

  // Baked transform check: x=10..60 scaled by 20 + 200 => 400..1400
  const b0 = VectorDocumentOps.boundsOf(doc.nodes[0]);
  assert.ok(b0);
  assert.ok(Math.abs(b0.left - 400) < 0.5);
  assert.ok(Math.abs(b0.right - 1400) < 0.5);

  const serialized = VectorSvgCodec.serialize(doc);
  assert.match(serialized, /id="mv-canvas-bg"/);
  const reparsed = VectorSvgCodec.parse(serialized);
  assert.equal(reparsed.nodes.length, 2);
  assert.equal(reparsed.backgroundHex, '#ffffff');
});

test('parse/serialize preserves stroke cap/join, opacity, groups, and clips', () => {
  const doc = VectorSvgCodec.parse(sampleSvg);
  assert.equal(doc.nodes.length, 2);

  let state = createEditorState(doc);
  state = EditorReducer.selectSingle(state, doc.nodes[0].id);
  state = EditorReducer.setStroke(state, '#0000ff', 3, 'round', 'bevel');
  state = EditorReducer.setOpacity(state, 0.75);
  state = EditorReducer.selectSingle(state, doc.nodes[1].id);
  state = EditorReducer.setFill(state, null);
  state = EditorReducer.setStroke(state, '#112233', 2);

  const grouped = EditorReducer.group({
    ...state,
    selectedIds: new Set([state.document.nodes[0].id, state.document.nodes[1].id]),
  });
  assert.equal(grouped.document.nodes.length, 1);
  assert.equal(grouped.document.nodes[0].kind, 'group');

  const serialized = VectorSvgCodec.serialize(grouped.document);
  assert.match(serialized, /stroke-linecap="round"/);
  assert.match(serialized, /stroke-linejoin="bevel"/);
  assert.match(serialized, /opacity="0\.75"/);
  assert.match(serialized, /<g>/);

  const reparsed = VectorSvgCodec.parse(serialized);
  assert.equal(reparsed.nodes.length, 1);
  assert.equal(reparsed.nodes[0].kind, 'group');
  assert.equal(reparsed.nodes[0].children.length, 2);
});

test('hitTest respects evenodd hole and stroke', () => {
  const donut = VectorPathOps.parse('M0 0L100 0L100 100L0 100ZM25 25L25 75L75 75L75 25Z');
  assert.equal(VectorPathOps.hitTest(donut, 10, 10, true, true, 0, 1), true);
  assert.equal(VectorPathOps.hitTest(donut, 50, 50, true, true, 0, 1), false);

  const strokeOnly = VectorPathOps.parse('M10 10L90 10');
  assert.equal(VectorPathOps.hitTest(strokeOnly, 50, 12, true, false, 6, 2), true);
  assert.equal(VectorPathOps.hitTest(strokeOnly, 50, 30, true, false, 2, 2), false);
});

test('document ops: duplicate, fill, undo/redo, delete guard, visibility, and lock', () => {
  const doc = VectorSvgCodec.parse(sampleSvg);
  let state = createEditorState(doc);

  state = EditorReducer.selectSingle(state, doc.nodes[0].id);
  state = EditorReducer.duplicate(state);
  assert.equal(state.document.nodes.length, 3);

  state = EditorReducer.setFill(state, '#123456');
  const swatches = VectorDocumentOps.collectSwatches(state.document);
  assert.ok(swatches.some(s => s.hex === '#123456' && s.count === 1));

  const afterFill = state.document;
  state = EditorReducer.undo(state);
  assert.ok(!VectorDocumentOps.collectSwatches(state.document).some(s => s.hex === '#123456'));
  state = EditorReducer.redo(state);
  assert.equal(state.document, afterFill);

  // Guard against deleting all paths.
  const allIds = new Set(state.document.nodes.map(n => n.id));
  const deleteAll = VectorDocumentOps.deleteSelected(state.document, allIds);
  assert.equal(deleteAll.removed, false);
  assert.equal(deleteAll.document, state.document);

  // Hit-test topmost unlocked visible node.
  const hit = VectorDocumentOps.hitTestTopmost(state.document, 75, 75, 2);
  assert.ok(hit);
  const hiddenDoc = VectorDocumentOps.toggleVisible(state.document, hit);
  assert.equal(VectorDocumentOps.hitTestTopmost(hiddenDoc, 75, 75, 2), null);
});

test('canvas ratio, megapixels, artwork scale, multi-select, and background round-trip', () => {
  const doc = VectorSvgCodec.parse(sampleSvg);
  let state = createEditorState(doc);

  state = EditorReducer.applyCanvasRatio(state, 16, 9);
  state = EditorReducer.applyCanvasMegapixels(state, 20);
  state = EditorReducer.setCanvasBackground(state, '#f5f5f5');

  const mp20 = VectorDocumentOps.canvasMegapixels(state.document);
  assert.ok(mp20 >= 19.9 && mp20 <= 20.1);
  assert.equal(state.document.backgroundHex, '#f5f5f5');

  const state65 = EditorReducer.applyCanvasMegapixels(state, 65);
  const mp65 = VectorDocumentOps.canvasMegapixels(state65.document);
  assert.ok(mp65 >= 64.9 && mp65 <= 65.1);

  const allIds = new Set(doc.nodes.map(n => n.id));
  const origBounds = VectorDocumentOps.selectionBounds(doc, allIds);
  const scaledDoc = VectorDocumentOps.applyArtworkScalePercent(doc, 50);
  const scaledBounds = VectorDocumentOps.selectionBounds(scaledDoc, allIds);
  assert.ok(origBounds && scaledBounds);
  assert.ok(Math.abs(boundsWidth(origBounds) * 1.5 - boundsWidth(scaledBounds)) < 0.2);

  // Deactivating Multi-Select clears all selections.
  let multiState = {
    ...createEditorState(doc),
    selectedIds: new Set([doc.nodes[0].id, doc.nodes[1].id]),
    multiSelectMode: true,
  };
  multiState = EditorReducer.toggleMultiSelectMode(multiState);
  assert.equal(multiState.multiSelectMode, false);
  assert.equal(multiState.selectedIds.size, 0);

  const serialized = VectorSvgCodec.serialize(state.document);
  assert.match(serialized, /id="mv-canvas-bg"/);
  const reparsed = VectorSvgCodec.parse(serialized);
  assert.equal(reparsed.backgroundHex, '#f5f5f5');
  assert.equal(reparsed.nodes.length, 2);

  state = EditorReducer.setCanvasBackground(state, null);
  const transparentSvg = VectorSvgCodec.serialize(state.document);
  assert.doesNotMatch(transparentSvg, /id="mv-canvas-bg"/);
});

test('Pathfinder boolean engine performs Unite, Minus Front, Intersect, Exclude, and Trim accurately', () => {
  const overlapSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><path fill="#111111" fill-rule="evenodd" d="M10 10L60 10L60 60L10 60Z"/><path fill="#333333" fill-rule="evenodd" d="M40 40L90 40L90 90L40 90Z"/></svg>`;
  const doc = VectorSvgCodec.parse(overlapSvg);
  const both = new Set(doc.nodes.map(n => n.id));
  const baseState = { ...createEditorState(doc), selectedIds: both };

  // Unite -> single node inheriting top-most #333333, bounding box 10..90
  const united = EditorReducer.applyPathfinder(baseState, 'UNITE', PlanarPathBooleanEngine);
  assert.equal(united.document.nodes.length, 1);
  assert.equal(united.document.nodes[0].kind, 'path');
  assert.equal(united.document.nodes[0].fillHex, '#333333');
  const uBounds = VectorDocumentOps.boundsOf(united.document.nodes[0]);
  assert.ok(uBounds);
  assert.ok(Math.abs(uBounds.left - 10) < 0.2 && Math.abs(uBounds.right - 90) < 0.2);

  // Intersect -> single node covering 40..60
  const intersected = EditorReducer.applyPathfinder(baseState, 'INTERSECT', PlanarPathBooleanEngine);
  assert.equal(intersected.document.nodes.length, 1);
  const iBounds = VectorDocumentOps.boundsOf(intersected.document.nodes[0]);
  assert.ok(iBounds);
  assert.ok(Math.abs(iBounds.left - 40) < 0.2 && Math.abs(iBounds.right - 60) < 0.2);
  assert.ok(Math.abs(iBounds.top - 40) < 0.2 && Math.abs(iBounds.bottom - 60) < 0.2);

  // Minus Front -> inherits bottom-most #111111, point (50, 50) cut out, point (20, 20) kept
  const cut = EditorReducer.applyPathfinder(baseState, 'MINUS_FRONT', PlanarPathBooleanEngine);
  assert.equal(cut.document.nodes.length, 1);
  const cutNode = cut.document.nodes[0];
  assert.equal(cutNode.kind, 'path');
  assert.equal(cutNode.fillHex, '#111111');
  assert.equal(VectorPathOps.hitTest(cutNode.commands, 20, 20, true, true, 0, 0.1), true);
  assert.equal(VectorPathOps.hitTest(cutNode.commands, 50, 50, true, true, 0, 0.1), false);

  // Exclude -> overlap (50, 50) removed, corners (20, 20) and (80, 80) kept
  const excluded = EditorReducer.applyPathfinder(baseState, 'EXCLUDE', PlanarPathBooleanEngine);
  assert.equal(excluded.document.nodes.length, 1);
  const exNode = excluded.document.nodes[0];
  assert.equal(exNode.kind, 'path');
  assert.equal(VectorPathOps.hitTest(exNode.commands, 20, 20, true, true, 0, 0.1), true);
  assert.equal(VectorPathOps.hitTest(exNode.commands, 80, 80, true, true, 0, 0.1), true);
  assert.equal(VectorPathOps.hitTest(exNode.commands, 50, 50, true, true, 0, 0.1), false);

  // Trim -> keeps 2 nodes; bottom trimmed, top untouched
  const trimmed = EditorReducer.applyPathfinder(baseState, 'TRIM', PlanarPathBooleanEngine);
  assert.equal(trimmed.document.nodes.length, 2);
  assert.equal(trimmed.document.nodes[1], doc.nodes[1]);
  assert.equal(trimmed.document.nodes[0].kind, 'path');
  assert.equal(trimmed.document.nodes[0].fillHex, '#111111');
  assert.equal(VectorPathOps.hitTest(trimmed.document.nodes[0].commands, 50, 50, true, true, 0, 0.1), false);

  // Disjoint Intersect -> empty result notice & document preserved
  const disjoint = VectorSvgCodec.parse(sampleSvg);
  const disjointState = { ...createEditorState(disjoint), selectedIds: new Set(disjoint.nodes.map(n => n.id)) };
  const emptyIntersect = EditorReducer.applyPathfinder(disjointState, 'INTERSECT', PlanarPathBooleanEngine);
  assert.equal(emptyIntersect.document, disjoint);
  assert.equal(emptyIntersect.noticeKey, 'pathfinder_empty_result');
});

test('desktop workspace integrates vector editor UI and raw SVG/EPS export commands', async () => {
  const index = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const commands = await readFile(new URL('../src-tauri/src/commands.rs', import.meta.url), 'utf8');
  const permissions = await readFile(new URL('../src-tauri/permissions/default.toml', import.meta.url), 'utf8');

  assert.match(index, /id="openVectorEditor"/);
  assert.match(index, /id="resetVectorEdits"/);
  assert.match(index, /id="vectorEditorView"/);
  assert.doesNotMatch(index, /id="removeAssetColors"|id="applyBackgroundColor"|id="eraseMarkedObjects"|id="wireframePreview"/);
  assert.match(main, /VectorEditorController/);
  assert.match(main, /save_raw_svg/);
  assert.match(main, /save_raw_eps/);
  assert.match(commands, /pub fn save_raw_svg/);
  assert.match(commands, /pub fn save_raw_eps/);
  assert.match(permissions, /"save_raw_svg"/);
  assert.match(permissions, /"save_raw_eps"/);

  const editorTs = await readFile(new URL('../src/editor/vectorEditor.ts', import.meta.url), 'utf8');
  const editorCss = await readFile(new URL('../src/editor/editor.css', import.meta.url), 'utf8');
  assert.match(editorTs, /multiSelectMode: false/);
  assert.match(editorTs, /aria-pressed/);
  assert.match(editorCss, /#vectorEditorView button\.ve-dock-btn\.is-selected/);
});
