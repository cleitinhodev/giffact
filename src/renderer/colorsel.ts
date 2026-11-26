// Ferramenta Seletor de cores (1.3.0-beta): analisa o quadro em uma paleta, deixa excluir/manter cores
// (conta-gotas com tolerância, Shift = várias), gera uma camada de formas vetoriais editáveis e converte
// o traço que sobrar em linhas do Giffact.
import { S, activeLayer, emit, findOrCreateLayer, markChanged, newLayer, on, pushUndo, toast } from './state';
import type { CutPt, Layer, VecShape } from './types';
import {
  type RGB, cleanLabels, colorDist, kmeansPalette, luminance, parseHex, ringPolyline, shapePath, shapesToStrokes, shapeThickness,
  similarIndices, toHex, traceLabels,
} from './vector';
import { docToScreen, px, requestRender, updateCursor, viewMatrix, type PointerInfo, type Tool } from './view';
import { t } from './i18n';

interface Session {
  palette: RGB[];
  deleted: Set<number>;
  selected: Set<number>;
  hist: number[][];
}
type Drag =
  | { kind: 'move'; x0: number; y0: number; orig: Map<string, VecShape>; moved: boolean }
  | { kind: 'node'; id: string; r: number; i: number; moved: boolean };

const dataOf = (c: HTMLCanvasElement) => c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height).data;
const hitCtx = document.createElement('canvas').getContext('2d')!;

export class ColorSelectTool implements Tool {
  cursor = 'crosshair';
  persistent = true;
  session: Session | null = null;
  /** ids das formas selecionadas (camada vetorial ativa) */
  sel = new Set<string>();
  selLayer: string | null = null;
  drag: Drag | null = null;
  busy = false;
  progress = { done: 0, total: 0 };
  rangeFrom = 1;
  rangeTo = 1;
  private lab: { key: string; labels: Int16Array; counts: number[] } | null = null;
  private pv: { key: string; canvas: HTMLCanvasElement } | null = null;
  private selPv: { key: string; canvas: HTMLCanvasElement } | null = null;
  private paramT: any = 0;

  constructor() {
    on('loaded', () => {
      this.session = null; this.lab = null; this.pv = null; this.sel.clear(); this.drag = null;
      this.rangeFrom = 1; this.rangeTo = S.frames.length;
      if (S.tool === 'colors') this.autoStart();
    });
    on('tool', () => { if (S.tool === 'colors') this.autoStart(); });
    on('layers', () => this.syncSel());
    on('frame', () => { this.syncSel(); if (this.session) requestRender(); });
  }

  get mode(): 'palette' | 'shapes' | 'none' {
    if (this.session) return 'palette';
    return activeLayer()?.vec ? 'shapes' : 'none';
  }
  get pending() { return !!this.session; }
  private state() { emit('vecstate'); requestRender(); }
  private syncSel() {
    const L = activeLayer();
    if (!L?.vec || L.id !== this.selLayer) { this.sel.clear(); this.selLayer = L?.vec ? L.id : null; }
    else for (const id of Array.from(this.sel)) if (!L.vec.shapes.some((s) => s.id === id)) this.sel.delete(id);
  }
  private autoStart() {
    if (S.loaded && !this.session && !activeLayer()?.vec && !this.busy) this.analyze();
  }

