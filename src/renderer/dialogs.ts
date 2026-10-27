// Diálogos: renomear, exportar, copiar para quadros, prévia animada, auto-traçar, atalhos
import { S, allLayerNames, copyLayerToFrames, copySelection, pasteToFrames, toast, pushUndo, markChanged, newLayer, emit } from './state';
import { $, h, showModal } from './dom';
import { fileName, runExport } from './exporter';
import { drawFrameLayers } from './render';
import { traceCanvas } from './trace';
import { isElectron } from './platform';
import { t, onLangChange, isAnyTranslation, type Key } from './i18n';

// ---------------- prompt de texto ----------------
export function askText(title: string, value: string): Promise<string | null> {
  return new Promise((resolve) => {
    $('prTitle').textContent = title;
    const inp = $<HTMLInputElement>('prInput');
    inp.value = value;
    showModal('dlgPrompt');
    setTimeout(() => { inp.focus(); inp.select(); }, 30);
    const done = (v: string | null) => {
      showModal('dlgPrompt', false);
      inp.onkeydown = null;
      resolve(v);
    };
    $('prOk').onclick = () => done(inp.value);
    $('prCancel').onclick = () => done(null);
    inp.onkeydown = (e) => {
      if (e.key === 'Enter') done(inp.value);
      if (e.key === 'Escape') done(null);
      e.stopPropagation();
    };
  });
}

// ---------------- exportar ----------------
let exporting = false;
let exportCancel = false;
export function openExportDialog(format: 'png' | 'svg' = 'png') {
  if (!S.loaded) { toast(t('toast.openFirst'), 'warn'); return; }
  const fmt = $<HTMLSelectElement>('exFormat');
  fmt.value = format;
  const frames = $<HTMLSelectElement>('exFrames');
  const from = $<HTMLInputElement>('exFrom'), to = $<HTMLInputElement>('exTo');
  from.max = to.max = String(S.frames.length);
  if (!from.value) from.value = '1';
  to.value = to.value && +to.value <= S.frames.length ? to.value : String(S.frames.length);
  const sizeMode = $<HTMLSelectElement>('exSizeMode');
  const sc = $<HTMLInputElement>('exScale');
  const W = $<HTMLInputElement>('exW'), H = $<HTMLInputElement>('exH');
  const lock = $<HTMLInputElement>('exLock');
  if (!W.value) { W.value = String(Math.round(S.docW * (+sc.value || 2))); H.value = String(Math.round(S.docH * (+sc.value || 2))); }
  const pfx = $<HTMLInputElement>('exPrefix');
  if (!pfx.value || isAnyTranslation('export.prefixDefault', pfx.value)) pfx.value = t('export.prefixDefault');
  const bg = $<HTMLSelectElement>('exBg');
  const layersBox = $('exLayers');
  layersBox.innerHTML = '';
  for (const name of allLayerNames()) {
    const c = h('input', { type: 'checkbox', 'data-layer': name }) as HTMLInputElement;
    c.checked = true;
    layersBox.append(h('label', { class: 'chk' }, c, name));
  }
  const dims = () => {
    if (sizeMode.value === 'scale') {
      const s = Math.max(0.05, +sc.value || 1);
      return { w: Math.max(1, Math.round(S.docW * s)), h: Math.max(1, Math.round(S.docH * s)) };
    }
    return { w: Math.max(1, Math.round(+W.value || S.docW)), h: Math.max(1, Math.round(+H.value || S.docH)) };
  };
  const update = () => {
    $('exRangeWrap').style.display = frames.value === 'range' ? '' : 'none';
    $('exScaleWrap').style.display = sizeMode.value === 'scale' ? '' : 'none';
    $('exSizeWrap').style.display = sizeMode.value === 'size' ? '' : 'none';
    $<HTMLInputElement>('exBgColor').style.display = bg.value === 'color' ? '' : 'none';
    const d = dims();
    $('exSizeInfo').textContent = t('export.output', { w: d.w, h: d.h, ow: S.docW, oh: S.docH }) + (d.w * d.h > 8192 * 8192 ? t('export.tooBig') : '');
    const ext = fmt.value;
    $('exNameEx').textContent = t('export.example', { name: fileName($<HTMLInputElement>('exPrefix').value, 0, S.frames.length, ext) });
    $('exGo').textContent = isElectron ? t('export.goFolder') : t('export.goZip');
  };
  W.oninput = () => { if (lock.checked) H.value = String(Math.round((+W.value * S.docH) / S.docW)); update(); };
  H.oninput = () => { if (lock.checked) W.value = String(Math.round((+H.value * S.docW) / S.docH)); update(); };
  for (const el of [fmt, frames, sizeMode, sc, bg, from, to, $('exPrefix')]) (el as HTMLInputElement).oninput = update;
  for (const el of [fmt, frames, sizeMode, bg]) (el as HTMLSelectElement).onchange = update;
  update();
  $('exProgress').hidden = true;
  $<HTMLButtonElement>('exGo').disabled = false;
  showModal('dlgExport');
  $('exCancel').onclick = () => {
    if (exporting) { exportCancel = true; return; }
    showModal('dlgExport', false);
  };
  $('exGo').onclick = async () => {
    if (exporting) return;
    let list: number[] = [];
    const n = S.frames.length;
    if (frames.value === 'all') list = Array.from({ length: n }, (_, i) => i);
    else if (frames.value === 'current') list = [S.cur];
    else if (frames.value === 'drawn') list = Array.from({ length: n }, (_, i) => i).filter((i) => S.docs[i].layers.some((l) => l.visible && l.strokes.length));
    else {
      const a = Math.max(1, Math.min(n, +from.value || 1)), b = Math.max(1, Math.min(n, +to.value || n));
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) list.push(i - 1);
    }
    if (!list.length) { toast(t('export.none'), 'warn'); return; }
    const names = new Set<string>();
    layersBox.querySelectorAll<HTMLInputElement>('input[data-layer]').forEach((c) => { if (c.checked) names.add(c.dataset.layer!); });
    const d = dims();
    const background = bg.value === 'transparent' ? null : bg.value === 'white' ? '#ffffff' : $<HTMLInputElement>('exBgColor').value;
    exporting = true; exportCancel = false;
    $<HTMLButtonElement>('exGo').disabled = true;
    const prog = $('exProgress');
    prog.hidden = false;
    const setP = (k: number, t: number) => {
      (prog.firstElementChild as HTMLElement).style.width = (100 * k) / t + '%';
      (prog.lastElementChild as HTMLElement).textContent = `${k} / ${t}`;
    };
    setP(0, list.length);
    try {
      const where = await runExport({
        format: fmt.value as 'png' | 'svg', frames: list, width: d.w, height: d.h, background,
        includeGif: $<HTMLInputElement>('exIncludeGif').checked,
        layerNames: names.size === allLayerNames().length ? null : names,
        prefix: $<HTMLInputElement>('exPrefix').value,
      }, setP, () => exportCancel);
      if (where) {
        toast(t('export.done', { n: list.length, where }), 'ok');
        showModal('dlgExport', false);
      }
    } catch (err: any) {
      toast(t('export.error', { msg: err?.message || String(err) }), 'warn');
    } finally {
      exporting = false;
      $<HTMLButtonElement>('exGo').disabled = false;
    }
  };
}

