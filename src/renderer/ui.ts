// Painéis: barra de ferramentas, opções, traços selecionados, camadas, fundo/onion, status
import { S, emit, on, activeLayer, pushUndo, markChanged, newLayer, saveSettings, setTool, copyFromFrame, toast, selectedStrokes } from './state';
import type { Settings, Stroke, ToolId } from './types';
import { $, h } from './dom';
import { TOOLS, deleteSelection, flipSelection, updateSelected } from './tools';
import { fitCurve, getSamples, uid } from './geom';
import { fitView, setRotation, setZoom, lastPointer, updateCursor } from './view';
import { askText } from './dialogs';
import { t, onLangChange, type Key } from './i18n';

export const TOOL_DEFS: { id: ToolId; key: string; icon: string }[] = [
  { id: 'select', key: 'V', icon: '<path d="M5 3l13 8-6 1.6L9.5 19z"/><path d="M14 14l4 4" />' },
  { id: 'pen', key: 'B', icon: '<path d="M4 20c4-1 6-3 9-6l5-5-3-3-5 5c-3 3-5 5-6 9z"/><path d="M14 6l3 3"/>' },
  { id: 'curve', key: 'C', icon: '<path d="M3 18C7 4 14 4 21 8"/><circle cx="3" cy="18" r="1.6"/><circle cx="11" cy="6.4" r="1.6"/><circle cx="21" cy="8" r="1.6"/>' },
  { id: 'line', key: 'L', icon: '<path d="M3 19L9 6l6 9 6-11"/><circle cx="3" cy="19" r="1.6"/><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="15" r="1.6"/>' },
  { id: 'edit', key: 'N', icon: '<path d="M4 18C8 8 16 16 20 6"/><rect x="9.8" y="9.6" width="4.4" height="4.4" fill="currentColor"/>' },
  { id: 'weight', key: 'W', icon: '<path d="M4 6h16" stroke-width="1"/><path d="M4 12h16" stroke-width="2.6"/><path d="M4 18.5h16" stroke-width="4.4"/>' },
  { id: 'pressure', key: 'U', icon: '<path d="M3 17c5-11 13-11 18-5"/><circle cx="8.5" cy="10" r="2.6" fill="currentColor"/><circle cx="18" cy="9.5" r="1.2" fill="currentColor"/>' },
  { id: 'color', key: 'K', icon: '<path d="M12 3c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11z"/>' },
  { id: 'eraser', key: 'E', icon: '<path d="M3 16.5l8-8 6 6-4 4H6.5z"/><path d="M11 8.5l3.5-3.5 6 6-3.5 3.5"/><path d="M3 21h18"/>' },
  { id: 'hand', key: 'H', icon: '<path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11M11 11V4a1.5 1.5 0 0 1 3 0v7M14 11V5.5a1.5 1.5 0 0 1 3 0V14c0 4-3 7-6.5 7-2.5 0-4.5-1.5-5.5-3.5l-2-4a1.5 1.5 0 0 1 2.6-1.5L8 14"/>' },
];

export const toolName = (id: ToolId) => t(('tool.' + id) as Key);
export const toolHint = (id: ToolId) => t(('tool.' + id + '.hint') as Key);

const svg = (inner: string) => `<svg viewBox="0 0 24 24">${inner}</svg>`;

// ---------------- barra de ferramentas ----------------
export function buildToolbar() {
  const tb = $('toolbar');
  tb.innerHTML = '';
  for (const td of TOOL_DEFS) {
    if (td.id === 'edit' || td.id === 'eraser' || td.id === 'hand') tb.append(h('div', { class: 'sep' }));
    const b = h('button', { 'data-tool': td.id, title: `${toolName(td.id)} (${td.key})`, html: svg(td.icon) + `<span class="k">${td.key}</span>` });
    b.onclick = () => setTool(td.id);
    tb.append(b);
  }
  tb.append(h('div', { class: 'sep' }));
  const sw = h('div', { class: 'swatch-cur', id: 'curColor', title: t('tool.currentColor') });
  const ci = h('input', { type: 'color', style: 'position:absolute;opacity:0;width:0;height:0' }) as HTMLInputElement;
  sw.onclick = () => { ci.value = S.settings.color; ci.click(); };
  ci.oninput = () => { S.settings.color = ci.value; settingsChanged(); };
  tb.append(sw, ci);
  refreshToolbar();
}
export function refreshToolbar() {
  document.querySelectorAll<HTMLButtonElement>('#toolbar button[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === S.tool));
  const sw = document.getElementById('curColor');
  if (sw) sw.style.background = S.settings.color;
}

export function settingsChanged() {
  saveSettings();
  emit('settings');
}

// ---------------- controles reutilizáveis ----------------
type NumKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];
type BoolKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

