// Seletor de cores (1.3.0-beta): quantização do quadro em paleta, limpeza de manchinhas, vetorização de cada
// região de cor em formas preenchidas (anéis de pontos Catmull-Rom = curvas Bézier) e conversão de regiões de
// traço em linhas do Giffact (esqueleto + espessura). Algoritmos próprios, sem dependências.
import type { CutPt, Pt, Stroke, VecData, VecShape } from './types';
import { fitCurve, uid } from './geom';

export type RGB = [number, number, number];

// ---------------------------------------------------------------- cores
export const toHex = (c: RGB) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
export function parseHex(s: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(s || '').trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const colorDist = (a: RGB, b: RGB) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const luminance = (c: RGB) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
/** tolerância 0..100 → distância RGB máxima */
export const tolToDist = (tol: number) => (Math.max(0, Math.min(100, tol)) / 100) * 442;

/** índices da paleta parecidos com o índice i (incluindo ele mesmo) */
export function similarIndices(palette: RGB[], i: number, tol: number): number[] {
  const thr = tolToDist(tol);
  const out: number[] = [];
  palette.forEach((c, j) => { if (j === i || colorDist(c, palette[i]) <= thr) out.push(j); });
  return out;
}

// ---------------------------------------------------------------- quantização (k-means determinístico)
function lcg(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/** Paleta de até k cores para os pixels opacos (alfa ≥ 128). Ordenada do mais escuro ao mais claro. */
export function kmeansPalette(data: Uint8ClampedArray, k: number): RGB[] {
  k = Math.max(2, Math.min(32, Math.round(k)));
  // amostras: cores distintas com peso (GIF tem no máx. 256 cores por quadro, então isso é pequeno)
  const hist = new Map<number, number>();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    hist.set(key, (hist.get(key) || 0) + 1);
  }
  let cols = Array.from(hist.entries()).map(([key, w]) => ({ c: [(key >> 16) & 255, (key >> 8) & 255, key & 255] as RGB, w }));
  if (!cols.length) return [[0, 0, 0], [255, 255, 255]];
  if (cols.length > 6000) {
    // muitas cores (imagem não-GIF): reduz para 5 bits por canal mantendo o peso
    const h2 = new Map<number, { c: number[]; w: number }>();
    for (const { c, w } of cols) {
      const key = ((c[0] >> 3) << 10) | ((c[1] >> 3) << 5) | (c[2] >> 3);
      const e = h2.get(key);
      if (e) { e.c[0] += c[0] * w; e.c[1] += c[1] * w; e.c[2] += c[2] * w; e.w += w; } else h2.set(key, { c: [c[0] * w, c[1] * w, c[2] * w], w });
    }
    cols = Array.from(h2.values()).map((e) => ({ c: [e.c[0] / e.w, e.c[1] / e.w, e.c[2] / e.w] as RGB, w: e.w }));
  }
  if (cols.length <= k) return sortPalette(cols.map((x) => x.c.map(Math.round) as RGB));
  // k-means++ (determinístico) ponderado
  const rnd = lcg(12345);
  cols.sort((a, b) => b.w - a.w);
  const centers: RGB[] = [cols[0].c.slice() as RGB];
  const d2 = new Float64Array(cols.length).fill(Infinity);
  while (centers.length < k) {
    const last = centers[centers.length - 1];
    let sum = 0;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i].c;
      const d = (c[0] - last[0]) ** 2 + (c[1] - last[1]) ** 2 + (c[2] - last[2]) ** 2;
      if (d < d2[i]) d2[i] = d;
      // peso: raiz da contagem (cores de traço, que ocupam pouca área, ainda ganham centro)
      sum += d2[i] * Math.sqrt(cols[i].w);
    }
    if (sum <= 0) break;
    let r = rnd() * sum, pick = cols.length - 1;
    for (let i = 0; i < cols.length; i++) { r -= d2[i] * Math.sqrt(cols[i].w); if (r <= 0) { pick = i; break; } }
    centers.push(cols[pick].c.slice() as RGB);
  }
  const assign = new Int32Array(cols.length);
  for (let it = 0; it < 16; it++) {
    const acc = centers.map(() => [0, 0, 0, 0]);
    let changed = 0;
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i].c;
      let best = 0, bd = Infinity;
      for (let j = 0; j < centers.length; j++) {
        const q = centers[j];
        const d = (c[0] - q[0]) ** 2 + (c[1] - q[1]) ** 2 + (c[2] - q[2]) ** 2;
        if (d < bd) { bd = d; best = j; }
      }
      if (assign[i] !== best) { assign[i] = best; changed++; }
      const a = acc[best], w = cols[i].w;
      a[0] += c[0] * w; a[1] += c[1] * w; a[2] += c[2] * w; a[3] += w;
    }
    for (let j = 0; j < centers.length; j++) if (acc[j][3] > 0) centers[j] = [acc[j][0] / acc[j][3], acc[j][1] / acc[j][3], acc[j][2] / acc[j][3]];
    if (!changed && it > 0) break;
  }
  // centros finais: arredonda e remove duplicados
  const out: RGB[] = [];
  for (const c of centers) {
    const r = c.map(Math.round) as RGB;
    if (!out.some((o) => colorDist(o, r) < 3)) out.push(r);
  }
  return sortPalette(out);
}
function sortPalette(p: RGB[]): RGB[] { return p.sort((a, b) => luminance(a) - luminance(b)); }

