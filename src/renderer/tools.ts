// Ferramentas de desenho e edição vetorial (estilo camada de Linework do PaintTool SAI)
import { S, activeLayer, emit, markChanged, pushUndo, replaceStrokes, toast, hooks } from './state';
import type { Layer, Pt, Stroke, ToolId } from './types';
import {
  fitCurve, getSamples, intersectionsAlong, sliceSamples, strokeBounds, strokeDistance,
  strokeFromPiece, transformStroke, uid,
} from './geom';
import { docToScreen, px, requestRender, type PointerInfo, type Tool } from './view';
import { t } from './i18n';

// ---------------- utilidades ----------------
function editableLayer(silent = false): Layer | null {
  const L = activeLayer();
  if (!L) return null;
  if (L.locked) { if (!silent) toast(t('toast.activeLocked'), 'warn'); return null; }
  if (!L.visible) { if (!silent) toast(t('toast.activeHidden'), 'warn'); return null; }
  return L;
}

const sampleScale = () => S.view.zoom * (window.devicePixelRatio || 1);

interface Hit { stroke: Stroke; i: number; t: number; d: number }
function hitStroke(p: { x: number; y: number }, tolPx = 6, L = activeLayer()): Hit | null {
  if (!L) return null;
  const tol = px(tolPx);
  let best: Hit | null = null;
  for (let k = L.strokes.length - 1; k >= 0; k--) {
    const s = L.strokes[k];
    const sm = getSamples(s, sampleScale());
    if (p.x < sm.minX - tol || p.x > sm.maxX + tol || p.y < sm.minY - tol || p.y > sm.maxY + tol) continue;
    const r = strokeDistance(sm, p.x, p.y);
    if (r.d <= tol && (!best || r.d < best.d - 1e-6)) {
      best = { stroke: s, i: r.i, t: r.t, d: r.d };
      if (r.d <= 0) break; // dentro do traço mais acima
    }
  }
  return best;
}

interface PtHit { stroke: Stroke; idx: number; d: number }
function hitPoint(p: { x: number; y: number }, tolPx = 8, L = activeLayer()): PtHit | null {
  if (!L) return null;
  const tol = px(tolPx);
  let best: PtHit | null = null;
  for (let k = L.strokes.length - 1; k >= 0; k--) {
    const s = L.strokes[k];
    s.pts.forEach((q, idx) => {
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d <= tol && (!best || d < best.d)) best = { stroke: s, idx, d };
    });
  }
  return best;
}

function newStroke(kind: 'curve' | 'line', pts: Pt[], closed = false): Stroke {
  const st = S.settings;
  return {
    id: uid(), kind, pts, closed, width: st.width, color: st.color,
    taperStart: closed ? 0 : st.taperStart, taperEnd: closed ? 0 : st.taperEnd,
  };
}

function commitAdd(L: Layer, s: Stroke) {
  pushUndo();
  L.strokes = L.strokes.concat([s]);
  markChanged();
}
function commitReplace(L: Layer, map: Map<string, Stroke | null>) {
  if (!map.size) return;
  pushUndo();
  replaceStrokes(L, map);
  for (const [id, s] of map) if (!s) S.selection.delete(id);
  markChanged();
  emit('selection');
}

function pressureToP(pr: number): number {
  const m = S.settings.minPressure;
  return m + (1 - m) * Math.max(0, Math.min(1, pr));
}

// ------ desenho de sobreposições ------
function drawHandle(g: CanvasRenderingContext2D, x: number, y: number, size: number, fill: string, stroke = '#1b1b1f', round = false) {
  const s = docToScreen(x, y);
  g.beginPath();
  if (round) g.arc(s.x, s.y, size / 2, 0, Math.PI * 2);
  else g.rect(s.x - size / 2, s.y - size / 2, size, size);
  g.fillStyle = fill; g.fill();
  g.lineWidth = 1; g.strokeStyle = stroke; g.stroke();
}
function drawCenterline(g: CanvasRenderingContext2D, s: Stroke, color: string, width = 1.5) {
  const sm = getSamples(s, sampleScale());
  g.beginPath();
  for (let i = 0; i < sm.n; i++) {
    const q = docToScreen(sm.xs[i], sm.ys[i]);
    if (i === 0) g.moveTo(q.x, q.y); else g.lineTo(q.x, q.y);
  }
  g.lineWidth = width; g.strokeStyle = color; g.lineJoin = 'round'; g.stroke();
}
function drawControlPolygon(g: CanvasRenderingContext2D, s: Stroke, color: string) {
  g.beginPath();
  s.pts.forEach((q, i) => {
    const a = docToScreen(q.x, q.y);
    if (i === 0) g.moveTo(a.x, a.y); else g.lineTo(a.x, a.y);
  });
  if (s.closed) g.closePath();
  g.setLineDash([3, 3]); g.lineWidth = 1; g.strokeStyle = color; g.stroke(); g.setLineDash([]);
}
function drawBrushCursor(g: CanvasRenderingContext2D, p: PointerInfo | null, radiusDoc: number, color = 'rgba(0,0,0,0.6)') {
  if (!p) return;
  const r = radiusDoc * S.view.zoom;
  g.beginPath(); g.arc(p.sx, p.sy, Math.max(r, 1), 0, Math.PI * 2);
  g.lineWidth = 1; g.strokeStyle = 'rgba(255,255,255,0.8)'; g.stroke();
  g.beginPath(); g.arc(p.sx, p.sy, Math.max(r - 1, 0.5), 0, Math.PI * 2);
  g.strokeStyle = color; g.stroke();
}
let hoverP: PointerInfo | null = null;

// =====================================================================
// Caneta à mão livre com estabilizador
// =====================================================================
class PenTool implements Tool {
  cursor = 'crosshair';
  raw: Pt[] = [];
  active = false;
  lx = 0; ly = 0; // posição "preguiçosa"
  ex = 0; ey = 0; // suavização exponencial
  ep = 1;
  layer: Layer | null = null;

