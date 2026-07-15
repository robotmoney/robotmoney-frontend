# Brand assets

Source-of-truth logo assets, split from the original handmade lockup on
2026-07-15. All files use `fill="currentColor"` so they recolor per register
(quartz text on night surfaces, ink on day). Never recolor the mark with
accent hues, add effects, or stretch (brand sheet rule; see
`robotmoney-context/brand/brand-sheet.md`).

| File | What | Provenance |
|---|---|---|
| `lockup.svg` | Mark + stacked ROBOT/MONEY wordmark | Byte-faithful path data from the original; potrace metadata stripped. |
| `wordmark.svg` | Wordmark alone, tight viewBox | Exact traced letterforms, isolated. Outlines, not live type; do not fake-bold or stretch. |
| `mark.svg` | Circle-and-wedge mark alone, square viewBox | Geometric reconstruction: true circle + straight wedge edges replacing bowed trace curves. Overlay-verified against the trace. Approved by Lex 2026-07-15. Use for favicons, avatars, OG images, and any new mark use. |
| `logo-trace-original.svg` | The original potrace autotrace | Kept as provenance; superseded by the files above. |

Mark geometry (viewBox 548x548): circle center (273.58, 274.3), r 273.29.
Wedge: rim vertex at -37.61deg, rim tangent tip at 90.07deg, inner vertex
(168.2, 331.9). The mark is a circle pierced by a wedge; the brand's
line-mass-point grammar derives from it.

Serving note: the static server serves `frontend/public/` only. Wiring these
into the site means copying (or referencing a copy) under
`frontend/public/assets/`; that step belongs to the implementation PRs, not
this directory.
