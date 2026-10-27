// Gera um GIF de exemplo "estilo anime" (personagem simples piscando/balançando) para testes
import { GIFEncoder, quantize, applyPalette } from 'gifenc';

export function makeDemoGif(frames = 12, W = 320, H = 240): Uint8Array {
  const gif = GIFEncoder();
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  for (let f = 0; f < frames; f++) {
    const t = (f / frames) * Math.PI * 2;
    // céu
    const grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, '#8ec5ff'); grd.addColorStop(1, '#e8f4ff');
    g.fillStyle = grd; g.fillRect(0, 0, W, H);
    // chão
    g.fillStyle = '#7bc47f'; g.fillRect(0, H * 0.78, W, H);
    const cx = W / 2 + Math.sin(t) * 18, cy = H * 0.45 + Math.abs(Math.sin(t)) * -8;
    // corpo
    g.fillStyle = '#ff7a59';
    g.beginPath(); g.ellipse(cx, cy + 70, 38, 46, 0, 0, Math.PI * 2); g.fill();
    // cabelo (espinhos)
    g.fillStyle = '#3b2a6b';
    g.beginPath();
    for (let k = 0; k <= 8; k++) {
      const a = Math.PI + (k / 8) * Math.PI;
      const r = k % 2 ? 62 : 46;
      g.lineTo(cx + Math.cos(a) * r, cy - 6 + Math.sin(a) * r);
    }
    g.closePath(); g.fill();
    // rosto
    g.fillStyle = '#ffe0c8';
    g.beginPath(); g.arc(cx, cy, 42, 0, Math.PI * 2); g.fill();
    // franja
    g.fillStyle = '#3b2a6b';
    g.beginPath(); g.moveTo(cx - 44, cy - 6); g.quadraticCurveTo(cx - 20, cy - 52, cx + 44, cy - 10); g.quadraticCurveTo(cx + 10, cy - 30, cx - 44, cy - 6); g.fill();
    // olhos (piscam no quadro 5-6)
    const blink = f === 5 || f === 6;
    g.fillStyle = '#1b1b3a';
    for (const s of [-1, 1]) {
      g.beginPath();
      if (blink) g.ellipse(cx + s * 16, cy + 6, 9, 2, 0, 0, Math.PI * 2);
      else g.ellipse(cx + s * 16, cy + 6, 8, 12, 0, 0, Math.PI * 2);
      g.fill();
      if (!blink) { g.fillStyle = '#fff'; g.beginPath(); g.arc(cx + s * 16 + 3, cy + 1, 3, 0, Math.PI * 2); g.fill(); g.fillStyle = '#1b1b3a'; }
    }
    // boca
    g.strokeStyle = '#a0404a'; g.lineWidth = 2;
    g.beginPath(); g.arc(cx, cy + 22, 7, 0.1 * Math.PI, 0.9 * Math.PI); g.stroke();
    const { data } = g.getImageData(0, 0, W, H);
    const palette = quantize(data, 128);
    const index = applyPalette(data, palette);
    gif.writeFrame(index, W, H, { palette, delay: 80 });
  }
  gif.finish();
  return gif.bytes();
}
