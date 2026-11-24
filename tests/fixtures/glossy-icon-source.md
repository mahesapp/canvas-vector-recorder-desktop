Source: the user's attached glossy landscape/photo icon with a pink price tag.
The identical local file was `/Users/yuda/Downloads/Screenshot 2026-10-21 at 11.06.38.png`.
Original PNG SHA-256: `5d1283c410e6b646b211a9b7a8d6e28ae0d354fc9a153f994e45655ba373ab19`.
Original dimensions: 1440 × 1450. A copy is stored in `RND/tracing-quality/glossy-icon-v15/source.png`.

`glossy-icon-source.rgba.gz` contains an 8-byte header (unsigned big-endian width,
height), followed by RGBA pixels. It was resized to 381 × 384 with the production
`resizeRaster` function, without changing colors or removing the gray background.

Before the fix, production Auto returned 11 colors, cleanup 0, 111 paths and
scene error 0.0007269194569155899 / edge error 0.0021672306931506055. White
highlights merged into the background color `#e4e4e5`. The regression runs the
production Auto pipeline and checks highlight recovery, fidelity and complexity.