const WMAX = 300, WMIN = 0.3;
const w2r = (w: number) => Math.round((Math.log(w / WMIN) / Math.log(WMAX / WMIN)) * 1000);
const r2w = (r: number) => Math.round(WMIN * Math.pow(WMAX / WMIN, r / 1000) * 10) / 10;

function widthControl(label = t('opt.width')): HTMLElement {
  const range = h('input', { type: 'range', min: '0', max: '1000', value: String(w2r(S.settings.width)) }) as HTMLInputElement;
  const num = h('input', { type: 'number', min: '0.1', max: '500', step: '0.1', class: 'num', value: String(S.settings.width), id: 'optWidth' }) as HTMLInputElement;
  range.oninput = () => { S.settings.width = r2w(+range.value); num.value = String(S.settings.width); settingsChanged(); };
  num.onchange = () => { const v = Math.max(0.1, Math.min(500, +num.value || 1)); S.settings.width = v; range.value = String(w2r(v)); settingsChanged(); };
  return h('label', { class: 'field' }, label, range, num);
}
function slider(label: string, key: NumKey, min: number, max: number, step: number, fmt: (v: number) => string, scale = 1): HTMLElement {
  const v = (S.settings[key] as number) * scale;
  const out = h('span', {}, fmt(S.settings[key] as number));
  const r = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(v) }) as HTMLInputElement;
  r.oninput = () => { (S.settings as any)[key] = +r.value / scale; out.textContent = fmt(S.settings[key] as number); settingsChanged(); };
  return h('label', { class: 'field' }, label, r, out);
}
function check(label: string, key: BoolKey): HTMLElement {
  const c = h('input', { type: 'checkbox' }) as HTMLInputElement;
  c.checked = S.settings[key] as boolean;
  c.onchange = () => { (S.settings as any)[key] = c.checked; settingsChanged(); };
  return h('label', { class: 'chk' }, c, label);
}
function colorRow(): HTMLElement {
  const ci = h('input', { type: 'color', value: S.settings.color }) as HTMLInputElement;
  ci.oninput = () => { S.settings.color = ci.value; settingsChanged(); };
  const sw = h('div', { class: 'swatches' });
  for (const c of S.settings.swatches) {
    const b = h('button', { class: 'sw' + (c.toLowerCase() === S.settings.color.toLowerCase() ? ' cur' : ''), style: `background:${c}`, title: t('opt.swatch.title', { c }) });
    b.onclick = () => { S.settings.color = c; settingsChanged(); };
    b.oncontextmenu = (e: MouseEvent) => {
      e.preventDefault();
      const i = S.settings.swatches.indexOf(c);
      if (i >= 0) { S.settings.swatches[i] = S.settings.color; settingsChanged(); }
    };
    sw.append(b);
  }
  return h('div', { class: 'row colorrow' }, h('span', {}, t('opt.color')), ci, sw);
}
function taperControls(): HTMLElement[] {
  const f = (v: number) => Math.round(v * 200) + '%';
  return [slider(t('opt.taperStart'), 'taperStart', 0, 50, 1, f, 100), slider(t('opt.taperEnd'), 'taperEnd', 0, 50, 1, f, 100)];
}
function hint(text: string) { return h('div', { class: 'hint' }, text); }

