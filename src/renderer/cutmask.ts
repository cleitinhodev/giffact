// Recorte: geometria da máscara (curva suave e/ou cantos retos) e renderização dos pixels recortados do GIF
import type { CutMask, CutPt } from './types';
import { crPoint } from './geom';

/** Polilinha fechada (x0,y0,x1,y1,…) que contorna a máscara em coordenadas do documento. */
export function maskPolyline(pts: CutPt[], closed = true): number[] {
  const n = pts.length;
  const out: number[] = [];
  if (n === 0) return out;
  if (n === 1) return [pts[0].x, pts[0].y];
  const segs = closed ? n : n - 1;
  const tmp = [0, 0];
  const at = (i: number) => pts[closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i))];
  for (let i = 0; i < segs; i++) {
    const p1 = at(i), p2 = at(i + 1);
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if ((p1.c && p2.c) || n === 2) { out.push(p1.x, p1.y); continue; }
    const p0 = p1.c || (!closed && i === 0) ? p1 : at(i - 1);
    const p3 = p2.c || (!closed && i + 2 > n - 1) ? p2 : at(i + 2);
    const steps = Math.max(2, Math.min(400, Math.ceil(len / 2)));
    const P = (q: CutPt) => ({ x: q.x, y: q.y, p: 1 });
    for (let k = 0; k < steps; k++) {
      crPoint(P(p0), P(p1), P(p2), P(p3), k / steps, tmp);
      out.push(tmp[0], tmp[1]);
    }
  }
  if (!closed) out.push(pts[n - 1].x, pts[n - 1].y);
  return out;
}

export function maskPath2D(m: CutMask, sx = 1, sy = sx): Path2D {
  return ptsPath2D(m.pts, sx, sy);
}
/** caminho fechado de uma lista de pontos (máscara principal ou área removida) */
export function ptsPath2D(pts: CutPt[], sx = 1, sy = sx): Path2D {
  const poly = maskPolyline(pts, true);
  const p = new Path2D();
  for (let i = 0; i < poly.length; i += 2) {
    const x = poly[i] * sx, y = poly[i + 1] * sy;
    if (i === 0) p.moveTo(x, y); else p.lineTo(x, y);
  }
  p.closePath();
  return p;
}

export function maskBounds(m: CutMask): { x: number; y: number; w: number; h: number } {
  const poly = maskPolyline(m.pts, true);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    x0 = Math.min(x0, poly[i]); x1 = Math.max(x1, poly[i]);
    y0 = Math.min(y0, poly[i + 1]); y1 = Math.max(y1, poly[i + 1]);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

let hitCtx: CanvasRenderingContext2D | null = null;
export function pointInMask(m: CutMask, x: number, y: number): boolean {
  return pointInPts(m.pts, x, y);
}
export function pointInPts(pts: CutPt[], x: number, y: number): boolean {
  if (!hitCtx) hitCtx = document.createElement('canvas').getContext('2d')!;
  return hitCtx.isPointInPath(ptsPath2D(pts), x, y, 'nonzero');
}
export function hasHoles(m: CutMask): boolean { return !!m.holes && m.holes.length > 0; }

/** Desenha a máscara final (opaca dentro, transparente fora) em `g`, já escalada: principal − áreas removidas. */
export function drawMaskAlpha(g: CanvasRenderingContext2D, m: CutMask, sx: number, sy: number) {
  g.save();
  g.fillStyle = '#000';
  g.fill(ptsPath2D(m.pts, sx, sy), 'nonzero');
  if (m.holes?.length) {
    g.globalCompositeOperation = 'destination-out';
    for (const h of m.holes) g.fill(ptsPath2D(h, sx, sy), 'nonzero');
  }
  g.restore();
}

// ---------- pixels recortados (cache LRU por máscara/quadro/tamanho) ----------
interface CacheEntry { mask: CutMask; frame: HTMLCanvasElement; w: number; h: number; c: HTMLCanvasElement }
const cache: CacheEntry[] = [];
const MAX_CACHE = 48;

/**
 * Pixels do quadro `frame` dentro da máscara, num canvas W×H (transparente fora).
 * A borda é suavizada (antisserrilhado); `feather` (px do documento) deixa a borda difusa.
 */
export function cutCanvas(m: CutMask, frame: HTMLCanvasElement, W = frame.width, H = frame.height): HTMLCanvasElement {
  for (let i = cache.length - 1; i >= 0; i--) {
    const e = cache[i];
    if (e.mask === m && e.frame === frame && e.w === W && e.h === H) {
      if (i !== cache.length - 1) { cache.splice(i, 1); cache.push(e); }
      return e.c;
    }
  }
  const c = renderCut(m, frame, W, H);
  cache.push({ mask: m, frame, w: W, h: H, c });
  while (cache.length > MAX_CACHE) { const old = cache.shift()!; if (!cache.some((e) => e.c === old.c)) old.c.width = old.c.height = 0; }
  return c;
}

export function renderCut(m: CutMask, frame: HTMLCanvasElement, W: number, H: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(W)); c.height = Math.max(1, Math.round(H));
  const g = c.getContext('2d')!;
  if (m.pts.length < 3) return c;
  const sx = c.width / frame.width, sy = c.height / frame.height;
  const f = Math.max(0, m.feather || 0);
  if (!hasHoles(m)) {
    if (f > 0) g.filter = `blur(${(f * Math.max(sx, sy)) / 2}px)`;
    g.fillStyle = '#000';
    g.fill(maskPath2D(m, sx, sy), 'nonzero');
    g.filter = 'none';
  } else if (f > 0) {
    // máscara combinada nítida → borda difusa aplicada uma vez no resultado (também nas bordas das áreas removidas)
    const hard = document.createElement('canvas');
    hard.width = c.width; hard.height = c.height;
    drawMaskAlpha(hard.getContext('2d')!, m, sx, sy);
    g.filter = `blur(${(f * Math.max(sx, sy)) / 2}px)`;
    g.drawImage(hard, 0, 0);
    g.filter = 'none';
    hard.width = hard.height = 0;
  } else drawMaskAlpha(g, m, sx, sy);
  g.globalCompositeOperation = 'source-in';
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(frame, 0, 0, c.width, c.height);
  g.globalCompositeOperation = 'source-over';
  return c;
}

const clonePts = (pts: CutPt[]) => pts.map((p) => (p.c ? { x: p.x, y: p.y, c: 1 } : { x: p.x, y: p.y }));
const validPts = (pts: any) => Array.isArray(pts) && pts.length >= 3 && pts.every((p: any) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
export function cloneHoles(holes: any): CutPt[][] {
  return Array.isArray(holes) ? holes.filter(validPts).map(clonePts) : [];
}
export function cloneMask(m: CutMask): CutMask {
  const out: CutMask = { pts: clonePts(m.pts), feather: m.feather || 0 };
  const hs = cloneHoles(m.holes);
  if (hs.length) out.holes = hs;
  return out;
}
export function isValidMask(m: any): m is CutMask {
  return !!m && validPts(m.pts);
}