/** Mapa de rótulos: índice da cor mais próxima da paleta por pixel (−1 = transparente). */
export function labelPixels(data: Uint8ClampedArray, W: number, H: number, palette: RGB[]): Int16Array {
  const N = W * H;
  const lab = new Int16Array(N);
  const cache = new Map<number, number>();
  for (let i = 0; i < N; i++) {
    const o = i * 4;
    if (data[o + 3] < 128) { lab[i] = -1; continue; }
    const key = (data[o] << 16) | (data[o + 1] << 8) | data[o + 2];
    let l = cache.get(key);
    if (l === undefined) {
      let bd = Infinity; l = 0;
      for (let j = 0; j < palette.length; j++) {
        const q = palette[j];
        const d = (data[o] - q[0]) ** 2 + (data[o + 1] - q[1]) ** 2 + (data[o + 2] - q[2]) ** 2;
        if (d < bd) { bd = d; l = j; }
      }
      cache.set(key, l);
    }
    lab[i] = l;
  }
  return lab;
}

/** Junta manchinhas (componentes 4-conexos com menos de minArea px) à cor vizinha mais comum. */
export function mergeSpecks(lab: Int16Array, W: number, H: number, minArea: number): void {
  if (minArea <= 1) return;
  for (let pass = 0; pass < 2; pass++) {
    const comp = new Int32Array(W * H).fill(-1);
    const stack = new Int32Array(W * H);
    let nComp = 0, changed = 0;
    for (let s = 0; s < W * H; s++) {
      if (comp[s] >= 0) continue;
      const L = lab[s];
      let sp = 0, size = 0;
      stack[sp++] = s; comp[s] = nComp;
      const members: number[] = [];
      while (sp) {
        const i = stack[--sp];
        size++;
        if (size <= minArea) members.push(i);
        const x = i % W, y = (i / W) | 0;
        if (x > 0 && comp[i - 1] < 0 && lab[i - 1] === L) { comp[i - 1] = nComp; stack[sp++] = i - 1; }
        if (x < W - 1 && comp[i + 1] < 0 && lab[i + 1] === L) { comp[i + 1] = nComp; stack[sp++] = i + 1; }
        if (y > 0 && comp[i - W] < 0 && lab[i - W] === L) { comp[i - W] = nComp; stack[sp++] = i - W; }
        if (y < H - 1 && comp[i + W] < 0 && lab[i + W] === L) { comp[i + W] = nComp; stack[sp++] = i + W; }
      }
      if (size < minArea) {
        const votes = new Map<number, number>();
        for (const i of members) {
          const x = i % W, y = (i / W) | 0;
          const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
          for (const j of nb) if (j >= 0 && lab[j] !== L) votes.set(lab[j], (votes.get(lab[j]) || 0) + 1);
        }
        let best = L, bv = 0;
        votes.forEach((v, k) => { if (v > bv) { bv = v; best = k; } });
        if (best !== L) { for (const i of members) lab[i] = best; changed++; }
      }
      nComp++;
    }
    if (!changed) break;
  }
}

/** Suavização suave de bordas: só troca pixels quase isolados (preserva traços de 1 px). */
export function smoothEdges(lab: Int16Array, W: number, H: number, passes: number): void {
  for (let p = 0; p < passes; p++) {
    const src = lab.slice();
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x, L = src[i];
      let own = 0;
      const cnt = new Map<number, number>();
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const v = src[i + dy * W + dx];
        if (v === L) own++; else cnt.set(v, (cnt.get(v) || 0) + 1);
      }
      if (own > 2) continue;
      let best = L, bv = 0;
      cnt.forEach((v, k) => { if (v > bv) { bv = v; best = k; } });
      if (bv >= 6) lab[i] = best;
    }
  }
}

