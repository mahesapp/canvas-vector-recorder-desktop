# Walnut contour regression

`walnut-contour-source.rgba.gz` contains the 512 × 512 original walnut image
from mini-vectorizer's `tests/assets/curve-cleanup/walnut-original.png`.
`walnut-contour-upscale.rgba.gz` contains the existing 1024 × 1024 bitmap from
`walnut-upscale.png` in the same mini-vectorizer fixture directory. Both images
are frozen; no AI preprocessing runs in these tests.

The uncompressed bytes are two big-endian unsigned 32-bit dimensions followed
by RGBA bytes. Java ImageIO decoded the source without resizing. Gzip keeps the
fixture small and allows Node's standard library to read it without a browser,
JDK or image decoding dependency.

The positive production regression uses 8 colors, tolerance 3.2, cleanup 96,
smoothing and background white removal on the 2× bitmap. It checks that bounded
cleanup is accepted, reduces curvature chatter, preserves protected detail, and
reports the measured SVG error. The original 512 px source uses tolerance 1.6
and cleanup 24 and exercises rejection of an unsafe candidate. Geometry tests independently measure the symmetric deviation guard,
corner/endpoints, small glyphs and narrow strokes.