  down(p: PointerInfo) {
    this.layer = editableLayer();
    if (!this.layer) return;
    this.active = true;
    this.lx = this.ex = p.x; this.ly = this.ey = p.y;
    this.ep = pressureToP(p.pressure);
    this.raw = [{ x: p.x, y: p.y, p: this.ep }];
  }
  move(_p: PointerInfo, co: PointerInfo[]) {
    if (!this.active) return;
    const S_ = S.settings.stabilizer;
    const R = px(S_ * 1.1);
    const a = 1 / (1 + S_ * 0.3);
    for (const q of co) {
      const dx = q.x - this.lx, dy = q.y - this.ly;
      const d = Math.hypot(dx, dy);
      if (d > R) {
        const k = (d - R) / d;
        this.lx += dx * k; this.ly += dy * k;
      }
      this.ex += (this.lx - this.ex) * a;
      this.ey += (this.ly - this.ey) * a;
      this.ep += (pressureToP(q.pressure) - this.ep) * Math.min(1, a * 1.5);
      const last = this.raw[this.raw.length - 1];
      if (Math.hypot(this.ex - last.x, this.ey - last.y) >= px(0.6)) {
        this.raw.push({ x: this.ex, y: this.ey, p: this.ep });
      }
    }
  }
  up() {
    if (!this.active || !this.layer) return;
    this.active = false;
    let pts: Pt[];
    if (this.raw.length < 2) {
      pts = [this.raw[0]];
    } else {
      pts = fitCurve(this.raw, px(0.55));
    }
    const s = newStroke('curve', pts);
    if (pts.length === 1) { s.taperStart = 0; s.taperEnd = 0; }
    commitAdd(this.layer, s);
    this.raw = [];
  }
  cancel() { this.active = false; this.raw = []; }
  hover(p: PointerInfo) { hoverP = p; }
  live() {
    if (!this.active || !this.layer) return null;
    const s = newStroke('line', this.raw);
    return { strokes: [s], opacity: this.layer.opacity };
  }
  overlay(g: CanvasRenderingContext2D) {
    if (!this.active) drawBrushCursor(g, hoverP, S.settings.width / 2);
    else if (S.settings.stabilizer > 0 && hoverP) {
      // fio do estabilizador
    }
  }
}

// =====================================================================
// Curva (clique para pontos) e Linha (polilinha reta)
// =====================================================================
class PointsTool implements Tool {
  cursor = 'crosshair';
  pts: Pt[] = [];
  hov: { x: number; y: number } | null = null;
  layer: Layer | null = null;
  lastDownT = 0;
  constructor(public kind: 'curve' | 'line') {}

  private snap(p: PointInfoLike): { x: number; y: number } {
    if (this.kind === 'line' && p.shift && this.pts.length) {
      const l = this.pts[this.pts.length - 1];
      const dx = p.x - l.x, dy = p.y - l.y;
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * (Math.PI / 12);
      const d = Math.hypot(dx, dy);
      return { x: l.x + Math.cos(ang) * d, y: l.y + Math.sin(ang) * d };
    }
    return { x: p.x, y: p.y };
  }
  private nearFirst(p: { x: number; y: number }) {
    return this.pts.length >= 3 && S.settings.closeCurveSnap && Math.hypot(p.x - this.pts[0].x, p.y - this.pts[0].y) <= px(8);
  }
  down(p: PointerInfo) {
    if (p.button === 2) { this.finish(false); return; }
    if (!this.pts.length) {
      this.layer = editableLayer();
      if (!this.layer) return;
    }
    const q = this.snap(p);
    if (this.nearFirst(q)) { this.finish(true); return; }
    const last = this.pts[this.pts.length - 1];
    if (last && Math.hypot(q.x - last.x, q.y - last.y) <= px(4)) {
      // clique repetido no último ponto (ou duplo clique) termina
      if (p.time - this.lastDownT < 500 || this.pts.length >= 2) { this.finish(false); }
      return;
    }
    this.lastDownT = p.time;
    this.pts.push({ x: q.x, y: q.y, p: pressureToP(p.pressure) });
    this.hov = q;
  }
  move(p: PointerInfo) { this.hov = this.snap(p); hoverP = p; }
  hover(p: PointerInfo) { this.hov = this.snap(p); hoverP = p; }
  dbl() { this.finish(false); }
  finish(closed: boolean) {
    if (this.layer && this.pts.length >= 2) {
      const s = newStroke(this.kind, this.pts.slice(), closed);
      commitAdd(this.layer, s);
    } else if (this.layer && this.pts.length === 1) {
      // ponto único vira um "ponto"
      const s = newStroke(this.kind, this.pts.slice());
      s.taperStart = 0; s.taperEnd = 0;
      commitAdd(this.layer, s);
    }
    this.pts = [];
    this.layer = null;
    requestRender();
  }
  cancel() { this.pts = []; this.layer = null; requestRender(); }
  deactivate() { this.finish(false); }
  key(e: KeyboardEvent): boolean {
    if (!this.pts.length) return false;
    if (e.key === 'Enter') { this.finish(e.shiftKey); return true; }
    if (e.key === 'Escape') { this.cancel(); return true; }
    if (e.key === 'Backspace' || (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey)) {
      this.pts.pop();
      if (!this.pts.length) this.layer = null;
      requestRender();
      return true;
    }
    return false;
  }
  live() {
    if (!this.pts.length || !this.layer) return null;
    const pts = this.pts.slice();
    const closing = this.hov && this.nearFirst(this.hov);
    if (this.hov && !closing) pts.push({ x: this.hov.x, y: this.hov.y, p: pts[pts.length - 1].p });
    const s = newStroke(this.kind, pts, !!closing);
    return { strokes: [s], opacity: this.layer.opacity };
  }
  overlay(g: CanvasRenderingContext2D) {
    if (!this.pts.length) { drawBrushCursor(g, hoverP, S.settings.width / 2); return; }
    const closing = this.hov && this.nearFirst(this.hov);
    const tmp = { ...newStroke(this.kind, this.pts), closed: false };
    drawControlPolygon(g, tmp, 'rgba(40,140,255,0.7)');
    this.pts.forEach((q, i) => drawHandle(g, q.x, q.y, i === 0 && closing ? 11 : 7, i === 0 ? (closing ? '#ffd23f' : '#9fd0ff') : '#ffffff'));
  }
}
type PointInfoLike = { x: number; y: number; shift: boolean };