// ---------------- painel de opções da ferramenta ----------------
export function refreshToolOptions() {
  const box = $('toolOptions');
  const def = TOOL_DEFS.find((t) => t.id === S.tool)!;
  $('pToolTitle').textContent = toolName(def.id);
  box.innerHTML = '';
  const st = S.settings;
  switch (S.tool) {
    case 'pen':
      box.append(widthControl(), colorRow(),
        slider(t('opt.stabilizer'), 'stabilizer', 0, 20, 1, (v) => String(v)),
        check(t('opt.usePressure'), 'usePressure'),
        slider(t('opt.minPressure'), 'minPressure', 0, 100, 1, (v) => Math.round(v * 100) + '%', 100),
        ...taperControls());
      break;
    case 'curve':
    case 'line':
      box.append(widthControl(), colorRow(), ...taperControls(), check(t('opt.closeSnap'), 'closeCurveSnap'));
      break;
    case 'edit':
      box.append(check(t('opt.showPoints'), 'showPoints'));
      break;
    case 'weight':
      box.append(widthControl(t('opt.widthClick')));
      break;
    case 'color':
      box.append(colorRow());
      break;
    case 'eraser': {
      const seg = h('div', { class: 'seg' });
      const modes: [Settings['eraserMode'], string][] = [['stroke', t('opt.eraser.stroke')], ['intersect', t('opt.eraser.intersect')], ['area', t('opt.eraser.area')]];
      for (const [m, lbl] of modes) {
        const b = h('button', { class: st.eraserMode === m ? 'on' : '' }, lbl);
        b.onclick = () => { st.eraserMode = m; settingsChanged(); refreshToolOptions(); };
        seg.append(b);
      }
      box.append(seg, slider(t('opt.size'), 'eraserSize', 2, 120, 1, (v) => v + ' px'));
      break;
    }
    case 'select':
      box.append(check(t('opt.scaleWidth'), 'scaleWidth'));
      break;
  }
  box.append(hint(toolHint(def.id)));
}

// ---------------- traços selecionados ----------------
export function refreshStrokeProps() {
  const sel = selectedStrokes();
  $('selCount').textContent = String(sel.length);
  const box = $('strokeProps');
  box.innerHTML = '';
  if (!sel.length) {
    box.append(hint(t('sel.none')));
    return;
  }
  const first = sel[0];
  const same = <T,>(f: (s: Stroke) => T) => sel.every((s) => f(s) === f(first));
  const wNum = h('input', { type: 'number', min: '0.1', max: '500', step: '0.1', class: 'num', value: same((s) => s.width) ? String(first.width) : '' , placeholder: t('sel.various') }) as HTMLInputElement;
  wNum.onchange = () => { const v = Math.max(0.1, +wNum.value || 1); updateSelected((s) => ({ ...s, width: v })); };
  const col = h('input', { type: 'color', value: first.color }) as HTMLInputElement;
  col.onchange = () => updateSelected((s) => ({ ...s, color: col.value }));
  const ts = h('input', { type: 'range', min: '0', max: '50', value: String(Math.round(first.taperStart * 100)) }) as HTMLInputElement;
  const te = h('input', { type: 'range', min: '0', max: '50', value: String(Math.round(first.taperEnd * 100)) }) as HTMLInputElement;
  ts.onchange = () => updateSelected((s) => ({ ...s, taperStart: +ts.value / 100 }));
  te.onchange = () => updateSelected((s) => ({ ...s, taperEnd: +te.value / 100 }));
  const closed = h('input', { type: 'checkbox' }) as HTMLInputElement;
  closed.checked = first.closed;
  closed.onchange = () => updateSelected((s) => (s.pts.length >= 3 ? { ...s, closed: closed.checked } : s));
  const kind = h('select', {}, h('option', { value: 'curve' }, t('sel.kind.curve')), h('option', { value: 'line' }, t('sel.kind.line'))) as HTMLSelectElement;
  kind.value = first.kind;
  kind.onchange = () => updateSelected((s) => ({ ...s, kind: kind.value as Stroke['kind'] }));
  const btn = (label: string, title: string, fn: () => void) => { const b = h('button', { title }, label); b.onclick = fn; return b; };
  box.append(
    h('label', { class: 'field' }, t('sel.width'), wNum, t('sel.color'), col),
    h('label', { class: 'field' }, t('sel.taperStart'), ts),
    h('label', { class: 'field' }, t('sel.taperEnd'), te),
    h('div', { class: 'row' }, h('label', { class: 'chk' }, closed, t('sel.closed')), kind),
    h('div', { class: 'row tight wrap' },
      btn(t('sel.resetPressure'), t('sel.resetPressure.title'), () => updateSelected((s) => ({ ...s, pts: s.pts.map((p) => ({ ...p, p: 1 })) }))),
      btn(t('sel.simplify'), t('sel.simplify.title'), () => updateSelected(simplifyStroke)),
      btn(t('sel.reverse'), t('sel.reverse.title'), () => updateSelected((s) => ({ ...s, pts: s.pts.slice().reverse(), taperStart: s.taperEnd, taperEnd: s.taperStart }))),
    ),
    h('div', { class: 'row tight wrap' },
      btn(t('sel.flipH'), t('sel.flipH.title'), () => flipSelection(true)),
      btn(t('sel.flipV'), t('sel.flipV.title'), () => flipSelection(false)),
      btn(t('sel.delete'), t('sel.delete.title'), () => deleteSelection()),
    ),
  );
}

