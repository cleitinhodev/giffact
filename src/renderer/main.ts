// Ponto de entrada do renderer
import { S, emit, on, goFrame, setTool, undo, redo, copySelection, pasteToFrames, toast, activeLayer, saveSettings, closeDocument } from './state';
import { initView, fitView, setZoom, setRotation, requestRender, updateCursor } from './view';
import { TOOLS, currentTool, onToolChanged, deleteSelection, selectAll } from './tools';
import { initPanels, copyNeighbor, settingsChanged, TOOL_DEFS } from './ui';
import { initTimeline, togglePlay, stopPlay } from './timeline';
import { openExportDialog, openRangeDialog, openPreview, closePreview, openTraceDialog, openHelp, openAbout, APP_VERSION } from './dialogs';
import { $, isModalOpen, showModal } from './dom';
import { openFile, saveProjectFile, setTitle, setDirtyFlag, native, isElectron, openExternal } from './platform';
import { loadMediaBytes, loadProjectBytes, serializeProject, isProjectName, PROJECT_EXT } from './project';
import { t, onLangChange, getLang, setPseudo, LANGS } from './i18n';
import { initPrefsEarly, initPrefs, setTheme, setAnimations, chooseLang, effectiveTheme, animationsOn, prefs } from './prefs';
import { bindMenu, initMenus, closeMenus, isMenuOpen } from './menus';
import { makeDemoGif } from './demo';
import { runExport } from './exporter';
import type { ToolId } from './types';

// ---------------- toasts ----------------
window.addEventListener('app-toast', (e: any) => {
  const { msg, kind } = e.detail;
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'warn' ? 4200 : 3000);
});

// ---------------- título / sujo ----------------
function refreshTitle() {
  const name = S.projectPath ? S.projectPath.split(/[\\/]/).pop() : S.sourceName;
  setTitle(`${S.dirty ? '• ' : ''}${name ? name + ' — ' : ''}Giffact`);
  setDirtyFlag(S.dirty);
}
let lastDirty = false;
on('doc', () => { if (S.dirty !== lastDirty) { lastDirty = S.dirty; refreshTitle(); } });

// ---------------- abrir / salvar ----------------
async function confirmDiscard(): Promise<boolean> {
  if (!S.dirty) return true;
  return window.confirm(t('confirm.discard'));
}

async function loadAny(name: string, data: Uint8Array, path?: string) {
  try {
    const lower = name.toLowerCase();
    if (isProjectName(lower)) {
      await loadProjectBytes(data);
      S.projectPath = path || '';
      toast(t('toast.projectOpened', { n: S.frames.length }), 'ok');
    } else {
      await loadMediaBytes(name, data);
      toast(t('toast.mediaOpened', { name, n: S.frames.length, w: S.docW, h: S.docH }), 'ok');
    }
    $('welcome').classList.add('hidden');
    fitView();
    lastDirty = S.dirty;
    refreshTitle();
    requestRender();
    $('canvas').focus();
  } catch (err: any) {
    console.error(err);
    toast(t('toast.openFail', { msg: err?.message || String(err) }), 'warn');
  }
}

async function doOpen(kind: 'media' | 'project' | 'any' = 'media') {
  if (!(await confirmDiscard())) return;
  const f = await openFile(kind);
  if (f) await loadAny(f.name, f.data, f.path);
}

async function doSave(saveAs = false) {
  if (!S.loaded) { toast(t('toast.nothingToSave'), 'warn'); return; }
  currentTool().deactivate?.();
  const base = (S.sourceName || 'project').replace(/\.[^.]+$/, '');
  const bytes = serializeProject();
  const p = await saveProjectFile(bytes, base + PROJECT_EXT, S.projectPath, saveAs);
  if (p) {
    if (isElectron) S.projectPath = p;
    S.dirty = false;
    lastDirty = false;
    refreshTitle();
    toast(isElectron ? t('toast.saved', { where: p }) : t('toast.savedDownload'), 'ok');
  }
}

async function doNew() {
  if (!S.loaded) return;
  if (!(await confirmDiscard())) return;
  stopPlay();
  closePreview();
  currentTool().deactivate?.();
  closeDocument();
  emit('loaded', 'frame', 'layers', 'selection', 'doc', 'view');
  $('welcome').classList.remove('hidden');
  lastDirty = false;
  refreshTitle();
  requestRender();
  toast(t('toast.newProject'));
}

// ---------------- arrastar e soltar ----------------
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  e.preventDefault();
  if (!(await confirmDiscard())) return;
  const data = new Uint8Array(await f.arrayBuffer());
  let path: string | undefined;
  try { path = native?.getPathForFile(f); } catch { /* */ }
  await loadAny(f.name, data, path);
});

