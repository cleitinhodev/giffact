// Geometria: splines, contorno de espessura variável, hit-test, simplificação, interseções
import type { Pt, Stroke } from './types';

let _uidCounter = 0;
export function uid(): string {
  _uidCounter = (_uidCounter + 1) % 1e6;
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7) + _uidCounter.toString(36);
}

export interface Samples {
  xs: Float64Array;
  ys: Float64Array;
  /** pressão (sem afinamento) */
  ps: Float64Array;
  /** raio final */
  rs: Float64Array;
  /** comprimento acumulado */
  cum: Float64Array;
  /** índice do segmento de controle de cada amostra */
  seg: Int32Array;
  n: number;
  total: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Catmull-Rom centrípeta entre p1 e p2 */
function crPoint(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number, out: number[]) {
  const alpha = 0.5;
  const d01 = Math.max(Math.pow(Math.hypot(p1.x - p0.x, p1.y - p0.y), alpha), 1e-4);
  const d12 = Math.max(Math.pow(Math.hypot(p2.x - p1.x, p2.y - p1.y), alpha), 1e-4);
  const d23 = Math.max(Math.pow(Math.hypot(p3.x - p2.x, p3.y - p2.y), alpha), 1e-4);
  // formulação de Barry-Goldman via tangentes (Yuksel)
  const m1x = d12 * ((p1.x - p0.x) / d01 - (p2.x - p0.x) / (d01 + d12)) + (p2.x - p1.x);
  const m1y = d12 * ((p1.y - p0.y) / d01 - (p2.y - p0.y) / (d01 + d12)) + (p2.y - p1.y);
  const m2x = d12 * ((p3.x - p2.x) / d23 - (p3.x - p1.x) / (d12 + d23)) + (p2.x - p1.x);
  const m2y = d12 * ((p3.y - p2.y) / d23 - (p3.y - p1.y) / (d12 + d23)) + (p2.y - p1.y);
  const t2 = t * t, t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
  out[0] = h00 * p1.x + h10 * m1x + h01 * p2.x + h11 * m2x;
  out[1] = h00 * p1.y + h10 * m1y + h01 * p2.y + h11 * m2y;
}

function taperFactor(s: number, ts: number, te: number): number {
  let f = 1;
  if (ts > 0.0001 && s < ts) {
    const x = s / ts;
    f = Math.min(f, 1 - (1 - x) * (1 - x));
  }
  if (te > 0.0001 && s > 1 - te) {
    const x = (1 - s) / te;
    f = Math.min(f, 1 - (1 - x) * (1 - x));
  }
  return Math.max(f, 0.06);
}

/** Amostra o traço em uma polilinha densa (coordenadas do documento). scale = px de tela por px de doc */
export function sampleStroke(s: Stroke, scale: number): Samples {
  const pts = s.pts;
  const xs: number[] = [], ys: number[] = [], ps: number[] = [], sg: number[] = [];
  const n = pts.length;
  const density = Math.max(scale, 0.25) / 1.6; // amostras por px de doc
  if (n === 1) {
    xs.push(pts[0].x); ys.push(pts[0].y); ps.push(pts[0].p); sg.push(0);
  } else if (s.kind === 'line' || n === 2) {
    const segs = s.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.max(1, Math.min(2000, Math.ceil(len * density / 3)));
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        xs.push(a.x + (b.x - a.x) * t); ys.push(a.y + (b.y - a.y) * t); ps.push(a.p + (b.p - a.p) * t); sg.push(i);
      }
    }
    const last = s.closed ? pts[0] : pts[n - 1];
    xs.push(last.x); ys.push(last.y); ps.push(last.p); sg.push(segs - 1);
  } else {
    const segs = s.closed ? n : n - 1;
    const tmp = [0, 0];
    const get = (i: number): Pt => {
      if (s.closed) return pts[((i % n) + n) % n];
      if (i < 0) return { x: 2 * pts[0].x - pts[1].x, y: 2 * pts[0].y - pts[1].y, p: pts[0].p };
      if (i >= n) return { x: 2 * pts[n - 1].x - pts[n - 2].x, y: 2 * pts[n - 1].y - pts[n - 2].y, p: pts[n - 1].p };
      return pts[i];
    };
    for (let i = 0; i < segs; i++) {
      const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
      const chord = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const steps = Math.max(2, Math.min(600, Math.ceil(chord * density * 1.15)));
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        crPoint(p0, p1, p2, p3, t, tmp);
        xs.push(tmp[0]); ys.push(tmp[1]); ps.push(p1.p + (p2.p - p1.p) * smooth(t)); sg.push(i);
      }
    }
    const last = s.closed ? pts[0] : pts[n - 1];
    xs.push(last.x); ys.push(last.y); ps.push(last.p); sg.push(segs - 1);
  }
  const m = xs.length;
  const out: Samples = {
    xs: new Float64Array(xs), ys: new Float64Array(ys), ps: new Float64Array(ps),
    rs: new Float64Array(m), cum: new Float64Array(m), seg: new Int32Array(sg), n: m, total: 0,
    minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity,
  };
  let c = 0;
  for (let i = 1; i < m; i++) {
    c += Math.hypot(out.xs[i] - out.xs[i - 1], out.ys[i] - out.ys[i - 1]);
    out.cum[i] = c;
  }
  out.total = c;
  const base = s.width / 2;
  const ts = s.closed ? 0 : s.taperStart, te = s.closed ? 0 : s.taperEnd;
  let maxR = 0;
  for (let i = 0; i < m; i++) {
    const f = c > 0 ? taperFactor(out.cum[i] / c, ts, te) : 1;
    const r = Math.max(base * Math.max(out.ps[i], 0) * f, 0.05);
    out.rs[i] = r;
    if (r > maxR) maxR = r;
    if (out.xs[i] < out.minX) out.minX = out.xs[i];
    if (out.ys[i] < out.minY) out.minY = out.ys[i];
    if (out.xs[i] > out.maxX) out.maxX = out.xs[i];
    if (out.ys[i] > out.maxY) out.maxY = out.ys[i];
  }
  out.minX -= maxR; out.minY -= maxR; out.maxX += maxR; out.maxY += maxR;
  return out;
}

