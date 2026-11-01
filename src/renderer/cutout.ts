// Ferramenta Recorte: desenha uma máscara fechada (curva suave ou polígono) e recorta os pixels
// do quadro do GIF dentro dela para uma nova camada de imagem (transparente fora da máscara).
import { S, activeLayer, emit, markChanged, newLayer, on, pushUndo, toast } from './state';
import type { CutMask, CutPt, Layer } from './types';
import { cloneMask, maskBounds, maskPath2D, maskPolyline, pointInMask, renderCut } from './cutmask';
import { docToScreen, px, requestRender, updateCursor, viewMatrix, type PointerInfo, type Tool } from './view';
import { t } from './i18n';

type Drag =
  | { kind: 'pt'; i: number; moved: boolean }
  | { kind: 'all'; x0: number; y0: number; orig: CutPt[]; moved: boolean };

export class CutoutTool implements Tool {
  cursor = 'crosshair';
  /** mantém a máscara pendente ao trocar de quadro/ferramenta */
  persistent = true;
  mode: 'idle' | 'draw' | 'edit' = 'idle';
  pts: CutPt[] = [];
  hov: { x: number; y: number } | null = null;
  lastDownT = 0;
  drag: Drag | null = null;
  /** nome da camada de recorte sendo reeditada (null = recorte novo) */
  editName: string | null = null;
  editFrame = -1;
  editLayerId: string | null = null;
  rangeFrom = 1;
  rangeTo = 1;
  private ver = 0;
  private pvKey = '';
  private pvCanvas: HTMLCanvasElement | null = null;

  constructor() {
    on('loaded', () => { this.reset(); this.rangeFrom = 1; this.rangeTo = S.frames.length; });
  }

  private changed() { this.ver++; requestRender(); }
  private state() { emit('cutstate'); }
  reset() {
    this.mode = 'idle'; this.pts = []; this.hov = null; this.drag = null;
    this.editName = null; this.editFrame = -1; this.editLayerId = null;
    this.pvCanvas = null; this.pvKey = '';
    this.changed(); this.state();
    S.version++; // camada reeditada volta a aparecer
  }
  get pending() { return this.mode !== 'idle'; }