  // =================== análise / paleta ===================
  /** analisa o quadro atual: paleta com S.settings.vecColors cores (cores excluídas são remapeadas pela mais próxima) */
  analyze(): boolean {
    if (!S.loaded) return false;
    const fr = S.frames[S.cur]?.canvas;
    if (!fr) return false;
    const palette = kmeansPalette(dataOf(fr), S.settings.vecColors);
    const prev = this.session;
    const deleted = new Set<number>();
    if (prev && prev.deleted.size) {
      palette.forEach((c, i) => {
        let best = 0, bd = Infinity;
        prev.palette.forEach((q, j) => { const d = colorDist(c, q); if (d < bd) { bd = d; best = j; } });
        if (prev.deleted.has(best)) deleted.add(i);
      });
    }
    this.session = { palette, deleted, selected: new Set(), hist: prev ? [] : [] };
    this.lab = null; this.pv = null; this.selPv = null;
    this.state();
    return true;
  }
  /** parâmetros de limpeza mudaram (prévia ao vivo) */
  paramsChanged(reanalyze = false) {
    clearTimeout(this.paramT);
    this.paramT = setTimeout(() => {
      if (!this.session) return;
      if (reanalyze) this.analyze(); else { this.lab = null; this.pv = null; this.selPv = null; this.state(); }
    }, 120);
  }
  private params() { return { speck: S.settings.vecSpeck, smooth: S.settings.vecSmooth }; }
  /** rótulos limpos do quadro atual (cache) */
  labels(): { labels: Int16Array; counts: number[] } | null {
    const ss = this.session;
    const fr = S.frames[S.cur]?.canvas;
    if (!ss || !fr) return null;
    const key = `${S.cur}|${ss.palette.map(toHex).join('')}|${S.settings.vecSpeck}|${S.settings.vecSmooth}`;
    if (this.lab?.key === key) return this.lab;
    const labels = cleanLabels(dataOf(fr), fr.width, fr.height, ss.palette, this.params());
    const counts = ss.palette.map(() => 0);
    for (let i = 0; i < labels.length; i++) if (labels[i] >= 0) counts[labels[i]]++;
    this.lab = { key, labels, counts };
    return this.lab;
  }
  private pushHist() {
    const ss = this.session!;
    ss.hist.push(Array.from(ss.deleted));
    if (ss.hist.length > 100) ss.hist.shift();
  }
  labelAt(x: number, y: number): number {
    const lb = this.labels();
    const fr = S.frames[S.cur]?.canvas;
    if (!lb || !fr) return -1;
    const xi = Math.floor(x), yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= fr.width || yi >= fr.height) return -1;
    return lb.labels[yi * fr.width + xi];
  }
  /** conta-gotas: seleciona a cor (e as parecidas, pela tolerância); add = Shift (várias) */
  pickAt(x: number, y: number, add = false): number[] {
    const ss = this.session;
    if (!ss) return [];
    const l = this.labelAt(x, y);
    if (l < 0) { if (!add) ss.selected.clear(); this.state(); return []; }
    return this.pickIndex(l, add);
  }
  pickIndex(l: number, add = false): number[] {
    const ss = this.session;
    if (!ss || l < 0 || l >= ss.palette.length) return [];
    const group = similarIndices(ss.palette, l, S.settings.vecTol);
    if (add) {
      const all = group.every((i) => ss.selected.has(i));
      for (const i of group) { if (all) ss.selected.delete(i); else ss.selected.add(i); }
    } else ss.selected = new Set(group);
    this.selPv = null;
    this.state();
    return group;
  }
  deleteSelected(): number {
    const ss = this.session;
    if (!ss || !ss.selected.size) return 0;
    this.pushHist();
    let n = 0;
    for (const i of ss.selected) if (!ss.deleted.has(i)) { ss.deleted.add(i); n++; }
    ss.selected.clear();
    this.pv = null; this.selPv = null;
    this.state();
    return n;
  }
  keepOnlySelected(): number {
    const ss = this.session;
    if (!ss || !ss.selected.size) return 0;
    this.pushHist();
    ss.deleted = new Set(ss.palette.map((_, i) => i).filter((i) => !ss.selected.has(i)));
    ss.selected.clear();
    this.pv = null; this.selPv = null;
    this.state();
    return ss.deleted.size;
  }
  toggleDeleted(i: number) {
    const ss = this.session;
    if (!ss || i < 0 || i >= ss.palette.length) return;
    this.pushHist();
    if (ss.deleted.has(i)) ss.deleted.delete(i); else ss.deleted.add(i);
    ss.selected.delete(i);
    this.pv = null; this.selPv = null;
    this.state();
  }
  restoreAll() {
    const ss = this.session;
    if (!ss || !ss.deleted.size) return;
    this.pushHist();
    ss.deleted.clear();
    this.pv = null;
    this.state();
  }
  undoPalette(): boolean {
    const ss = this.session;
    if (!ss || !ss.hist.length) return false;
    ss.deleted = new Set(ss.hist.pop());
    ss.selected.clear();
    this.pv = null; this.selPv = null;
    this.state();
    return true;
  }
  cancel() {
    if (this.busy) return;
    if (this.session) { this.session = null; this.lab = null; this.pv = null; this.selPv = null; this.state(); return; }
    if (this.sel.size) { this.sel.clear(); this.state(); }
  }

  targetFrames(scope = S.settings.vecScope): number[] {
    const n = S.frames.length;
    if (scope === 'all') return Array.from({ length: n }, (_, i) => i);
    if (scope === 'range') {
      const a = Math.max(1, Math.min(n, this.rangeFrom || 1)), b = Math.max(1, Math.min(n, this.rangeTo || n));
      const list: number[] = [];
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) list.push(i - 1);
      return list;
    }
    return [S.cur];
  }

  /** gera a camada de formas vetoriais nos quadros escolhidos (mesmas cores excluídas, paleta pela cor mais próxima) */
  async generate(): Promise<number> {
    const ss = this.session;
    if (!ss || this.busy) return 0;
    if (ss.deleted.size >= ss.palette.length) { toast(t('toast.vecAllDeleted'), 'warn'); return 0; }
    const frames = this.targetFrames();
    const name = uniqueVecName();
    const idx = S.docs[S.cur].activeLayer + 1;
    const palette = ss.palette.slice(), deleted = new Set(ss.deleted), prm = this.params();
    this.busy = true; this.progress = { done: 0, total: frames.length };
    this.state();
    let count = 0, shapesCur = 0;
    try {
      for (const fi of frames) {
        const fr = S.frames[fi].canvas;
        const lab = fi === S.cur && this.lab && this.labels() ? this.labels()!.labels : cleanLabels(dataOf(fr), fr.width, fr.height, palette, prm);
        const shapes = traceLabels(lab, fr.width, fr.height, palette, (l) => !deleted.has(l), prm.smooth);
        const doc = S.docs[fi];
        pushUndo(fi);
        const L = newLayer(name);
        L.vec = { shapes };
        const at = Math.max(0, Math.min(idx, doc.layers.length));
        doc.layers.splice(at, 0, L);
        if (fi === S.cur) { doc.activeLayer = at; shapesCur = shapes.length; }
        markChanged(fi);
        count++;
        this.progress = { done: count, total: frames.length };
        emit('vecstate');
        if (frames.length > 1) await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      this.busy = false;
    }
    this.session = null; this.lab = null; this.pv = null; this.selPv = null;
    this.sel.clear(); this.selLayer = activeLayer()?.id || null;
    S.selection.clear();
    emit('layers', 'selection');
    this.state();
    toast(t('toast.vecDone', { name, n: count, s: shapesCur }), 'ok');
    return count;
  }

  // =================== formas (camada vetorial) ===================
  vecLayer(silent = true): Layer | null {
    const L = activeLayer();
    if (!L?.vec) return null;
    if (L.locked) { if (!silent) toast(t('toast.activeLocked'), 'warn'); return null; }
    if (!L.visible) { if (!silent) toast(t('toast.activeHidden'), 'warn'); return null; }
    return L;
  }
  selectedShapes(): VecShape[] {
    const L = activeLayer();
    return L?.vec ? L.vec.shapes.filter((s) => this.sel.has(s.id)) : [];
  }
  private replaceShapes(L: Layer, map: Map<string, VecShape | null>) {
    const out: VecShape[] = [];
    for (const s of L.vec!.shapes) {
      if (map.has(s.id)) { const r = map.get(s.id); if (r) out.push(r); } else out.push(s);
    }
    L.vec = { shapes: out };
  }
  hitShape(x: number, y: number): VecShape | null {
    const L = activeLayer();
    if (!L?.vec) return null;
    for (let k = L.vec.shapes.length - 1; k >= 0; k--) {
      const s = L.vec.shapes[k];
      if (hitCtx.isPointInPath(shapePath(s), x, y, 'evenodd')) return s;
    }
    return null;
  }
  private hitNode(s: VecShape, p: { x: number; y: number }): { r: number; i: number } | null {
    let best: { r: number; i: number } | null = null, bd = px(8);
    s.rings.forEach((ring, r) => ring.forEach((q, i) => { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d <= bd) { bd = d; best = { r, i }; } }));
    return best;
  }
  /** segmento do contorno mais próximo (para inserir nó) */
  private hitOutline(s: VecShape, p: { x: number; y: number }): { r: number; i: number } | null {
    const steps = 8;
    let best: { r: number; i: number } | null = null, bd = px(6);
    s.rings.forEach((ring, r) => {
      const poly = ringPolyline(ring, steps);
      for (let k = 0; k + 3 < poly.length; k += 2) {
        const d = distSeg(p.x, p.y, poly[k], poly[k + 1], poly[k + 2], poly[k + 3]);
        if (d <= bd) { bd = d; best = { r, i: Math.floor(k / 2 / steps) }; }
      }
    });
    return best;
  }
  selectShapes(ids: string[]) { this.sel = new Set(ids); this.selLayer = activeLayer()?.id || null; this.state(); }
  deleteShapes(): number {
    const L = this.vecLayer(false);
    if (!L || !this.sel.size) return 0;
    pushUndo();
    const map = new Map<string, VecShape | null>();
    for (const id of this.sel) map.set(id, null);
    this.replaceShapes(L, map);
    const n = map.size;
    this.sel.clear();
    markChanged();
    this.state();
    return n;
  }
  setFill(color: string): number {
    const L = this.vecLayer(false);
    if (!L || !this.sel.size || !/^#[0-9a-f]{6}$/i.test(color)) return 0;
    pushUndo();
    const map = new Map<string, VecShape | null>();
    for (const s of L.vec!.shapes) if (this.sel.has(s.id)) map.set(s.id, { ...s, color });
    this.replaceShapes(L, map);
    markChanged();
    this.state();
    return map.size;
  }
  selectSameColor(): number {
    const L = activeLayer();
    if (!L?.vec || !this.sel.size) return 0;
    const cols = new Set(this.selectedShapes().map((s) => s.color.toLowerCase()));
    this.sel = new Set(L.vec.shapes.filter((s) => cols.has(s.color.toLowerCase())).map((s) => s.id));
    this.state();
    return this.sel.size;
  }
  /** cores-alvo da conversão: as das formas selecionadas, ou a mais escura da camada */
  lineColors(): string[] {
    const sel = this.selectedShapes();
    if (sel.length) return Array.from(new Set(sel.map((s) => s.color.toLowerCase())));
    const L = activeLayer();
    if (!L?.vec?.shapes.length) return [];
    let best = L.vec.shapes[0].color, bl = Infinity;
    for (const s of L.vec.shapes) { const l = luminance(parseHex(s.color)); if (l < bl) { bl = l; best = s.color; } }
    return [best.toLowerCase()];
  }
  /** converte as formas das cores escolhidas em linhas do Giffact numa camada de linhas comum */
  toLines(): { strokes: number; frames: number; layer: string; skipped: number } {
    const src = this.vecLayer(false);
    const res = { strokes: 0, frames: 0, layer: '', skipped: 0 };
    if (!src) return res;
    const colors = this.lineColors().map(parseHex);
    if (!colors.length) return res;
    const match = (s: VecShape) => colors.some((c) => colorDist(c, parseHex(s.color)) <= 24);
    const lineName = t('layer.vecLines', { name: src.name });
    res.layer = lineName;
    const frames = S.settings.vecLinesScope === 'layer'
      ? S.docs.map((d, fi) => (d.layers.some((l) => l.vec && l.name === src.name) ? fi : -1)).filter((fi) => fi >= 0)
      : [S.cur];
    for (const fi of frames) {
      const doc = S.docs[fi];
      const Lv = fi === S.cur ? src : doc.layers.find((l) => l.vec && l.name === src.name);
      if (!Lv?.vec || Lv.locked) continue;
      // manchas grossas demais (não são traço) ficam como formas
      const maxW = S.settings.vecLineMax;
      const target = Lv.vec.shapes.filter((s) => {
        if (!match(s)) return false;
        if (shapeThickness(s) <= maxW) return true;
        if (fi === S.cur) res.skipped++;
        return false;
      });
      if (!target.length) continue;
      const strokes = shapesToStrokes(target, S.docW, S.docH, target[0].color);
      if (!strokes.length) continue;
      pushUndo(fi);
      const vi = doc.layers.indexOf(Lv);
      const Ll = findOrCreateLayer(doc, lineName, vi + 1, 'line');
      if (Ll.locked) { S.undo[fi].pop(); continue; }
      Ll.strokes = Ll.strokes.concat(strokes);
      if (S.settings.vecLinesRemove) {
        const ids = new Set(target.map((s) => s.id));
        Lv.vec = { shapes: Lv.vec.shapes.filter((s) => !ids.has(s.id)) };
      }
      // camada ativa continua sendo a vetorial
      doc.activeLayer = doc.layers.indexOf(Lv);
      markChanged(fi);
      res.strokes += strokes.length; res.frames++;
    }
    this.sel.clear();
    emit('layers', 'selection');
    this.state();
    if (res.strokes) toast(t('toast.vecLinesDone', { n: res.strokes, f: res.frames, name: lineName }) + (res.skipped ? ' · ' + t('toast.vecLinesSkipped', { n: res.skipped }) : ''), 'ok');
    else toast(t('toast.vecLinesNone'), 'warn');
    return res;
  }

  // =================== ponteiro ===================
  down(p: PointerInfo) {
    if (!S.loaded || this.busy) return;
    if (this.session) {
      if (p.button === 2) { const l = this.labelAt(p.x, p.y); if (l >= 0) this.toggleDeleted(l); return; }
      this.pickAt(p.x, p.y, p.shift);
      return;
    }
    const L = activeLayer();
    if (!L?.vec) return;
    if (L.locked || !L.visible) { this.vecLayer(false); return; }
    // edição de nós: com uma única forma selecionada
    const one = this.sel.size === 1 ? this.selectedShapes()[0] : null;
    if (one) {
      const hn = this.hitNode(one, p);
      if (hn) {
        if (p.button === 2) { this.deleteNode(one, hn.r, hn.i); return; }
        if (p.alt) { this.toggleCorner(one, hn.r, hn.i); return; }
        this.drag = { kind: 'node', id: one.id, r: hn.r, i: hn.i, moved: false };
        return;
      }
      if (p.button === 0) {
        const ho = this.hitOutline(one, p);
        if (ho) {
          pushUndo();
          const ring = one.rings[ho.r].slice();
          ring.splice(ho.i + 1, 0, p.alt ? { x: p.x, y: p.y, c: 1 } : { x: p.x, y: p.y });
          const ns: VecShape = { ...one, rings: one.rings.map((r, k) => (k === ho.r ? ring : r)) };
          this.replaceShapes(L, new Map([[one.id, ns]]));
          this.drag = { kind: 'node', id: one.id, r: ho.r, i: ho.i + 1, moved: true };
          S.version++; requestRender();
          return;
        }
      }
    }
    if (p.button !== 0) return;
    const hit = this.hitShape(p.x, p.y);
    if (!hit) { if (!p.shift) { this.sel.clear(); this.state(); } return; }
    if (p.shift) {
      if (this.sel.has(hit.id)) this.sel.delete(hit.id); else this.sel.add(hit.id);
      this.selLayer = L.id;
      this.state();
      return;
    }
    if (!this.sel.has(hit.id)) { this.sel = new Set([hit.id]); this.selLayer = L.id; }
    const orig = new Map<string, VecShape>();
    for (const s of this.selectedShapes()) orig.set(s.id, s);
    this.drag = { kind: 'move', x0: p.x, y0: p.y, orig, moved: false };
    this.state();
  }
  move(p: PointerInfo) {
    const d = this.drag;
    const L = activeLayer();
    if (!d || !L?.vec) { this.hover(p); return; }
    if (d.kind === 'move') {
      const dx = p.x - d.x0, dy = p.y - d.y0;
      if (!d.moved) { if (Math.hypot(dx, dy) < px(2)) return; pushUndo(); d.moved = true; }
      const map = new Map<string, VecShape | null>();
      d.orig.forEach((s, id) => map.set(id, { ...s, rings: s.rings.map((r) => r.map((q) => ({ ...q, x: q.x + dx, y: q.y + dy }))) }));
      this.replaceShapes(L, map);
    } else {
      const s = L.vec.shapes.find((q) => q.id === d.id);
      if (!s) return;
      if (!d.moved) { pushUndo(); d.moved = true; }
      const ring = s.rings[d.r].slice();
      ring[d.i] = { ...ring[d.i], x: p.x, y: p.y };
      this.replaceShapes(L, new Map([[s.id, { ...s, rings: s.rings.map((r, k) => (k === d.r ? ring : r)) }]]));
    }
    S.version++;
    requestRender();
  }
  up() {
    const d = this.drag;
    this.drag = null;
    if (d?.moved) { markChanged(); this.state(); }
  }
  hover(p: PointerInfo) {
    if (this.session) { this.cursor = 'crosshair'; updateCursor(); return; }
    const one = this.sel.size === 1 ? this.selectedShapes()[0] : null;
    let c = 'default';
    if (one && this.hitNode(one, p)) c = 'move';
    else if (one && this.hitOutline(one, p)) c = 'copy';
    else if (this.hitShape(p.x, p.y)) c = 'pointer';
    if (c !== this.cursor) { this.cursor = c; updateCursor(); }
  }
  private deleteNode(s: VecShape, r: number, i: number) {
    const L = this.vecLayer(false);
    if (!L) return;
    const ring = s.rings[r];
    if (ring.length <= 3 && r === 0) return;
    pushUndo();
    const rings = ring.length <= 3 ? s.rings.filter((_, k) => k !== r) : s.rings.map((q, k) => (k === r ? q.filter((_, j) => j !== i) : q));
    this.replaceShapes(L, new Map([[s.id, { ...s, rings }]]));
    markChanged();
    this.state();
  }
  private toggleCorner(s: VecShape, r: number, i: number) {
    const L = this.vecLayer(false);
    if (!L) return;
    pushUndo();
    const ring = s.rings[r].map((q, j): CutPt => (j === i ? (q.c ? { x: q.x, y: q.y } : { x: q.x, y: q.y, c: 1 }) : q));
    this.replaceShapes(L, new Map([[s.id, { ...s, rings: s.rings.map((q, k) => (k === r ? ring : q)) }]]));
    markChanged();
    this.state();
  }

  key(e: KeyboardEvent): boolean {
    if (this.busy) return e.key === 'Enter' || e.key === 'Escape';
    const ctrl = e.ctrlKey || e.metaKey;
    if (this.session) {
      if (e.key === 'Enter') { void this.generate(); return true; }
      if (e.key === 'Escape') { if (this.session.selected.size) { this.session.selected.clear(); this.state(); } else this.cancel(); return true; }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (e.shiftKey) this.keepOnlySelected(); else this.deleteSelected();
        return true;
      }
      if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) { if (!this.undoPalette()) toast(t('toast.nothingUndo')); return true; }
      return false;
    }
    if (this.mode === 'shapes') {
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel.size) { this.deleteShapes(); return true; }
      if (e.key === 'Escape' && this.sel.size) { this.sel.clear(); this.state(); return true; }
      if (ctrl && e.key.toLowerCase() === 'a' && !e.shiftKey) {
        const L = activeLayer();
        if (L?.vec) { this.selectShapes(L.vec.shapes.map((s) => s.id)); return true; }
      }
    }
    return false;
  }

  // =================== desenho ===================
  /** prévia: quadro reduzido à paleta (cores excluídas = transparentes) */
  previewCanvas(): HTMLCanvasElement | null {
    const ss = this.session;
    const lb = this.labels();
    const fr = S.frames[S.cur]?.canvas;
    if (!ss || !lb || !fr) return null;
    const key = `${this.lab!.key}|${Array.from(ss.deleted).sort().join(',')}`;
    if (this.pv?.key === key) return this.pv.canvas;
    const c = this.pv?.canvas || document.createElement('canvas');
    c.width = fr.width; c.height = fr.height;
    const g = c.getContext('2d')!;
    const img = g.createImageData(fr.width, fr.height);
    const cols = ss.palette.map((q, i) => (ss.deleted.has(i) ? null : q));
    for (let i = 0; i < lb.labels.length; i++) {
      const l = lb.labels[i];
      const q = l >= 0 ? cols[l] : null;
      if (!q) continue;
      img.data[i * 4] = q[0]; img.data[i * 4 + 1] = q[1]; img.data[i * 4 + 2] = q[2]; img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    this.pv = { key, canvas: c };
    return c;
  }
  private selectionCanvas(): HTMLCanvasElement | null {
    const ss = this.session;
    const lb = this.labels();
    const fr = S.frames[S.cur]?.canvas;
    if (!ss || !lb || !fr || !ss.selected.size) return null;
    const key = `${this.lab!.key}|${Array.from(ss.selected).sort().join(',')}`;
    if (this.selPv?.key === key) return this.selPv.canvas;
    const c = document.createElement('canvas');
    c.width = fr.width; c.height = fr.height;
    const g = c.getContext('2d')!;
    const img = g.createImageData(fr.width, fr.height);
    for (let i = 0; i < lb.labels.length; i++) {
      if (!ss.selected.has(lb.labels[i])) continue;
      img.data[i * 4] = 255; img.data[i * 4 + 1] = 40; img.data[i * 4 + 2] = 200; img.data[i * 4 + 3] = 150;
    }
    g.putImageData(img, 0, 0);
    this.selPv = { key, canvas: c };
    return c;
  }
  overlay(g: CanvasRenderingContext2D) {
    if (!S.loaded) return;
    const M = viewMatrix();
    if (this.session) {
      const pv = this.previewCanvas();
      if (!pv) return;
      g.save();
      g.transform(M.a, M.b, M.c, M.d, M.e, M.f);
      // xadrez onde a cor foi excluída
      g.fillStyle = checker();
      g.fillRect(0, 0, S.docW, S.docH);
      g.imageSmoothingEnabled = false;
      g.drawImage(pv, 0, 0);
      const sc = this.selectionCanvas();
      if (sc) {
        g.globalAlpha = 0.55 + 0.35 * Math.sin(performance.now() / 180);
        g.drawImage(sc, 0, 0);
        g.globalAlpha = 1;
        requestRender(); // pisca a seleção
      }
      g.restore();
      return;
    }
    const L = activeLayer();
    if (!L?.vec || !this.sel.size) return;
    const shapes = this.selectedShapes();
    g.save();
    g.transform(M.a, M.b, M.c, M.d, M.e, M.f);
    const lw = 1.5 / Math.max(1e-6, S.view.zoom);
    g.lineWidth = lw; g.lineJoin = 'round';
    for (const s of shapes) {
      const p = shapePath(s);
      g.strokeStyle = '#ffffff'; g.setLineDash([]); g.stroke(p);
      g.strokeStyle = '#ff2fb4'; g.setLineDash([5 * lw, 4 * lw]); g.stroke(p);
    }
    g.restore();
    if (shapes.length === 1) {
      const s = shapes[0];
      const d = this.drag;
      s.rings.forEach((ring, r) => ring.forEach((q, i) => {
        const sp = docToScreen(q.x, q.y);
        const active = d?.kind === 'node' && d.r === r && d.i === i;
        g.beginPath();
        if (q.c) g.rect(sp.x - 3.5, sp.y - 3.5, 7, 7); else g.arc(sp.x, sp.y, 3.5, 0, Math.PI * 2);
        g.fillStyle = active ? '#ffd23f' : r === 0 ? '#ffffff' : '#ffc4ee';
        g.fill();
        g.lineWidth = 1; g.strokeStyle = '#1b1b1f'; g.stroke();
      }));
    }
  }
}

let checkerPat: CanvasPattern | null = null;
function checker(): CanvasPattern {
  if (checkerPat) return checkerPat;
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const g = c.getContext('2d')!;
  g.fillStyle = '#e9e9ef'; g.fillRect(0, 0, 16, 16);
  g.fillStyle = '#c9c9d3'; g.fillRect(0, 0, 8, 8); g.fillRect(8, 8, 8, 8);
  checkerPat = g.createPattern(c, 'repeat')!;
  return checkerPat;
}

export function uniqueVecName(): string {
  const names = new Set<string>();
  for (const d of S.docs) for (const l of d.layers) names.add(l.name);
  let i = 1;
  while (names.has(t('layer.vecName', { n: i }))) i++;
  return t('layer.vecName', { n: i });
}
function distSeg(px_: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let u = l2 ? ((px_ - ax) * dx + (py - ay) * dy) / l2 : 0;
  u = Math.max(0, Math.min(1, u));
  return Math.hypot(px_ - (ax + u * dx), py - (ay + u * dy));
}
