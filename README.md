<p align="center">
  <img src="build/icon.png" width="128" alt="Giffact icon" />
</p>

<h1 align="center">Giffact</h1>

<p align="center">
  Trace animated GIFs frame by frame with clean, pressure-sensitive vector linework, in the spirit of PaintTool SAI's linework layers, then export only the lines as PNG or SVG at any resolution.
  <br />
  <b>English</b> · <a href="README.pt-BR.md">Português (Brasil)</a>
</p>

<p align="center">
  <img src="docs/screenshots/dark-neon.png" alt="Giffact, dark theme" width="860" />
</p>

Giffact runs as a Windows desktop app (Electron) and as a plain web page. Everything happens locally: your GIFs and projects never leave your computer.

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

<p align="center">
  <img src="docs/screenshots/light.png" alt="Light theme" width="420" />
  <img src="docs/screenshots/project-menu.png" alt="Project menu" width="420" />
  <br />
  <img src="docs/screenshots/about.png" alt="About dialog" width="420" />
  <img src="docs/screenshots/japanese.png" alt="Japanese interface" width="420" />
</p>

## Download / run
**Windows:** build with `npm run dist:win` (see below). It produces:
- `dist/Giffact-1.1.1-portatil.exe`: a single portable executable with nothing to install.
- `dist/Giffact-1.1.1-win-x64.zip`: unzip it and run `Giffact.exe`. This starts faster than the portable exe.

> The executable is not code-signed, so Windows SmartScreen may warn you. Click *More info → Run anyway*.

**Web:** after `npm run build`, serve the `app/` folder with any static server (for example `npx http-server app`) and open `index.html`. On the web, exports download as a `.zip` and projects are saved as downloads.

## Development
Requires Node 20+.
```
npm install
npm run build        # bundles app/ (renderer + Electron main/preload)
npm start            # runs in Electron
npm run dist:win     # Windows x64: portable .exe + .zip in dist/
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
node test/screenshots.mjs         # regenerates docs/screenshots
```

## Links
- Author: [github.com/cleitinhodev](https://github.com/cleitinhodev)
- Website: [bugzinho.com](https://www.bugzinho.com/)
- Support the project: [bugzinho.com/donate](https://www.bugzinho.com/donate)

## License
[MIT](LICENSE) © 2026 cleitinhodev
