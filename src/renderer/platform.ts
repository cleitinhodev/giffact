// Abstração de E/S: Electron (API nativa via preload) ou navegador (input/download/zip)
import { zipSync } from 'fflate';
import { t } from './i18n';

export interface OpenedFile { name: string; path?: string; data: Uint8Array }

interface NativeAPI {
  isElectron: true;
  openFile(kind: 'media' | 'project' | 'any'): Promise<OpenedFile | null>;
  readFile(path: string): Promise<OpenedFile | null>;
  saveFileDialog(defaultName: string, kind: 'project'): Promise<string | null>;
  writeFile(path: string, data: Uint8Array): Promise<boolean>;
  chooseFolder(): Promise<string | null>;
  writeInFolder(folder: string, name: string, data: Uint8Array): Promise<boolean>;
  revealFolder(folder: string): Promise<void>;
  setTitle(t: string): void;
  setDirty(d: boolean): void;
  onOpenPath(cb: (path: string) => void): void;
  getPathForFile(f: File): string;
  openExternal(url: string): Promise<boolean>;
  setLocaleStrings(strings: Record<string, string>): void;
}

declare global {
  interface Window { native?: NativeAPI }
}

export const native: NativeAPI | null = window.native && window.native.isElectron ? window.native : null;
export const isElectron = !!native;

function pickFileWeb(accept: string): Promise<OpenedFile | null> {
  return new Promise((resolve) => {
    const inp = document.getElementById('fileInput') as HTMLInputElement;
    inp.accept = accept;
    inp.value = '';
    let done = false;
    inp.onchange = async () => {
      done = true;
      const f = inp.files?.[0];
      if (!f) return resolve(null);
      resolve({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) });
    };
    // se o usuário cancelar, o promise simplesmente fica pendente até a próxima escolha
    window.addEventListener('focus', () => setTimeout(() => { if (!done) resolve(null); }, 600), { once: true });
    inp.click();
  });
}

export async function openFile(kind: 'media' | 'project' | 'any'): Promise<OpenedFile | null> {
  if (native) return native.openFile(kind);
  const accept = kind === 'media' ? '.gif,image/gif,.png,.jpg,.jpeg,.webp' : kind === 'project' ? '.giffact,.gifline,.json' : '.gif,.png,.jpg,.jpeg,.webp,.giffact,.gifline,.json';
  return pickFileWeb(accept);
}

export function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

/** Salva um projeto. Retorna o caminho (Electron) ou o nome (web) */
export async function saveProjectFile(data: Uint8Array, suggested: string, existingPath: string, forceDialog: boolean): Promise<string | null> {
  if (native) {
    let path = existingPath;
    if (!path || forceDialog) path = (await native.saveFileDialog(suggested, 'project')) || '';
    if (!path) return null;
    const ok = await native.writeFile(path, data);
    return ok ? path : null;
  }
  downloadBlob(new Blob([data as BlobPart], { type: 'application/json' }), suggested);
  return suggested;
}

export interface ExportSink {
  write(name: string, data: Uint8Array): Promise<void>;
  finish(): Promise<string>;
  label: string;
}

export async function createExportSink(zipName: string): Promise<ExportSink | null> {
  if (native) {
    const folder = await native.chooseFolder();
    if (!folder) return null;
    return {
      label: folder,
      async write(name, data) {
        const ok = await native.writeInFolder(folder, name, data);
        if (!ok) throw new Error(t('export.writeFail', { name }));
      },
      async finish() { native.revealFolder(folder); return folder; },
    };
  }
  // navegador: junta tudo num .zip
  const files: Record<string, Uint8Array> = {};
  return {
    label: zipName,
    async write(name, data) { files[name] = data; },
    async finish() {
      const z = zipSync(files, { level: 0 });
      downloadBlob(new Blob([z as BlobPart], { type: 'application/zip' }), zipName);
      return zipName;
    },
  };
}

export function setTitle(title: string) {
  document.title = title;
  native?.setTitle(title);
}
/** Abre um link externo (só http/https) no navegador padrão. */
export function openExternal(url: string) {
  if (!/^https?:\/\//i.test(url)) return;
  if (native) native.openExternal(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}
export function setDirtyFlag(d: boolean) { native?.setDirty(d); }
