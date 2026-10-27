// Exportação de quadros: PNG em qualquer resolução e SVG vetorial
import { S } from './state';
import type { FrameDoc, Layer } from './types';
import { renderFrameToCanvas } from './render';
import { getSamples, outlineSvgPath } from './geom';
import { createExportSink } from './platform';
import { t } from './i18n';

export interface ExportOptions {
  format: 'png' | 'svg';
  frames: number[];
  width: number;
  height: number;
  background: string | null; // null = transparente
  includeGif: boolean;
  layerNames: Set<string> | null; // null = todas visíveis
  prefix: string;
}

export function padFor(count: number) {
  return Math.max(3, String(count).length);
}
export function fileName(prefix: string, index: number, total: number, ext: string) {
  return `${prefix}${String(index + 1).padStart(padFor(total), '0')}.${ext}`;
}

function canvasToPng(c: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    c.toBlob(async (b) => {
      if (!b) return reject(new Error(t('export.pngFail')));
      resolve(new Uint8Array(await b.arrayBuffer()));
    }, 'image/png');
  });
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export function frameToSvg(doc: FrameDoc, fi: number, o: { width: number; height: number; background: string | null; includeGif: boolean; layerFilter: (l: Layer) => boolean }): string {
  const W = S.docW, H = S.docH;
  const scale = Math.max(o.width / W, o.height / H);
  const out: string[] = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${o.width}" height="${o.height}" viewBox="0 0 ${W} ${H}">`);
  if (o.background) out.push(`<rect width="${W}" height="${H}" fill="${esc(o.background)}"/>`);
  if (o.includeGif && S.frames[fi]) {
    const url = S.frames[fi].canvas.toDataURL('image/png');
    out.push(`<image width="${W}" height="${H}" xlink:href="${url}" href="${url}"/>`);
  }
  for (const L of doc.layers) {
    if (!L.visible || !o.layerFilter(L) || !L.strokes.length) continue;
    out.push(`<g id="${esc(L.name)}" opacity="${L.opacity}">`);
    for (const s of L.strokes) {
      const sm = getSamples(s, Math.max(scale, 2));
      out.push(`<path fill="${esc(s.color)}" fill-rule="nonzero" d="${outlineSvgPath(sm, Math.max(scale, 2))}"/>`);
    }
    out.push('</g>');
  }
  out.push('</svg>');
  return out.join('\n');
}

export async function runExport(o: ExportOptions, progress: (done: number, total: number) => void, isCancelled: () => boolean): Promise<string | null> {
  const ext = o.format;
  const sink = await createExportSink(`${(o.prefix || 'quadros').replace(/[_\-\s.]+$/, '') || 'quadros'}_${ext}.zip`);
  if (!sink) return null;
  const filter = (l: Layer) => !o.layerNames || o.layerNames.has(l.name);
  const total = S.frames.length;
  for (let k = 0; k < o.frames.length; k++) {
    if (isCancelled()) throw new Error(t('export.cancelled'));
    const fi = o.frames[k];
    const doc = S.docs[fi];
    let data: Uint8Array;
    if (o.format === 'png') {
      const c = renderFrameToCanvas(doc, S.docW, S.docH, o.width, o.height, {
        background: o.background,
        bgImage: o.includeGif ? S.frames[fi].canvas : null,
        layerFilter: filter,
      });
      data = await canvasToPng(c);
      c.width = c.height = 0; // libera memória
    } else {
      data = new TextEncoder().encode(frameToSvg(doc, fi, { width: o.width, height: o.height, background: o.background, includeGif: o.includeGif, layerFilter: filter }));
    }
    await sink.write(fileName(o.prefix, fi, total, ext), data);
    progress(k + 1, o.frames.length);
    await new Promise((r) => setTimeout(r, 0));
  }
  return sink.finish();
}
