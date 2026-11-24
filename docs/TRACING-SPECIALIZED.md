# Geometry, pixel grids and gradient paints

The tracing engine now recognizes additional geometry, detects pixel-art grids,
and reconstructs opaque linear/radial gradient paints. All three mechanisms are
enabled by default. Geometry and gradient reconstruction require smoothing;
pixel-grid reconstruction preserves its horizontal/vertical edges independently.
`geometry: false`, `pixelArt: false` and `gradients: false` disable the respective
mechanisms through `TraceOptions`. Existing UI controls and output dimensions
remain applicable. The persisted Auto recommendation revision is 3.

## Geometry

`geometry-shapes.ts` recognizes:

- Closed polygons with 3–12 supported straight sides.
- Rotated rounded rectangles and capsules, serialized as lines and cubic arcs.
- Open circular arcs with both shared-junction coordinates fixed.

Recognition works on the existing measured contour points. It does not replace
regions independently or move shared junctions. Polygon/rounding fits have
maximum measured deviations around 0.6–0.65 px and RMS limits around 0.24–0.25 px.
Candidates enter the existing coverage-energy, complexity and intersection
checks in `finishCurves`. A recognition is counted only when accepted.

## Pixel art

`pixel-grid.ts` analyzes horizontal and vertical edge profiles before palette
reduction. It requires repeated boundaries on both axes, compatible periods,
high edge alignment and nearly constant cell interiors. The current detector
handles a regular grid, including fractional positions from resizing; it does
not reconstruct an arbitrarily warped grid.

Each cell receives its interior modal color. The existing perceptual quantizer
limits the palette to the requested color count. Boundary walking merges
collinear edges; all contours of one color are combined using nonzero winding.
This preserves disconnected components and transparent holes without adding
overlapping seam strokes. White-background flood removal and removal of all
white cells remain distinct operations.

Detection requires dimensions of at least 24 px, a cell period of 2.5–96 px,
at least six cells on each axis and at most 65,536 cells. Existing Auto/export
complexity limits still apply to the resulting vector. Cell boundaries remain
sharp; the pixel-grid path intentionally retains grid cells instead of applying
the ordinary speck cleanup to them.

## Gradient reconstruction and evaluation

`gradient-trace.ts` separates connected, smoothly varying source fields and
fits opaque two-stop paints. Linear fitting considers 24 axes; concentric radial
fitting optimizes center and saturation radius. A paint must explain at least
88% of the field's variation, satisfy a per-channel RMS bound of 4/255, and
avoid coherent unexplained detail. Nearby fields supply evidence for antialias
mixtures. A contrasting isolated accent vetoes a proposal instead of being
painted over.

The shape engine traces an encoded field raster; gradient coordinates remain
in the original image's user space. The final SVG is evaluated against the
unchanged original RGBA. Practically exact specialized results can return
directly. Other candidates must improve scene error by at least 2%, pass the
existing edge/detail/tile gate and stay within the segment-growth budget.
Optional proposal failures preserve the ordinary tracing path and are counted.

The current reconstruction limit is one megapixel and at most 16 major fields,
also bounded by the requested palette count. New paints use two opaque stops;
the shared renderer/export subset supports up to 32 strictly increasing stops.
Arbitrary meshes, transparency gradients, focal/elliptical radial gradients and
SVG filter effects are outside this implementation. Unsupported source patterns
continue through the ordinary flat-color tracer.

`gradient-paint.ts` owns paint parsing, interpolation and serialization.
`svg-paths.ts`, `scene-quality.ts`, browser export layout, palette-limit handling
and EPS export all use that representation. The evaluator samples gradient
colors in the same user space as each path and retains winding, alpha-error
and clip evaluation. Gradient outputs bypass the flat-color seam underpaint.

## Desktop and EPS

Desktop validation accepts only generated local gradient definitions and stops,
requires finite coordinates and ordered opaque hex colors, and rejects missing,
external and duplicate references. SVG exports retain editable definitions.

Both the TypeScript EPS serializer and Rust SVG/EPS paths emit clipped PostScript
LanguageLevel 3 axial/radial shading dictionaries with exponential or stitching
functions. They preserve artwork scaling and clip domains; they do not rasterize
the artwork. These operators follow Adobe's
[PostScript Language Reference, third edition](https://www.adobe.com/jp/print/postscript/pdfs/PLRM.pdf),
sections on shading dictionaries and functions.

Global export color limits count gradient stop colors. If a result exceeds the
limit, only the export copy is retraced with gradients disabled and the requested
flat palette limit; the saved editor result is retained.

## Validation and reproducible review

```sh
npm run compile
node --test tests/tracing-specialized.test.mjs tests/stock-export.test.mjs
cargo test --manifest-path src-tauri/Cargo.toml --lib
node tests/tracing-specialized-quality.mjs
```

The audit writes source PNGs, before/after SVGs, vector EPS files, measurements
and a comparison page to `build/specialized-tracing/`. Its baseline is the same
production engine with `geometry`, `pixelArt` and `gradients` disabled. Inputs
are identical; timing is a single run rather than a performance benchmark.

Measured examples:

| Working input | Before | After |
| --- | --- | --- |
| Rounded rectangle, 96×64 | 16 segments; error 0.000054821 | 12 segments; error 0.000020513 |
| Pixel art, 64×64 | 64 paths; 7,593 SVG bytes | 3 compound paths; 1,734 bytes; identical color coverage |
| Linear gradient, 64×64 | 8 paths; 42 segments | 1 path; 4 segments; error 0.000000956 |
| Radial gradient, 64×64 | 8 paths; 27 segments | 1 path; 4 segments; error 0.000000592 |
| Antialiased gradient object, 64×64 | 6 paths; 24 segments | 2 paths; 8 segments; error 0.000003716 |

Frozen walnut, doodle and barong working rasters at a maximum side of 128 px
retained their scene error, path counts, segment counts and SVG size. These
examples do not establish quality for every image or prove behavior at every
resolution.

The known unrelated frontend startup test still expects a PNG landing logo while
the baseline HTML uses SVG. No startup, licensing or branding code is changed.