export interface Sink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  circle(x: number, y: number, r: number): void;
}

/**
 * Gera o contorno como união de círculos + trapézios tangentes, todos com a mesma
 * orientação (horária na tela) para que o preenchimento nonzero faça a união sem buracos.
 */
export function emitOutline(sm: Samples, sink: Sink, scale: number) {
  const { xs, ys, rs, n } = sm;
  if (n === 0) return;
  if (n === 1) { sink.circle(xs[0], ys[0], rs[0]); return; }
  const tol = 0.12 / Math.max(scale, 0.05);
  let prevAng = NaN;
  let prevAlpha = NaN;
  // filtra amostras quase coincidentes
  let i0 = 0;
  sink.circle(xs[0], ys[0], rs[0]);
  for (let i = 1; i < n; i++) {
    const x0 = xs[i0], y0 = ys[i0], r0 = rs[i0];
    const x1 = xs[i], y1 = ys[i], r1 = rs[i];
    const dx = x1 - x0, dy = y1 - y0;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6 && i < n - 1) continue;
    if (d <= Math.abs(r0 - r1) + 1e-9) {
      // um círculo contém o outro
      sink.circle(x0, y0, r0);
      sink.circle(x1, y1, r1);
      i0 = i; prevAng = NaN;
      continue;
    }
    const th = Math.atan2(dy, dx);
    const al = Math.acos(Math.max(-1, Math.min(1, (r0 - r1) / d)));
    if (!isNaN(prevAng)) {
      let dth = Math.abs(th - prevAng);
      if (dth > Math.PI) dth = 2 * Math.PI - dth;
      const eff = dth + Math.abs(al - prevAlpha);
      if (r0 * (1 - Math.cos(Math.min(eff, Math.PI) / 2)) > tol) sink.circle(x0, y0, r0);
    }
    const a1 = th + al, a2 = th - al;
    const ax = x0 + r0 * Math.cos(a1), ay = y0 + r0 * Math.sin(a1);
    const bx = x1 + r1 * Math.cos(a1), by = y1 + r1 * Math.sin(a1);
    const cx = x1 + r1 * Math.cos(a2), cy = y1 + r1 * Math.sin(a2);
    const ex = x0 + r0 * Math.cos(a2), ey = y0 + r0 * Math.sin(a2);
    // orientação: área com sinal positiva (horária na tela, mesma do arc)
    const area = (ax * by - bx * ay) + (bx * cy - cx * by) + (cx * ey - ex * cy) + (ex * ay - ax * ey);
    if (area >= 0) {
      sink.moveTo(ax, ay); sink.lineTo(bx, by); sink.lineTo(cx, cy); sink.lineTo(ex, ey);
    } else {
      sink.moveTo(ax, ay); sink.lineTo(ex, ey); sink.lineTo(cx, cy); sink.lineTo(bx, by);
    }
    sink.closePath();
    prevAng = th; prevAlpha = al;
    i0 = i;
  }
  sink.circle(xs[i0], ys[i0], rs[i0]);
}

export function outlinePath2D(sm: Samples, scale: number): Path2D {
  const p = new Path2D();
  emitOutline(sm, {
    moveTo: (x, y) => p.moveTo(x, y),
    lineTo: (x, y) => p.lineTo(x, y),
    closePath: () => p.closePath(),
    circle: (x, y, r) => { p.moveTo(x + r, y); p.arc(x, y, r, 0, Math.PI * 2, false); p.closePath(); },
  }, scale);
  return p;
}