// ---------------- botões do topo ----------------
function bindTop() {
  $('btnOpen').onclick = () => doOpen('media');
  $('wOpen').onclick = () => doOpen('media');
  $('wOpenProject').onclick = () => doOpen('project');
  $('wDemo').onclick = () => loadAny('sample_anime.gif', makeDemoGif());
  $('btnExport').onclick = () => openExportDialog('png');
  $('btnUndo').onclick = () => { if (!undo()) toast(t('toast.nothingUndo')); };
  $('btnRedo').onclick = () => { if (!redo()) toast(t('toast.nothingRedo')); };
  $('btnPreview').onclick = () => openPreview();
  $('btnTrace').onclick = () => openTraceDialog();
  $('btnHelp').onclick = () => openHelp();
  $('frToRange').onclick = () => openRangeDialog(S.selection.size ? 'selection' : 'layer');
  $('btnAbout').onclick = () => openAbout();
  // menu Projeto (fica no <body>, position: fixed — não é cortado pela barra)
  const menu = $('menuProject');
  bindMenu($('btnProject'), menu, () => {
    menu.querySelectorAll<HTMLButtonElement>('.needs-doc').forEach((b) => { b.disabled = !S.loaded; });
    (menu.querySelector('[data-act="new"]') as HTMLButtonElement).disabled = !S.loaded;
  });
  menu.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((b) => {
    b.addEventListener('click', () => {
      closeMenus();
      const a = b.dataset.act;
      if (a === 'new') doNew();
      else if (a === 'openGif') doOpen('media');
      else if (a === 'openProject') doOpen('project');
      else if (a === 'save') doSave(false);
      else if (a === 'saveAs') doSave(true);
      else if (a === 'exportPng') openExportDialog('png');
      else if (a === 'exportSvg') openExportDialog('svg');
    });
  });
  bindMenu($('btnLang'), $('menuLang'));
  bindMenu($('btnTheme'), $('menuTheme'));
  // links externos (Sobre): no Electron abrem no navegador padrão via shell.openExternal
  document.querySelectorAll<HTMLAnchorElement>('a[data-external]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      openExternal(a.href);
    });
  });
  // modais: clique fora fecha
  document.querySelectorAll<HTMLElement>('.modal').forEach((m) => {
    m.addEventListener('pointerdown', (e) => {
      if (e.target === m && m.id !== 'dlgExport' && m.id !== 'dlgTrace') {
        if (m.id === 'dlgPreview') closePreview(); else m.hidden = true;
      }
    });
  });
}

// ---------------- teclado ----------------
const TOOL_KEYS: Record<string, ToolId> = {};
for (const td of TOOL_DEFS) TOOL_KEYS[td.key.toLowerCase()] = td.id;

