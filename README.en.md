<p align="center">
  <img src="build/icon.png" width="128" alt="Giffact icon" />
</p>

<h1 align="center">Giffact</h1>

<p align="center">
  Trace animated GIFs frame by frame with clean, pressure-sensitive vector linework, in the spirit of PaintTool SAI's linework layers, then export only the lines as PNG or SVG at any resolution.
  <br />
  <b>English</b> · <a href="README.md">Português (Brasil)</a>
</p>

<p align="center">
  <img src="docs/screenshots/dark-neon.png" alt="Giffact, dark theme" width="860" />
</p>

Giffact runs as a desktop app for Windows and Linux (Electron) and as a plain web page. Everything happens locally: your GIFs and projects never leave your computer.

## Features
- **Open GIF** (button, `Ctrl+O` or drag and drop). PNG, JPG and WebP open as a single frame. Disposal methods, partial frames, transparency and per-frame delays are decoded correctly.
- **Timeline** with every frame. It scrolls horizontally, uses virtualized thumbnails and stays smooth with hundreds of frames.
- **Per-frame layers:** add, delete, rename, reorder, hide, lock and set opacity. "+ all" creates a layer in every frame.
- **Vector linework tools** (SAI-like):

  | Key | Tool | What it does |
  |---|---|---|
  | `C` | **Curve** | Click to place points and the curve flows smoothly through them. **Right-click** (or `Backspace`) goes back to the previous point and keeps the same curve going; `Enter` or double-click finishes; clicking the 1st point (or `Shift+Enter`) closes it; `Esc` cancels. |
  | `L` | **Straight line** | Like the curve, with straight segments (right-click also goes back one point). `Shift` snaps to 15° steps. |
  | `B` | **Pen** | Freehand with a **stabilizer** (`Shift+[ ]`). It becomes an editable curve when you release. |
  | `N` | **Edit points** | Drag points, drag the line to insert a point, `Alt+click` to delete one, `Ctrl+drag` to move the whole stroke. |
  | `W` | **Weight** | Drag over a stroke to make the whole stroke thicker or thinner. |
  | `U` | **Pressure** | Change the thickness only at one point. |
  | `K` | **Color** | Click a stroke to apply the current color. |
  | `E` | **Vector eraser** | Whole stroke, **up to the intersection** (like SAI) or area. |
  | `V` | **Selection** | Move, scale and rotate with handles. `Delete` removes the selection. |
  | `H` | **Hand** | Pan the view (or hold `Space`, or use the middle mouse button). |

- **Pen tablets:** pressure is recorded per point through Pointer Events (Wacom, Huion, XP-Pen, Surface, …), with automatic taper at the start and end of each stroke.
- **Onion skin**, **copy lines** from the previous or next frame (`Alt+←/→`), and **copy to a range of frames** (`Ctrl+Shift+V`).
- **Undo/redo per frame**, plus zoom, pan and **canvas rotation**.
- **Animated preview** (`P`) at the GIF timing or a custom FPS.
- **Auto-trace (experimental):** an edge-detected sketch of the frame as editable curves on its own layer.
- **Export** (`Ctrl+E`):
  - PNG or SVG, at any scale (2×, 4×, …) or an exact width/height.
  - Transparent, white or colored background, with or without the GIF underneath.
  - Choose which layers and frames to include.
- **Projects** (`Ctrl+S`): `.giffact` files with the GIF embedded. Older `.gifline`/`.json` projects from GIF Linework still open.

## What's new in 1.1.1
- Curve and Line tools: **right-click now goes back to the previous point** and keeps the line in progress instead of finishing it. Finish with `Enter` or a double-click.

## What's new in 1.1
- New name and icon: **Giffact**.
- **Project** menu: New, Open, Save (`Ctrl+S`), Save as (`Ctrl+Shift+S`), and Export PNG/SVG.
- **Dark theme** with a navy/indigo/violet gradient and subtle animated neon lavender streaks around the edges (never over the canvas), plus a lavender/white **light theme**. Both follow the system theme by default.
- **Neon animation toggle**: animations respect `prefers-reduced-motion` and pause when the window is hidden.
- **10 languages**: English, Português (Brasil), Español, Français, Deutsch, Italiano, 日本語, 中文（简体）, 한국어 and Русский. The language follows your system by default and can be changed in the 🌐 menu.
- **Help** (how-to and keyboard shortcuts) and **About** dialogs.