export function outlineSvgPath(sm: Samples, scale: number): string {
  const f = (v: number) => (Math.round(v * 100) / 100).toString();
  const parts: string[] = [];
  emitOutline(sm, {
    moveTo: (x, y) => parts.push('M' + f(x) + ' ' + f(y)),
    lineTo: (x, y) => parts.push('L' + f(x) + ' ' + f(y)),
    closePath: () => parts.push('Z'),
    circle: (x, y, r) => {
      const R = f(r);
      parts.push(`M${f(x + r)} ${f(y)}A${R} ${R} 0 1 1 ${f(x - r)} ${f(y)}A${R} ${R} 0 1 1 ${f(x + r)} ${f(y)}Z`);
    },
  }, scale);
  return parts.join('');
}

// ---------- cache por identidade ----------
interface CacheEntry { bucket: number; sm: Samples; path?: Path2D }
const cache = new WeakMap<Stroke, CacheEntry[]>();

export function scaleBucket(scale: number): number {
  const b = Math.pow(2, Math.ceil(Math.log2(Math.max(scale, 0.0625))));
  return Math.min(Math.max(b, 0.25), 64);
}

function entry(s: Stroke, scale: number): CacheEntry {
  const bucket = scaleBucket(scale);
  let list = cache.get(s);
  if (!list) { list = []; cache.set(s, list); }
  let e = list.find((x) => x.bucket === bucket);
  if (!e) {
    e = { bucket, sm: sampleStroke(s, bucket) };
    list.push(e);
    if (list.length > 3) list.shift();
  }
  return e;
}

export function getSamples(s: Stroke, scale: number): Samples {
  return entry(s, scale).sm;
}

export function getPath(s: Stroke, scale: number): Path2D {
  const e = entry(s, scale);
  if (!e.path) e.path = outlinePath2D(e.sm, e.bucket);
  return e.path;
}

// ---------- distâncias e hit-test ----------
export function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): { d: number; t: number } {
  const dx = bx - ax, dy = by - ay;
  const L = dx * dx + dy * dy;
  let t = L > 0 ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + dx * t, y = ay + dy * t;
  return { d: Math.hypot(px - x, py - y), t };
}

/** distância do ponto à borda do traço (negativa = dentro). Também retorna índice/param da amostra mais próxima */
export function strokeDistance(sm: Samples, x: number, y: number): { d: number; i: number; t: number } {
  let best = Infinity, bi = 0, bt = 0;
  if (sm.n === 1) return { d: Math.hypot(x - sm.xs[0], y - sm.ys[0]) - sm.rs[0], i: 0, t: 0 };
  for (let i = 0; i < sm.n - 1; i++) {
    const r = distToSeg(x, y, sm.xs[i], sm.ys[i], sm.xs[i + 1], sm.ys[i + 1]);
    const rad = sm.rs[i] + (sm.rs[i + 1] - sm.rs[i]) * r.t;
    const d = r.d - rad;
    if (d < best) { best = d; bi = i; bt = r.t; }
  }
  return { d: best, i: bi, t: bt };
}

