// Decodificação de GIF com composição correta (disposal, quadros parciais, transparência)
import { parseGIF, decompressFrames } from 'gifuct-js';
import type { GifFrame } from './types';
import { t } from './i18n';

export interface DecodedGif {
  width: number;
  height: number;
  frames: GifFrame[];
}

export function decodeGif(buf: ArrayBuffer): DecodedGif {
  const gif = parseGIF(buf);
  const raw = decompressFrames(gif, true) as any[];
  const W = (gif as any).lsd.width as number;
  const H = (gif as any).lsd.height as number;
  if (!W || !H || !raw.length) throw new Error(t('err.noFrames'));
  const full = new Uint8ClampedArray(W * H * 4); // começa transparente
  const frames: GifFrame[] = [];
  let prevDisposal = 0;
  let prevDims: { left: number; top: number; width: number; height: number } | null = null;
  let saved: Uint8ClampedArray | null = null;

  for (const fr of raw) {
    // aplica o disposal do quadro anterior
    if (prevDims) {
      if (prevDisposal === 2) {
        clearRect(full, W, H, prevDims);
      } else if (prevDisposal === 3 && saved) {
        full.set(saved);
      }
    }
    const disposal = fr.disposalType || 0;
    saved = disposal === 3 ? full.slice() : null;

    const { left, top, width, height } = fr.dims;
    const patch: Uint8ClampedArray = fr.patch;
    for (let y = 0; y < height; y++) {
      const dy = top + y;
      if (dy < 0 || dy >= H) continue;
      for (let x = 0; x < width; x++) {
        const dx = left + x;
        if (dx < 0 || dx >= W) continue;
        const si = (y * width + x) * 4;
        if (patch[si + 3] === 0) continue; // pixel transparente: mantém o anterior
        const di = (dy * W + dx) * 4;
        full[di] = patch[si]; full[di + 1] = patch[si + 1]; full[di + 2] = patch[si + 2]; full[di + 3] = 255;
      }
    }
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    c.getContext('2d')!.putImageData(new ImageData(full.slice(), W, H), 0, 0);
    // gifuct-js só define delay quando há bloco de controle (GCE); < 20 ms vira 100 ms como nos navegadores
    let delay = typeof fr.delay === 'number' ? fr.delay : 100;
    if (!(delay >= 20)) delay = 100;
    frames.push({ canvas: c, delay });
    prevDisposal = disposal;
    prevDims = { left, top, width, height };
  }
  return { width: W, height: H, frames };
}

function clearRect(buf: Uint8ClampedArray, W: number, H: number, r: { left: number; top: number; width: number; height: number }) {
  for (let y = Math.max(0, r.top); y < Math.min(H, r.top + r.height); y++) {
    const start = (y * W + Math.max(0, r.left)) * 4;
    const end = (y * W + Math.min(W, r.left + r.width)) * 4;
    buf.fill(0, start, end);
  }
}

/** Decodifica imagem estática (PNG/JPG/WebP) como um único quadro */
export async function decodeImage(buf: ArrayBuffer, mime: string): Promise<DecodedGif> {
  const blob = new Blob([buf], { type: mime });
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  return { width: bmp.width, height: bmp.height, frames: [{ canvas: c, delay: 100 }] };
}

export function isGif(buf: ArrayBuffer): boolean {
  const b = new Uint8Array(buf, 0, Math.min(6, buf.byteLength));
  return b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46;
}