function simplifyStroke(s: Stroke): Stroke {
  if (s.kind === 'line' || s.pts.length < 4) return s;
  const sm = getSamples(s, 2);
  const pts = [] as { x: number; y: number; p: number }[];
  for (let i = 0; i < sm.n; i++) pts.push({ x: sm.xs[i], y: sm.ys[i], p: sm.ps[i] });
  const fitted = fitCurve(pts, 0.9);
  if (s.closed && fitted.length > 3) fitted.pop();
  return fitted.length >= 2 ? { ...s, pts: fitted } : s;
}

// ---------------- camadas ----------------
let dragLayer = -1;
export function refreshLayers() {
  const ul = $('layerList');
  ul.innerHTML = '';
  $('layerFrameLbl').textContent = S.loaded ? `#${S.cur + 1}` : '';
  if (!S.loaded) return;
  const doc = S.docs[S.cur];
  // topo da lista = camada de cima
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const L = doc.layers[i];
    const eye = h('button', { class: L.visible ? '' : 'off', title: L.visible ? t('layer.hide') : t('layer.show') }, L.visible ? '👁' : '🚫');
    eye.onclick = (e: MouseEvent) => { e.stopPropagation(); pushUndo(); L.visible = !L.visible; markChanged(); refreshLayers(); };
    const lock = h('button', { class: L.locked ? '' : 'off', title: L.locked ? t('layer.unlock') : t('layer.lock') }, L.locked ? '🔒' : '🔓');
    lock.onclick = (e: MouseEvent) => { e.stopPropagation(); L.locked = !L.locked; S.dirty = true; refreshLayers(); emit('layers'); };
    const nm = h('span', { class: 'nm', title: t('layer.rename.title') }, L.name);
    const li = h('li', { class: i === doc.activeLayer ? 'active' : '', draggable: 'true' }, eye, lock, nm, h('span', { class: 'cnt', title: t('layer.strokes.title') }, String(L.strokes.length)));
    li.onclick = () => { if (doc.activeLayer !== i) { doc.activeLayer = i; S.selection.clear(); emit('layers', 'selection'); } };
    li.ondblclick = async () => {
      const name = await askText(t('layer.rename'), L.name);
      if (name && name.trim()) { pushUndo(); L.name = name.trim(); markChanged(); refreshLayers(); }
    };
    li.ondragstart = () => { dragLayer = i; };
    li.ondragover = (e: DragEvent) => { e.preventDefault(); li.classList.add('dragover'); };
    li.ondragleave = () => li.classList.remove('dragover');
    li.ondrop = (e: DragEvent) => {
      e.preventDefault(); e.stopPropagation();
      li.classList.remove('dragover');
      if (dragLayer < 0 || dragLayer === i) return;
      moveLayer(dragLayer, i);
      dragLayer = -1;
    };
    ul.append(li);
  }
  const L = doc.layers[doc.activeLayer];
  const op = $<HTMLInputElement>('lyOpacity');
  op.value = String(Math.round(L.opacity * 100));
  $('lyOpacityV').textContent = Math.round(L.opacity * 100) + '%';
  $<HTMLButtonElement>('lyDel').disabled = doc.layers.length <= 1;
}
function moveLayer(from: number, to: number) {
  const doc = S.docs[S.cur];
  pushUndo();
  const act = doc.layers[doc.activeLayer];
  const [L] = doc.layers.splice(from, 1);
  doc.layers.splice(to, 0, L);
  doc.activeLayer = doc.layers.indexOf(act);
  markChanged();
  refreshLayers();
}

