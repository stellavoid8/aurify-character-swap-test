# Test fixtures

All files are original (generated for this repo), so there are no third-party licenses.

| File | What it is | How it was made |
| --- | --- | --- |
| `exif-orientation-6.jpg` | 64×32 JPEG tagged EXIF Orientation 6 (displays as 32×64) | `sharp({ create }).jpeg().withMetadata({ orientation: 6 })` |
| `small.png` | 40×30 RGBA PNG | `sharp({ create }).png()` |
| `sample.heic` | 640×480 HEVC HEIC, `ftypheic` brand, 4.5 KB | Pillow + `pillow-heif` (libheif + x265), `quality=70` |
| `document.pdf` | Minimal one-page PDF | Hand-written |

The 4000×3000 PNG used by `tests/images.test.ts` is generated at test time rather than committed.