// =====================================================================
// Editar (pontos de controle)
// =====================================================================
class EditTool implements Tool {
  cursor = 'default';
  mode: 'none' | 'point' | 'whole' | 'insert' = 'none';
  orig: Stroke | null = null;
  cur: Stroke | null = null;
  idx = -1;
  sx = 0; sy = 0; startX = 0; startY = 0;
  moved = false;
  hoverPt: PtHit | null = null;
  hoverStroke: Stroke | null = null;
  insertAt: { idx: number; pt: Pt } | null = null;
  layer: Layer | null = null;

  hover(p: PointerInfo) {
    hoverP = p;
    this.hoverPt = hitPoint(p);
    this.hoverStroke = this.hoverPt ? this.hoverPt.stroke : hitStroke(p)?.stroke || null;
  }
  down(p: PointerInfo) {
    this.layer = editableLayer();
    if (!this.layer) return;
    this.moved = false;
    this.startX = p.x; this.startY = p.y;
    const ph = hitPoint(p);
    if (ph && p.alt) {
      // Alt+clique: apaga o ponto
      const s = ph.stroke;
      const map = new Map<string, Stroke | null>();
      if (s.pts.length <= 2) map.set(s.id, null);
      else map.set(s.id, { ...s, pts: s.pts.filter((_, i) => i !== ph.idx), closed: s.closed && s.pts.length > 3 });
      commitReplace(this.layer, map);
      this.hoverPt = null;
      return;
    }
    if (ph && !p.ctrl) {
      this.mode = 'point'; this.orig = ph.stroke; this.idx = ph.idx; this.cur = ph.stroke;
      return;
    }
    const h = hitStroke(p);
    if (h) {
      this.orig = h.stroke; this.cur = h.stroke;
      if (p.ctrl) { this.mode = 'whole'; return; }
      // clique em um trecho: insere ponto se arrastar
      const sm = getSamples(h.stroke, sampleScale());
      const seg = sm.seg[h.i];
      const i2 = Math.min(h.i + 1, sm.n - 1);
      const pt: Pt = {
        x: sm.xs[h.i] + (sm.xs[i2] - sm.xs[h.i]) * h.t,
        y: sm.ys[h.i] + (sm.ys[i2] - sm.ys[h.i]) * h.t,
        p: sm.ps[h.i] + (sm.ps[i2] - sm.ps[h.i]) * h.t,
      };
      this.insertAt = { idx: seg + 1, pt };
      this.mode = 'insert';
      return;
    }
    this.mode = 'none';
  }
  move(p: PointerInfo) {
    hoverP = p;
    if (!this.orig || this.mode === 'none') return;
    const dx = p.x - this.startX, dy = p.y - this.startY;
    if (!this.moved && Math.hypot(dx, dy) < px(2)) return;
    this.moved = true;
    const o = this.orig;
    if (this.mode === 'point') {
      const pts = o.pts.map((q, i) => (i === this.idx ? { ...q, x: q.x + dx, y: q.y + dy } : q));
      this.cur = { ...o, pts };
    } else if (this.mode === 'whole') {
      this.cur = transformStroke(o, [1, 0, 0, 1, dx, dy], false);
    } else if (this.mode === 'insert' && this.insertAt) {
      const pts = o.pts.slice();
      const ip = this.insertAt.pt;
      pts.splice(this.insertAt.idx, 0, { x: ip.x + dx, y: ip.y + dy, p: ip.p });
      this.cur = { ...o, pts };
    }
  }
  up() {
    if (this.layer && this.orig && this.cur && this.moved && this.cur !== this.orig) {
      commitReplace(this.layer, new Map([[this.orig.id, this.cur]]));
    }
    this.mode = 'none'; this.orig = null; this.cur = null; this.insertAt = null;
  }
  dbl(p: PointerInfo) {
    // duplo clique em um trecho insere ponto
    const L = editableLayer(true);
    if (!L) return;
    if (hitPoint(p)) return;
    const h = hitStroke(p);
    if (!h) return;
    const sm = getSamples(h.stroke, sampleScale());
    const seg = sm.seg[h.i];
    const pts = h.stroke.pts.slice();
    pts.splice(seg + 1, 0, { x: sm.xs[h.i], y: sm.ys[h.i], p: sm.ps[h.i] });
    commitReplace(L, new Map([[h.stroke.id, { ...h.stroke, pts }]]));
  }
  cancel() { this.mode = 'none'; this.orig = null; this.cur = null; }
  exclude() { return this.orig && this.moved ? new Set([this.orig.id]) : null; }
  live() {
    if (!this.orig || !this.moved || !this.cur || !this.layer) return null;
    return { strokes: [this.cur], opacity: this.layer.opacity };
  }
  overlay(g: CanvasRenderingContext2D) {
    const L = activeLayer();
    if (!L || !L.visible) return;
    const editing = this.orig && this.moved ? this.cur : null;
    const hs = editing || this.hoverStroke;
    if (hs) { drawCenterline(g, hs, 'rgba(40,140,255,0.9)'); drawControlPolygon(g, hs, 'rgba(40,140,255,0.5)'); }
    if (S.settings.showPoints) {
      for (const s of L.strokes) {
        const ss = editing && s.id === this.orig!.id ? editing : s;
        for (let i = 0; i < ss.pts.length; i++) {
          const isHov = this.hoverPt && this.hoverPt.stroke.id === s.id && this.hoverPt.idx === i;
          drawHandle(g, ss.pts[i].x, ss.pts[i].y, isHov ? 10 : 6, isHov ? '#ffd23f' : (i === 0 ? '#9fd0ff' : '#ffffff'));
        }
      }
    }
  }
}

