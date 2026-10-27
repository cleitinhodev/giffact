// Área de desenho: transformação de visualização (zoom/pan/rotação), renderização e eventos de ponteiro
import { S, emit, on } from './state';
import { drawFrameLayers, drawStroke } from './render';
import type { Stroke } from './types';

export interface PointerInfo {
  x: number; y: number; // doc
  sx: number; sy: number; // tela (css px, relativo ao canvas)
  pressure: number;
  pointerType: string;
  shift: boolean; ctrl: boolean; alt: boolean;
  button: number;
  time: number;
}

export interface Tool {
  cursor?: string;
  down?(p: PointerInfo): void;
  move?(p: PointerInfo, coalesced: PointerInfo[]): void;
  up?(p: PointerInfo): void;
  hover?(p: PointerInfo): void;
  dbl?(p: PointerInfo): void;
  key?(e: KeyboardEvent): boolean;
  cancel?(): void;
  deactivate?(): void;
  overlay?(ctx: CanvasRenderingContext2D): void;
  exclude?(): Set<string> | null;
  live?(): { strokes: Stroke[]; opacity: number } | null;
}

let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;
let W = 0, H = 0, dpr = 1;
let needs = true;
let getTool: () => Tool;
const linesCache = document.createElement('canvas');
let linesKey = '';
const onionCanvas = document.createElement('canvas');
let onionKey = '';
let paperPattern: CanvasPattern | null = null;

export let lastPointer: PointerInfo | null = null;
export let pointerInside = false;

export function requestRender() {
  needs = true;
}

export function initView(c: HTMLCanvasElement, toolGetter: () => Tool) {
  canvas = c;
  ctx = c.getContext('2d')!;
  getTool = toolGetter;
  const ro = new ResizeObserver(() => resize());
  ro.observe(c.parentElement!);
  resize();
  bindPointer();
  const loop = () => {
    if (needs) { needs = false; try { draw(); } catch (err) { console.error(err); } }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  on('doc', requestRender);
  on('frame', requestRender);
  on('settings', requestRender);
  on('selection', requestRender);
  on('tool', requestRender);
  on('layers', requestRender);
}

function resize() {
  const r = canvas.parentElement!.getBoundingClientRect();
  dpr = window.devicePixelRatio || 1;
  W = Math.max(1, Math.floor(r.width));
  H = Math.max(1, Math.floor(r.height));
  canvas.width = Math.floor(W * dpr);
  canvas.height = Math.floor(H * dpr);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  requestRender();
}

export function viewSize() { return { w: W, h: H }; }

/** Matriz doc -> tela (css px) */
export function viewMatrix(): DOMMatrix {
  const v = S.view;
  return new DOMMatrix()
    .translate(W / 2 + v.panX, H / 2 + v.panY)
    .rotate(v.rot)
    .scale(v.zoom)
    .translate(-S.docW / 2, -S.docH / 2);
}
export function screenToDoc(sx: number, sy: number): { x: number; y: number } {
  const p = viewMatrix().inverse().transformPoint(new DOMPoint(sx, sy));
  return { x: p.x, y: p.y };
}
export function docToScreen(x: number, y: number): { x: number; y: number } {
  const p = viewMatrix().transformPoint(new DOMPoint(x, y));
  return { x: p.x, y: p.y };
}
/** converte px de tela em px de documento */
export const px = (n: number) => n / S.view.zoom;

export function fitView() {
  if (!S.loaded) return;
  const z = Math.min((W - 40) / S.docW, (H - 40) / S.docH);
  S.view = { zoom: Math.max(0.05, z), panX: 0, panY: 0, rot: 0 };
  emit('view');
  requestRender();
}
export function setZoom(z: number, sx = W / 2, sy = H / 2) {
  z = Math.max(0.05, Math.min(64, z));
  const before = screenToDoc(sx, sy);
  S.view.zoom = z;
  const after = docToScreen(before.x, before.y);
  S.view.panX += sx - after.x;
  S.view.panY += sy - after.y;
  emit('view');
  requestRender();
}
export function setRotation(deg: number, sx = W / 2, sy = H / 2) {
  const before = screenToDoc(sx, sy);
  S.view.rot = ((deg % 360) + 540) % 360 - 180;
  const after = docToScreen(before.x, before.y);
  S.view.panX += sx - after.x;
  S.view.panY += sy - after.y;
  emit('view');
  requestRender();
}

function getPaper(): CanvasPattern {
  if (!paperPattern) {
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const g = c.getContext('2d')!;
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 16, 16);
    g.fillStyle = '#e6e6e6'; g.fillRect(0, 0, 8, 8); g.fillRect(8, 8, 8, 8);
    paperPattern = ctx.createPattern(c, 'repeat')!;
  }
  return paperPattern;
}

