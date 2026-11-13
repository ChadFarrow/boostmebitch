# Brand icons

The "face in the stamp" logo: the inked stamp, with a bolt character inside it. Good twin, evil twin — one shape for both brands; the colours and the face tell them apart.

| Brand | Look |
| --- | --- |
| Boost Me Bitch | cream outline stamp, yellow bolt with angry brows and a smirk, on `#0a0a08` |
| Boost Me Buddy | yellow outline stamp, yellow bolt with happy eyes and an open smile in ink, on `#0a0a08` |

Where the stamp is too small to read, the lettering goes: the installed-app icon is the face bolt by itself, and the favicon is a thick frame around it.

Buddy had a solid yellow tile (ink bolt, cream face) until the owner saw it on the site: on the dark pages it was the brightest thing there. Every Buddy file now uses the header mark's colours — yellow on ink, with the face in ink: the yellow outline frame on the favicon, the header mark and the stamp, and the bolt alone on the app icon, as on bmb.

The bolt is the chunky, flat-topped one from a Nano Banana exploration, redrawn as vector. Its upper half is wide on purpose: the face has to sit inside it, and the app's older thin bolt left no room for brows. Both brands use the identical bolt path.

It was checked against the Podcasting 2.0 Boostagram chapter art (a dark speech bubble split by a bolt, on pale yellow). There is no speech bubble here on purpose: the two must not be confused.

## Sources — `src/`

The masters. Text is outlined (Bricolage Grotesque 800), so nothing needs the font installed. The rough "inked" edge is an SVG filter (`feTurbulence` + `feDisplacementMap`), not baked paths.

| File | What it is | Used for |
| --- | --- | --- |
| `*-app.svg` | the yellow face bolt alone on ink, no stamp, no frame, full bleed — the same shape on both brands | the installed app — `icon.svg`, `icon-192/512.png`, `apple-touch-icon.png`. The stamp left a wide black band on a home screen, so the app icon drops it |
| `*-app-maskable.svg` | the same at 0.82 scale | `icon-192/512-maskable.png` — every bolt corner sits inside Android's 40% safe-zone circle |
| `*-full.svg` | the stamp, full bleed | the Helipad and Podcast Index PNGs below, where the stamp's lettering names the app |
| `*-maskable.svg` | the stamp at 72% | not shipped; kept as the stamp's safe-zone reference |
| `*-mark.svg` | thick frame + large yellow face bolt on ink, no inner frame, no text, no filter: a cream frame (bmb), a yellow frame (buddy) — the header mark's colours, drawn heavier | favicons (`favicon.svg`, `favicon-32.png`); at 16–32px the inner frame and lettering turn to grey noise, so the tab icon is simplified and the frame colour alone carries the brand |
| `*-header.svg` | outline frame filled with ink + yellow face bolt, cropped tight: a cream frame (bmb), a yellow frame (buddy) | `public/icons/*/header-mark.svg`, the desktop header (34px, `sm:` and up; phones keep the plain bolt). The ink fill is for the light theme — an `<img>` cannot follow the theme tokens, so a transparent frame vanished on the cream header |

**`icon-512.png` is read by three things outside this app**: the site kind:0 `picture` (`scripts/publish-site-profile.mjs`), the TWA `iconUrl` (`android/twa-manifest*.json`) and the Zapstore `icon` (`zapstore*.yaml`). Changing the picture keeps its URL; renaming or moving the file blanks the site's avatar on every Nostr client until `npm run publish:site-profile` and `publish:site-profile:buddy` run again, and the Android app and Zapstore listing until their next publish.

The PNGs in `public/icons/{bmb,buddy}/` are rendered from these with resvg (it supports the filter; librsvg and Inkscape exports differ). `@resvg/resvg-js` 2.6.2 with `fitTo: { mode: 'width' }` reproduces the shipped bmb PNGs pixel for pixel, so use that version. A changed source means re-rendering every size, then checking the 32px favicon by eye.

## For other repos

These files are not served by this app. They are the exact files two Podcast Index repos want.

### Helipad — `Podcastindex-org/helipad`

Helipad draws a sending app's icon at max 60×60, square, no corner rounding, on a `#c4c4df` card. **It does not read the Podcast Index apps list** — it serves its own static `webroot/extra/apps.json` — so each list needs its own PR.

1. `helipad/boostmebitch.png` and `helipad/boostmebuddy.png` → `webroot/image/`
2. Two entries in `webroot/extra/apps.json`. The key is the boostagram's `app_name` lowercased, which is `BRAND.wireName`. **Lowercase is required**: `webroot/script/helipad.js` looks up `appList[boostApp.toLowerCase()]`, so a key with a capital letter never matches and the boost shows `unknown.png` (the `"StableKraft"` and `"ITDV App"` keys did, until Podcastindex-org/helipad#164):

   ```json
   "boostmebitch": { "icon": "boostmebitch", "url": "https://www.boostmebitch.com" },
   "boostmebuddy": { "icon": "boostmebuddy", "url": "https://www.boostmebuddy.com" }
   ```

### Podcast Index apps page — `Podcastindex-org/web-ui`

`podcastindex/boostmebitch.png` and `podcastindex/boostmebuddy.png` → `server/assets/`, then an entry each in `server/data/apps.json` naming the file in `appIconUrl` (PNG or JPG; schema in `server/data/apps-schema.json`, which CI validates). Both entries list the same `supportedElements`, because both deploys run the same code; when the app gains or drops a Podcasting 2.0 element, change both. Edit the 4,500-line file as text — re-serializing it rewrites every other app's entry.