function onKey(e: KeyboardEvent) {
  if (isMenuOpen()) return;
  const tg = e.target as HTMLElement;
  const inField = tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.tagName === 'SELECT');
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();

  if (isModalOpen()) {
    if (e.key === 'Escape') {
      if (!$('dlgPreview').hidden) closePreview();
      else document.querySelectorAll<HTMLElement>('.modal').forEach((m) => { if (m.id !== 'dlgExport' || true) m.hidden = true; });
      e.preventDefault();
    }
    return;
  }
  // atalhos de arquivo valem mesmo com foco em campos
  if (ctrl && k === 'n' && !e.shiftKey) { e.preventDefault(); doNew(); return; }
  if (ctrl && k === 'o') { e.preventDefault(); doOpen(e.shiftKey ? 'project' : 'media'); return; }
  if (ctrl && k === 's') { e.preventDefault(); doSave(e.shiftKey); return; }
  if (ctrl && k === 'e') { e.preventDefault(); openExportDialog(e.shiftKey ? 'svg' : 'png'); return; }
  if (e.key === 'F1') { e.preventDefault(); openHelp(); return; }
  if (inField) return;
  if (!S.loaded) return;

  // a ferramenta ativa tem prioridade (ex.: Enter/Esc/Backspace na curva)
  if (currentTool().key?.(e)) { e.preventDefault(); requestRender(); return; }

  if (ctrl) {
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); if (!undo()) toast(t('toast.nothingUndo')); return; }
    if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); if (!redo()) toast(t('toast.nothingRedo')); return; }
    if (k === 'c') { e.preventDefault(); const n = copySelection(); if (n) toast(t('toast.copied', { n })); return; }
    if (k === 'x') { e.preventDefault(); const n = copySelection(); if (n) { deleteSelection(); toast(t('toast.cut', { n })); } return; }
    if (k === 'v' && e.shiftKey) { e.preventDefault(); openRangeDialog(S.selection.size ? 'selection' : 'layer'); return; }
    if (k === 'v') { e.preventDefault(); if (!S.clipboard) { toast(t('toast.clipEmpty'), 'warn'); return; } if (activeLayer()?.locked) { toast(t('toast.layerLocked'), 'warn'); return; } pasteToFrames([S.cur]); return; }
    if (k === 'a') { e.preventDefault(); selectAll(); if (S.tool !== 'select') setTool('select'); return; }
    if (k === 'd') { e.preventDefault(); S.selection.clear(); emit('selection'); return; }
    if (k === 'n' && e.shiftKey) { e.preventDefault(); $('lyAdd').click(); return; }
    if (k === '0') { e.preventDefault(); fitView(); return; }
    return;
  }
  if (e.altKey) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); copyNeighbor(-1); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); copyNeighbor(1); return; }
    return;
  }
  switch (e.key) {
    case 'ArrowLeft': e.preventDefault(); goFrame(S.cur - 1); return;
    case 'ArrowRight': e.preventDefault(); goFrame(S.cur + 1); return;
    case 'Home': e.preventDefault(); goFrame(0); return;
    case 'End': e.preventDefault(); goFrame(S.frames.length - 1); return;
    case 'Delete': case 'Backspace': if (S.selection.size) { e.preventDefault(); deleteSelection(); } return;
    case 'Escape': if (S.selection.size) { S.selection.clear(); emit('selection'); } return;
    case '[': case ']': {
      const up = e.key === ']';
      const st = S.settings;
      if (e.shiftKey) st.stabilizer = Math.max(0, Math.min(20, st.stabilizer + (up ? 1 : -1)));
      else if (S.tool === 'eraser') st.eraserSize = Math.max(2, Math.min(120, Math.round(st.eraserSize * (up ? 1.2 : 1 / 1.2))));
      else st.width = Math.max(0.3, Math.min(300, Math.round(st.width * (up ? 1.2 : 1 / 1.2) * 10) / 10));
      settingsChanged();
      return;
    }
    case '{': case '}': {
      S.settings.stabilizer = Math.max(0, Math.min(20, S.settings.stabilizer + (e.key === '}' ? 1 : -1)));
      settingsChanged();
      return;
    }
    case '+': case '=': setZoom(S.view.zoom * 1.25); return;
    case '-': case '_': setZoom(S.view.zoom / 1.25); return;
    case '0': fitView(); return;
    case '1': setZoom(1); return;
    case '?': openHelp(); return;
  }
  if (k === 'a') { goFrame(S.cur - 1); return; }
  if (k === 'd') { goFrame(S.cur + 1); return; }
  if (k === 'f') { S.settings.bgVisible = !S.settings.bgVisible; settingsChanged(); return; }
  if (k === 'g') { S.settings.bgGray = !S.settings.bgGray; settingsChanged(); return; }
  if (k === 'o') { S.settings.onion = !S.settings.onion; settingsChanged(); toast(S.settings.onion ? t('toast.onionOn') : t('toast.onionOff')); return; }
  if (k === 'p') { if (e.shiftKey) togglePlay(); else { stopPlay(); openPreview(); } return; }
  if (k === 'r' && e.shiftKey) { setRotation(0); return; }
  if (k === 'r') return; // segurar R = girar
  const tool = TOOL_KEYS[k];
  if (tool && !e.shiftKey) { setTool(tool); return; }
}

// ---------------- inicialização ----------------
/** Barra superior: se não couber (idiomas longos / janela estreita), esconde rótulos aos poucos. */
function fitTopbar() {
  const tb = $('topbar');
  tb.classList.remove('compact1', 'compact2');
  if (tb.scrollWidth > tb.clientWidth + 1) tb.classList.add('compact1');
  if (tb.scrollWidth > tb.clientWidth + 1) tb.classList.add('compact2');
}

function init() {
  initPrefsEarly();
  document.body.classList.toggle('is-electron', isElectron);
  initMenus();
  initPrefs();
  initPanels();
  initTimeline();
  initView($<HTMLCanvasElement>('canvas'), currentTool);
  bindTop();
  on('tool', () => { onToolChanged(); updateCursor(); });
  on('settings', () => saveSettings());
  window.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', (e) => {
    if (S.dirty && !isElectron) { e.preventDefault(); e.returnValue = ''; }
  });
  native?.onOpenPath(async (path) => {
    const f = await native!.readFile(path);
    if (f && (await confirmDiscard())) await loadAny(f.name, f.data, f.path);
  });
  refreshTitle();
  setTool(S.tool);
  showModal('dlgHelp', false);
  new ResizeObserver(fitTopbar).observe($('topbar'));
  onLangChange(() => { fitTopbar(); requestRender(); });
  fitTopbar();
}
init();

// ---------------- ganchos para testes automatizados ----------------
(window as any).__app = {
  S, TOOLS, loadAny, makeDemoGif, runExport, goFrame, setTool, undo, redo, fitView, serializeProject, loadProjectBytes,
  setZoom, setRotation, doNew, doSave, openAbout, closeDocument,
  i18n: { t, getLang, setLang: chooseLang, setPseudo, LANGS: LANGS.map((l) => l.code) },
  prefs: { setTheme, setAnimations, effectiveTheme, animationsOn, get: () => ({ ...prefs }) },
  version: APP_VERSION,
};
