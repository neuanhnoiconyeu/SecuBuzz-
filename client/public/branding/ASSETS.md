# Brand asset provenance

The supplied `Yahoo! Security Messenger Logo.png` is preserved unchanged as `yahoo-security-logo-source.png`. Its SHA-256 is `9372e70e9685e419c168f26ae9ea67a82e85e043a65dcbc8b95a3c3b2e6f2226`.

| Asset | Size | Origin and use |
| --- | --- | --- |
| `yahoo-security-logo-source.png` | 1784 × 882 RGBA | Original full symbol and wordmark; use on light surfaces and preserve its aspect ratio. |
| `yahoo-security-icon.png` | 1254 × 1254 RGBA | Built-in `image_gen` reference-image edit with `transparent_background: true`; detailed isolated symbol for larger UI artwork. This is AI-assisted isolation, not a pixel-identical crop. |
| `favicon.svg` | 64 × 64 view box | Authored SVG paths and gradients simplifying the supplied chat bubble, Y!, orbital ring, signal rays, shield, and lock. No embedded raster or external font. |
| `favicon-16.png` | 16 × 16 RGBA | Deterministic Chrome canvas rendering of `favicon.svg`. |
| `favicon-32.png` | 32 × 32 RGBA | Deterministic Chrome canvas rendering of `favicon.svg`. |
| `apple-touch-icon.png` | 180 × 180 RGBA | Deterministic Chrome canvas rendering of `favicon.svg`. |

All PNGs have genuine alpha transparency, with alpha extrema 0–255. The detailed icon's alpha bounds are `(33, 41, 1222, 1228)`, preserving the complete orbital ring, rays, speech tail, and shield. The full source's alpha bounds are `(95, 23, 1680, 810)`.

`BrandLogo` uses Next.js responsive image optimization with explicit display-size hints for raster artwork. The source files above remain unchanged; browsers receive appropriately sized optimized images. Favicon URLs remain direct SVG/PNG assets.

Actual 16 px and 32 px raster previews were inspected. The purple Y!/chat shape, orbital sweep and shield remain recognizable; fine lock detail is necessarily abstract at 16 px. The full wordmark uses deep purple, so a light backing is appropriate when it appears on a dark surface. Use the SVG for crisp small-size rendering and avoid stretching any variant.

## Final raster edit prompt

Built-in tool mode was used; no fallback API/CLI or API key was used. The only reference was the supplied source logo.

```text
Use case: background-extraction / precise-object-edit.
Asset type: transparent high-resolution icon-only brand logo for Yahoo! Security Messenger 2.0.
Input image 1 is the edit target and sole source of truth. Extract ONLY the existing LEFT-HAND main emblem from the supplied logo: the purple Y! oval speech bubble with its lower-left pointed tail, the complete swooping purple orbital ring around it, the foreground purple shield with white/lilac outline and white padlock at lower-right, and the three purple signal rays above-right. Remove the vertical divider and all right-side Yahoo! Security Messenger wordmark lettering and underline. Preserve the LEFT emblem's exact recognizable geometry, proportions, gradients, glossy highlight, colors, white Y! lettering, shield and lock design; do not redesign, reinterpret, replace or invent a new emblem. Do not add any text. The only retained lettering is the original Y! INSIDE the emblem. Keep the whole orbital ring, all signal rays, speech tail and entire shield fully visible, with modest transparent padding on every edge. Center this isolated emblem on a square transparent canvas suitable for high-DPI UI icons. Use genuine alpha transparency, including around and between every shape. No white, black, checkerboard, colored rectangle, shadow background, border, extra decoration, or flattened backdrop. Keep source design faithful, clean edges and original colors.
```
