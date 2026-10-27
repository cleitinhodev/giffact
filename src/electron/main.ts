// Processo principal do Electron
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

let win: BrowserWindow | null = null;
let dirty = false;
let pendingOpen: string | null = null;

/** Textos dos diálogos nativos — o renderer envia a tradução do idioma escolhido (padrão: inglês). */
const L: Record<string, string> = {
  'native.openGif': 'Open GIF',
  'native.openProject': 'Open project',
  'native.saveProject': 'Save project',
  'native.chooseFolder': 'Choose the export folder',
  'native.filterMedia': 'GIF / images',
  'native.filterProject': 'Giffact project',
  'native.filterAny': 'GIF, images and projects',
  'native.filterAll': 'All files',
  'native.unsavedTitle': 'Unsaved changes',
  'native.unsavedMsg': 'The project has unsaved changes. Quit anyway?',
  'native.quit': 'Quit without saving',
  'native.cancel': 'Cancel',
};

/** Só deixa sair para o navegador URLs http(s) bem formadas. */
export function isSafeExternal(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 2048) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch { return false; }
}
function openExternalSafe(url: unknown) {
  if (!isSafeExternal(url)) return false;
  shell.openExternal(url);
  return true;
}

function fileArg(argv: string[]): string | null {
  for (const a of argv.slice(1)) {
    if (a.startsWith('-')) continue;
    if (/\.(gif|png|jpe?g|webp|giffact|gifline|json)$/i.test(a)) return a;
  }
  return null;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const f = fileArg(argv);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (f) win.webContents.send('open-path', f);
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d0f2b',
    title: 'Giffact',
    icon: path.join(__dirname, process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => { win!.maximize(); win!.show(); });
  win.webContents.on('did-finish-load', () => {
    const f = pendingOpen || fileArg(process.argv);
    pendingOpen = null;
    if (f) win!.webContents.send('open-path', path.resolve(f));
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
      win!.webContents.toggleDevTools();
      e.preventDefault();
    }
  });
  // links externos abrem no navegador padrão (só http/https); a janela nunca navega para fora do app
  win.webContents.setWindowOpenHandler(({ url }) => { openExternalSafe(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file:')) return;
    e.preventDefault();
    openExternalSafe(url);
  });
  win.on('close', (e) => {
    if (!dirty) return;
    const r = dialog.showMessageBoxSync(win!, {
      type: 'warning',
      buttons: [L['native.quit'], L['native.cancel']],
      defaultId: 1,
      cancelId: 1,
      title: L['native.unsavedTitle'],
      message: L['native.unsavedMsg'],
    });
    if (r === 1) e.preventDefault();
  });
  win.on('closed', () => { win = null; });
}

const filters = (kind: 'media' | 'project' | 'any') => {
  if (kind === 'media') return [{ name: L['native.filterMedia'], extensions: ['gif', 'png', 'jpg', 'jpeg', 'webp'] }];
  if (kind === 'project') return [{ name: L['native.filterProject'], extensions: ['giffact', 'gifline', 'json'] }];
  return [{ name: L['native.filterAny'], extensions: ['gif', 'png', 'jpg', 'jpeg', 'webp', 'giffact', 'gifline', 'json'] }];
};

async function readAsOpened(p: string) {
  const data = await fs.readFile(p);
  return { name: path.basename(p), path: p, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}

ipcMain.handle('open-file', async (_e, kind: 'media' | 'project' | 'any') => {
  const r = await dialog.showOpenDialog(win!, {
    title: kind === 'project' ? L['native.openProject'] : L['native.openGif'],
    properties: ['openFile'],
    filters: [...filters(kind), { name: L['native.filterAll'], extensions: ['*'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return readAsOpened(r.filePaths[0]);
});
ipcMain.handle('read-file', async (_e, p: string) => {
  try { return await readAsOpened(p); } catch { return null; }
});
ipcMain.handle('save-dialog', async (_e, defaultName: string) => {
  const r = await dialog.showSaveDialog(win!, {
    title: L['native.saveProject'],
    defaultPath: defaultName,
    filters: [{ name: L['native.filterProject'], extensions: ['giffact'] }],
  });
  if (r.canceled || !r.filePath) return null;
  return r.filePath;
});
ipcMain.handle('write-file', async (_e, p: string, data: Uint8Array) => {
  try {
    const tmp = p + '.tmp';
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, p);
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
});
ipcMain.handle('choose-folder', async () => {
  const r = await dialog.showOpenDialog(win!, {
    title: L['native.chooseFolder'],
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return r.filePaths[0];
});
ipcMain.handle('write-in-folder', async (_e, folder: string, name: string, data: Uint8Array) => {
  try {
    const safe = path.basename(name).replace(/[<>:"/\\|?*]/g, '_');
    await fs.writeFile(path.join(folder, safe), data);
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
});
ipcMain.handle('reveal-folder', async (_e, folder: string) => { await shell.openPath(folder); });
ipcMain.on('set-title', (_e, t: string) => { win?.setTitle(t); });
ipcMain.on('set-dirty', (_e, d: boolean) => { dirty = !!d; });
ipcMain.handle('open-external', (_e, url: unknown) => openExternalSafe(url));
ipcMain.on('set-locale-strings', (_e, strings: unknown) => {
  if (!strings || typeof strings !== 'object') return;
  for (const [k, v] of Object.entries(strings as Record<string, unknown>)) {
    if (k in L && typeof v === 'string' && v.length < 300) L[k] = v;
  }
});

app.setAppUserModelId('com.cleitinhodev.giffact');

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
