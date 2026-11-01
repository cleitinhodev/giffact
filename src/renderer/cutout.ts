// Ferramenta Recorte: desenha uma máscara fechada (curva suave ou polígono) e recorta os pixels
// do quadro do GIF dentro dela para uma nova camada de imagem (transparente fora da máscara).
import { S, activeLayer, emit, markChanged, newLayer, on, pushUndo, toast } from './state';
import type { CutMask, CutPt, Layer } from './types';
import { cloneHoles, cloneMask, maskBounds, maskPath2D, maskPolyline, pointInMask, pointInPts, ptsPath2D, renderCut } from './cutmask';
import { docToScreen, px, requestRender, updateCursor, viewMatrix, type PointerInfo, type Tool } from './view';
import { t } from './i18n';

type Drag =
  | { kind: 'pt'; i: number; moved: boolean }
  | { kind: 'all'; x0: number; y0: number; orig: CutPt[]; moved: boolean };
/** arraste de uma área vermelha pendente (modo Subtrair) */
type SubDrag =
  | { kind: 'pt'; s: number; i: number }
  | { kind: 'all'; s: number; x0: number; y0: number; orig: CutPt[] };

export const SUB_RED = '#ff2d55';

export class CutoutTool implements Tool {
  cursor = 'crosshair';
  /** mantém a máscara pendente ao trocar de quadro/ferramenta */
  persistent = true;
  /** 'sub' = Subtrair: áreas vermelhas removidas de uma camada de recorte já aplicada */
  mode: 'idle' | 'draw' | 'edit' | 'sub' = 'idle';
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
  /** áreas já removidas da camada reeditada (preservadas ao reaplicar a máscara) */
  editHoles: CutPt[][] = [];
  // ---- Subtrair ----
  /** nome da camada de recorte alvo */
  subName: string | null = null;
  /** áreas vermelhas fechadas, pendentes até "Remover" */
  subShapes: CutPt[][] = [];
  /** área vermelha sendo desenhada */
  subCur: CutPt[] = [];
  subActive = -1;
  subDrag: SubDrag | null = null;
  /** 'current' = só o quadro atual; 'layer' = todos os quadros com esta camada de recorte */
  subScope: 'current' | 'layer' = 'current';
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
    this.editName = null; this.editFrame = -1; this.editLayerId = null; this.editHoles = [];
    this.subName = null; this.subShapes = []; this.subCur = []; this.subActive = -1; this.subDrag = null;
    this.pvCanvas = null; this.pvKey = '';
    this.changed(); this.state();
    S.version++; // camada reeditada volta a aparecer
  }
  get pending() { return this.mode !== 'idle'; }

  private snap(p: { x: number; y: number; shift: boolean }, pts = this.pts) {
    if (p.shift && pts.length) {
      const l = pts[pts.length - 1];
      const dx = p.x - l.x, dy = p.y - l.y;
      const step = Math.PI / 12;
      const ang = Math.round(Math.atan2(dy, dx) / step) * step;
      const d = Math.hypot(dx, dy);
      return { x: l.x + Math.cos(ang) * d, y: l.y + Math.sin(ang) * d };
    }
    return { x: p.x, y: p.y };
  }
  private nearFirst(p: { x: number; y: number }, pts = this.pts) {
    return pts.length >= 3 && Math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= px(8);
  }
  private hitHandle(p: { x: number; y: number }, pts = this.pts): number {
    let best = -1, bd = px(8);
    pts.forEach((q, i) => { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d <= bd) { bd = d; best = i; } });
    return best;
  }
  /** segmento do contorno (polígono de controle) mais próximo, para inserir ponto */
  private hitSegment(p: { x: number; y: number }, pts = this.pts): number {
    const n = pts.length;
    const poly = maskPolyline(pts, true);
    let onOutline = false;
    for (let i = 0; i < poly.length && !onOutline; i += 2) {
      const j = (i + 2) % poly.length;
      if (distSeg(p.x, p.y, poly[i], poly[i + 1], poly[j], poly[j + 1]) <= px(6)) onOutline = true;
    }
    if (!onOutline) return -1;
    let best = -1, bd = Infinity;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const d = distSeg(p.x, p.y, a.x, a.y, b.x, b.y);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  mask(): CutMask {
    const m: CutMask = { pts: this.pts, feather: S.settings.cutFeather };
    if (this.editHoles.length) m.holes = this.editHoles;
    return m;
  }

  down(p: PointerInfo) {
    if (!S.loaded) return;
    if (this.mode === 'sub') { this.subDown(p); return; }
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
    if (this.mode === 'sub' && this.subDrag) {
      const d = this.subDrag, sh = this.subShapes[d.s];
      if (sh) {
        if (d.kind === 'pt') { sh[d.i].x = p.x; sh[d.i].y = p.y; }
        else { const dx = p.x - d.x0, dy = p.y - d.y0; this.subShapes[d.s] = d.orig.map((q) => ({ ...q, x: q.x + dx, y: q.y + dy })); }
        this.changed();
      }
      return;
    }
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
  up() {
    if (this.drag) { this.drag = null; this.changed(); }
    if (this.subDrag) { this.subDrag = null; this.changed(); }
  }
  hover(p: PointerInfo) {
    if (this.mode === 'sub') {
      this.hov = this.snap(p, this.subCur);
      this.cursor = this.subCur.length ? 'crosshair' : this.subHit(p).kind === 'pt' ? 'move' : this.subHit(p).kind === 'seg' ? 'copy' : this.subHit(p).kind === 'in' ? 'grab' : 'crosshair';
      if (!this.subDrag) updateCursor();
      requestRender();
      return;
    }
    this.hov = this.snap(p);
    if (this.mode === 'edit') {
      const hi = this.hitHandle(p);
      this.cursor = hi >= 0 ? 'move' : this.hitSegment(p) >= 0 ? 'copy' : pointInMask(this.mask(), p.x, p.y) ? 'grab' : 'default';
    } else this.cursor = 'crosshair';
    if (!this.drag) updateCursor();
    if (this.mode === 'draw') requestRender();
  }
  dbl() {
    if (this.mode === 'draw') this.close();
    else if (this.mode === 'sub' && this.subCur.length) this.subClose();
  }

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
    this.editHoles = cloneHoles(L.cut.holes);
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
      // ao reeditar, as áreas removidas (Subtrair) de cada quadro continuam valendo
      const holes = this.editName != null ? (L.cut ? L.cut.holes : this.editHoles) : undefined;
      L.cut = cloneMask(holes?.length ? { ...m, holes } : m);
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
    if (this.mode === 'sub') return this.subKey(e);
    if (this.mode === 'idle') {
      // S = Subtrair na camada de recorte selecionada
      if (e.key.toLowerCase() === 's' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && activeLayer()?.cut) { this.startSub(); return true; }
      return false;
    }
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

  // =================== Subtrair ===================
  /** entra no modo Subtrair para a camada de recorte selecionada */
  startSub(): boolean {
    const L = activeLayer();
    if (!L?.cut) { toast(t('toast.subNeedCut'), 'warn'); return false; }
    if (L.locked) { toast(t('toast.layerLocked'), 'warn'); return false; }
    if (this.mode !== 'idle') this.reset();
    this.mode = 'sub';
    this.subName = L.name;
    this.subShapes = []; this.subCur = []; this.subActive = -1; this.subDrag = null;
    this.lastDownT = 0;
    this.changed(); this.state();
    return true;
  }
  /** camada alvo no quadro atual */
  subLayer(fi = S.cur): Layer | undefined {
    return S.docs[fi]?.layers.find((l) => l.name === this.subName && !!l.cut);
  }
  private subHit(p: { x: number; y: number }): { kind: 'pt' | 'seg' | 'in' | 'none'; s: number; i: number } {
    const order = this.subShapes.map((_, i) => i).reverse();
    if (this.subActive >= 0 && this.subActive < this.subShapes.length) { order.splice(order.indexOf(this.subActive), 1); order.unshift(this.subActive); }
    for (const s of order) { const i = this.hitHandle(p, this.subShapes[s]); if (i >= 0) return { kind: 'pt', s, i }; }
    for (const s of order) { const i = this.hitSegment(p, this.subShapes[s]); if (i >= 0) return { kind: 'seg', s, i }; }
    for (const s of order) if (pointInPts(this.subShapes[s], p.x, p.y)) return { kind: 'in', s, i: -1 };
    return { kind: 'none', s: -1, i: -1 };
  }
  private subDown(p: PointerInfo) {
    const cur = this.subCur;
    if (!cur.length) {
      const h = this.subHit(p);
      if (p.button === 2) {
        // botão direito num ponto: remove o ponto (com 3 pontos, a área inteira)
        if (h.kind === 'pt') {
          const sh = this.subShapes[h.s];
          if (sh.length > 3) sh.splice(h.i, 1); else { this.subShapes.splice(h.s, 1); this.subActive = -1; }
          this.changed(); this.state();
        }
        return;
      }
      if (h.kind === 'pt') {
        this.subActive = h.s;
        if (p.alt) { const q = this.subShapes[h.s][h.i]; if (q.c) delete q.c; else q.c = 1; this.changed(); return; }
        this.subDrag = { kind: 'pt', s: h.s, i: h.i };
        this.changed(); return;
      }
      if (h.kind === 'seg') {
        const sh = this.subShapes[h.s];
        sh.splice(h.i + 1, 0, S.settings.cutPoly || p.alt ? { x: p.x, y: p.y, c: 1 } : { x: p.x, y: p.y });
        this.subActive = h.s;
        this.subDrag = { kind: 'pt', s: h.s, i: h.i + 1 };
        this.changed(); return;
      }
      if (h.kind === 'in') {
        this.subActive = h.s;
        this.subDrag = { kind: 'all', s: h.s, x0: p.x, y0: p.y, orig: this.subShapes[h.s].map((q) => ({ ...q })) };
        this.changed(); return;
      }
    }
    // desenhando uma área vermelha (igual à Curva)
    if (p.button === 2) { this.subUndoPoint(); return; }
    const prevDownT = this.lastDownT;
    this.lastDownT = p.time;
    const q = this.snap(p, cur);
    if (this.nearFirst(q, cur)) { this.subClose(); return; }
    const last = cur[cur.length - 1];
    if (last && Math.hypot(q.x - last.x, q.y - last.y) <= px(4)) {
      if (p.time - prevDownT < 500) this.subClose();
      return;
    }
    const corner = S.settings.cutPoly || p.alt;
    cur.push(corner ? { x: q.x, y: q.y, c: 1 } : { x: q.x, y: q.y });
    this.hov = q;
    this.subActive = -1;
    this.changed(); this.state();
  }
  subUndoPoint() {
    if (!this.subCur.length) return;
    this.subCur.pop();
    this.lastDownT = 0;
    this.changed(); this.state();
  }
  /** fecha a área vermelha em desenho; ela fica pendente (editável) até "Remover" */
  subClose(): boolean {
    if (this.subCur.length < 3) { toast(t('toast.cutFew'), 'warn'); return false; }
    this.subShapes.push(this.subCur);
    this.subActive = this.subShapes.length - 1;
    this.subCur = [];
    this.hov = null;
    this.changed(); this.state();
    return true;
  }
  subDeleteActive(): boolean {
    if (this.subActive < 0 || this.subActive >= this.subShapes.length) return false;
    this.subShapes.splice(this.subActive, 1);
    this.subActive = -1;
    this.changed(); this.state();
    return true;
  }
  subFrames(): number[] {
    if (this.subScope !== 'layer') return [S.cur];
    const out: number[] = [];
    for (let i = 0; i < S.docs.length; i++) if (this.subLayer(i)) out.push(i);
    return out;
  }
  /** "Remover": tira todas as áreas vermelhas pendentes da camada de recorte (um passo de desfazer por quadro) */
  removeAreas(): number {
    if (this.mode !== 'sub') return 0;
    if (this.subCur.length && !this.subClose()) return 0;
    if (!this.subShapes.length) return 0;
    let count = 0;
    for (const fi of this.subFrames()) {
      const L = this.subLayer(fi);
      if (!L?.cut || L.locked) continue;
      pushUndo(fi);
      // máscara nova (o cache de pixels é por objeto de máscara)
      L.cut = cloneMask({ ...L.cut, holes: [...(L.cut.holes || []), ...this.subShapes] });
      markChanged(fi);
      count++;
    }
    if (!count) { toast(t('toast.subNoLayer', { name: this.subName || '' }), 'warn'); return 0; }
    const n = this.subShapes.length;
    this.subShapes = []; this.subActive = -1; this.subDrag = null;
    this.changed(); this.state();
    emit('layers');
    toast(t('toast.subDone', { n, f: count }), 'ok');
    return count;
  }
  private subKey(e: KeyboardEvent): boolean {
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === 'Enter') {
      if (this.subCur.length) this.subClose(); else this.removeAreas();
      return true;
    }
    if (e.key === 'Escape') {
      // Esc descarta a área em desenho; sem área em desenho, sai do Subtrair
      if (this.subCur.length) { this.subCur = []; this.lastDownT = 0; this.changed(); this.state(); }
      else this.reset();
      return true;
    }
    if (this.subCur.length && (e.key === 'Backspace' || (e.key.toLowerCase() === 'z' && ctrl && !e.shiftKey))) { this.subUndoPoint(); return true; }
    if (!this.subCur.length && (e.key === 'Delete' || e.key === 'Backspace')) return this.subDeleteActive();
    return false;
  }
  private subOverlay(g: CanvasRenderingContext2D, M: DOMMatrix) {
    const L = this.subLayer();
    if (L?.cut) {
      antsPath(g, maskPath2D(L.cut), M, 0.6);
      for (const h of L.cut.holes || []) antsPath(g, ptsPath2D(h), M, 0.45, SUB_RED);
    }
    this.subShapes.forEach((sh, si) => {
      const path = ptsPath2D(sh);
      g.save(); g.transform(M.a, M.b, M.c, M.d, M.e, M.f);
      g.fillStyle = 'rgba(255,45,85,0.32)';
      g.fill(path, 'nonzero');
      g.restore();
      antsPath(g, path, M, 1, SUB_RED);
      const act = si === this.subActive;
      sh.forEach((q, i) => {
        const dragging = this.subDrag?.kind === 'pt' && this.subDrag.s === si && this.subDrag.i === i;
        drawHandle(g, q, dragging ? '#ffd23f' : act ? '#ffffff' : '#ffc4cf', !q.c, act ? 7 : 6);
      });
    });
    const cur = this.subCur;
    if (!cur.length) return;
    const pts = cur.slice();
    const closing = this.hov && this.nearFirst(this.hov, cur);
    if (this.hov && !closing) pts.push(S.settings.cutPoly ? { ...this.hov, c: 1 } : { ...this.hov });
    const poly = maskPolyline(pts, !!closing);
    const path = new Path2D();
    for (let i = 0; i < poly.length; i += 2) { if (i) path.lineTo(poly[i], poly[i + 1]); else path.moveTo(poly[i], poly[i + 1]); }
    if (closing) path.closePath();
    antsPath(g, path, M, 1, SUB_RED);
    cur.forEach((q, i) => drawHandle(g, q, i === 0 ? (closing ? '#ffd23f' : '#ffc4cf') : '#ffffff', !q.c, i === 0 && closing ? 11 : 7));
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
        for (const h of L.cut.holes || []) antsPath(g, ptsPath2D(h), M, 0.45, SUB_RED);
      }
      return;
    }
    if (this.mode === 'sub') { this.subOverlay(g, M); return; }
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
      for (const h of this.editHoles) antsPath(g, ptsPath2D(h), M, 0.6, SUB_RED);
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
function antsPath(g: CanvasRenderingContext2D, path: Path2D, M: DOMMatrix, alpha: number, color = '#1060ff') {
  g.save();
  g.globalAlpha = alpha;
  g.transform(M.a, M.b, M.c, M.d, M.e, M.f);
  const lw = 1.5 / Math.max(1e-6, S.view.zoom);
  g.lineWidth = lw; g.lineJoin = 'round';
  g.strokeStyle = '#ffffff'; g.setLineDash([]); g.stroke(path);
  g.strokeStyle = color; g.setLineDash([5 * lw, 4 * lw]); g.stroke(path);
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