// ---------------- copiar para intervalo ----------------
export function openRangeDialog(prefer: 'layer' | 'selection' = 'layer') {
  if (!S.loaded) return;
  const what = $<HTMLSelectElement>('rgWhat');
  what.value = prefer === 'selection' && S.selection.size ? 'selection' : 'layer';
  const from = $<HTMLInputElement>('rgFrom'), to = $<HTMLInputElement>('rgTo');
  from.max = to.max = String(S.frames.length);
  from.value = String(Math.min(S.cur + 2, S.frames.length));
  to.value = String(S.frames.length);
  showModal('dlgRange');
  $('rgCancel').onclick = () => showModal('dlgRange', false);
  $('rgGo').onclick = () => {
    const n = S.frames.length;
    const a = Math.max(1, Math.min(n, +from.value || 1)), b = Math.max(1, Math.min(n, +to.value || n));
    const list: number[] = [];
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i - 1 !== S.cur) list.push(i - 1);
    if (!list.length) { toast(t('range.empty'), 'warn'); return; }
    const mode = $<HTMLSelectElement>('rgMode').value as 'merge' | 'replace';
    if (what.value === 'selection') {
      if (!copySelection()) { toast(t('toast.nothingSelected'), 'warn'); return; }
      if (mode === 'replace') {
        const L = S.docs[S.cur].layers[S.docs[S.cur].activeLayer];
        for (const fi of list) {
          const T = S.docs[fi].layers.find((l) => l.name === L.name);
          if (T && !T.locked) { pushUndo(fi); T.strokes = []; markChanged(fi); }
        }
      }
      pasteToFrames(list);
    } else {
      copyLayerToFrames(list, mode);
    }
    emit('doc');
    toast(t('range.done', { n: list.length }), 'ok');
    showModal('dlgRange', false);
  };
}

