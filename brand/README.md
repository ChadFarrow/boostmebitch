# Brand icons

The "face in the stamp" logo: the inked stamp, with a bolt character inside it. Good twin, evil twin — one shape for both brands; the colours and the face tell them apart.

| Brand | Look |
| --- | --- |
| Boost Me Bitch | cream outline stamp, yellow bolt with angry brows and a smirk, on `#0a0a08` |
| Boost Me Buddy | solid yellow stamp, black bolt with happy eyes and an open smile, on `#0a0a08` |

The bolt is the chunky, flat-topped one from a Nano Banana exploration, redrawn as vector. Its upper half is wide on purpose: the face has to sit inside it, and the app's older thin bolt left no room for brows. Both brands use the identical bolt path.

It was checked against the Podcasting 2.0 Boostagram chapter art (a dark speech bubble split by a bolt, on pale yellow). There is no speech bubble here on purpose: the two must not be confused.

## Sources — `src/`

The masters. Text is outlined (Bricolage Grotesque 800), so nothing needs the font installed. The rough "inked" edge is an SVG filter (`feTurbulence` + `feDisplacementMap`), not baked paths.

| File | What it is | Used for |
| --- | --- | --- |
| `*-full.svg` | the stamp, full bleed | `icon.svg`, every PNG an OS or a listing shows large |
| `*-maskable.svg` | the stamp at 72% | Android adaptive icons — every corner sits inside the 40% safe-zone circle |
| `*-mark.svg` | frame + face bolt, no text, no filter | favicons; at 16–32px the lettering is noise |

The PNGs in `public/icons/{bmb,buddy}/` are rendered from these with resvg (it supports the filter; librsvg and Inkscape exports differ). A changed source means re-rendering every size, then checking the 32px favicon by eye.

## For other repos

These files are not served by this app. They are the exact files two Podcast Index repos want.

### Helipad — `Podcastindex-org/helipad`

Helipad draws a sending app's icon at max 60×60, square, no corner rounding, on a `#c4c4df` card.

1. `helipad/boostmebitch.png` and `helipad/boostmebuddy.png` → `webroot/image/`
2. Two entries in `webroot/extra/apps.json`. The key is the boostagram's `app_name` lowercased, which is `BRAND.wireName`:

   ```json
   "boostmebitch": { "icon": "boostmebitch", "url": "https://www.boostmebitch.com" },
   "boostmebuddy": { "icon": "boostmebuddy", "url": "https://www.boostmebuddy.com" }
   ```

### Podcast Index apps page — `Podcastindex-org/web-ui`

`podcastindex/boostmebitch.png` and `podcastindex/boostmebuddy.png` → the assets folder, then an entry each in `server/data/apps.json` naming the file in `appIconUrl` (PNG or JPG; schema in `server/data/apps-schema.json`).