## Screenshots
<table>
  <tr>
    <td align="center" width="50%"><img src="docs/screenshots/onion-skin.png" alt="Onion skin" /><br /><sub><b>Onion skin</b>: previous frame in red, next in blue</sub></td>
    <td align="center" width="50%"><img src="docs/screenshots/edit-points.png" alt="Edit points tool" /><br /><sub><b>Edit points</b>: every curve stays editable</sub></td>
  </tr>
  <tr>
    <td align="center" width="50%"><img src="docs/screenshots/export.png" alt="Export dialog" /><br /><sub><b>Export</b> PNG/SVG at any scale</sub></td>
    <td align="center" width="50%"><img src="docs/screenshots/lines-example.png" alt="Exported lines at 2x" /><br /><sub>The result: only the lines, exported at 2× (960×960)</sub></td>
  </tr>
  <tr>
    <td align="center" width="50%"><img src="docs/screenshots/preview.png" alt="Animated preview" /><br /><sub><b>Animated preview</b> of the traced frames</sub></td>
    <td align="center" width="50%"><img src="docs/screenshots/light.png" alt="Light theme" /><br /><sub><b>Light theme</b></sub></td>
  </tr>
  <tr>
    <td align="center" width="50%"><img src="docs/screenshots/project-menu.png" alt="Project menu" /><br /><sub><b>Project</b> menu</sub></td>
    <td align="center" width="50%"><img src="docs/screenshots/about.png" alt="About dialog" /><br /><sub><b>About</b></sub></td>
  </tr>
  <tr>
    <td align="center" width="50%"><img src="docs/screenshots/japanese.png" alt="Japanese interface" /><br /><sub>10 languages (here: 日本語)</sub></td>
    <td align="center" width="50%"><img src="docs/screenshots/pt-BR.png" alt="Portuguese interface, light theme" /><br /><sub>Português (Brasil), light theme</sub></td>
  </tr>
</table>

## Download
Grab the latest build from the **[Releases page](https://github.com/cleitinhodev/giffact/releases/latest)**. Every release lists SHA-256 checksums in `SHA256SUMS.txt`.

| System | File | How to run |
|---|---|---|
| Windows 10/11 x64 | `Giffact-1.1.1-windows-portable.exe` | A single portable executable with nothing to install. Just run it. |
| Windows 10/11 x64 | `Giffact-1.1.1-windows-x64.zip` | Unzip it and run `Giffact.exe`. This starts faster than the portable exe. |
| Linux x64 (any distro) | `Giffact-1.1.1-linux-x86_64.AppImage` | `chmod +x Giffact-1.1.1-linux-x86_64.AppImage` and run it. |
| Debian / Ubuntu / Mint | `Giffact-1.1.1-linux-amd64.deb` | `sudo apt install ./Giffact-1.1.1-linux-amd64.deb`, then open Giffact from the app menu (Graphics). |
| Linux x64 (manual) | `Giffact-1.1.1-linux-x64.tar.gz` | Extract it and run `./giffact` inside the folder. |

> **Windows:** the executable is not code-signed, so SmartScreen may warn you. Click *More info → Run anyway*.
>
> **Linux:** AppImages need FUSE 2. If it doesn't start, install `libfuse2` (`libfuse2t64` on Ubuntu 24.04+), or run it with `--appimage-extract-and-run`.

**Web:** after `npm run build`, serve the `app/` folder with any static server (for example `npx http-server app`) and open `index.html`. On the web, exports download as a `.zip` and projects are saved as downloads.

## Development
Requires Node 20+.
```
npm install
npm run build        # bundles app/ (renderer + Electron main/preload)
npm start            # runs in Electron
npm run dist:win     # Windows x64: portable .exe + .zip in dist/
npm run dist:linux   # Linux x64: AppImage + .deb + .tar.gz in dist/
```

## Tests
Browser tests use `playwright-core` with a local Chrome/Chromium. Electron tests on Linux need `xvfb-run`.
```
npm run typecheck
npm run test:i18n                 # 10 languages: key/placeholder parity, locale detection, pseudo-locale scan, de/ru/ja/zh/ko layouts
npm test                          # drawing, editing, eraser, layers, auto-trace, export (PNG/SVG), projects, pen pressure
npm run test:features             # Project menu, themes, neon animations, language switching, Help/About links
npm run test:layout               # 300/600 frames at 1280×720, 1920×1080 and 1024×600
xvfb-run -a npm run test:electron
xvfb-run -a npm run test:features:electron
xvfb-run -a npm run test:layout:electron
xvfb-run -a npm run test:linux   # packaged Linux build: opens a GIF, draws, exports PNG (pass an .AppImage path to test it)
node test/screenshots.mjs [project.giffact | animation.gif]   # regenerates docs/screenshots (built-in demo GIF if no file is given)
```

## Links
- Author: [github.com/cleitinhodev](https://github.com/cleitinhodev)
- Website: [bugzinho.com](https://www.bugzinho.com/)
- Support the project: [bugzinho.com/donate](https://www.bugzinho.com/donate)

## License
[MIT](LICENSE) © 2026 cleitinhodev