// =====================================================================
// Espessura (traço inteiro)
// =====================================================================
class WeightTool implements Tool {
  cursor = 'ew-resize';
  orig: Stroke | null = null;
  cur: Stroke | null = null;
  sx = 0; moved = false;
  hov: Stroke | null = null;
  layer: Layer | null = null;
  hover(p: PointerInfo) { hoverP = p; this.hov = hitStroke(p)?.stroke || null; }
  down(p: PointerInfo) {
    this.layer = editableLayer();
    if (!this.layer) return;
    const h = hitStroke(p);
    if (!h) return;
    this.orig = h.stroke; this.cur = h.stroke; this.sx = p.sx; this.moved = false;
  }
  move(p: PointerInfo) {
    hoverP = p;
    if (!this.orig) return;
    const dx = p.sx - this.sx;
    if (!this.moved && Math.abs(dx) < 3) return;
    this.moved = true;
    const w = Math.max(0.1, Math.min(500, this.orig.width * Math.exp(dx / 120)));
    this.cur = { ...this.orig, width: Math.round(w * 100) / 100 };
  }
  up() {
    if (!this.orig || !this.layer) return;
    const res = this.moved ? this.cur! : { ...this.orig, width: S.settings.width };
    if (res.width !== this.orig.width) commitReplace(this.layer, new Map([[this.orig.id, res]]));
    this.orig = null; this.cur = null;
  }
  cancel() { this.orig = null; this.cur = null; }
  exclude() { return this.orig && this.moved ? new Set([this.orig.id]) : null; }
  live() { return this.orig && this.moved && this.cur ? { strokes: [this.cur], opacity: this.layer!.opacity } : null; }
  overlay(g: CanvasRenderingContext2D) {
    const s = (this.moved && this.cur) || this.hov;
    if (s) {
      drawCenterline(g, s, 'rgba(40,140,255,0.8)', 1);
      if (hoverP) label(g, hoverP.sx + 14, hoverP.sy - 10, `${s.width.toFixed(1)} px`);
    }
  }
}

function label(g: CanvasRenderingContext2D, x: number, y: number, text: string) {
  g.font = '12px system-ui, sans-serif';
  const w = g.measureText(text).width + 10;
  g.fillStyle = 'rgba(20,20,24,0.85)';
  g.fillRect(x, y - 14, w, 20);
  g.fillStyle = '#fff';
  g.fillText(text, x + 5, y + 1);
}

// =====================================================================
// Pressão (espessura por ponto)
// =====================================================================
class PressureTool implements Tool {
  cursor = 'ns-resize';
  orig: Stroke | null = null;
  cur: Stroke | null = null;
  idx = -1; sy = 0; moved = false;
  hovPt: PtHit | null = null;
  hov: Stroke | null = null;
  layer: Layer | null = null;
  hover(p: PointerInfo) {
    hoverP = p;
    this.hovPt = hitPoint(p, 10);
    this.hov = this.hovPt?.stroke || hitStroke(p)?.stroke || null;
  }
  private pick(p: PointerInfo): PtHit | null {
    const ph = hitPoint(p, 10);
    if (ph) return ph;
    const h = hitStroke(p);
    if (!h) return null;
    const sm = getSamples(h.stroke, sampleScale());
    const seg = sm.seg[h.i];
    const n = h.stroke.pts.length;
    const a = h.stroke.pts[seg], b = h.stroke.pts[(seg + 1) % n];
    const x = sm.xs[h.i], y = sm.ys[h.i];
    const idx = !b || Math.hypot(a.x - x, a.y - y) <= Math.hypot(b.x - x, b.y - y) ? seg : (seg + 1) % n;
    return { stroke: h.stroke, idx, d: 0 };
  }
  down(p: PointerInfo) {
    this.layer = editableLayer();
    if (!this.layer) return;
    const ph = this.pick(p);
    if (!ph) return;
    if (p.alt) {
      const pts = ph.stroke.pts.map((q, i) => (i === ph.idx ? { ...q, p: 1 } : q));
      commitReplace(this.layer, new Map([[ph.stroke.id, { ...ph.stroke, pts }]]));
      return;
    }
    this.orig = ph.stroke; this.cur = ph.stroke; this.idx = ph.idx; this.sy = p.sy; this.moved = false;
    S.selection = new Set([ph.stroke.id]);
    emit('selection');
  }
  move(p: PointerInfo) {
    hoverP = p;
    if (!this.orig) return;
    const dy = this.sy - p.sy;
    if (!this.moved && Math.abs(dy) < 2) return;
    this.moved = true;
    const base = this.orig.pts[this.idx].p;
    const np = Math.max(0.02, Math.min(4, base + dy / 80));
    const pts = this.orig.pts.map((q, i) => {
      if (i === this.idx) return { ...q, p: np };
      if (p.shift) return q;
      return q;
    });
    this.cur = { ...this.orig, pts };
  }
  up() {
    if (this.orig && this.cur && this.moved && this.layer) commitReplace(this.layer, new Map([[this.orig.id, this.cur]]));
    this.orig = null; this.cur = null;
  }
  cancel() { this.orig = null; this.cur = null; }
  exclude() { return this.orig && this.moved ? new Set([this.orig.id]) : null; }
  live() { return this.orig && this.moved && this.cur ? { strokes: [this.cur], opacity: this.layer!.opacity } : null; }
  overlay(g: CanvasRenderingContext2D) {
    const s = (this.moved && this.cur) || this.hov;
    if (!s) return;
    drawCenterline(g, s, 'rgba(40,140,255,0.7)', 1);
    s.pts.forEach((q, i) => {
      const isH = (this.orig && this.idx === i) || (this.hovPt && this.hovPt.stroke.id === s.id && this.hovPt.idx === i);
      const r = Math.max(4, Math.min(30, q.p * 7));
      drawHandle(g, q.x, q.y, r, isH ? '#ffd23f' : 'rgba(255,255,255,0.85)', '#1b1b1f', true);
    });
    if (this.orig && this.moved && hoverP) label(g, hoverP.sx + 14, hoverP.sy - 10, `pressão ${Math.round(this.cur!.pts[this.idx].p * 100)}%`);
  }
}

