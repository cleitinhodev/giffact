// Renderização de traços/camadas (compartilhada por tela, miniaturas, exportação e prévia)
import type { FrameDoc, Layer, Stroke } from './types';
import { getPath } from './geom';

export function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, scale: number, color?: string) {
  ctx.fillStyle = color || s.color;
  ctx.fill(getPath(s, scale), 'nonzero');
}

let tmpCanvas: HTMLCanvasElement | null = null;
function getTmp(w: number, h: number): CanvasRenderingContext2D {
  if (!tmpCanvas) tmpCanvas = document.createElement('canvas');
  if (tmpCanvas.width !== w || tmpCanvas.height !== h) {
    tmpCanvas.width = w; tmpCanvas.height = h;
  }
  const c = tmpCanvas.getContext('2d')!;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, w, h);
  return c;
}

export interface LayerRenderOpts {
  /** escala efetiva (px de saída por px de doc) para qualidade das amostras */
  scale: number;
  exclude?: Set<string>;
  layerFilter?: (l: Layer, index: number) => boolean;
  /** cor única (para onion skin) */
  tint?: string;
  ignoreOpacity?: boolean;
}

/**
 * Desenha todas as camadas visíveis de um quadro em ctx, que já deve estar com a
 * transformação doc->saída aplicada. Camadas com opacidade < 1 passam por um canvas temporário.
 */
export function drawFrameLayers(ctx: CanvasRenderingContext2D, doc: FrameDoc, o: LayerRenderOpts) {
  const T = ctx.getTransform();
  doc.layers.forEach((L, idx) => {
    if (!L.visible) return;
    if (o.layerFilter && !o.layerFilter(L, idx)) return;
    const strokes = o.exclude ? L.strokes.filter((s) => !o.exclude!.has(s.id)) : L.strokes;
    if (!strokes.length) return;
    const op = o.ignoreOpacity ? 1 : L.opacity;
    if (op >= 0.999) {
      for (const s of strokes) drawStroke(ctx, s, o.scale, o.tint);
    } else if (op > 0.001) {
      const W = ctx.canvas.width, H = ctx.canvas.height;
      const t = getTmp(W, H);
      t.setTransform(T);
      for (const s of strokes) drawStroke(t, s, o.scale, o.tint);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha *= op;
      ctx.drawImage(t.canvas, 0, 0);
      ctx.restore();
    }
  });
}

/** Renderiza as linhas de um quadro em um canvas novo de tamanho W×H (escala doc->saída) */
export function renderFrameToCanvas(doc: FrameDoc, docW: number, docH: number, W: number, H: number, opts: {
  background?: string | null;
  bgImage?: HTMLCanvasElement | null;
  bgOpacity?: number;
  layerFilter?: (l: Layer, i: number) => boolean;
}): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d')!;
  if (opts.background) { ctx.fillStyle = opts.background; ctx.fillRect(0, 0, W, H); }
  if (opts.bgImage) {
    ctx.save();
    ctx.globalAlpha = opts.bgOpacity ?? 1;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(opts.bgImage, 0, 0, W, H);
    ctx.restore();
  }
  const sx = W / docW, sy = H / docH;
  ctx.setTransform(sx, 0, 0, sy, 0, 0);
  drawFrameLayers(ctx, doc, { scale: Math.max(sx, sy), layerFilter: opts.layerFilter });
  return c;
}