export interface VecParams { speck: number; smooth: number }
/** rótulos limpos de um quadro para a paleta dada */
export function cleanLabels(data: Uint8ClampedArray, W: number, H: number, palette: RGB[], o: VecParams): Int16Array {
  const lab = labelPixels(data, W, H, palette);
  mergeSpecks(lab, W, H, Math.max(1, Math.round(o.speck)));
  smoothEdges(lab, W, H, Math.min(2, Math.max(0, Math.round(o.smooth))));
  return lab;
}

// ---------------------------------------------------------------- contornos → formas
const r2 = (v: number) => Math.round(v * 100) / 100;

/** laços de borda (arestas de pixel) de uma máscara binária em uma janela; sentido horário = externo */
function traceLoops(mask: Uint8Array, bw: number, bh: number): number[][] {
  // vértices (bw+1)×(bh+1); bits de saída: 1=+x 2=+y 4=−x 8=−y
  const VW = bw + 1;
  const out = new Uint8Array(VW * (bh + 1));
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < bw && y < bh && mask[y * bw + x] === 1;
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    if (!mask[y * bw + x]) continue;
    if (!inside(x, y - 1)) out[y * VW + x] |= 1;
    if (!inside(x + 1, y)) out[y * VW + x + 1] |= 2;
    if (!inside(x, y + 1)) out[(y + 1) * VW + x + 1] |= 4;
    if (!inside(x - 1, y)) out[(y + 1) * VW + x] |= 8;
  }
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
  const loops: number[][] = [];
  const pop = (b: number) => (b & 1) + ((b >> 1) & 1) + ((b >> 2) & 1) + ((b >> 3) & 1);
  for (let v0 = 0; v0 < out.length; v0++) {
    while (out[v0] && pop(out[v0]) === 1) {
      let v = v0;
      let d = Math.log2(out[v]) | 0;
      out[v] &= ~(1 << d);
      const pts: number[] = [v % VW, (v / VW) | 0];
      let guard = 0;
      for (;;) {
        const x = (v % VW) + DX[d], y = ((v / VW) | 0) + DY[d];
        v = y * VW + x;
        if (v === v0) break;
        // curva à direita, reto, à esquerda (direita primeiro = 4-conectividade)
        let nd = -1;
        for (const c of [(d + 1) & 3, d, (d + 3) & 3]) if (out[v] & (1 << c)) { nd = c; break; }
        if (nd < 0 || ++guard > 4 * out.length) break;
        if (nd !== d) pts.push(x, y);
        d = nd;
        out[v] &= ~(1 << d);
      }
      loops.push(pts);
    }
  }
  return loops;
}

function signedArea(p: number[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i += 2) {
    const j = (i + 2) % p.length;
    a += p[i] * p[j + 1] - p[j] * p[i + 1];
  }
  return a / 2;
}

/** RDP em polígono fechado (pontos x,y intercalados) */
function rdpClosed(xs: number[], ys: number[], eps: number): number[] {
  const n = xs.length;
  if (n <= 4) return Array.from({ length: n }, (_, i) => i);
  // divide no ponto mais distante do 1º
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) { const d = (xs[i] - xs[0]) ** 2 + (ys[i] - ys[0]) ** 2; if (d > fd) { fd = d; far = i; } }
  const keep = new Uint8Array(n);
  keep[0] = 1; keep[far] = 1;
  const seg = (a: number, b: number) => {
    // índices circulares de a até b
    const stack: [number, number][] = [[a, b]];
    while (stack.length) {
      const [s, e] = stack.pop()!;
      const len = (e - s + n) % n;
      if (len < 2) continue;
      const ax = xs[s], ay = ys[s], bx = xs[e], by = ys[e];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      let md = -1, mi = -1;
      for (let k = 1; k < len; k++) {
        const i = (s + k) % n;
        let u = l2 ? ((xs[i] - ax) * dx + (ys[i] - ay) * dy) / l2 : 0;
        u = Math.max(0, Math.min(1, u));
        const d = Math.hypot(xs[i] - (ax + u * dx), ys[i] - (ay + u * dy));
        if (d > md) { md = d; mi = i; }
      }
      if (md > eps) { keep[mi] = 1; stack.push([s, mi], [mi, e]); }
    }
  };
  seg(0, far); seg(far, 0);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) idx.push(i);
  return idx;
}

