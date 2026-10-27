// Estado global da aplicação, histórico (desfazer/refazer por quadro) e operações do documento
import type { FrameDoc, GifFrame, Layer, Settings, Stroke, ToolId } from './types';
import { DEFAULT_SETTINGS } from './types';
import { cloneStroke, uid } from './geom';
import { t } from './i18n';

type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();
export function on(ev: string, fn: Listener) {
  if (!listeners.has(ev)) listeners.set(ev, new Set());
  listeners.get(ev)!.add(fn);
}
export function emit(...evs: string[]) {
  for (const ev of evs) listeners.get(ev)?.forEach((f) => f());
}

export interface View { zoom: number; panX: number; panY: number; rot: number }

export const S = {
  loaded: false,
  docW: 0,
  docH: 0,
  frames: [] as GifFrame[],
  docs: [] as FrameDoc[],
  cur: 0,
  sourceBytes: null as Uint8Array | null,
  sourceName: '',
  sourceMime: 'image/gif',
  projectPath: '' as string,
  tool: 'curve' as ToolId,
  settings: loadSettings(),
  selection: new Set<string>(),
  view: { zoom: 1, panX: 0, panY: 0, rot: 0 } as View,
  undo: [] as string[][],
  redo: [] as string[][],
  dirty: false,
  clipboard: null as null | { strokes: Stroke[] },
  layerClipboard: null as null | Layer,
  /** incrementa a cada mudança de conteúdo (para caches/miniaturas) */
  version: 0,
  frameVersion: [] as number[],
};

function loadSettings(): Settings {
  try {
    // 'gif-linework-settings' = nome antigo (versões ≤ 1.0.x), migrado automaticamente
    const raw = localStorage.getItem('giffact-settings') ?? localStorage.getItem('gif-linework-settings');
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch { /* ignora */ }
  return { ...DEFAULT_SETTINGS, swatches: DEFAULT_SETTINGS.swatches.slice() };
}
let saveT: any = 0;
export function saveSettings() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    try { localStorage.setItem('giffact-settings', JSON.stringify(S.settings)); } catch { /* */ }
  }, 300);
}

export function newLayer(name: string): Layer {
  return { id: uid(), name, visible: true, locked: false, opacity: 1, strokes: [] };
}
export function newFrameDoc(): FrameDoc {
  return { layers: [newLayer(t('layer.defaultName'))], activeLayer: 0 };
}

export function setupDocument(w: number, h: number, frames: GifFrame[], docs?: FrameDoc[]) {
  S.docW = w; S.docH = h; S.frames = frames;
  S.docs = docs && docs.length === frames.length ? docs : frames.map(() => newFrameDoc());
  S.cur = 0;
  S.undo = frames.map(() => []);
  S.redo = frames.map(() => []);
  S.frameVersion = frames.map(() => 0);
  S.selection.clear();
  S.loaded = true;
  S.dirty = false;
  S.version++;
}

/** Fecha o documento atual e volta à tela inicial (Projeto ▸ Novo). */
export function closeDocument() {
  S.loaded = false;
  S.docW = 0; S.docH = 0;
  S.frames = []; S.docs = []; S.cur = 0;
  S.undo = []; S.redo = []; S.frameVersion = [];
  S.selection.clear();
  S.sourceBytes = null; S.sourceName = ''; S.sourceMime = 'image/gif';
  S.projectPath = '';
  S.dirty = false;
  S.version++;
}

export const curDoc = () => S.docs[S.cur];
export const activeLayer = (): Layer | null => {
  const d = S.docs[S.cur];
  if (!d) return null;
  return d.layers[d.activeLayer] || null;
};

// ---------- histórico ----------
const MAX_UNDO = 150;
function snapshot(fi: number): string {
  return JSON.stringify(S.docs[fi]);
}
/** Chamar ANTES de modificar o quadro fi */
export function pushUndo(fi = S.cur) {
  S.undo[fi].push(snapshot(fi));
  if (S.undo[fi].length > MAX_UNDO) S.undo[fi].shift();
  S.redo[fi] = [];
}
export function markChanged(fi = S.cur) {
  S.dirty = true;
  S.version++;
  S.frameVersion[fi] = (S.frameVersion[fi] || 0) + 1;
  emit('doc');
}
export function undo() {
  hooks.beforeFrame.forEach((f) => f());
  const fi = S.cur;
  const st = S.undo[fi].pop();
  if (st === undefined) return false;
  S.redo[fi].push(snapshot(fi));
  S.docs[fi] = JSON.parse(st);
  S.selection.clear();
  markChanged(fi);
  emit('layers', 'selection');
  return true;
}
export function redo() {
  hooks.beforeFrame.forEach((f) => f());
  const fi = S.cur;
  const st = S.redo[fi].pop();
  if (st === undefined) return false;
  S.undo[fi].push(snapshot(fi));
  S.docs[fi] = JSON.parse(st);
  S.selection.clear();
  markChanged(fi);
  emit('layers', 'selection');
  return true;
}