// =====================================================================
// Cor
// =====================================================================
class ColorTool implements Tool {
  cursor = 'pointer';
  map = new Map<string, Stroke | null>();
  active = false;
  hov: Stroke | null = null;
  layer: Layer | null = null;
  hover(p: PointerInfo) { hoverP = p; this.hov = hitStroke(p)?.stroke || null; }
  down(p: PointerInfo) {
    const h = hitStroke(p);
    if (p.alt || p.button === 2) {
      if (h) { S.settings.color = h.stroke.color; emit('settings'); }
      return;
    }
    this.layer = editableLayer();
    if (!this.layer) return;
    this.active = true;
    this.map = new Map();
    this.apply(p);
  }
  apply(p: PointerInfo) {
    const h = hitStroke(p);
    if (h && h.stroke.color !== S.settings.color && !this.map.has(h.stroke.id)) {
      this.map.set(h.stroke.id, { ...h.stroke, color: S.settings.color });
    }
  }
  move(p: PointerInfo) { hoverP = p; if (this.active) this.apply(p); }
  up() {
    if (this.active && this.layer) commitReplace(this.layer, this.map);
    this.active = false; this.map = new Map();
  }
  cancel() { this.active = false; this.map = new Map(); }
  exclude() { return this.map.size ? new Set(this.map.keys()) : null; }
  live() {
    if (!this.map.size || !this.layer) return null;
    return { strokes: Array.from(this.map.values()).filter(Boolean) as Stroke[], opacity: this.layer.opacity };
  }
  overlay(g: CanvasRenderingContext2D) {
    if (this.hov) drawCenterline(g, this.hov, S.settings.color, 2);
  }
}

// =====================================================================
// Borracha vetorial
// =====================================================================
class EraserTool implements Tool {
  cursor = 'none';
  active = false;
  removed = new Set<string>();
  undoPushed = false;
  layer: Layer | null = null;
  lastP: { x: number; y: number } | null = null;

  hover(p: PointerInfo) { hoverP = p; }
  down(p: PointerInfo) {
    this.layer = editableLayer();
    if (!this.layer) return;
    this.active = true;
    this.removed = new Set();
    this.undoPushed = false;
    this.lastP = null;
    this.apply(p);
  }
  move(p: PointerInfo, co: PointerInfo[]) {
    hoverP = p;
    if (!this.active) return;
    for (const q of co) this.apply(q);
  }
  private radius() { return px(S.settings.eraserSize / 2); }
  private ensureUndo() {
    if (!this.undoPushed) { pushUndo(); this.undoPushed = true; }
  }
  apply(p: PointerInfo) {
    const L = this.layer!;
    const mode = S.settings.eraserMode;
    if (mode === 'stroke') {
      const R = this.radius();
      // varre também o segmento desde o último ponto
      const pts = [p];
      if (this.lastP) {
        const d = Math.hypot(p.x - this.lastP.x, p.y - this.lastP.y);
        const n = Math.ceil(d / Math.max(R, 0.5));
        for (let i = 1; i < n; i++) pts.push({ ...p, x: this.lastP.x + ((p.x - this.lastP.x) * i) / n, y: this.lastP.y + ((p.y - this.lastP.y) * i) / n });
      }
      this.lastP = { x: p.x, y: p.y };
      for (const s of L.strokes) {
        if (this.removed.has(s.id)) continue;
        const sm = getSamples(s, sampleScale());
        for (const q of pts) {
          if (q.x < sm.minX - R || q.x > sm.maxX + R || q.y < sm.minY - R || q.y > sm.maxY + R) continue;
          if (strokeDistance(sm, q.x, q.y).d <= R) { this.removed.add(s.id); break; }
        }
      }
    } else if (mode === 'intersect') {
      const h = hitStroke(p, Math.max(4, S.settings.eraserSize / 2));
      if (!h) return;
      this.ensureUndo();
      const res = cutAtIntersections(L, h.stroke, p);
      replaceStrokes(L, new Map([[h.stroke.id, null]]));
      L.strokes = L.strokes.concat(res);
      S.selection.delete(h.stroke.id);
      markChanged();
    } else {
      const R = this.radius();
      const from = this.lastP;
      this.lastP = { x: p.x, y: p.y };
      let changed = false;
      const map = new Map<string, Stroke | null>();
      const add: Stroke[] = [];
      for (const s of L.strokes) {
        const sm = getSamples(s, sampleScale());
        if (p.x < sm.minX - R - 50 && from === null) continue;
        const res = eraseArea(s, sm, p, from, R);
        if (res) {
          map.set(s.id, null);
          add.push(...res);
          changed = true;
        }
      }
      if (changed) {
        this.ensureUndo();
        replaceStrokes(L, map);
        L.strokes = L.strokes.concat(add);
        markChanged();
      }
    }
  }
  up() {
    if (this.active && this.layer && S.settings.eraserMode === 'stroke' && this.removed.size) {
      const map = new Map<string, Stroke | null>();
      for (const id of this.removed) map.set(id, null);
      commitReplace(this.layer, map);
    }
    this.active = false; this.removed = new Set(); this.lastP = null;
  }
  cancel() { this.active = false; this.removed = new Set(); }
  exclude() { return this.removed.size ? this.removed : null; }
  overlay(g: CanvasRenderingContext2D) {
    if (S.settings.eraserMode === 'intersect') {
      if (hoverP) {
        const h = hitStroke(hoverP, Math.max(4, S.settings.eraserSize / 2));
        if (h && this.layer !== undefined) {
          const L = activeLayer();
          if (L) {
            const pieces = previewCut(L, h);
            if (pieces) {
              g.save();
              g.beginPath();
              for (let i = 0; i < pieces.length; i++) {
                const q = docToScreen(pieces[i].x, pieces[i].y);
                if (i === 0) g.moveTo(q.x, q.y); else g.lineTo(q.x, q.y);
              }
              g.lineWidth = Math.max(4, h.stroke.width * S.view.zoom + 4);
              g.lineCap = 'round'; g.lineJoin = 'round';
              g.strokeStyle = 'rgba(255,60,90,0.55)';
              g.stroke();
              g.restore();
            }
          }
        }
      }
      drawBrushCursor(g, hoverP, px(Math.max(4, S.settings.eraserSize / 2)), 'rgba(255,60,90,0.9)');
    } else {
      drawBrushCursor(g, hoverP, px(S.settings.eraserSize / 2), 'rgba(255,60,90,0.9)');
    }
  }
}

function locate(sm: ReturnType<typeof getSamples>, x: number, y: number): number {
  const r = strokeDistance(sm, x, y);
  const i2 = Math.min(r.i + 1, sm.n - 1);
  return sm.cum[r.i] + (sm.cum[i2] - sm.cum[r.i]) * r.t;
}