/** laço de pixels (cantos) → anel de nós suaves com cantos marcados */
function loopToRing(corners: number[], ox: number, oy: number, smooth: number): CutPt[] {
  // pontos médios de cada aresta unitária (corta a escadinha)
  const xs: number[] = [], ys: number[] = [];
  const m = corners.length / 2;
  for (let k = 0; k < m; k++) {
    const ax = corners[2 * k], ay = corners[2 * k + 1];
    const bx = corners[(2 * k + 2) % corners.length], by = corners[(2 * k + 3) % corners.length];
    const len = Math.abs(bx - ax) + Math.abs(by - ay);
    const sx = Math.sign(bx - ax), sy = Math.sign(by - ay);
    for (let s = 0; s < len; s++) { xs.push(ax + sx * (s + 0.5)); ys.push(ay + sy * (s + 0.5)); }
  }
  const n = xs.length;
  if (n < 3) return [];
  // suavização [1 2 1] circular
  const passes = Math.max(0, Math.round(smooth));
  let X = xs, Y = ys;
  for (let p = 0; p < passes; p++) {
    const nx = new Array(n), ny = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n, b = (i + 1) % n;
      nx[i] = (X[a] + 2 * X[i] + X[b]) / 4; ny[i] = (Y[a] + 2 * Y[i] + Y[b]) / 4;
    }
    X = nx; Y = ny;
  }
  const eps = 0.45 + 0.3 * Math.max(0, smooth);
  let idx = rdpClosed(X, Y, eps);
  if (idx.length < 3) {
    // forma minúscula: usa os cantos
    const ring: CutPt[] = [];
    for (let k = 0; k < m; k++) ring.push({ x: r2(corners[2 * k] + ox), y: r2(corners[2 * k + 1] + oy), c: 1 });
    return ring.length >= 3 ? ring : [];
  }
  // garante espaçamento máximo (curvas longas não “estufam”)
  const maxSeg = 28;
  const dense: number[] = [];
  for (let k = 0; k < idx.length; k++) {
    const a = idx[k], b = idx[(k + 1) % idx.length];
    dense.push(a);
    const len = (b - a + n) % n;
    const pieces = Math.ceil(len / maxSeg);
    for (let q = 1; q < pieces; q++) dense.push((a + Math.round((len * q) / pieces)) % n);
  }
  idx = dense;
  const ring: CutPt[] = idx.map((i) => ({ x: r2(X[i] + ox), y: r2(Y[i] + oy) }));
  // cantos: ângulo de virada forte
  const L = ring.length;
  for (let i = 0; i < L; i++) {
    const a = ring[(i - 1 + L) % L], b = ring[i], c = ring[(i + 1) % L];
    const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y;
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (!lu || !lv) continue;
    const cos = (ux * vx + uy * vy) / (lu * lv);
    if (cos < 0.25) b.c = 1; // virada > ~75°
  }
  return ring;
}

/**
 * Vetoriza um mapa de rótulos: cada componente conexo de uma cor mantida vira uma forma (anel externo + furos).
 * Formas maiores ficam embaixo (desenhadas primeiro).
 */
export function traceLabels(lab: Int16Array, W: number, H: number, palette: RGB[], keep: (label: number) => boolean, smooth: number): VecShape[] {
  const comp = new Int32Array(W * H).fill(-1);
  const stack = new Int32Array(W * H);
  const shapes: { s: VecShape; area: number }[] = [];
  let nComp = 0;
  for (let s0 = 0; s0 < W * H; s0++) {
    const L = lab[s0];
    if (comp[s0] >= 0 || L < 0 || !keep(L)) continue;
    let sp = 0, x0 = W, y0 = H, x1 = 0, y1 = 0, area = 0;
    const members: number[] = [];
    stack[sp++] = s0; comp[s0] = nComp;
    while (sp) {
      const i = stack[--sp];
      members.push(i); area++;
      const x = i % W, y = (i / W) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && comp[i - 1] < 0 && lab[i - 1] === L) { comp[i - 1] = nComp; stack[sp++] = i - 1; }
      if (x < W - 1 && comp[i + 1] < 0 && lab[i + 1] === L) { comp[i + 1] = nComp; stack[sp++] = i + 1; }
      if (y > 0 && comp[i - W] < 0 && lab[i - W] === L) { comp[i - W] = nComp; stack[sp++] = i - W; }
      if (y < H - 1 && comp[i + W] < 0 && lab[i + W] === L) { comp[i + W] = nComp; stack[sp++] = i + W; }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const mask = new Uint8Array(bw * bh);
    for (const i of members) mask[(((i / W) | 0) - y0) * bw + (i % W) - x0] = 1;
    const loops = traceLoops(mask, bw, bh);
    const rings: { r: CutPt[]; a: number }[] = [];
    for (const lp of loops) {
      const a = signedArea(lp);
      const r = loopToRing(lp, x0, y0, smooth);
      if (r.length >= 3) rings.push({ r, a });
    }
    rings.sort((p, q) => q.a - p.a); // externo (maior área positiva) primeiro
    if (rings.length && rings[0].a > 0) {
      shapes.push({ s: { id: uid(), color: toHex(palette[L]), rings: rings.map((x) => x.r) }, area });
    }
    nComp++;
  }
  shapes.sort((a, b) => b.area - a.area);
  return shapes.map((x) => x.s);
}

