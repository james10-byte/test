# Smart Icon Generator

Source: `backend/src/icons/iconGenerator.js`. Tests: `tests/iconGenerator.test.js`.

## Pipeline

1. The file is checked by signature (PNG, JPEG or WebP), by size and by pixel count before decoding. The extension is never used.
2. Sharp decodes it with `failOn: error` and a pixel limit. EXIF orientation is applied. The image becomes sRGB with an alpha channel and is downscaled to at most 2048 pixels on its longest side. It is never stretched.
3. Every output is rendered from that normalized copy with Lanczos resampling. Resizing and lossy conversion are not lossless, and the generator does not claim they are.
4. The resources are written into the generated Android project and referenced by its manifest. The preview endpoint runs the same functions.

## Settings

`scale` (0.1 to 1) and `padding` (0 to 0.4) set the artwork size: the content box is `(1 - 2 x padding) x scale` of the canvas. `offsetX` and `offsetY` move the artwork by a fraction of the canvas and are clamped so it stays inside. `fit: contain` keeps the whole image, `cover` fills the content box and crops. `background` is a color or `transparent`; when it is transparent the adaptive icon uses `adaptiveBackground`.

## Generated resources

| Resource | Sizes | Notes |
| --- | --- | --- |
| `mipmap-<density>/ic_launcher.png` and `ic_launcher_round.png` | mdpi 48, hdpi 72, xhdpi 96, xxhdpi 144, xxxhdpi 192 | The round file is masked to a circle. |
| `mipmap-<density>/ic_launcher_foreground.png` | 108dp canvas: 108, 162, 216, 324, 432 | Transparent canvas, artwork limited to the 66dp safe zone so launcher masks do not crop it. |
| `mipmap-<density>/ic_launcher_monochrome.png` | same as foreground | Themed icon for Android 13 and newer. |
| `mipmap-anydpi-v26/ic_launcher.xml` and `ic_launcher_round.xml` | | Adaptive icon with background color, foreground and monochrome layers. |
| `values/ic_launcher_background.xml` | | The adaptive background color. |

The manifest of the template references `@mipmap/ic_launcher` and `@mipmap/ic_launcher_round`; a test checks that these match what the generator produces.

## Monochrome rule

Deterministic and documented: if the source has transparency, the silhouette keeps its alpha and every pixel becomes black. If the source is opaque, opacity is derived from darkness (`alpha x (255 - luminance) / 255`), so dark shapes become opaque and light backgrounds transparent. Android recolors the result.

## Not verified

No installed APK has been inspected on a device or emulator, so the final on-device appearance of the icon is unconfirmed.