function ensureSize(c: HTMLCanvasElement) {
  if (c.width !== canvas.width || c.height !== canvas.height) { c.width = canvas.width; c.height = canvas.height; }
}

function draw() {
  const g = ctx;
  g.setTransform(1, 0, 0, 1, 0, 0);
  // fundo transparente: o gradiente do tema (CSS de #stage) aparece por trás
  g.clearRect(0, 0, canvas.width, canvas.height);
  if (!S.loaded) return;
  const st = S.settings;
  const M = new DOMMatrix().scale(dpr).multiply(viewMatrix());
  const scale = S.view.zoom * dpr;
  const vkey = `${M.a.toFixed(5)},${M.b.toFixed(5)},${M.c.toFixed(5)},${M.d.toFixed(5)},${M.e.toFixed(2)},${M.f.toFixed(2)},${canvas.width}x${canvas.height}`;

  // papel
  g.setTransform(M);
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.5)';
  g.shadowBlur = 12;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, S.docW, S.docH);
  g.restore();
  if (!st.bgVisible) {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, S.docW, S.docH);
  }
  // fundo GIF
  const fr = S.frames[S.cur];
  if (st.bgVisible && fr) {
    g.save();
    // fundo transparente do GIF -> xadrez
    g.fillStyle = getPaper();
    g.globalAlpha = 0.6;
    g.fillRect(0, 0, S.docW, S.docH);
    g.globalAlpha = st.bgOpacity;
    if (st.bgGray) g.filter = 'grayscale(1)';
    g.imageSmoothingEnabled = S.view.zoom < 3;
    g.imageSmoothingQuality = 'high';
    g.drawImage(fr.canvas, 0, 0);
    g.restore();
  }

  // onion skin
  if (st.onion && S.frames.length > 1) {
    ensureSize(onionCanvas);
    const okey = `${S.version}|${S.cur}|${vkey}|${st.onionPrev},${st.onionNext},${st.onionOpacity},${st.onionPrevColor},${st.onionNextColor}`;
    if (okey !== onionKey) {
      onionKey = okey;
      const oc = onionCanvas.getContext('2d')!;
      oc.setTransform(1, 0, 0, 1, 0, 0);
      oc.clearRect(0, 0, onionCanvas.width, onionCanvas.height);
      const list: { fi: number; color: string; a: number }[] = [];
      for (let k = st.onionPrev; k >= 1; k--) {
        const fi = S.cur - k;
        if (fi >= 0) list.push({ fi, color: st.onionPrevColor, a: st.onionOpacity * (1 - (k - 1) / (st.onionPrev + 1)) });
      }
      for (let k = st.onionNext; k >= 1; k--) {
        const fi = S.cur + k;
        if (fi < S.frames.length) list.push({ fi, color: st.onionNextColor, a: st.onionOpacity * (1 - (k - 1) / (st.onionNext + 1)) });
      }
      for (const it of list) {
        oc.save();
        oc.globalAlpha = it.a;
        oc.setTransform(M);
        drawFrameLayers(oc, S.docs[it.fi], { scale, tint: it.color, ignoreOpacity: true });
        oc.restore();
      }
    }
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(onionCanvas, 0, 0);
    g.restore();
  }

  // linhas do quadro atual (cache)
  const tool = getTool();
  const excl = tool.exclude?.() || null;
  ensureSize(linesCache);
  const ekey = excl ? Array.from(excl).sort().join(',') : '';
  const lkey = `${S.version}|${S.cur}|${vkey}|${ekey}`;
  if (lkey !== linesKey) {
    linesKey = lkey;
    const lc = linesCache.getContext('2d')!;
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.clearRect(0, 0, linesCache.width, linesCache.height);
    lc.setTransform(M);
    drawFrameLayers(lc, S.docs[S.cur], { scale, exclude: excl || undefined });
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.drawImage(linesCache, 0, 0);

  // traços ao vivo (sendo desenhados/editados)
  const live = tool.live?.();
  if (live && live.strokes.length) {
    g.save();
    g.setTransform(M);
    g.globalAlpha = live.opacity;
    for (const s of live.strokes) drawStroke(g, s, scale);
    g.restore();
  }

  // sobreposições da ferramenta (em coordenadas de tela css)
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  tool.overlay?.(g);
}

// ---------- ponteiro ----------
let spaceDown = false;
let rKeyDown = false;
let gesture: null | { kind: 'pan' | 'rotate'; sx: number; sy: number; panX: number; panY: number; rot: number; startAng: number } = null;
let toolActive = false;
let activePointer = -1;

export function isSpaceDown() { return spaceDown; }

function info(e: PointerEvent): PointerInfo {
  const r = canvas.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  const d = screenToDoc(sx, sy);
  let pressure = e.pressure;
  if (e.pointerType === 'mouse' || !S.settings.usePressure) pressure = 1;
  else if (pressure === 0 && e.buttons) pressure = 0.5;
  return {
    x: d.x, y: d.y, sx, sy, pressure, pointerType: e.pointerType,
    shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, button: e.button, time: e.timeStamp,
  };
}

