# Brand icons

The "face in the stamp" logo: the inked stamp, with a bolt character inside it. Good twin, evil twin — one shape for both brands; the colours and the face tell them apart.

| Brand | Look |
| --- | --- |
| Boost Me Bitch | cream outline stamp, yellow bolt with angry brows and a smirk, on `#0a0a08` |
| Boost Me Buddy | solid yellow stamp, black bolt with happy eyes and an open smile, on `#0a0a08` |

Where the stamp is too small to read, the bolt goes alone: the installed-app icon is the face bolt by itself, and the favicon is a thick frame around it.

The bolt is the chunky, flat-topped one from a Nano Banana exploration, redrawn as vector. Its upper half is wide on purpose: the face has to sit inside it, and the app's older thin bolt left no room for brows. Both brands use the identical bolt path.

It was checked against the Podcasting 2.0 Boostagram chapter art (a dark speech bubble split by a bolt, on pale yellow). There is no speech bubble here on purpose: the two must not be confused.

## Sources — `src/`

The masters. Text is outlined (Bricolage Grotesque 800), so nothing needs the font installed. The rough "inked" edge is an SVG filter (`feTurbulence` + `feDisplacementMap`), not baked paths.

| File | What it is | Used for |
| --- | --- | --- |
| `*-app.svg` | the face bolt alone, no stamp, full bleed: yellow bolt on ink (bmb), ink bolt on a solid yellow tile (buddy) | the installed app — `icon.svg`, `icon-192/512.png`, `apple-touch-icon.png`. The stamp left a wide black band on a home screen, so the app icon drops it |
| `*-app-maskable.svg` | the same at 0.82 scale | `icon-192/512-maskable.png` — every bolt corner sits inside Android's 40% safe-zone circle |
| `*-full.svg` | the stamp, full bleed | the Helipad and Podcast Index PNGs below, where the stamp's lettering names the app |
| `*-maskable.svg` | the stamp at 72% | not shipped; kept as the stamp's safe-zone reference |
| `*-mark.svg` | thick frame + large face bolt, no inner frame, no text, no filter | favicons (`favicon.svg`, `favicon-32.png`); at 16–32px the inner frame and lettering turn to grey noise, so the tab icon is simplified and the frame style alone carries the brand |
| `*-header.svg` | frame + face bolt, cropped tight, transparent | `public/icons/*/header-mark.svg`, the desktop header (34px, `sm:` and up; phones keep the plain bolt) |

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
