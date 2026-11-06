# Self-hosted typography sources

The application bundles the official Google Fonts files at revision
`24ddc1f324cac5d9f5aedca126d298f56e3f1640` of
[`google/fonts`](https://github.com/google/fonts/tree/24ddc1f324cac5d9f5aedca126d298f56e3f1640).
Both families are distributed under **SIL Open Font License 1.1**. Their complete
copyright notices and licenses are included in each family directory as `OFL.txt`;
the original upstream `METADATA.pb` files are included for attribution and coverage.

The deployed application also serves unchanged copies of both complete license
texts and a provenance notice, without duplicating the font binaries:

- `/fonts/licenses/Bungee-OFL.txt`
- `/fonts/licenses/Space-Grotesk-OFL.txt`
- `/fonts/licenses/NOTICE.txt`

Both TTF name tables contain a short OFL statement and license URL in name IDs
13/14, rather than the complete license. The public text files preserve access
to the full terms alongside the generated font distribution.

| Family | Asset | Bytes | Application weights |
| --- | --- | ---: | --- |
| Bungee | `bungee/Bungee-Regular.ttf` | 118,996 | Regular 400 only |
| Space Grotesk | `spacegrotesk/SpaceGrotesk-Variable.ttf` | 136,676 | Variable 400–700 |

The binary files are unmodified. Only Space Grotesk's filename is normalized from
the upstream `SpaceGrotesk[wght].ttf` to avoid Windows wildcard-path handling.
Its original weight axis is 300–700, with default 300; the application declares
400–700 in its font face. Bungee has no variable axis or additional supplied weight.
Do not synthesize bold Bungee.

`src/app/fonts.ts` loads both files once through `next/font/local`, using
`font-display: swap`, Next.js fallback metrics, and the CSS variables
`--font-bungee` / `--font-space-grotesk`. The root layout applies those variable
classes; semantic typography roles live in `src/styles/typography.css`.
Fonts are served from the application's generated static assets. Builds and
page loads require no Google Fonts or other font-CDN request.

The official family directories publish these complete TTFs, rather than WOFF2
assets. Keeping them intact avoids a font-conversion dependency and preserves all
published glyphs instead of retaining only a Latin subset. Upstream metadata lists
Latin, Latin Extended, and Vietnamese. Direct character-map inspection confirmed
Latin `A`, Latin Extended `Ł`, and Vietnamese `ế` in both fonts; CJK `星` and emoji
`👋` are outside these font files. The configured fallback stack includes system UI,
Segoe UI, Arial, Noto Sans CJK SC, Microsoft YaHei, and Apple/Segoe/Noto emoji fonts.
Those fallback glyphs depend on fonts installed on the user's device.

## Integrity and provenance

`SOURCES.json` records pinned download URLs, sizes, SHA-256 checksums, actual weight
axes, and sample glyph coverage. `UPSTREAM_REVISION.txt` records the same revision.

| Asset | SHA-256 |
| --- | --- |
| Bungee Regular TTF | `c4f5361ce120af3e6b9156d0bf379fa19cda2ea0cd18ac01fd99596c6bf66e3f` |
| Space Grotesk variable TTF | `acad6de1fc93436f5c0f1f4137751ef04f1aea3063e7036535970ffcfbd79f72` |
| Bungee OFL | `d5787a50dde5be6c6daecab9ed459939b1bc37cff0d0e00257eaf1ec2cf4c16c` |
| Space Grotesk OFL | `564ce565c371c5e5bbf286006565a7c9aa55a9f56e7ca58d56e05d649dd61a72` |

Official sources:

- [Bungee source and metadata](https://github.com/google/fonts/tree/24ddc1f324cac5d9f5aedca126d298f56e3f1640/ofl/bungee)
- [Space Grotesk source and metadata](https://github.com/google/fonts/tree/24ddc1f324cac5d9f5aedca126d298f56e3f1640/ofl/spacegrotesk)
- [Bungee license](https://github.com/google/fonts/blob/24ddc1f324cac5d9f5aedca126d298f56e3f1640/ofl/bungee/OFL.txt)
- [Space Grotesk license](https://github.com/google/fonts/blob/24ddc1f324cac5d9f5aedca126d298f56e3f1640/ofl/spacegrotesk/OFL.txt)