  private snap(p: { x: number; y: number; shift: boolean }) {
    if (p.shift && this.pts.length) {
      const l = this.pts[this.pts.length - 1];
      const dx = p.x - l.x, dy = p.y - l.y;
      const step = Math.PI / 12;
      const ang = Math.round(Math.atan2(dy, dx) / step) * step;
      const d = Math.hypot(dx, dy);
      return { x: l.x + Math.cos(ang) * d, y: l.y + Math.sin(ang) * d };
    }
    return { x: p.x, y: p.y };
  }
  private nearFirst(p: { x: number; y: number }) {
    return this.pts.length >= 3 && Math.hypot(p.x - this.pts[0].x, p.y - this.pts[0].y) <= px(8);
  }
  private hitHandle(p: { x: number; y: number }): number {
    let best = -1, bd = px(8);
    this.pts.forEach((q, i) => { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d <= bd) { bd = d; best = i; } });
    return best;
  }
  /** segmento do contorno (polígono de controle) mais próximo, para inserir ponto */
  private hitSegment(p: { x: number; y: number }): number {
    const n = this.pts.length;
    const poly = maskPolyline(this.pts, true);
    let onOutline = false;
    for (let i = 0; i < poly.length && !onOutline; i += 2) {
      const j = (i + 2) % poly.length;
      if (distSeg(p.x, p.y, poly[i], poly[i + 1], poly[j], poly[j + 1]) <= px(6)) onOutline = true;
    }
    if (!onOutline) return -1;
    let best = -1, bd = Infinity;
    for (let i = 0; i < n; i++) {
      const a = this.pts[i], b = this.pts[(i + 1) % n];
      const d = distSeg(p.x, p.y, a.x, a.y, b.x, b.y);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  mask(): CutMask { return { pts: this.pts, feather: S.settings.cutFeather }; }

  down(p: PointerInfo) {
    if (!S.loaded) return;
    if (this.mode === 'edit') { this.editDown(p); return; }
    if (p.button === 2) { this.undoPoint(); return; }
    const prevDownT = this.lastDownT;
    this.lastDownT = p.time;
    const q = this.snap(p);
    if (this.mode === 'draw' && this.nearFirst(q)) { this.close(); return; }
    const last = this.pts[this.pts.length - 1];
    if (last && Math.hypot(q.x - last.x, q.y - last.y) <= px(4)) {
      // duplo clique (2º clique rápido no mesmo lugar) fecha a máscara
      if (p.time - prevDownT < 500) this.close();
      return;
    }
    if (this.mode === 'idle') { this.mode = 'draw'; this.editName = null; this.editLayerId = null; this.state(); }
    const corner = S.settings.cutPoly || p.alt;
    this.pts.push(corner ? { x: q.x, y: q.y, c: 1 } : { x: q.x, y: q.y });
    this.hov = q;
    this.changed(); this.state();
  }
  private editDown(p: PointerInfo) {
    const hi = this.hitHandle(p);
    if (p.button === 2) {
      // botão direito: remove o ponto (mínimo de 3)
      if (hi >= 0 && this.pts.length > 3) { this.pts.splice(hi, 1); this.changed(); }
      return;
    }
    if (hi >= 0) {
      if (p.alt) { const q = this.pts[hi]; if (q.c) delete q.c; else q.c = 1; this.changed(); return; }
      this.drag = { kind: 'pt', i: hi, moved: false };
      return;
    }
    const seg = this.hitSegment(p);
    if (seg >= 0) {
      const np: CutPt = S.settings.cutPoly || p.alt ? { x: p.x, y: p.y, c: 1 } : { x: p.x, y: p.y };
      this.pts.splice(seg + 1, 0, np);
      this.drag = { kind: 'pt', i: seg + 1, moved: true };
      this.changed();
      return;
    }
    if (pointInMask(this.mask(), p.x, p.y)) {
      this.drag = { kind: 'all', x0: p.x, y0: p.y, orig: this.pts.map((q) => ({ ...q })), moved: false };
    }
  }
  move(p: PointerInfo) {
    if (this.mode === 'edit' && this.drag) {
      const d = this.drag;
      if (d.kind === 'pt') { this.pts[d.i].x = p.x; this.pts[d.i].y = p.y; }
      else {
        const dx = p.x - d.x0, dy = p.y - d.y0;
        this.pts = d.orig.map((q) => ({ ...q, x: q.x + dx, y: q.y + dy }));
      }
      d.moved = true;
      this.changed();
      return;
    }
    this.hover(p);
  }
  up() { if (this.drag) { this.drag = null; this.changed(); } }
  hover(p: PointerInfo) {
    this.hov = this.snap(p);
    if (this.mode === 'edit') {
      const hi = this.hitHandle(p);
      this.cursor = hi >= 0 ? 'move' : this.hitSegment(p) >= 0 ? 'copy' : pointInMask(this.mask(), p.x, p.y) ? 'grab' : 'default';
    } else this.cursor = 'crosshair';
    if (!this.drag) updateCursor();
    if (this.mode === 'draw') requestRender();
  }
  dbl() { if (this.mode === 'draw') this.close(); }

  undoPoint() {
    if (this.mode !== 'draw' || !this.pts.length) return;
    this.pts.pop();
    this.lastDownT = 0;
    if (!this.pts.length) this.mode = 'idle';
    this.changed(); this.state();
  }
  /** fecha a máscara e passa ao modo de edição (pontos ainda podem ser movidos antes de aplicar) */
  close(): boolean {
    if (this.mode !== 'draw') return false;
    if (this.pts.length < 3) { toast(t('toast.cutFew'), 'warn'); return false; }
    this.mode = 'edit';
    this.hov = null;
    this.changed(); this.state();
    return true;
  }
  cancel() { if (this.mode !== 'idle') this.reset(); }

  /** carrega a máscara da camada de recorte ativa para reedição */
  editActive(): boolean {
    const L = activeLayer();
    if (!L?.cut) return false;
    this.mode = 'edit';
    this.pts = cloneMask(L.cut).pts;
    this.editName = L.name;
    this.editFrame = S.cur;
    this.editLayerId = L.id;
    S.settings.cutFeather = L.cut.feather || 0;
    S.version++;
    emit('settings');
    this.changed(); this.state();
    return true;
  }

  targetFrames(): number[] {
    const n = S.frames.length;
    const sc = S.settings.cutScope;
    let list: number[];
    if (sc === 'all') list = Array.from({ length: n }, (_, i) => i);
    else if (sc === 'range') {
      const a = Math.max(1, Math.min(n, this.rangeFrom || 1)), b = Math.max(1, Math.min(n, this.rangeTo || n));
      list = [];
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) list.push(i - 1);
    } else list = [S.cur];
    if (this.editName != null && this.editFrame >= 0 && this.editFrame < n && !list.includes(this.editFrame)) list.push(this.editFrame);
    return list.sort((x, y) => x - y);
  }

  /** aplica o recorte: cria (ou atualiza) a camada de recorte nos quadros escolhidos. Retorna nº de quadros. */
  apply(): number {
    if (this.mode === 'draw' && !this.close()) return 0;
    if (this.mode !== 'edit' || this.pts.length < 3) return 0;
    const m: CutMask = cloneMask({ pts: this.pts, feather: Math.max(0, S.settings.cutFeather || 0) });
    const b = maskBounds(m);
    if (b.w < 0.5 || b.h < 0.5 || b.x > S.docW || b.y > S.docH || b.x + b.w < 0 || b.y + b.h < 0) {
      toast(t('toast.cutEmpty'), 'warn');
      return 0;
    }
    const name = this.editName ?? uniqueCutName();
    const frames = this.targetFrames();
    const idx = S.docs[S.cur].activeLayer + (this.editName ? 0 : 1);
    let count = 0;
    for (const fi of frames) {
      const doc = S.docs[fi];
      let L: Layer | undefined = (fi === this.editFrame && this.editLayerId ? doc.layers.find((l) => l.id === this.editLayerId) : undefined)
        || doc.layers.find((l) => l.name === name && !!l.cut);
      if (L?.locked) continue;
      pushUndo(fi);
      if (!L) {
        L = newLayer(name);
        const at = Math.max(0, Math.min(idx, doc.layers.length));
        doc.layers.splice(at, 0, L);
        if (fi === S.cur) doc.activeLayer = at;
      } else if (fi === S.cur) doc.activeLayer = doc.layers.indexOf(L);
      L.strokes = [];
      L.cut = cloneMask(m);
      markChanged(fi);
      count++;
    }
    S.selection.clear();
    this.reset();
    emit('layers', 'selection');
    if (count) toast(t('toast.cutDone', { name, n: count }), 'ok');
    return count;
  }

  key(e: KeyboardEvent): boolean {
    if (this.mode === 'idle') return false;
    if (e.key === 'Enter') {
      if (this.mode === 'draw') this.close(); else this.apply();
      return true;
    }
    if (e.key === 'Escape') { this.cancel(); return true; }
    if (this.mode === 'draw' && (e.key === 'Backspace' || (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey))) {
      this.undoPoint();
      return true;
    }
    return false;
  }

  /** camada reeditada some do desenho normal enquanto a prévia é mostrada */
  exclude(): Set<string> | null {
    return this.mode === 'edit' && this.editLayerId && S.cur === this.editFrame ? new Set([this.editLayerId]) : null;
  }

  overlay(g: CanvasRenderingContext2D) {
    if (!S.loaded) return;
    const M = viewMatrix();
    if (this.mode === 'idle') {
      // contorno discreto da camada de recorte ativa
      const L = activeLayer();
      if (L?.cut && L.visible) {
        g.save(); g.transform(M.a, M.b, M.c, M.d, M.e, M.f);
        const path = maskPath2D(L.cut);
        g.restore();
        antsPath(g, path, M, 0.6);
      }
      return;
    }
    if (this.mode === 'edit') {
      const fr = S.frames[S.cur]?.canvas;
      const m = this.mask();
      const path = maskPath2D(m);
      g.save();
      g.transform(M.a, M.b, M.c, M.d, M.e, M.f);
      // escurece o lado de fora da máscara
      const outside = new Path2D();
      outside.rect(0, 0, S.docW, S.docH);
      outside.addPath(path);
      g.fillStyle = 'rgba(10,12,20,0.45)';
      g.fill(outside, 'evenodd');
      // prévia do recorte (pixels do quadro, opacidade cheia)
      if (fr) {
        const key = `${this.ver}|${S.cur}|${m.feather}`;
        if (key !== this.pvKey || !this.pvCanvas) { this.pvKey = key; this.pvCanvas = renderCut(m, fr, fr.width, fr.height); }
        g.imageSmoothingEnabled = S.view.zoom < 3;
        g.drawImage(this.pvCanvas, 0, 0);
      }
      g.restore();
      antsPath(g, path, M, 1);
      this.pts.forEach((q, i) => drawHandle(g, q, this.drag?.kind === 'pt' && this.drag.i === i ? '#ffd23f' : '#ffffff', !q.c));
      return;
    }
    // desenhando: contorno aberto até o cursor
    const pts = this.pts.slice();
    const closing = this.hov && this.nearFirst(this.hov);
    if (this.hov && !closing) pts.push(S.settings.cutPoly ? { ...this.hov, c: 1 } : { ...this.hov });
    const poly = maskPolyline(pts, !!closing);
    const path = new Path2D();
    for (let i = 0; i < poly.length; i += 2) { if (i) path.lineTo(poly[i], poly[i + 1]); else path.moveTo(poly[i], poly[i + 1]); }
    if (closing) path.closePath();
    antsPath(g, path, M, 1);
    this.pts.forEach((q, i) => drawHandle(g, q, i === 0 ? (closing ? '#ffd23f' : '#9fd0ff') : '#ffffff', !q.c, i === 0 && closing ? 11 : 7));
  }
}

