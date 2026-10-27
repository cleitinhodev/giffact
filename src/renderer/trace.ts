// Auto-traçado experimental: bordas (Canny simplificado) -> cadeias -> traços vetoriais editáveis
import type { Pt, Stroke } from './types';
import { fitCurve, uid } from './geom';

export interface TraceOptions {
  threshold: number; // 1..100 (maior = mais linhas)
  blur: number; // 0..4
  minLength: number; // px
  width: number;
  color: string;
}

export function traceCanvas(src: HTMLCanvasElement, o: TraceOptions): Stroke[] {
  const W = src.width, H = src.height;
  const data = src.getContext('2d')!.getImageData(0, 0, W, H).data;
  const N = W * H;
  let g: Float32Array = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = data[i * 4 + 3] / 255;
    const l = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    g[i] = l * a + 255 * (1 - a);
  }
  // desfoque gaussiano aproximado (passadas [1 2 1])
  for (let pass = 0; pass < o.blur; pass++) {
    const t = new Float32Array(N);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const l = x > 0 ? g[i - 1] : g[i], r = x < W - 1 ? g[i + 1] : g[i];
      t[i] = (l + 2 * g[i] + r) / 4;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const u = y > 0 ? t[i - W] : t[i], d = y < H - 1 ? t[i + W] : t[i];
      g[i] = (u + 2 * t[i] + d) / 4;
    }
  }
  // Sobel
  const mag = new Float32Array(N);
  const dir = new Uint8Array(N);
  let maxM = 0;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    const gx = -g[i - W - 1] - 2 * g[i - 1] - g[i + W - 1] + g[i - W + 1] + 2 * g[i + 1] + g[i + W + 1];
    const gy = -g[i - W - 1] - 2 * g[i - W] - g[i - W + 1] + g[i + W - 1] + 2 * g[i + W] + g[i + W + 1];
    const m = Math.hypot(gx, gy);
    mag[i] = m;
    if (m > maxM) maxM = m;
    let a = (Math.atan2(gy, gx) * 180) / Math.PI;
    if (a < 0) a += 180;
    dir[i] = a < 22.5 || a >= 157.5 ? 0 : a < 67.5 ? 1 : a < 112.5 ? 2 : 3;
  }
  // supressão de não-máximos
  const nms = new Float32Array(N);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    const m = mag[i];
    if (m === 0) continue;
    let a = 0, b = 0;
    switch (dir[i]) {
      case 0: a = mag[i - 1]; b = mag[i + 1]; break;
      case 1: a = mag[i - W - 1]; b = mag[i + W + 1]; break;
      case 2: a = mag[i - W]; b = mag[i + W]; break;
      default: a = mag[i - W + 1]; b = mag[i + W - 1];
    }
    if (m >= a && m >= b) nms[i] = m;
  }
  // limiares + histerese
  const t01 = Math.max(0, Math.min(1, o.threshold / 100));
  const high = maxM * (0.55 - 0.5 * t01);
  const low = high * 0.45;
  const edge = new Uint8Array(N);
  const stack: number[] = [];
  for (let i = 0; i < N; i++) if (nms[i] >= high) { edge[i] = 1; stack.push(i); }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % W, y = (i / W) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const j = yy * W + xx;
      if (!edge[j] && nms[j] >= low) { edge[j] = 1; stack.push(j); }
    }
  }
  g = new Float32Array(0);
  // rastreia cadeias
  const NB = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]];
  const visited = new Uint8Array(N);
  const neighbors = (i: number) => {
    const x = i % W, y = (i / W) | 0;
    const res: number[] = [];
    for (const [dx, dy] of NB) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const j = yy * W + xx;
      if (edge[j]) res.push(j);
    }
    return res;
  };
  const chains: number[][] = [];
  const walk = (start: number) => {
    const chain = [start];
    visited[start] = 1;
    let cur = start;
    for (;;) {
      const nb = neighbors(cur).filter((j) => !visited[j]);
      if (!nb.length) break;
      cur = nb[0];
      visited[cur] = 1;
      chain.push(cur);
    }
    return chain;
  };
  // primeiro a partir das pontas
  for (let i = 0; i < N; i++) {
    if (!edge[i] || visited[i]) continue;
    if (neighbors(i).length === 1) {
      const c = walk(i);
      // tenta estender pelo outro lado também
      chains.push(c);
    }
  }
  for (let i = 0; i < N; i++) {
    if (!edge[i] || visited[i]) continue;
    const c = walk(i);
    const rest = walk2(c[0]);
    chains.push(rest.reverse().concat(c));
  }
  function walk2(start: number): number[] {
    const out: number[] = [];
    let cur = start;
    for (;;) {
      const nb = neighbors(cur).filter((j) => !visited[j]);
      if (!nb.length) break;
      cur = nb[0];
      visited[cur] = 1;
      out.push(cur);
    }
    return out;
  }
  const strokes: Stroke[] = [];
  for (const c of chains) {
    if (c.length < o.minLength) continue;
    let pts: Pt[] = c.map((i) => ({ x: (i % W) + 0.5, y: ((i / W) | 0) + 0.5, p: 1 }));
    // suaviza (média móvel)
    if (pts.length > 4) {
      const sm: Pt[] = [pts[0]];
      for (let k = 1; k < pts.length - 1; k++) sm.push({ x: (pts[k - 1].x + 2 * pts[k].x + pts[k + 1].x) / 4, y: (pts[k - 1].y + 2 * pts[k].y + pts[k + 1].y) / 4, p: 1 });
      sm.push(pts[pts.length - 1]);
      pts = sm;
    }
    const first = pts[0], last = pts[pts.length - 1];
    const closed = pts.length > 12 && Math.hypot(first.x - last.x, first.y - last.y) < 1.6;
    const fitted = fitCurve(pts, 0.7);
    if (fitted.length < 2) continue;
    if (closed && fitted.length > 3) fitted.pop();
    strokes.push({
      id: uid(), kind: 'curve', pts: fitted, closed: closed && fitted.length > 2, width: o.width, color: o.color,
      taperStart: closed ? 0 : 0.1, taperEnd: closed ? 0 : 0.1,
    });
  }
  return strokes;
}