// ---------------- prévia animada ----------------
let pvTimer = 0;
let pvPlaying = true;
let pvFrame = 0;
export function openPreview() {
  if (!S.loaded) return;
  showModal('dlgPreview');
  const c = $<HTMLCanvasElement>('pvCanvas');
  const wrap = c.parentElement!;
  const maxW = wrap.clientWidth - 10, maxH = wrap.clientHeight - 10;
  const s = Math.min(maxW / S.docW, maxH / S.docH, 4);
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(S.docW * s * dpr); c.height = Math.round(S.docH * s * dpr);
  c.style.width = Math.round(S.docW * s) + 'px'; c.style.height = Math.round(S.docH * s) + 'px';
  pvFrame = S.cur;
  pvPlaying = true;
  $('pvPlay').textContent = t('preview.pause');
  const draw = () => {
    const g = c.getContext('2d')!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    const sc = c.width / S.docW;
    if ($<HTMLInputElement>('pvBg').checked) {
      g.globalAlpha = 1;
      g.drawImage(S.frames[pvFrame].canvas, 0, 0, c.width, c.height);
    } else {
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    }
    g.setTransform(sc, 0, 0, sc, 0, 0);
    drawFrameLayers(g, S.docs[pvFrame], { scale: sc });
    $('pvLabel').textContent = t('preview.label', { cur: pvFrame + 1, n: S.frames.length });
  };
  const tick = () => {
    clearTimeout(pvTimer);
    draw();
    if (!pvPlaying) return;
    const delay = $<HTMLInputElement>('pvGifTiming').checked ? S.frames[pvFrame].delay : 1000 / Math.max(1, +$<HTMLInputElement>('pvFps').value || 12);
    pvTimer = window.setTimeout(() => {
      if (pvFrame + 1 >= S.frames.length && !$<HTMLInputElement>('pvLoop').checked) { pvPlaying = false; $('pvPlay').textContent = t('preview.play'); return; }
      pvFrame = (pvFrame + 1) % S.frames.length;
      tick();
    }, delay);
  };
  $('pvPlay').onclick = () => {
    pvPlaying = !pvPlaying;
    $('pvPlay').textContent = pvPlaying ? t('preview.pause') : t('preview.play');
    if (pvPlaying) tick();
  };
  $('pvBg').onchange = draw;
  $('pvClose').onclick = closePreview;
  tick();
}
export function closePreview() {
  clearTimeout(pvTimer);
  pvPlaying = false;
  showModal('dlgPreview', false);
}

// ---------------- auto-traçar ----------------
export function openTraceDialog() {
  if (!S.loaded) { toast(t('toast.openFirst'), 'warn'); return; }
  const ids = ['trThresh', 'trBlur', 'trMin'];
  const upd = () => ids.forEach((id) => { $(id + 'V').textContent = $<HTMLInputElement>(id).value; });
  ids.forEach((id) => { $<HTMLInputElement>(id).oninput = upd; });
  upd();
  $('trProgress').hidden = true;
  showModal('dlgTrace');
  let cancel = false;
  let running = false;
  $('trCancel').onclick = () => { if (running) cancel = true; else showModal('dlgTrace', false); };
  $('trGo').onclick = async () => {
    if (running) return;
    running = true; cancel = false;
    const opts = {
      threshold: +$<HTMLInputElement>('trThresh').value,
      blur: +$<HTMLInputElement>('trBlur').value,
      minLength: +$<HTMLInputElement>('trMin').value,
      width: Math.max(0.3, +$<HTMLInputElement>('trWidth').value || 1.5),
      color: S.settings.color,
    };
    const list = $<HTMLSelectElement>('trFrames').value === 'all' ? S.frames.map((_, i) => i) : [S.cur];
    const prog = $('trProgress');
    prog.hidden = false;
    let total = 0;
    const traceName = t('layer.autoTrace');
    for (let k = 0; k < list.length; k++) {
      if (cancel) break;
      const fi = list[k];
      const strokes = traceCanvas(S.frames[fi].canvas, opts);
      const doc = S.docs[fi];
      pushUndo(fi);
      let L = doc.layers.find((l) => l.name === traceName) || doc.layers.find((l) => isAnyTranslation('layer.autoTrace', l.name));
      if (!L) { L = newLayer(traceName); doc.layers.push(L); }
      L.strokes = strokes;
      if (fi === S.cur) doc.activeLayer = doc.layers.indexOf(L);
      markChanged(fi);
      total += strokes.length;
      (prog.firstElementChild as HTMLElement).style.width = (100 * (k + 1)) / list.length + '%';
      (prog.lastElementChild as HTMLElement).textContent = `${k + 1} / ${list.length}`;
      await new Promise((r) => setTimeout(r, 0));
    }
    running = false;
    emit('layers', 'doc');
    toast(t('trace.done', { n: total, layer: traceName }), 'ok');
    showModal('dlgTrace', false);
  };
}