function uniqueCutName(): string {
  const names = new Set<string>();
  for (const d of S.docs) for (const l of d.layers) names.add(l.name);
  let i = 1;
  while (names.has(t('layer.cutName', { n: i }))) i++;
  return t('layer.cutName', { n: i });
}

/** contorno tracejado preto/branco ("formigas") de um caminho em coordenadas do documento */
function antsPath(g: CanvasRenderingContext2D, path: Path2D, M: DOMMatrix, alpha: number) {
  g.save();
  g.globalAlpha = alpha;
  g.transform(M.a, M.b, M.c, M.d, M.e, M.f);
  const lw = 1.5 / Math.max(1e-6, S.view.zoom);
  g.lineWidth = lw; g.lineJoin = 'round';
  g.strokeStyle = '#ffffff'; g.setLineDash([]); g.stroke(path);
  g.strokeStyle = '#1060ff'; g.setLineDash([5 * lw, 4 * lw]); g.stroke(path);
  g.restore();
}
function drawHandle(g: CanvasRenderingContext2D, q: { x: number; y: number }, fill: string, round: boolean, size = 7) {
  const s = docToScreen(q.x, q.y);
  g.beginPath();
  if (round) g.arc(s.x, s.y, size / 2, 0, Math.PI * 2);
  else g.rect(s.x - size / 2, s.y - size / 2, size, size);
  g.fillStyle = fill; g.fill();
  g.lineWidth = 1; g.strokeStyle = '#1b1b1f'; g.stroke();
}
function distSeg(px_: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let u = l2 ? ((px_ - ax) * dx + (py - ay) * dy) / l2 : 0;
  u = Math.max(0, Math.min(1, u));
  return Math.hypot(px_ - (ax + u * dx), py - (ay + u * dy));
}