function updateCursor() {
  if (gesture) canvas.style.cursor = gesture.kind === 'pan' ? 'grabbing' : 'alias';
  else if (spaceDown || S.tool === 'hand') canvas.style.cursor = 'grab';
  else if (rKeyDown) canvas.style.cursor = 'alias';
  else canvas.style.cursor = getTool().cursor || 'crosshair';
}
export { updateCursor };

function bindPointer() {
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    if (!S.loaded) return;
    canvas.focus();
    const p = info(e);
    lastPointer = p;
    if (activePointer !== -1 && activePointer !== e.pointerId) return;
    if (e.button === 1 || spaceDown || S.tool === 'hand' || rKeyDown || (e.button === 0 && e.altKey && e.shiftKey)) {
      const rotate = rKeyDown || (e.altKey && e.shiftKey);
      gesture = {
        kind: rotate ? 'rotate' : 'pan', sx: p.sx, sy: p.sy, panX: S.view.panX, panY: S.view.panY, rot: S.view.rot,
        startAng: Math.atan2(p.sy - H / 2 - S.view.panY, p.sx - W / 2 - S.view.panX),
      };
      try { canvas.setPointerCapture(e.pointerId); } catch { /* ponteiro sintético */ }
      activePointer = e.pointerId;
      updateCursor();
      e.preventDefault();
      return;
    }
    if (e.button !== 0 && e.button !== 2) return;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ponteiro sintético */ }
    activePointer = e.pointerId;
    toolActive = true;
    getTool().down?.(p);
    requestRender();
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!S.loaded) return;
    const p = info(e);
    lastPointer = p;
    pointerInside = true;
    if (gesture && e.pointerId === activePointer) {
      if (gesture.kind === 'pan') {
        S.view.panX = gesture.panX + (p.sx - gesture.sx);
        S.view.panY = gesture.panY + (p.sy - gesture.sy);
      } else {
        const cx = W / 2 + S.view.panX, cy = H / 2 + S.view.panY;
        const a = Math.atan2(p.sy - cy, p.sx - cx);
        let deg = gesture.rot + ((a - gesture.startAng) * 180) / Math.PI;
        if (p.shift) deg = Math.round(deg / 15) * 15;
        S.view.rot = ((deg % 360) + 540) % 360 - 180;
      }
      emit('view');
      requestRender();
      return;
    }
    if (toolActive && e.pointerId === activePointer) {
      const co = (e as any).getCoalescedEvents ? (e as any).getCoalescedEvents().map(info) : [p];
      getTool().move?.(p, co.length ? co : [p]);
    } else if (!toolActive) {
      getTool().hover?.(p);
    }
    emit('pointer');
    requestRender();
  });
  const end = (e: PointerEvent) => {
    if (e.pointerId !== activePointer) return;
    activePointer = -1;
    if (gesture) { gesture = null; updateCursor(); return; }
    if (toolActive) {
      toolActive = false;
      getTool().up?.(info(e));
      requestRender();
    }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', (e) => {
    if (e.pointerId !== activePointer) return;
    activePointer = -1;
    gesture = null;
    if (toolActive) { toolActive = false; getTool().up?.(info(e)); }
  });
  canvas.addEventListener('pointerleave', () => { pointerInside = false; requestRender(); });
  canvas.addEventListener('dblclick', (e) => {
    if (!S.loaded) return;
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const d = screenToDoc(sx, sy);
    getTool().dbl?.({ x: d.x, y: d.y, sx, sy, pressure: 1, pointerType: 'mouse', shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, button: 0, time: e.timeStamp });
    requestRender();
  });
  canvas.addEventListener('wheel', (e) => {
    if (!S.loaded) return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    if (e.altKey) {
      setRotation(S.view.rot + (dy > 0 ? 15 : -15), sx, sy);
    } else if (e.shiftKey && !e.ctrlKey) {
      S.view.panX -= dy;
      emit('view'); requestRender();
    } else {
      const f = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015));
      setZoom(S.view.zoom * f, sx, sy);
    }
  }, { passive: false });

  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (e.code === 'Space' && !spaceDown) { spaceDown = true; updateCursor(); e.preventDefault(); }
    if (e.code === 'KeyR' && !e.ctrlKey && !e.shiftKey && !e.altKey && !rKeyDown) { rKeyDown = true; updateCursor(); }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') { spaceDown = false; updateCursor(); }
    if (e.code === 'KeyR') { rKeyDown = false; updateCursor(); }
  });
  window.addEventListener('blur', () => { spaceDown = false; rKeyDown = false; updateCursor(); });
}

export function isToolActive() { return toolActive; }