/** Encontra o trecho [a,b] (comprimento ao longo do traço) entre os cruzamentos vizinhos ao ponto clicado */
function computeCut(L: Layer, s: Stroke, at: { x: number; y: number }) {
  const sc = Math.max(sampleScale(), 1);
  const sm = getSamples(s, sc);
  const Lpos = locate(sm, at.x, at.y);
  const raw: number[] = [];
  for (const o of L.strokes) {
    if (o.id === s.id) continue;
    raw.push(...intersectionsAlong(sm, getSamples(o, sc)));
  }
  raw.push(...intersectionsAlong(sm, sm, true));
  const params = raw.filter((v) => v > 1e-3 && v < sm.total - 1e-3).sort((x, y) => x - y);
  let a = 0, b = sm.total;
  for (const v of params) { if (v < Lpos - 1e-6) a = v; else if (v > Lpos + 1e-6) { b = v; break; } }
  if (s.closed && params.length) {
    if (a === 0) a = params[params.length - 1] - sm.total; // dá a volta
    if (b === sm.total) b = params[0] + sm.total;
  }
  return { sm, a, b, params };
}

function cutAtIntersections(L: Layer, s: Stroke, at: { x: number; y: number }): Stroke[] {
  const { sm, a, b, params } = computeCut(L, s, at);
  const out: Stroke[] = [];
  if (!params.length) return out; // sem cruzamentos: apaga o traço inteiro
  if (s.closed) {
    const T = sm.total;
    let pts: Pt[];
    if (a < 0) pts = sliceSamples(sm, b, T + a);
    else if (b > T) pts = sliceSamples(sm, b - T, a);
    else pts = sliceSamples(sm, b, T).concat(sliceSamples(sm, 0, a).slice(1));
    const ns = strokeFromPiece(s, pts, false, false);
    if (ns) out.push(ns);
    return out;
  }
  if (a > 0.01) {
    const ns = strokeFromPiece(s, sliceSamples(sm, 0, a), true, false);
    if (ns) out.push(ns);
  }
  if (b < sm.total - 0.01) {
    const ns = strokeFromPiece(s, sliceSamples(sm, b, sm.total), false, true);
    if (ns) out.push(ns);
  }
  return out;
}

function previewCut(L: Layer, h: Hit): Pt[] | null {
  if (!hoverP) return null;
  const { sm, a, b, params } = computeCut(L, h.stroke, hoverP);
  if (!params.length) return sliceSamples(sm, 0, sm.total);
  const T = sm.total;
  if (a < 0) return sliceSamples(sm, T + a, T).concat(sliceSamples(sm, 0, b));
  if (b > T) return sliceSamples(sm, a, T).concat(sliceSamples(sm, 0, b - T));
  return sliceSamples(sm, a, b);
}

/** Apaga a parte do traço dentro do círculo (ou da cápsula from->p). Retorna null se não tocou. */
function eraseArea(s: Stroke, sm: ReturnType<typeof getSamples>, p: { x: number; y: number }, from: { x: number; y: number } | null, R: number): Stroke[] | null {
  const ax = from ? from.x : p.x, ay = from ? from.y : p.y;
  const minx = Math.min(ax, p.x) - R, maxx = Math.max(ax, p.x) + R, miny = Math.min(ay, p.y) - R, maxy = Math.max(ay, p.y) + R;
  if (sm.maxX < minx || sm.minX > maxx || sm.maxY < miny || sm.minY > maxy) return null;
  const inside = new Uint8Array(sm.n);
  let any = false;
  for (let i = 0; i < sm.n; i++) {
    const d = from ? distSeg(sm.xs[i], sm.ys[i], ax, ay, p.x, p.y) : Math.hypot(sm.xs[i] - p.x, sm.ys[i] - p.y);
    if (d <= R) { inside[i] = 1; any = true; }
  }
  if (!any) return null;
  // corre os trechos fora
  const runs: [number, number][] = [];
  let st = -1;
  for (let i = 0; i < sm.n; i++) {
    if (!inside[i] && st < 0) st = i;
    if ((inside[i] || i === sm.n - 1) && st >= 0) {
      const end = inside[i] ? i - 1 : i;
      if (end > st) runs.push([st, end]);
      st = -1;
    }
  }
  if (s.closed && runs.length >= 2 && runs[0][0] === 0 && runs[runs.length - 1][1] === sm.n - 1) {
    // junta o último com o primeiro
    const first = runs.shift()!;
    const last = runs.pop()!;
    const pts = toPts(sm, last[0], last[1]).concat(toPts(sm, first[0], first[1]).slice(1));
    const ns = strokeFromPiece(s, pts, false, false);
    const out: Stroke[] = ns ? [ns] : [];
    for (const r of runs) { const x = strokeFromPiece(s, toPts(sm, r[0], r[1]), false, false); if (x) out.push(x); }
    return out;
  }
  const out: Stroke[] = [];
  for (const r of runs) {
    const x = strokeFromPiece(s, toPts(sm, r[0], r[1]), r[0] === 0 && !s.closed, r[1] === sm.n - 1 && !s.closed);
    if (x) out.push(x);
  }
  return out;
}
function toPts(sm: ReturnType<typeof getSamples>, a: number, b: number): Pt[] {
  const out: Pt[] = [];
  for (let i = a; i <= b; i++) out.push({ x: sm.xs[i], y: sm.ys[i], p: sm.ps[i] });
  return out;
}
function distSeg(px_: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const L = dx * dx + dy * dy;
  let t = L > 0 ? ((px_ - ax) * dx + (py - ay) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px_ - (ax + dx * t), py - (ay + dy * t));
}

// =====================================================================
// Seleção / Transformação
// =====================================================================
type Handle = 'tl' | 'tr' | 'bl' | 'br' | 't' | 'b' | 'l' | 'r' | 'rot';
class SelectTool implements Tool {
  cursor = 'default';
  mode: 'none' | 'marquee' | 'move' | 'scale' | 'rotate' | 'maybe' = 'none';
  start = { x: 0, y: 0 };
  cur = { x: 0, y: 0 };
  startS = { x: 0, y: 0 };
  handle: Handle | null = null;
  box: { x: number; y: number; w: number; h: number } | null = null;
  origs: Stroke[] = [];
  live_: Stroke[] = [];
  matrix: number[] = [1, 0, 0, 1, 0, 0];
  additive = false;
  layer: Layer | null = null;
  pendingHit: Stroke | null = null;