// ---------- navegação ----------
export const hooks = { beforeFrame: [] as (() => void)[] };
export function goFrame(i: number) {
  if (!S.loaded) return;
  hooks.beforeFrame.forEach((f) => f());
  const n = S.frames.length;
  i = ((i % n) + n) % n;
  if (i === S.cur) return;
  S.cur = i;
  S.selection.clear();
  emit('frame', 'layers', 'selection');
}

export function setTool(t: ToolId) {
  S.tool = t;
  emit('tool');
}

// ---------- operações de traços ----------
export function selectedStrokes(): Stroke[] {
  const L = activeLayer();
  if (!L) return [];
  return L.strokes.filter((s) => S.selection.has(s.id));
}

export function replaceStrokes(L: Layer, map: Map<string, Stroke | null>) {
  const out: Stroke[] = [];
  for (const s of L.strokes) {
    if (map.has(s.id)) {
      const r = map.get(s.id);
      if (r) out.push(r);
    } else out.push(s);
  }
  L.strokes = out;
}

export function copySelection(): number {
  const sel = selectedStrokes();
  if (!sel.length) return 0;
  S.clipboard = { strokes: sel.map((s) => cloneStroke(s, false)) };
  return sel.length;
}

function findOrCreateLayer(doc: FrameDoc, name: string, preferIndex: number): Layer {
  let L = doc.layers.find((l) => l.name === name);
  if (!L) {
    L = newLayer(name);
    doc.layers.splice(Math.min(preferIndex, doc.layers.length), 0, L);
  }
  return L;
}

/** Cola a área de transferência na camada ativa (ou em camada de mesmo nome) dos quadros indicados */
export function pasteToFrames(frames: number[]): number {
  if (!S.clipboard) return 0;
  const srcLayer = activeLayer();
  let count = 0;
  for (const fi of frames) {
    pushUndo(fi);
    const doc = S.docs[fi];
    const L = fi === S.cur ? (srcLayer as Layer) : findOrCreateLayer(doc, srcLayer?.name || t('layer.defaultName'), S.docs[S.cur].activeLayer);
    if (L.locked) { S.undo[fi].pop(); continue; }
    const fresh = S.clipboard.strokes.map((s) => cloneStroke(s, true));
    L.strokes = L.strokes.concat(fresh);
    if (fi === S.cur) {
      S.selection = new Set(fresh.map((s) => s.id));
    }
    markChanged(fi);
    count++;
  }
  emit('layers', 'selection');
  return count;
}

/** Copia a camada ativa do quadro atual para outros quadros (substitui ou mescla em camada de mesmo nome) */
export function copyLayerToFrames(frames: number[], mode: 'replace' | 'merge') {
  const src = activeLayer();
  if (!src) return;
  const idx = S.docs[S.cur].activeLayer;
  for (const fi of frames) {
    if (fi === S.cur) continue;
    pushUndo(fi);
    const doc = S.docs[fi];
    const L = findOrCreateLayer(doc, src.name, idx);
    const fresh = src.strokes.map((s) => cloneStroke(s, true));
    L.strokes = mode === 'replace' ? fresh : L.strokes.concat(fresh);
    L.opacity = src.opacity;
    markChanged(fi);
  }
}

/** Traz as linhas de outro quadro (mesmo nome de camada) para a camada ativa */
export function copyFromFrame(srcFi: number, mode: 'replace' | 'merge'): number {
  const L = activeLayer();
  if (!L || L.locked) return 0;
  const srcDoc = S.docs[srcFi];
  if (!srcDoc) return 0;
  const srcL = srcDoc.layers.find((l) => l.name === L.name) || srcDoc.layers[Math.min(S.docs[S.cur].activeLayer, srcDoc.layers.length - 1)];
  if (!srcL) return 0;
  pushUndo();
  const fresh = srcL.strokes.map((s) => cloneStroke(s, true));
  L.strokes = mode === 'replace' ? fresh : L.strokes.concat(fresh);
  S.selection = new Set(fresh.map((s) => s.id));
  markChanged();
  emit('selection');
  return fresh.length;
}

export function frameHasStrokes(fi: number): boolean {
  return S.docs[fi]?.layers.some((l) => l.strokes.length > 0) ?? false;
}

export function allLayerNames(): string[] {
  const names: string[] = [];
  for (const d of S.docs) for (const l of d.layers) if (!names.includes(l.name)) names.push(l.name);
  return names;
}

export function toast(msg: string, kind: 'info' | 'warn' | 'ok' = 'info') {
  window.dispatchEvent(new CustomEvent('app-toast', { detail: { msg, kind } }));
}
