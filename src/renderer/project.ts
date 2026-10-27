// Salvar/abrir projeto (.giffact = JSON com o GIF embutido em base64; .gifline/.json antigos continuam abrindo)
import { S, setupDocument, emit } from './state';
import type { FrameDoc } from './types';
import { decodeGif, decodeImage, isGif, type DecodedGif } from './gif';
import { t } from './i18n';

/** Identificadores aceitos no campo `app` (o antigo vem da época “GIF Linework”). */
export const PROJECT_APP_IDS = ['giffact', 'gif-linework'];
export const PROJECT_EXT = '.giffact';
export const isProjectName = (name: string) => /\.(giffact|gifline|json)$/i.test(name);

export function toBase64(u8: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + CH)));
  return btoa(s);
}
export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

export function mimeFor(name: string, bytes: Uint8Array): string {
  if (isGif(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + Math.min(bytes.byteLength, 16)) as ArrayBuffer)) return 'image/gif';
  const n = name.toLowerCase();
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
  if (n.endsWith('.webp')) return 'image/webp';
  return 'image/gif';
}

export async function decodeSource(bytes: Uint8Array, mime: string): Promise<DecodedGif> {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  if (mime === 'image/gif') return decodeGif(ab);
  return decodeImage(ab, mime);
}

export function serializeProject(): Uint8Array {
  const st = S.settings;
  const obj = {
    app: 'giffact',
    version: 1,
    savedAt: new Date().toISOString(),
    source: { name: S.sourceName, mime: S.sourceMime, data: S.sourceBytes ? toBase64(S.sourceBytes) : '' },
    width: S.docW,
    height: S.docH,
    current: S.cur,
    view: { bgOpacity: st.bgOpacity, bgGray: st.bgGray, bgVisible: st.bgVisible, onion: st.onion },
    frames: S.docs,
  };
  return new TextEncoder().encode(JSON.stringify(obj));
}

export async function loadProjectBytes(bytes: Uint8Array): Promise<void> {
  const obj = JSON.parse(new TextDecoder().decode(bytes));
  if (!obj || !PROJECT_APP_IDS.includes(obj.app) || !obj.source?.data) throw new Error(t('err.invalidProject'));
  const src = fromBase64(obj.source.data);
  const dec = await decodeSource(src, obj.source.mime || 'image/gif');
  const docs: FrameDoc[] = obj.frames;
  if (!Array.isArray(docs) || docs.length !== dec.frames.length) throw new Error(t('err.projectMismatch'));
  // saneamento
  for (const d of docs) {
    if (!Array.isArray(d.layers) || !d.layers.length) d.layers = [{ id: 'l' + Math.random().toString(36).slice(2), name: t('layer.defaultName'), visible: true, locked: false, opacity: 1, strokes: [] }];
    d.activeLayer = Math.max(0, Math.min(d.activeLayer | 0, d.layers.length - 1));
    for (const L of d.layers) {
      L.opacity = typeof L.opacity === 'number' ? L.opacity : 1;
      L.strokes = (L.strokes || []).filter((s) => s && Array.isArray(s.pts) && s.pts.length).map((s) => ({
        ...s, taperStart: s.taperStart ?? 0, taperEnd: s.taperEnd ?? 0, closed: !!s.closed, kind: s.kind === 'line' ? 'line' : 'curve',
      }));
    }
  }
  S.sourceBytes = src;
  S.sourceName = obj.source.name || 'projeto.gif';
  S.sourceMime = obj.source.mime || 'image/gif';
  setupDocument(dec.width, dec.height, dec.frames, docs);
  if (obj.view) Object.assign(S.settings, obj.view);
  S.cur = Math.max(0, Math.min(obj.current | 0, dec.frames.length - 1));
  emit('loaded', 'frame', 'layers', 'settings', 'doc');
}

export async function loadMediaBytes(name: string, bytes: Uint8Array): Promise<void> {
  const mime = mimeFor(name, bytes);
  const dec = await decodeSource(bytes, mime);
  S.sourceBytes = bytes;
  S.sourceName = name;
  S.sourceMime = mime;
  S.projectPath = '';
  setupDocument(dec.width, dec.height, dec.frames);
  emit('loaded', 'frame', 'layers', 'settings', 'doc');
}