export function strokeBounds(strokes: Stroke[], scale = 1): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) {
    const sm = getSamples(s, scale);
    minX = Math.min(minX, sm.minX); minY = Math.min(minY, sm.minY);
    maxX = Math.max(maxX, sm.maxX); maxY = Math.max(maxY, sm.maxY);
  }
  if (!isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// ---------- simplificação (Ramer–Douglas–Peucker) ----------
export function rdp(pts: Pt[], eps: number): Pt[] {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distToSeg(pts[i].x, pts[i].y, pts[a].x, pts[a].y, pts[b].x, pts[b].y).d;
      // considera também variação de pressão
      const pa = pts[a].p + (pts[b].p - pts[a].p) * ((i - a) / (b - a));
      const dp = Math.abs(pts[i].p - pa) * 6 * eps;
      const dd = Math.max(d, dp);
      if (dd > maxD) { maxD = dd; idx = i; }
    }
    if (maxD > eps && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * Converte uma polilinha densa em pontos de controle para Catmull-Rom.
 * Simplifica com RDP e depois garante espaçamento mínimo.
 */
export function fitCurve(raw: Pt[], eps: number): Pt[] {
  // remove duplicados
  const pts: Pt[] = [];
  for (const p of raw) {
    const l = pts[pts.length - 1];
    if (!l || Math.hypot(p.x - l.x, p.y - l.y) > 0.05) pts.push(p);
  }
  if (pts.length < 3) return pts;
  let out = rdp(pts, eps);
  // RDP sozinho deixa pontos muito distantes em curvas suaves longas; insere pontos para fidelidade
  const refined: Pt[] = [out[0]];
  const idxOf = new Map<Pt, number>();
  pts.forEach((p, i) => idxOf.set(p, i));
  for (let k = 1; k < out.length; k++) {
    const ia = idxOf.get(out[k - 1])!, ib = idxOf.get(out[k])!;
    // comprimento do trecho
    let len = 0;
    for (let i = ia + 1; i <= ib; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    const maxSeg = Math.max(eps * 40, 24);
    const pieces = Math.ceil(len / maxSeg);
    if (pieces > 1) {
      let acc = 0, next = len / pieces, j = 1;
      for (let i = ia + 1; i < ib && j < pieces; i++) {
        acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        if (acc >= next) { refined.push(pts[i]); j++; next = (len * j) / pieces; }
      }
    }
    refined.push(out[k]);
  }
  out = refined;
  return out.map((p) => ({ x: p.x, y: p.y, p: p.p }));
}

// ---------- interseções ----------
function segInter(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number {
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return -1;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return t;
  return -1;
}

/** Retorna parâmetros (comprimento acumulado ao longo de A) onde A cruza B */
export function intersectionsAlong(A: Samples, B: Samples, self = false): number[] {
  const res: number[] = [];
  if (A.maxX < B.minX || B.maxX < A.minX || A.maxY < B.minY || B.maxY < A.minY) return res;
  for (let i = 0; i < A.n - 1; i++) {
    const ax = A.xs[i], ay = A.ys[i], bx = A.xs[i + 1], by = A.ys[i + 1];
    const minx = Math.min(ax, bx), maxx = Math.max(ax, bx), miny = Math.min(ay, by), maxy = Math.max(ay, by);
    for (let j = 0; j < B.n - 1; j++) {
      if (self && Math.abs(i - j) < 3) continue;
      const cx = B.xs[j], cy = B.ys[j], dx = B.xs[j + 1], dy = B.ys[j + 1];
      if (Math.max(cx, dx) < minx || Math.min(cx, dx) > maxx || Math.max(cy, dy) < miny || Math.min(cy, dy) > maxy) continue;
      const t = segInter(ax, ay, bx, by, cx, cy, dx, dy);
      if (t >= 0) res.push(A.cum[i] + (A.cum[i + 1] - A.cum[i]) * t);
    }
  }
  return res;
}

/** Extrai o trecho [l0,l1] (comprimento) das amostras como Pt[] (pressão sem afinamento) */
export function sliceSamples(sm: Samples, l0: number, l1: number): Pt[] {
  const out: Pt[] = [];
  const at = (L: number): Pt => {
    let i = 0;
    while (i < sm.n - 2 && sm.cum[i + 1] < L) i++;
    const seg = sm.cum[i + 1] - sm.cum[i];
    const t = seg > 0 ? Math.max(0, Math.min(1, (L - sm.cum[i]) / seg)) : 0;
    return {
      x: sm.xs[i] + (sm.xs[i + 1] - sm.xs[i]) * t,
      y: sm.ys[i] + (sm.ys[i + 1] - sm.ys[i]) * t,
      p: sm.ps[i] + (sm.ps[i + 1] - sm.ps[i]) * t,
    };
  };
  if (sm.n < 2) return [{ x: sm.xs[0], y: sm.ys[0], p: sm.ps[0] }];
  out.push(at(l0));
  for (let i = 0; i < sm.n; i++) if (sm.cum[i] > l0 && sm.cum[i] < l1) out.push({ x: sm.xs[i], y: sm.ys[i], p: sm.ps[i] });
  out.push(at(l1));
  return out;
}

/** Cria um novo traço a partir de um trecho de outro (mantém estilo) */
export function strokeFromPiece(src: Stroke, pts: Pt[], keepTaperStart: boolean, keepTaperEnd: boolean): Stroke | null {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  if (len < 0.5) return null;
  const fitted = src.kind === 'line' ? rdp(pts, 0.05) : fitCurve(pts, 0.25);
  return {
    ...src,
    id: uid(),
    kind: src.kind,
    closed: false,
    pts: fitted,
    taperStart: keepTaperStart ? src.taperStart : 0,
    taperEnd: keepTaperEnd ? src.taperEnd : 0,
  };
}

/** Aplica uma matriz afim [a,b,c,d,e,f] a um traço */
export function transformStroke(s: Stroke, m: number[], scaleWidth: boolean): Stroke {
  const [a, b, c, d, e, f] = m;
  const det = Math.sqrt(Math.abs(a * d - b * c));
  return {
    ...s,
    pts: s.pts.map((p) => ({ x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f, p: p.p })),
    width: scaleWidth ? Math.max(0.1, s.width * det) : s.width,
  };
}

export function cloneStroke(s: Stroke, newId = true): Stroke {
  return { ...s, id: newId ? uid() : s.id, pts: s.pts.map((p) => ({ ...p })) };
}