/** pipeline completo de um quadro: pixels → rótulos limpos → formas (sem as cores excluídas) */
export function vectorizeCanvas(frame: HTMLCanvasElement, palette: RGB[], deleted: Set<number>, o: VecParams): VecShape[] {
  const W = frame.width, H = frame.height;
  const data = frame.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, W, H).data;
  const lab = cleanLabels(data, W, H, palette, o);
  return traceLabels(lab, W, H, palette, (l) => !deleted.has(l), o.smooth);
}

// ---------------------------------------------------------------- caminhos (Catmull-Rom centrípeta → Bézier)
function tangents(p0: CutPt, p1: CutPt, p2: CutPt, p3: CutPt): [number, number, number, number] {
  const a = 0.5;
  const d01 = Math.max(Math.pow(Math.hypot(p1.x - p0.x, p1.y - p0.y), a), 1e-4);
  const d12 = Math.max(Math.pow(Math.hypot(p2.x - p1.x, p2.y - p1.y), a), 1e-4);
  const d23 = Math.max(Math.pow(Math.hypot(p3.x - p2.x, p3.y - p2.y), a), 1e-4);
  const m1x = d12 * ((p1.x - p0.x) / d01 - (p2.x - p0.x) / (d01 + d12)) + (p2.x - p1.x);
  const m1y = d12 * ((p1.y - p0.y) / d01 - (p2.y - p0.y) / (d01 + d12)) + (p2.y - p1.y);
  const m2x = d12 * ((p3.x - p2.x) / d23 - (p3.x - p1.x) / (d12 + d23)) + (p2.x - p1.x);
  const m2y = d12 * ((p3.y - p2.y) / d23 - (p3.y - p1.y) / (d12 + d23)) + (p2.y - p1.y);
  return [m1x, m1y, m2x, m2y];
}
/** segmentos Bézier de um anel fechado: [x0,y0] + por segmento [c1x,c1y,c2x,c2y,x,y] */
export function ringBeziers(ring: CutPt[]): { x: number; y: number; segs: number[][] } {
  const n = ring.length;
  const at = (i: number) => ring[((i % n) + n) % n];
  const segs: number[][] = [];
  for (let i = 0; i < n; i++) {
    const p1 = at(i), p2 = at(i + 1);
    if ((p1.c && p2.c) || n < 3) { segs.push([p1.x, p1.y, p2.x, p2.y, p2.x, p2.y]); continue; }
    const p0 = p1.c ? p1 : at(i - 1), p3 = p2.c ? p2 : at(i + 2);
    const [m1x, m1y, m2x, m2y] = tangents(p0, p1, p2, p3);
    segs.push([p1.x + m1x / 3, p1.y + m1y / 3, p2.x - m2x / 3, p2.y - m2y / 3, p2.x, p2.y]);
  }
  return { x: ring[0].x, y: ring[0].y, segs };
}

const pathCache = new WeakMap<VecShape, Path2D>();
export function shapePath(s: VecShape): Path2D {
  let p = pathCache.get(s);
  if (p) return p;
  p = new Path2D();
  for (const ring of s.rings) {
    if (ring.length < 3) continue;
    const b = ringBeziers(ring);
    p.moveTo(b.x, b.y);
    for (const g of b.segs) p.bezierCurveTo(g[0], g[1], g[2], g[3], g[4], g[5]);
    p.closePath();
  }
  pathCache.set(s, p);
  return p;
}
const f2 = (v: number) => String(Math.round(v * 100) / 100);
export function shapeSvgD(s: VecShape): string {
  const out: string[] = [];
  for (const ring of s.rings) {
    if (ring.length < 3) continue;
    const b = ringBeziers(ring);
    out.push(`M${f2(b.x)} ${f2(b.y)}`);
    for (const g of b.segs) out.push(`C${f2(g[0])} ${f2(g[1])} ${f2(g[2])} ${f2(g[3])} ${f2(g[4])} ${f2(g[5])}`);
    out.push('Z');
  }
  return out.join('');
}
/** largura do contorno de mesma cor que esconde frestas entre formas vizinhas (px do documento) */
export const SEAM = 0.6;