  private selBox() {
    const sel = activeLayer()?.strokes.filter((s) => S.selection.has(s.id)) || [];
    return sel.length ? strokeBounds(sel, sampleScale()) : null;
  }
  private handles(b: { x: number; y: number; w: number; h: number }): [Handle, number, number][] {
    const { x, y, w, h } = b;
    const off = px(22);
    return [
      ['tl', x, y], ['tr', x + w, y], ['bl', x, y + h], ['br', x + w, y + h],
      ['t', x + w / 2, y], ['b', x + w / 2, y + h], ['l', x, y + h / 2], ['r', x + w, y + h / 2],
      ['rot', x + w / 2, y - off],
    ];
  }
  hover(p: PointerInfo) { hoverP = p; }
  down(p: PointerInfo) {
    const L = activeLayer();
    if (!L) return;
    this.layer = L;
    this.start = { x: p.x, y: p.y }; this.cur = { x: p.x, y: p.y };
    this.startS = { x: p.sx, y: p.sy };
    const b = this.selBox();
    if (b && !L.locked) {
      for (const [hname, hx, hy] of this.handles(b)) {
        const s = docToScreen(hx, hy);
        if (Math.hypot(s.x - p.sx, s.y - p.sy) <= 7) {
          this.handle = hname; this.box = b;
          this.mode = hname === 'rot' ? 'rotate' : 'scale';
          this.beginTransform(L);
          return;
        }
      }
    }
    const h = hitStroke(p);
    if (h) {
      if (p.shift || p.ctrl) {
        if (S.selection.has(h.stroke.id)) S.selection.delete(h.stroke.id); else S.selection.add(h.stroke.id);
        emit('selection');
        this.mode = 'none';
        return;
      }
      if (!S.selection.has(h.stroke.id)) { S.selection = new Set([h.stroke.id]); emit('selection'); }
      if (L.locked) { this.mode = 'none'; return; }
      this.mode = 'move'; this.box = this.selBox();
      this.beginTransform(L);
      return;
    }
    if (b && !L.locked && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) {
      this.mode = 'move'; this.box = b; this.beginTransform(L);
      return;
    }
    this.mode = 'marquee';
    this.additive = p.shift || p.ctrl;
    if (!this.additive && S.selection.size) { S.selection.clear(); emit('selection'); }
  }
  private beginTransform(L: Layer) {
    this.origs = L.strokes.filter((s) => S.selection.has(s.id));
    this.live_ = this.origs;
    this.matrix = [1, 0, 0, 1, 0, 0];
  }
  move(p: PointerInfo) {
    hoverP = p;
    this.cur = { x: p.x, y: p.y };
    if (this.mode === 'move') {
      let dx = p.x - this.start.x, dy = p.y - this.start.y;
      if (p.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      this.setMatrix([1, 0, 0, 1, dx, dy]);
    } else if (this.mode === 'scale' && this.box && this.handle) {
      const b = this.box;
      const hd = this.handle;
      // âncora oposta
      const ax = hd.includes('l') ? b.x + b.w : hd.includes('r') ? b.x : b.x + b.w / 2;
      const ay = hd.includes('t') ? b.y + b.h : hd.includes('b') ? b.y : b.y + b.h / 2;
      const ox = hd.includes('l') ? b.x : hd.includes('r') ? b.x + b.w : b.x + b.w / 2;
      const oy = hd.includes('t') ? b.y : hd.includes('b') ? b.y + b.h : b.y + b.h / 2;
      let sx = hd === 't' || hd === 'b' ? 1 : (p.x - ax) / (ox - ax || 1e-6);
      let sy = hd === 'l' || hd === 'r' ? 1 : (p.y - ay) / (oy - ay || 1e-6);
      const corner = hd.length === 2;
      if (corner && !p.shift) { const u = Math.abs(sx) > Math.abs(sy) ? sx : sy; sx = Math.sign(sx || 1) * Math.abs(u); sy = Math.sign(sy || 1) * Math.abs(u); }
      if (p.alt) {
        // escala a partir do centro
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        this.setMatrix([sx, 0, 0, sy, cx - sx * cx, cy - sy * cy]);
      } else {
        this.setMatrix([sx, 0, 0, sy, ax - sx * ax, ay - sy * ay]);
      }
    } else if (this.mode === 'rotate' && this.box) {
      const b = this.box;
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      const a0 = Math.atan2(this.start.y - cy, this.start.x - cx);
      let a = Math.atan2(p.y - cy, p.x - cx) - a0;
      if (p.shift) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
      const c = Math.cos(a), s = Math.sin(a);
      this.setMatrix([c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy]);
    }
  }
  private setMatrix(m: number[]) {
    this.matrix = m;
    this.live_ = this.origs.map((s) => transformStroke(s, m, S.settings.scaleWidth && this.mode === 'scale'));
  }
  up(p: PointerInfo) {
    const L = this.layer;
    if (!L) return;
    if (this.mode === 'marquee') {
      const x0 = Math.min(this.start.x, this.cur.x), x1 = Math.max(this.start.x, this.cur.x);
      const y0 = Math.min(this.start.y, this.cur.y), y1 = Math.max(this.start.y, this.cur.y);
      if (Math.hypot(p.sx - this.startS.x, p.sy - this.startS.y) > 3) {
        if (!this.additive) S.selection.clear();
        for (const s of L.strokes) {
          const sm = getSamples(s, sampleScale());
          for (let i = 0; i < sm.n; i++) {
            if (sm.xs[i] >= x0 && sm.xs[i] <= x1 && sm.ys[i] >= y0 && sm.ys[i] <= y1) { S.selection.add(s.id); break; }
          }
        }
        emit('selection');
      }
    } else if ((this.mode === 'move' || this.mode === 'scale' || this.mode === 'rotate') && this.origs.length) {
      const m = this.matrix;
      if (!(m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0)) {
        const map = new Map<string, Stroke | null>();
        this.origs.forEach((s, i) => map.set(s.id, this.live_[i]));
        commitReplace(L, map);
      }
    }
    this.mode = 'none'; this.origs = []; this.live_ = []; this.handle = null;
  }
  cancel() { this.mode = 'none'; this.origs = []; this.live_ = []; }
  key(e: KeyboardEvent): boolean {
    if (e.key === 'Escape' && S.selection.size) { S.selection.clear(); emit('selection'); return true; }
    return false;
  }
  exclude() { return this.origs.length && this.mode !== 'none' ? new Set(this.origs.map((s) => s.id)) : null; }
  live() {
    if (!this.origs.length || this.mode === 'none' || !this.layer) return null;
    return { strokes: this.live_, opacity: this.layer.opacity };
  }
  overlay(g: CanvasRenderingContext2D) {
    const L = activeLayer();
    if (!L) return;
    if (this.mode === 'marquee') {
      const a = docToScreen(this.start.x, this.start.y);
      const corners = [
        docToScreen(this.start.x, this.start.y), docToScreen(this.cur.x, this.start.y),
        docToScreen(this.cur.x, this.cur.y), docToScreen(this.start.x, this.cur.y),
      ];
      void a;
      g.beginPath();
      corners.forEach((c, i) => (i ? g.lineTo(c.x, c.y) : g.moveTo(c.x, c.y)));
      g.closePath();
      g.fillStyle = 'rgba(40,140,255,0.12)'; g.fill();
      g.setLineDash([4, 3]); g.strokeStyle = 'rgba(40,140,255,0.9)'; g.lineWidth = 1; g.stroke(); g.setLineDash([]);
    }
    const sel = this.mode !== 'none' && this.origs.length ? this.live_ : L.strokes.filter((s) => S.selection.has(s.id));
    if (!sel.length) return;
    for (const s of sel) drawCenterline(g, s, 'rgba(40,140,255,0.85)', 1);
    let b: { x: number; y: number; w: number; h: number } | null;
    if (this.mode !== 'none' && this.box && this.mode !== 'move') {
      // caixa transformada
      const m = this.matrix, bb = this.box;
      const tp = (x: number, y: number) => docToScreen(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]);
      const cs = [tp(bb.x, bb.y), tp(bb.x + bb.w, bb.y), tp(bb.x + bb.w, bb.y + bb.h), tp(bb.x, bb.y + bb.h)];
      g.beginPath(); cs.forEach((c, i) => (i ? g.lineTo(c.x, c.y) : g.moveTo(c.x, c.y))); g.closePath();
      g.strokeStyle = 'rgba(40,140,255,0.9)'; g.setLineDash([5, 4]); g.stroke(); g.setLineDash([]);
      return;
    }
    b = strokeBounds(sel, sampleScale());
    if (!b) return;
    const cs = [docToScreen(b.x, b.y), docToScreen(b.x + b.w, b.y), docToScreen(b.x + b.w, b.y + b.h), docToScreen(b.x, b.y + b.h)];
    g.beginPath(); cs.forEach((c, i) => (i ? g.lineTo(c.x, c.y) : g.moveTo(c.x, c.y))); g.closePath();
    g.strokeStyle = 'rgba(40,140,255,0.9)'; g.lineWidth = 1; g.setLineDash([5, 4]); g.stroke(); g.setLineDash([]);
    if (L.locked) return;
    const top = docToScreen(b.x + b.w / 2, b.y);
    const rot = this.handles(b).find((h) => h[0] === 'rot')!;
    const rs = docToScreen(rot[1], rot[2]);
    g.beginPath(); g.moveTo(top.x, top.y); g.lineTo(rs.x, rs.y); g.strokeStyle = 'rgba(40,140,255,0.9)'; g.stroke();
    for (const [hn, hx, hy] of this.handles(b)) drawHandle(g, hx, hy, hn === 'rot' ? 10 : 8, hn === 'rot' ? '#ffd23f' : '#ffffff', '#1d6fd6', hn === 'rot');
  }
}

