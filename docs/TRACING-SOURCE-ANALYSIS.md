# Source-aware tracing candidates

The October 25, 2026 implementation adapts three mechanisms investigated in the
supplied browser vectorizer: source noise evidence, colored two-ink evidence,
and bounded local residual correction. It uses the existing shared-boundary
engine. It does not bundle Potrace or ImageTracer.

## Source evidence and label coherence

`source-analysis.ts` measures luminance range in opaque 5×5 windows. A ratio
above 0.25 between mildly varying windows and edge windows proposes a noisy
artwork candidate, provided enough edge evidence exists. This heuristic is not
a JPEG format detector and can also identify noise from other sources.

The candidate sets `TraceOptions.noiseCleanup`. It grows reliable labels into
flat pixels that are ambiguous between two nearby palette colors. Source RGBA
is unchanged. Exact colors, alpha, protected detail and crisp boundaries stay
anchored; local foreground/background connectivity checks guard each relabel.
Other region cleanup remains in the existing pipeline.

The two-ink candidate accepts arbitrary colored inks and their antialias
mixtures. At least 98.5% of stable samples must be near the ink endpoints.
Coherent off-axis third colors, including a two-pixel accent, veto the candidate.
Broad gradients fail the endpoint test. The two-ink candidate uses at most
0.35 px tolerance with area cleanup disabled.

Auto retains the ordinary candidates, then adds at most one candidate of each
kind. Specialized candidates must improve the selection score while preserving
source error and passing the existing detail/edge/tile gate. Ties retain the
ordinary result. A selected two-color approximation is checked again against
the full working raster when the suggested palette has more than two colors,
so a disappearing preview accent cannot authorize the approximation.

The Auto recommendation cache revision is now 2. Manual controls do not enable
either option automatically. `sourceNoisy` and `twoTone` recommendation fields
describe evidence at the detector's sampling resolution, which can differ from
the selector's preview resolution.

## Local residual correction

`scene-defects.ts` groups unusually bad 16×16 residual tiles. It excludes
insignificant errors and errors covering more than 35% of the raster, then
retains at most four areas. These bounds are residual measurements, not labels
such as missing object or incorrect color.

`TraceOptions.localRefinement` retains the measured contour samples and cuts.
After the existing global fitting passes, it proposes tighter fits for at most
12 shared chains touching those areas. Existing corners and chain endpoints
remain anchors. Curve count, source-contour distance and sampled
self-intersection checks reject unsafe proposals before scene evaluation.

No patch paths are overlaid. The region graph, palette and loop references
remain unchanged. A candidate must reduce the selected tiles' combined error
by more than 15%, preserve global/detail/edge error, satisfy the existing tile
gate and avoid increasing other tiles by more than 0.002 raw squared-error
units. Segment growth is bounded by 25% plus eight segments.

Auto offers one optional local attempt only for eligible final rasters with
4,096–1,048,576 pixels, at most 6,000 segments, localized residuals and an
available attempt in its existing bounded budget. Failure retains the completed
trace; cancellation still propagates. The exported candidate is scored again
by Auto. Local refinement can conservatively reject all proposals on a source.

Diagnostics: `noiseScore`, `coherentLabelPixels`, `localDefectAreas`,
`localRefitChains`, and `localRefitAccepted`.

## Validation

`tests/source-analysis.test.mjs` covers noise evidence, colored antialias,
two-pixel accents, gradients, source immutability, connectivity, alpha, holes,
protected pixels, full-raster rechecking, local residual grouping and safe
rejection of local proposals. Existing Auto selector tests account for the
additional measured candidate while retaining baseline/tie behavior.

Reproduce the paired audit with:

```sh
node tests/tracing-source-quality.mjs HEAD 128
```

Run it before committing, or replace `HEAD` with the pre-change revision. It
compares the old and new production Auto pipelines on identical working rasters
with white removal explicitly disabled. Output SVGs and metrics are written to
`build/source-analysis-audit/`. Timing is a single run, not a speed benchmark.

At a maximum working side of 128 px, sparkle, walnut, doodle, barong and the
synthetic colored logo retained the same error and segment counts. Synthetic
noisy two-color art improved source error from 0.0000999353 to 0.0000769123
(23.0%) and edge error from 0.0000983396 to 0.0000759924, with eight segments
and two paths retained. That improvement came from the measured two-ink
candidate; it is not evidence of a general improvement on photographic inputs.
No local refit was accepted on these six audit inputs.

The pre-existing frontend startup test expects a PNG landing logo, while the
baseline HTML uses SVG. This unrelated test remains unchanged; startup HTML,
licensing and brand assets are outside this implementation.

## Subsequent implementation

Additional geometry, grid-aware pixel art, opaque gradient paints, and the SVG,
evaluator and EPS changes are now implemented. See
[specialized tracing](TRACING-SPECIALIZED.md) for their scope and validation.
Selective upsampling is still outside these changes.