/** polilinha de um anel (para distância ao contorno) */
export function ringPolyline(ring: CutPt[], steps = 8): number[] {
  const b = ringBeziers(ring);
  const out: number[] = [b.x, b.y];
  let x = b.x, y = b.y;
  for (const g of b.segs) {
    for (let k = 1; k <= steps; k++) {
      const t = k / steps, u = 1 - t;
      out.push(u * u * u * x + 3 * u * u * t * g[0] + 3 * u * t * t * g[2] + t * t * t * g[4],
        u * u * u * y + 3 * u * u * t * g[1] + 3 * u * t * t * g[3] + t * t * t * g[5]);
    }
    x = g[4]; y = g[5];
  }
  return out;
}
/** espessura média da forma (2·área/perímetro): ≈ largura de um traço; ≈ raio de uma mancha redonda */
export function shapeThickness(s: VecShape): number {
  let area = 0, per = 0;
  s.rings.forEach((ring, k) => {
    const p = ringPolyline(ring, 6);
    let a = 0;
    for (let i = 0; i + 1 < p.length; i += 2) {
      const j = (i + 2) % p.length;
      a += p[i] * p[j + 1] - p[j] * p[i + 1];
      per += Math.hypot(p[j] - p[i], p[j + 1] - p[i + 1]);
    }
    area += (k === 0 ? 1 : -1) * Math.abs(a / 2);
  });
  return per > 0 ? (2 * Math.max(0, area)) / per : 0;
}
export function shapeBounds(s: VecShape): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of s.rings[0] || []) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ---------------------------------------------------------------- dados da camada (clonar / validar)
const clonePt = (p: CutPt): CutPt => (p.c ? { x: p.x, y: p.y, c: 1 } : { x: p.x, y: p.y });
export function cloneShape(s: VecShape, newId = false): VecShape {
  return { id: newId ? uid() : s.id, color: s.color, rings: s.rings.map((r) => r.map(clonePt)) };
}
export function cloneVec(v: VecData, newIds = false): VecData {
  return { shapes: v.shapes.map((s) => cloneShape(s, newIds)) };
}
const validRing = (r: any) => Array.isArray(r) && r.length >= 3 && r.every((p: any) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
/** saneia dados vindos de um arquivo de projeto; null = inválido */
export function sanitizeVec(v: any): VecData | null {
  if (!v || !Array.isArray(v.shapes)) return null;
  const shapes: VecShape[] = [];
  for (const s of v.shapes) {
    if (!s || !Array.isArray(s.rings)) continue;
    const rings = s.rings.filter(validRing).map((r: any[]) => r.map((p) => clonePt({ x: +p.x, y: +p.y, c: p.c ? 1 : undefined })));
    if (!rings.length) continue;
    shapes.push({ id: typeof s.id === 'string' && s.id ? s.id : uid(), color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#000000', rings });
  }
  return { shapes };
}

// ---------------------------------------------------------------- traço → linhas do Giffact
export interface ToLinesOpts { minLength?: number }

/**
 * Converte formas preenchidas (ex.: o traço escuro) em linhas: rasteriza, afina até o esqueleto
 * (Zhang-Suen), mede a espessura (transformada de distância) e ajusta curvas com pressão = espessura local.
 */
export function shapesToStrokes(shapes: VecShape[], W: number, H: number, color?: string, o: ToLinesOpts = {}): Stroke[] {
  if (!shapes.length) return [];
  const f = W * H <= 1200 * 1200 ? 2 : 1;
  const RW = Math.ceil(W * f) + 2, RH = Math.ceil(H * f) + 2;
  const c = document.createElement('canvas');
  c.width = RW; c.height = RH;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.setTransform(f, 0, 0, f, 1, 1);
  g.fillStyle = '#000';
  for (const s of shapes) g.fill(shapePath(s), 'evenodd');
  const img = g.getImageData(0, 0, RW, RH).data;
  c.width = c.height = 0;
  const N = RW * RH;
  const bin = new Uint8Array(N);
  for (let i = 0; i < N; i++) bin[i] = img[i * 4 + 3] >= 128 ? 1 : 0;
  // transformada de distância (chanfro 1 / √2) até o fundo
  const dt = new Float32Array(N);
  const BIG = 1e9, D2 = Math.SQRT2;
  for (let i = 0; i < N; i++) dt[i] = bin[i] ? BIG : 0;
  for (let y = 1; y < RH - 1; y++) for (let x = 1; x < RW - 1; x++) {
    const i = y * RW + x;
    if (!dt[i]) continue;
    dt[i] = Math.min(dt[i], dt[i - 1] + 1, dt[i - RW] + 1, dt[i - RW - 1] + D2, dt[i - RW + 1] + D2);
  }
  for (let y = RH - 2; y >= 1; y--) for (let x = RW - 2; x >= 1; x--) {
    const i = y * RW + x;
    if (!dt[i]) continue;
    dt[i] = Math.min(dt[i], dt[i + 1] + 1, dt[i + RW] + 1, dt[i + RW + 1] + D2, dt[i + RW - 1] + D2);
  }
  // afinamento Zhang-Suen (só nos pixels candidatos)
  const sk = bin;
  let cand: number[] = [];
  for (let i = 0; i < N; i++) if (sk[i]) cand.push(i);
  const nbZ = (i: number) => [sk[i - RW], sk[i - RW + 1], sk[i + 1], sk[i + RW + 1], sk[i + RW], sk[i + RW - 1], sk[i - 1], sk[i - RW - 1]];
  for (let iter = 0; iter < 200; iter++) {
    let removed = 0;
    for (let step = 0; step < 2; step++) {
      const del: number[] = [];
      for (const i of cand) {
        if (!sk[i]) continue;
        const p = nbZ(i);
        const B = p[0] + p[1] + p[2] + p[3] + p[4] + p[5] + p[6] + p[7];
        if (B < 2 || B > 6) continue;
        let A = 0;
        for (let k = 0; k < 8; k++) if (!p[k] && p[(k + 1) & 7]) A++;
        if (A !== 1) continue;
        if (step === 0) { if (p[0] * p[2] * p[4] || p[2] * p[4] * p[6]) continue; }
        else if (p[0] * p[2] * p[6] || p[0] * p[4] * p[6]) continue;
        del.push(i);
      }
      for (const i of del) sk[i] = 0;
      removed += del.length;
    }
    cand = cand.filter((i) => sk[i]);
    if (!removed) break;
  }
  // remove pixels redundantes (degraus em "L"): o esqueleto fica 8-fino, sem junções falsas
  const OFF = [-RW - 1, -RW, -RW + 1, -1, 1, RW - 1, RW, RW + 1];
  // anel de vizinhos N, NE, E, SE, S, SW, W, NW
  const RING = [-RW, -RW + 1, 1, RW + 1, RW, RW - 1, -1, -RW - 1];
  const nbGroups = (i: number) => {
    const v = RING.map((o2) => sk[i + o2]);
    let B = 0;
    for (const x of v) B += x;
    if (!B) return { B, G: 0 };
    // componentes 8-conexos entre os vizinhos (consecutivos no anel; ortogonais vizinhos via canto)
    const par = [0, 1, 2, 3, 4, 5, 6, 7];
    const find = (x: number): number => (par[x] === x ? x : (par[x] = find(par[x])));
    const join = (a2: number, b2: number) => { if (v[a2] && v[b2]) par[find(a2)] = find(b2); };
    for (let k = 0; k < 8; k++) join(k, (k + 1) & 7);
    join(0, 2); join(2, 4); join(4, 6); join(6, 0);
    const roots = new Set<number>();
    for (let k = 0; k < 8; k++) if (v[k]) roots.add(find(k));
    return { B, G: roots.size };
  };
  for (let pass = 0; pass < 6; pass++) {
    let ch = 0;
    for (const i of cand) {
      if (!sk[i]) continue;
      const { B, G } = nbGroups(i);
      if (B >= 2 && G === 1) {
        // só remove se nenhum vizinho virar ponta solta por causa disso
        sk[i] = 0;
        let breaks = false;
        for (const o2 of OFF) { const j = i + o2; if (sk[j] && nbGroups(j).B === 0) { breaks = true; break; } }
        if (breaks) sk[i] = 1; else ch++;
      }
    }
    cand = cand.filter((i) => sk[i]);
    if (!ch) break;
  }
  const deg = (i: number) => { let d = 0; for (const o2 of OFF) if (sk[i + o2]) d++; return d; };
  type Chain = { pts: number[]; closed: boolean; endA: number; endB: number };
  const extract = (): Chain[] => {
    const pix = cand.filter((i) => sk[i]);
    const dg = new Map<number, number>();
    for (const i of pix) dg.set(i, deg(i));
    const visitedEdge = new Set<string>();
    const ek = (a2: number, b2: number) => (a2 < b2 ? a2 + ',' + b2 : b2 + ',' + a2);
    const isNode = (i: number) => (dg.get(i) || 0) !== 2;
    const out: Chain[] = [];
    const walk = (start: number, next: number) => {
      const pts = [start, next];
      visitedEdge.add(ek(start, next));
      let prev = start, cur = next;
      while (!isNode(cur)) {
        let nxt = -1;
        for (const o2 of OFF) {
          const j = cur + o2;
          if (sk[j] && j !== prev && !visitedEdge.has(ek(cur, j))) { nxt = j; break; }
        }
        if (nxt < 0) break;
        visitedEdge.add(ek(cur, nxt));
        pts.push(nxt);
        if (nxt === start) break;
        prev = cur; cur = nxt;
      }
      return pts;
    };
    for (const i of pix) {
      if (!isNode(i)) continue;
      for (const o2 of OFF) {
        const j = i + o2;
        if (!sk[j] || visitedEdge.has(ek(i, j))) continue;
        // aresta entre dois pixels de um mesmo aglomerado de junção
        if ((dg.get(i) || 0) > 2 && (dg.get(j) || 0) > 2) { visitedEdge.add(ek(i, j)); continue; }
        const pts = walk(i, j);
        out.push({ pts, closed: false, endA: dg.get(pts[0]) || 0, endB: dg.get(pts[pts.length - 1]) || 0 });
      }
    }
    // ciclos sem nós (ex.: um anel)
    for (const i of pix) {
      if (isNode(i)) continue;
      let j = -1;
      for (const o2 of OFF) { const q2 = i + o2; if (sk[q2] && !visitedEdge.has(ek(i, q2))) { j = q2; break; } }
      if (j < 0) continue;
      const pts = walk(i, j);
      out.push({ pts, closed: pts.length > 3 && pts[pts.length - 1] === pts[0], endA: 2, endB: 2 });
    }
    return out;
  };
  // poda de esporas (ramos curtos de ponta solta ligados a uma junção), repetida até estabilizar
  const rAt = (i: number) => Math.max(0.5, dt[i] - 0.5);
  let chains = extract();
  for (let it = 0; it < 4; it++) {
    let pruned = 0;
    for (const ch of chains) {
      if (ch.closed) continue;
      const a1 = ch.endA === 1 && ch.endB > 2, b1 = ch.endB === 1 && ch.endA > 2;
      if (!a1 && !b1) continue;
      const jn = a1 ? ch.pts[ch.pts.length - 1] : ch.pts[0];
      if (ch.pts.length < Math.max(3 * f, 2.2 * rAt(jn))) {
        for (const i of ch.pts) if (i !== jn) sk[i] = 0;
        pruned++;
      }
    }
    if (!pruned) break;
    chains = extract();
  }
  const minLen = (o.minLength ?? 2.5) * f;
  const strokes: Stroke[] = [];
  for (const ch of chains) {
    let pts = ch.pts;
    if (ch.closed) pts = pts.slice(0, -1);
    const len = pts.length;
    if (len < minLen && !(ch.endA > 2 && ch.endB > 2)) continue;
    let P: Pt[] = pts.map((i) => ({ x: ((i % RW) - 1 + 0.5) / f, y: (((i / RW) | 0) - 1 + 0.5) / f, p: rAt(i) / f }));
    // suaviza posição e espessura (pontas fixas)
    for (let pass = 0; pass < 2; pass++) {
      if (P.length < 4) break;
      const Q: Pt[] = [P[0]];
      for (let k = 1; k < P.length - 1; k++) Q.push({ x: (P[k - 1].x + 2 * P[k].x + P[k + 1].x) / 4, y: (P[k - 1].y + 2 * P[k].y + P[k + 1].y) / 4, p: (P[k - 1].p + 2 * P[k].p + P[k + 1].p) / 4 });
      Q.push(P[P.length - 1]);
      P = Q;
    }
    const rs = P.map((q) => q.p).sort((a, b) => a - b);
    const rMax = Math.max(0.4, rs[Math.min(rs.length - 1, Math.floor(rs.length * 0.8))]);
    const norm = P.map((q) => ({ x: q.x, y: q.y, p: Math.max(0.15, Math.min(1, q.p / rMax)) }));
    let fitted = fitCurve(norm, 0.55);
    if (ch.closed && fitted.length > 3) {
      const a = fitted[0], b = fitted[fitted.length - 1];
      if (Math.hypot(a.x - b.x, a.y - b.y) < 1.5) fitted = fitted.slice(0, -1);
    }
    if (fitted.length < 2) {
      if (P.length >= 2) fitted = [norm[0], norm[norm.length - 1]]; else continue;
    }
    strokes.push({
      id: uid(), kind: 'curve', pts: fitted.map((q) => ({ x: r2(q.x), y: r2(q.y), p: Math.round(q.p * 1000) / 1000 })),
      closed: ch.closed && fitted.length > 2, width: Math.round(rMax * 2 * 100) / 100,
      color: color || '#111111', taperStart: 0, taperEnd: 0,
    });
  }
  return strokes;
}