export function bindLayerButtons() {
  $('lyAdd').onclick = () => {
    if (!S.loaded) return;
    const doc = S.docs[S.cur];
    pushUndo();
    const L = newLayer(uniqueLayerName(doc.layers.map((l) => l.name)));
    doc.layers.splice(doc.activeLayer + 1, 0, L);
    doc.activeLayer = doc.activeLayer + 1;
    S.selection.clear();
    markChanged();
    emit('layers', 'selection');
  };
  $('lyAddAll').onclick = async () => {
    if (!S.loaded) return;
    const name = await askText(t('layer.newAllPrompt'), uniqueLayerName(S.docs[S.cur].layers.map((l) => l.name)));
    if (!name) return;
    S.docs.forEach((doc, fi) => {
      if (doc.layers.some((l) => l.name === name)) return;
      pushUndo(fi);
      doc.layers.splice(doc.activeLayer + 1, 0, newLayer(name));
      if (fi === S.cur) doc.activeLayer = doc.activeLayer + 1;
      markChanged(fi);
    });
    emit('layers');
    toast(t('toast.layerAllCreated', { name }), 'ok');
  };
  $('lyDup').onclick = () => {
    if (!S.loaded) return;
    const doc = S.docs[S.cur];
    const src = doc.layers[doc.activeLayer];
    pushUndo();
    const L = { ...src, id: uid(), name: src.name + ' ' + t('layer.copySuffix'), strokes: src.strokes.map((s) => ({ ...s, id: uid() })) };
    doc.layers.splice(doc.activeLayer + 1, 0, L);
    doc.activeLayer++;
    markChanged();
    emit('layers');
  };
  $('lyUp').onclick = () => {
    const doc = S.docs[S.cur];
    if (!doc || doc.activeLayer >= doc.layers.length - 1) return;
    moveLayer(doc.activeLayer, doc.activeLayer + 1);
  };
  $('lyDown').onclick = () => {
    const doc = S.docs[S.cur];
    if (!doc || doc.activeLayer <= 0) return;
    moveLayer(doc.activeLayer, doc.activeLayer - 1);
  };
  $('lyDel').onclick = () => {
    const doc = S.docs[S.cur];
    if (!doc || doc.layers.length <= 1) return;
    pushUndo();
    doc.layers.splice(doc.activeLayer, 1);
    doc.activeLayer = Math.max(0, doc.activeLayer - 1);
    S.selection.clear();
    markChanged();
    emit('layers', 'selection');
  };
  let opUndo = false;
  const op = $<HTMLInputElement>('lyOpacity');
  op.oninput = () => {
    const L = activeLayer();
    if (!L) return;
    if (!opUndo) { pushUndo(); opUndo = true; }
    L.opacity = +op.value / 100;
    $('lyOpacityV').textContent = op.value + '%';
    markChanged();
  };
  op.onchange = () => { opUndo = false; };
}
function uniqueLayerName(existing: string[]) {
  let i = existing.length + 1;
  while (existing.includes(t('layer.numbered', { n: i }))) i++;
  return t('layer.numbered', { n: i });
}

