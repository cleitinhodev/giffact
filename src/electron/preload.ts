// Ponte segura entre o renderer e o processo principal
import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('native', {
  isElectron: true,
  openFile: (kind: string) => ipcRenderer.invoke('open-file', kind),
  readFile: (p: string) => ipcRenderer.invoke('read-file', p),
  saveFileDialog: (name: string) => ipcRenderer.invoke('save-dialog', name),
  writeFile: (p: string, data: Uint8Array) => ipcRenderer.invoke('write-file', p, data),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  writeInFolder: (folder: string, name: string, data: Uint8Array) => ipcRenderer.invoke('write-in-folder', folder, name, data),
  revealFolder: (folder: string) => ipcRenderer.invoke('reveal-folder', folder),
  setTitle: (t: string) => ipcRenderer.send('set-title', t),
  setDirty: (d: boolean) => ipcRenderer.send('set-dirty', d),
  onOpenPath: (cb: (p: string) => void) => ipcRenderer.on('open-path', (_e, p) => cb(p)),
  getPathForFile: (f: File) => webUtils.getPathForFile(f),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  setLocaleStrings: (strings: Record<string, string>) => ipcRenderer.send('set-locale-strings', strings),
});