class HandTool implements Tool { cursor = 'grab'; }

// ---------------- registro ----------------
export const TOOLS: Record<ToolId, Tool> = {
  select: new SelectTool(),
  pen: new PenTool(),
  curve: new PointsTool('curve'),
  line: new PointsTool('line'),
  edit: new EditTool(),
  weight: new WeightTool(),
  pressure: new PressureTool(),
  color: new ColorTool(),
  eraser: new EraserTool(),
  hand: new HandTool(),
};

let prevTool: ToolId = S.tool;
export function currentTool(): Tool { return TOOLS[S.tool]; }
export function onToolChanged() {
  if (prevTool !== S.tool) {
    TOOLS[prevTool].deactivate?.();
    TOOLS[prevTool].cancel?.();
    prevTool = S.tool;
  }
}
hooks.beforeFrame.push(() => {
  const t = TOOLS[S.tool];
  t.deactivate?.();
  t.cancel?.();
});

export function deleteSelection(): number {
  const L = editableLayer();
  if (!L || !S.selection.size) return 0;
  const map = new Map<string, Stroke | null>();
  for (const id of S.selection) map.set(id, null);
  const n = map.size;
  commitReplace(L, map);
  S.selection.clear();
  emit('selection');
  return n;
}

/** Aplica propriedades a todos os traços selecionados */
export function updateSelected(fn: (s: Stroke) => Stroke) {
  const L = editableLayer();
  if (!L || !S.selection.size) return;
  const map = new Map<string, Stroke | null>();
  for (const s of L.strokes) if (S.selection.has(s.id)) map.set(s.id, fn(s));
  commitReplace(L, map);
}

export function flipSelection(horizontal: boolean) {
  const L = editableLayer();
  if (!L) return;
  const sel = L.strokes.filter((s) => S.selection.has(s.id));
  const b = strokeBounds(sel);
  if (!b) return;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const m = horizontal ? [-1, 0, 0, 1, 2 * cx, 0] : [1, 0, 0, -1, 0, 2 * cy];
  const map = new Map<string, Stroke | null>();
  for (const s of sel) map.set(s.id, transformStroke(s, m, false));
  commitReplace(L, map);
}

/** Afina pontas: define o afinamento de início/fim dos selecionados */
export function selectAll() {
  const L = activeLayer();
  if (!L) return;
  S.selection = new Set(L.strokes.map((s) => s.id));
  emit('selection');
}