// ---------------- fundo e onion ----------------
export function bindBgPanel() {
  const st = S.settings;
  const bind = (id: string, key: keyof Settings, kind: 'check' | 'range100' | 'num' | 'color') => {
    const el = $<HTMLInputElement>(id);
    const vEl = document.getElementById(id + 'V');
    const sync = () => {
      const v = st[key] as any;
      if (kind === 'check') el.checked = v;
      else if (kind === 'range100') { el.value = String(Math.round(v * 100)); if (vEl) vEl.textContent = Math.round(v * 100) + '%'; }
      else el.value = String(v);
    };
    el.addEventListener(kind === 'check' ? 'change' : 'input', () => {
      if (kind === 'check') (st as any)[key] = el.checked;
      else if (kind === 'range100') (st as any)[key] = +el.value / 100;
      else if (kind === 'num') (st as any)[key] = Math.max(0, Math.min(5, Math.round(+el.value || 0)));
      else (st as any)[key] = el.value;
      sync();
      settingsChanged();
    });
    on('settings', sync);
    sync();
  };
  bind('bgVisible', 'bgVisible', 'check');
  bind('bgGray', 'bgGray', 'check');
  bind('bgOpacity', 'bgOpacity', 'range100');
  bind('onion', 'onion', 'check');
  bind('onionPrev', 'onionPrev', 'num');
  bind('onionNext', 'onionNext', 'num');
  bind('onionOpacity', 'onionOpacity', 'range100');
  bind('onionPrevColor', 'onionPrevColor', 'color');
  bind('onionNextColor', 'onionNextColor', 'color');

  $('frCopyPrev').onclick = () => copyNeighbor(-1);
  $('frCopyNext').onclick = () => copyNeighbor(1);
  $('frClear').onclick = () => {
    const L = activeLayer();
    if (!L || L.locked || !L.strokes.length) return;
    pushUndo(); L.strokes = []; S.selection.clear(); markChanged(); emit('selection');
  };
}
export function copyNeighbor(dir: number) {
  if (!S.loaded) return;
  const fi = S.cur + dir;
  if (fi < 0 || fi >= S.frames.length) { toast(dir < 0 ? t('toast.noPrev') : t('toast.noNext'), 'warn'); return; }
  const n = copyFromFrame(fi, 'merge');
  if (n) toast(t('toast.copiedFrom', { n, f: fi + 1 }), 'ok');
  else toast(t('toast.nothingToCopy', { f: fi + 1 }), 'warn');
}

// ---------------- barra de status ----------------
export function refreshStatus() {
  const v = S.view;
  $('stZoom').textContent = Math.round(v.zoom * 100) + '%';
  $('stRot').textContent = Math.round(v.rot) + '°';
  $('stFrame').textContent = S.loaded ? t('status.frame', { cur: S.cur + 1, n: S.frames.length, w: S.docW, h: S.docH }) : '—';
  $('stTool').textContent = toolName(S.tool);
}
export function refreshPointerStatus() {
  const p = lastPointer;
  $('stPos').textContent = p && S.loaded ? `x ${p.x.toFixed(1)}  y ${p.y.toFixed(1)}` : '';
}
export function bindStatus() {
  $('stZoomIn').onclick = () => setZoom(S.view.zoom * 1.25);
  $('stZoomOut').onclick = () => setZoom(S.view.zoom / 1.25);
  $('stFit').onclick = () => fitView();
  $('stRotL').onclick = () => setRotation(S.view.rot - 15);
  $('stRotR').onclick = () => setRotation(S.view.rot + 15);
  $('stRotReset').onclick = () => setRotation(0);
}

export function initPanels() {
  buildToolbar();
  bindLayerButtons();
  bindBgPanel();
  bindStatus();
  document.querySelectorAll('.panel h3').forEach((h3) => {
    h3.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.badge')) return;
      h3.parentElement!.classList.toggle('collapsed');
    });
  });
  on('tool', () => { refreshToolbar(); refreshToolOptions(); refreshStatus(); updateCursor(); });
  on('settings', () => {
    refreshToolbar();
    const ae = document.activeElement as HTMLElement | null;
    if (!(ae && ae.tagName === 'INPUT' && ae.closest('#toolOptions'))) refreshToolOptions();
  });
  on('selection', refreshStrokeProps);
  on('doc', () => { refreshStrokeProps(); refreshLayerCounts(); });
  on('layers', refreshLayers);
  on('frame', () => { refreshLayers(); refreshStatus(); refreshStrokeProps(); });
  on('view', refreshStatus);
  on('pointer', refreshPointerStatus);
  on('loaded', () => { refreshLayers(); refreshStatus(); refreshStrokeProps(); });
  onLangChange(() => { buildToolbar(); refreshToolOptions(); refreshStrokeProps(); refreshLayers(); refreshStatus(); });
  refreshToolOptions();
  refreshStrokeProps();
  refreshStatus();
  void TOOLS;
}
function refreshLayerCounts() {
  // atualiza contadores sem reconstruir (evita perder foco)
  const doc = S.docs[S.cur];
  if (!doc) return;
  const items = $('layerList').querySelectorAll('li .cnt');
  const n = doc.layers.length;
  if (items.length !== n) { refreshLayers(); return; }
  items.forEach((el, k) => { el.textContent = String(doc.layers[n - 1 - k].strokes.length); });
}