// ---------------- atalhos ----------------
type ScItem = [Key, string | Key];
/** Teclas que contêm palavras são chaves de tradução (terminam em ".k"). */
export const SHORTCUTS: [Key, ScItem[]][] = [
  ['sc.tools', [
    ['sc.select', 'V'], ['sc.pen', 'B'], ['sc.curve', 'C'], ['sc.line', 'L'],
    ['sc.edit', 'N'], ['sc.weight', 'W'], ['sc.pressure', 'U'], ['sc.color', 'K'],
    ['sc.eraser', 'E'], ['sc.hand', 'H'], ['sc.widthPM', '[  ]'], ['sc.stabPM', 'Shift+[  ]'],
  ]],
  ['sc.curveLine', [
    ['sc.finish', 'sc.finish.k'], ['sc.finishClosed', 'sc.finishClosed.k'],
    ['sc.undoPoint', 'Backspace'], ['sc.cancel', 'Esc'], ['sc.angle', 'Shift'],
  ]],
  ['sc.editPoints', [
    ['sc.movePoint', 'sc.movePoint.k'], ['sc.insertPoint', 'sc.insertPoint.k'],
    ['sc.moveStroke', 'sc.moveStroke.k'], ['sc.deletePoint', 'sc.deletePoint.k'],
  ]],
  ['sc.frames', [
    ['sc.prevNext', 'sc.prevNext.k'], ['sc.firstLast', 'Home / End'],
    ['sc.copyNeighbor', 'Alt+← / Alt+→'], ['sc.copyRange', 'Ctrl+Shift+V'],
    ['sc.preview', 'P'], ['sc.play', 'Shift+P'],
  ]],
  ['sc.view', [
    ['sc.toggleGif', 'F'], ['sc.grayGif', 'G'], ['sc.onion', 'O'],
    ['sc.pan', 'sc.pan.k'], ['sc.zoom', 'sc.zoom.k'], ['sc.fit', '0'], ['sc.zoom100', '1'],
    ['sc.rotate', 'sc.rotate.k'], ['sc.rotReset', 'Shift+R'],
  ]],
  ['sc.editing', [
    ['sc.undoRedo', 'Ctrl+Z / Ctrl+Y'], ['sc.clip', 'Ctrl+C / X / V'],
    ['sc.selectAll', 'Ctrl+A'], ['sc.deselect', 'Ctrl+D / Esc'], ['sc.deleteSel', 'Delete'],
    ['sc.newLayer', 'Ctrl+Shift+N'],
  ]],
  ['sc.file', [
    ['sc.newProject', 'Ctrl+N'], ['sc.openGif', 'Ctrl+O'], ['sc.openProject', 'Ctrl+Shift+O'], ['sc.save', 'Ctrl+S'],
    ['sc.saveAs', 'Ctrl+Shift+S'], ['sc.exportPng', 'Ctrl+E'], ['sc.exportSvg', 'Ctrl+Shift+E'], ['sc.help', 'sc.help.k'],
  ]],
];
const keyLabel = (k: string) => (k.startsWith('sc.') ? t(k as Key) : k);
function buildHelp() {
  const body = $('helpBody');
  body.innerHTML = '';
  for (const [title, items] of SHORTCUTS) {
    body.append(h('h4', {}, t(title)));
    for (const [a, b] of items) body.append(h('div', {}, h('span', {}, t(a)), h('kbd', {}, keyLabel(b))));
  }
}
export function openHelp() {
  buildHelp();
  showModal('dlgHelp');
  $('helpClose').onclick = () => showModal('dlgHelp', false);
  $('helpAbout').onclick = () => { showModal('dlgHelp', false); openAbout(); };
}

// ---------------- sobre ----------------
declare const __APP_VERSION__: string;
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
export function openAbout() {
  $('aboutVer').textContent = t('about.version', { v: APP_VERSION });
  showModal('dlgAbout');
  $('aboutClose').onclick = () => showModal('dlgAbout', false);
}

onLangChange(() => {
  if (!$('dlgHelp').hidden) buildHelp();
  $('aboutVer').textContent = t('about.version', { v: APP_VERSION });
  if (!$('dlgPreview').hidden) $('pvPlay').textContent = pvPlaying ? t('preview.pause') : t('preview.play');
});
