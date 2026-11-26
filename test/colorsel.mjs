// Testes do Seletor de cores (1.3.0-beta): quantização em paleta, limpeza de manchinhas, conta-gotas com tolerância,
// excluir / manter só / restaurar / desfazer, gerar formas vetoriais (furos, cores), editar formas e nós,
// traço → linhas do Giffact, todos os quadros, salvar/abrir projeto e exportação PNG/SVG.
// Uso: `node test/colorsel.mjs` (requer `node build.mjs` antes).
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve('app');
const OUT = path.resolve('test-output/colorsel');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const ok = (c, m) => { console.log((c ? '  ✔ ' : '  ✘ ') + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const p = path.join(ROOT, u === '/' ? 'index.html' : u);
  if (!p.startsWith(ROOT) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' }[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true, deviceScaleFactor: 1, locale: 'pt-BR' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('dialog', (d) => d.accept());
await page.goto(`http://localhost:${server.address().port}/index.html`);
const waitFor = async (fn, arg, timeout = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { try { if (await page.evaluate(fn, arg)) return true; } catch {} await sleep(60); }
  return false;
};
await waitFor(() => !!window.__app);
await page.evaluate(() => localStorage.clear());

// imagem sintética (sem antisserrilhado): fundo branco, quadrado vermelho, anel preto, linha preta,
// quadrado azul + manchinha azul de 2×2 px
const W = 200, H = 160;
await page.evaluate(async ([W, H]) => {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const img = g.createImageData(W, H);
  const put = (x, y, r, gg, b) => { const o = (y * W + x) * 4; img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = b; img.data[o + 3] = 255; };
  const dseg = (px, py, ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy; let u = ((px - ax) * dx + (py - ay) * dy) / l2; u = Math.max(0, Math.min(1, u)); return Math.hypot(px - ax - u * dx, py - ay - u * dy); };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const cx = x + 0.5, cy = y + 0.5;
    const rr = Math.hypot(cx - 140, cy - 60);
    if (x >= 20 && x < 80 && y >= 20 && y < 80) put(x, y, 255, 0, 0);
    else if (rr >= 28 && rr <= 32) put(x, y, 0, 0, 0);
    else if (dseg(cx, cy, 20, 118, 120, 128) <= 1.6) put(x, y, 0, 0, 0);
    else if ((x >= 150 && x < 164 && y >= 120 && y < 134) || (x >= 100 && x < 102 && y >= 145 && y < 147)) put(x, y, 0, 0, 255);
    else put(x, y, 255, 255, 255);
  }
  g.putImageData(img, 0, 0);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  await window.__app.loadAny('sintetica.png', new Uint8Array(await blob.arrayBuffer()));
}, [W, H]);
await sleep(200);
const box = await page.locator('#canvas').boundingBox();
const at = async (x, y) => {
  const [sx, sy] = await page.evaluate(([x, y]) => {
    const S = window.__app.S, v = S.view, c = document.getElementById('canvas');
    const m = new DOMMatrix().translate(c.clientWidth / 2 + v.panX, c.clientHeight / 2 + v.panY).rotate(v.rot).scale(v.zoom).translate(-S.docW / 2, -S.docH / 2);
    const p = m.transformPoint(new DOMPoint(x, y)); return [p.x, p.y];
  }, [x, y]);
  return [box.x + sx, box.y + sy];
};
const click = async (x, y, opts = {}) => {
  const [sx, sy] = await at(x, y);
  const mods = opts.modifiers || [];
  for (const m of mods) await page.keyboard.down(m);
  await page.mouse.click(sx, sy, { button: opts.button });
  for (const m of mods) await page.keyboard.up(m);
  await sleep(120);
};
const drag = async (a, b) => {
  const [sx, sy] = await at(...a); const [ex, ey] = await at(...b);
  await page.mouse.move(sx, sy); await page.mouse.down(); await page.mouse.move(ex, ey, { steps: 6 }); await page.mouse.up(); await sleep(120);
};
const key = (k) => page.keyboard.press(k);
const sess = () => page.evaluate(() => {
  const T = window.__app.TOOLS.colors, V = window.__app.vec;
  if (!T.session) return null;
  return { pal: T.session.palette.map(V.toHex), del: Array.from(T.session.deleted).sort(), sel: Array.from(T.session.selected).sort(), counts: T.labels().counts };
});
const idxOf = (s, hex) => s.pal.indexOf(hex);
const vecLayer = (fi) => page.evaluate((fi) => {
  const S = window.__app.S; const d = S.docs[fi ?? S.cur];
  const L = d.layers.find((l) => l.vec);
  return L ? { name: L.name, active: d.layers[d.activeLayer] === L, shapes: L.vec.shapes.map((s) => ({ id: s.id, color: s.color, rings: s.rings.map((r) => r.map((p) => ({ ...p }))) })) } : null;
}, fi);
const bounds = (sh) => { const xs = sh.rings[0].map((p) => p.x), ys = sh.rings[0].map((p) => p.y); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };

// ---------------------------------------------------------------- 1. ferramenta e análise
console.log('1) Ferramenta e análise do quadro');
ok(await page.locator('#toolbar button[data-tool="colors"]').count() === 1, 'Botão "Seletor de cores" na barra de ferramentas');
await page.locator('#canvas').focus();
await key('i');
ok(await page.evaluate(() => window.__app.S.tool) === 'colors', 'Atalho I ativa o Seletor de cores');
ok(await waitFor(() => !!window.__app.TOOLS.colors.session), 'Ao abrir a ferramenta o quadro é analisado automaticamente');
let s = await sess();
ok(s.pal.length === 4 && ['#ffffff', '#ff0000', '#000000', '#0000ff'].every((c) => s.pal.includes(c)), `Quantização: imagem de 4 cores vira paleta exata (${s.pal.join(' ')})`);
ok(await page.locator('#vecPalette .vsw').count() === 4, 'Paleta mostrada no painel (4 amostras)');
ok(s.counts[idxOf(s, '#0000ff')] === 196, `Manchinha azul de 2×2 px some com "Remover manchinhas" (azul = ${s.counts[idxOf(s, '#0000ff')]} px, só o quadrado 14×14)`);
await page.evaluate(() => { window.__app.S.settings.vecSpeck = 1; window.__app.TOOLS.colors.paramsChanged(); });
await sleep(300);
s = await sess();
ok(s.counts[idxOf(s, '#0000ff')] === 200, `…e volta com o limite em 1 px (azul = ${s.counts[idxOf(s, '#0000ff')]} px)`);
await page.evaluate(() => { window.__app.S.settings.vecSpeck = 8; window.__app.TOOLS.colors.paramsChanged(); });
await sleep(300);
// número de cores: k-means numa imagem real (GIF de exemplo) respeita o limite
const kTest = await page.evaluate(() => {
  const V = window.__app.vec, fr = window.__app.S.frames[0].canvas;
  const d = fr.getContext('2d').getImageData(0, 0, fr.width, fr.height).data;
  const noisy = new Uint8ClampedArray(d.length);
  for (let i = 0; i < d.length; i += 4) { noisy[i] = (i * 7) % 256; noisy[i + 1] = (i * 13) % 256; noisy[i + 2] = (i * 29) % 256; noisy[i + 3] = 255; }
  const p6 = V.kmeansPalette(noisy, 6), p6b = V.kmeansPalette(noisy, 6);
  return { n: p6.length, same: JSON.stringify(p6) === JSON.stringify(p6b), sorted: p6.every((c, i) => !i || V.luminance(c) >= V.luminance(p6[i - 1])) };
});
ok(kTest.n === 6 && kTest.same && kTest.sorted, 'k-means: 6 cores pedidas → 6 cores, determinístico e ordenado do escuro ao claro');
await page.evaluate(() => { window.__app.S.settings.vecColors = 3; window.__app.TOOLS.colors.paramsChanged(true); });
await sleep(350);
ok((await sess()).pal.length === 3, 'Controle "Número de cores" refaz a análise (3 cores)');
await page.evaluate(() => { window.__app.S.settings.vecColors = 8; window.__app.TOOLS.colors.paramsChanged(true); });
await sleep(350);
ok((await sess()).pal.length === 4, '…e com 8 cores pedidas volta às 4 cores reais');
await page.screenshot({ path: `${OUT}/01_paleta.png` });

// ---------------------------------------------------------------- 2. conta-gotas, excluir, manter só
console.log('2) Conta-gotas, excluir, manter só, desfazer');
s = await sess();
const iW = idxOf(s, '#ffffff'), iR = idxOf(s, '#ff0000'), iK = idxOf(s, '#000000'), iB = idxOf(s, '#0000ff');
await click(5, 5);
ok(JSON.stringify((await sess()).sel) === JSON.stringify([iW]), 'Clique na imagem seleciona a cor sob o cursor (branco)');
await click(50, 50, { modifiers: ['Shift'] });
ok(JSON.stringify((await sess()).sel) === JSON.stringify([iW, iR].sort()), 'Shift+clique adiciona outra cor (vermelho)');
await click(50, 50, { modifiers: ['Shift'] });
ok(JSON.stringify((await sess()).sel) === JSON.stringify([iW]), 'Shift+clique de novo tira a cor da seleção');
await page.evaluate(() => { window.__app.S.settings.vecTol = 60; });
await click(50, 50);
ok(JSON.stringify((await sess()).sel) === JSON.stringify([iR, iK].sort()), 'Tolerância 60: o clique no vermelho pega também a cor mais próxima (preto), mas não branco/azul');
await page.evaluate(() => { window.__app.S.settings.vecTol = 100; });
await click(50, 50);
ok((await sess()).sel.length === 4, 'Tolerância máxima: um clique pega todas as cores (4)');
await page.evaluate(() => { window.__app.S.settings.vecTol = 6; });
await click(5, 5);
await key('Delete');
s = await sess();
ok(JSON.stringify(s.del) === JSON.stringify([iW]) && !s.sel.length, 'Delete exclui a cor selecionada (branco)');
const pvAlpha = await page.evaluate(() => { const c = window.__app.TOOLS.colors.previewCanvas(); const g = c.getContext('2d'); return [g.getImageData(5, 5, 1, 1).data[3], g.getImageData(50, 50, 1, 1).data[3]]; });
ok(pvAlpha[0] === 0 && pvAlpha[1] === 255, 'Prévia ao vivo: cor excluída fica transparente, as outras continuam');
ok(await page.locator(`#vecPalette .vsw[data-i="${iW}"].del`).count() === 1, 'Amostra da cor excluída marcada na paleta');
await page.click(`#vecPalette .vsw[data-i="${iB}"] .vsw-x`, { force: true });
ok(JSON.stringify((await sess()).del) === JSON.stringify([iW, iB].sort()), 'Botão × da amostra exclui a cor (azul)');
await key('Control+z');
ok(JSON.stringify((await sess()).del) === JSON.stringify([iW]), 'Ctrl+Z desfaz a última exclusão de cor');
await click(150 + 7, 120 + 7, { button: 'right' });
ok((await sess()).del.includes(iB), 'Botão direito na imagem exclui a cor direto (azul)');
await page.click('#vecRestore');
ok(!(await sess()).del.length, '"Restaurar todas" traz as cores de volta');
await click(50, 50);
await key('Shift+Delete');
ok(JSON.stringify((await sess()).del) === JSON.stringify([iW, iK, iB].sort()), 'Shift+Delete ("Manter só esta") exclui todas as outras cores');
await page.click('#vecUndo');
ok(!(await sess()).del.length, 'Botão Desfazer volta ao estado anterior');
await page.click(`#vecPalette .vsw[data-i="${iR}"]`);
await page.click('#vecKeep');
ok(JSON.stringify((await sess()).del) === JSON.stringify([iW, iK, iB].sort()), 'Clique na amostra + "Manter só esta" pelo painel');
await page.click('#vecRestore');
await click(5, 5); await key('Delete');
await page.screenshot({ path: `${OUT}/02_branco_excluido.png` });

// ---------------------------------------------------------------- 3. gerar vetores
console.log('3) Gerar formas vetoriais');
const nLayers0 = await page.evaluate(() => window.__app.S.docs[0].layers.length);
await key('Enter');
ok(await waitFor(() => !window.__app.TOOLS.colors.session && !window.__app.TOOLS.colors.busy), 'Enter gera a camada vetorial');
let V = await vecLayer();
ok(!!V && V.name === 'Vetor 1' && V.active, `Nova camada "${V?.name}" criada e ativa`);
ok(await page.evaluate(() => window.__app.S.docs[0].layers.length) === nLayers0 + 1, 'Uma camada a mais no quadro');
ok(V.shapes.length === 4, `4 formas (quadrado, anel, linha, quadrado azul): ${V.shapes.length}`);
ok(!V.shapes.some((sh) => sh.color === '#ffffff'), 'Nenhuma forma com a cor excluída (branco)');
const red = V.shapes.find((sh) => sh.color === '#ff0000');
const rb = red ? bounds(red) : [0, 0, 0, 0];
ok(red && Math.abs(rb[0] - 20) < 1.2 && Math.abs(rb[1] - 20) < 1.2 && Math.abs(rb[2] - 80) < 1.2 && Math.abs(rb[3] - 80) < 1.2, `Quadrado vermelho vetorizado no lugar certo (${rb.map((v) => v.toFixed(1)).join(', ')})`);
ok(red && red.rings[0].filter((p) => p.c).length >= 4, 'Cantos do quadrado viram pontos de canto');
const ring = V.shapes.find((sh) => sh.color === '#000000' && sh.rings.length === 2);
ok(!!ring, 'Anel preto vira uma forma com furo (2 contornos)');
ok(await page.locator('#layerList li.veclayer').count() === 1, 'Camada aparece na lista com o ícone de vetor');
ok(await page.isVisible('#vecToLines') && await page.isVisible('#vecFill'), 'Painel passa para a edição de formas');
// pixels renderizados
const px1 = await page.evaluate(() => {
  const A = window.__app; const c = A.cut.renderFrameToCanvas(A.S.docs[0], A.S.docW, A.S.docH, 400, 320, { frame: A.S.frames[0].canvas, layerFilter: (l) => !!l.vec });
  const g = c.getContext('2d'); const p = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data);
  return { red: p(100, 100), bg: p(10, 10), hole: p(280, 120), ring: p(340, 120), blue: p(314, 254) };
});
ok(px1.red.join() === '255,0,0,255' && px1.bg[3] === 0 && px1.hole[3] === 0 && px1.ring.join() === '0,0,0,255' && px1.blue.join() === '0,0,255,255',
  'Render 2×: formas nas cores certas, fundo e furo do anel transparentes');
await key('Control+z');
ok(!(await vecLayer()), 'Ctrl+Z remove a camada vetorial gerada');
await key('Control+y');
V = await vecLayer();
ok(!!V && V.shapes.length === 4, 'Ctrl+Y traz a camada de volta');

// ---------------------------------------------------------------- 4. editar formas
console.log('4) Editar formas e nós');
await page.evaluate(() => { window.__app.TOOLS.colors.sel.clear(); document.querySelectorAll('.toast').forEach((t) => t.remove()); });
await click(40, 40);
ok(await page.evaluate(() => window.__app.TOOLS.colors.sel.size) === 1, 'Clique numa forma seleciona');
const redId = (await vecLayer()).shapes.find((sh) => sh.color === '#ff0000').id;
ok(await page.evaluate((id) => window.__app.TOOLS.colors.sel.has(id), redId), '…a forma certa (quadrado vermelho)');
await drag([40, 40], [50, 45]);
let red2 = (await vecLayer()).shapes.find((sh) => sh.id === redId);
let b2 = bounds(red2);
ok(Math.abs(b2[0] - rb[0] - 10) < 0.6 && Math.abs(b2[1] - rb[1] - 5) < 0.6, `Arrastar move a forma (+10, +5): ${b2[0].toFixed(1)}, ${b2[1].toFixed(1)}`);
await key('Control+z');
red2 = (await vecLayer()).shapes.find((sh) => sh.id === redId);
ok(Math.abs(bounds(red2)[0] - rb[0]) < 0.6, 'Ctrl+Z desfaz o movimento');
await page.evaluate((id) => window.__app.TOOLS.colors.selectShapes([id]), redId);
const n0 = red2.rings[0][0];
await drag([n0.x, n0.y], [n0.x - 8, n0.y - 6]);
red2 = (await vecLayer()).shapes.find((sh) => sh.id === redId);
ok(Math.abs(red2.rings[0][0].x - (n0.x - 8)) < 0.6 && Math.abs(red2.rings[0][0].y - (n0.y - 6)) < 0.6, 'Arrastar um nó move só esse ponto');
const cnt0 = red2.rings[0].length;
// meio da borda de cima (entre dois cantos)
const tops = red2.rings[0].filter((p) => Math.abs(p.y - 20) < 1.5).sort((a, b) => a.x - b.x);
const mx = tops.length >= 2 ? (tops[tops.length - 2].x + tops[tops.length - 1].x) / 2 : 60;
await click(mx, 20);
red2 = (await vecLayer()).shapes.find((sh) => sh.id === redId);
ok(red2.rings[0].length === cnt0 + 1, `Clique no contorno cria um nó (${cnt0} → ${red2.rings[0].length})`);
const np = red2.rings[0].find((p) => Math.abs(p.x - mx) < 0.8 && Math.abs(p.y - 20) < 0.8);
await click(np.x, np.y, { button: 'right' });
red2 = (await vecLayer()).shapes.find((sh) => sh.id === redId);
ok(red2.rings[0].length === cnt0, 'Botão direito num nó remove o ponto');
const q = red2.rings[0][1];
const wasC = !!q.c;
await click(q.x, q.y, { modifiers: ['Alt'] });
red2 = (await vecLayer()).shapes.find((sh) => sh.id === redId);
ok(!!red2.rings[0][1].c !== wasC, 'Alt+clique alterna ponto de canto/suave');
await page.evaluate(() => { const i = document.getElementById('vecFill'); i.value = '#33aa55'; i.dispatchEvent(new Event('change')); });
red2 = (await vecLayer()).shapes.find((sh) => sh.id === redId);
ok(red2.color === '#33aa55', 'Mudar a cor de preenchimento da forma selecionada');
await key('Delete');
ok(!(await vecLayer()).shapes.some((sh) => sh.id === redId), 'Delete apaga a forma selecionada');
await key('Control+z');
ok((await vecLayer()).shapes.some((sh) => sh.id === redId && sh.color === '#33aa55'), 'Ctrl+Z traz a forma de volta');
// mesma cor
await page.evaluate(() => { const T = window.__app.TOOLS.colors; const L = window.__app.S.docs[0].layers.find((l) => l.vec); T.selectShapes([L.vec.shapes.find((s) => s.color === '#000000').id]); });
await page.click('#vecSameColor');
ok(await page.evaluate(() => window.__app.TOOLS.colors.sel.size) === 2, '"Selecionar mesma cor" pega o anel e a linha (2 formas pretas)');
// outras ferramentas não desenham na camada vetorial
await page.evaluate(() => window.__app.setTool('pen'));
await drag([30, 140], [90, 150]);
ok(await page.evaluate(() => window.__app.S.docs[0].layers.find((l) => l.vec).strokes.length) === 0, 'Pincel não desenha na camada vetorial (aviso)');
await page.evaluate(() => window.__app.setTool('colors'));
await page.screenshot({ path: `${OUT}/04_formas.png` });

// ---------------------------------------------------------------- 5. traço → linhas
console.log('5) Traço → linhas do Giffact');
// mancha grossa (quadrado 60×60) não é traço: fica como forma
await page.evaluate((id) => { window.__app.TOOLS.colors.selectShapes([id]); window.__app.S.settings.vecLineMax = 8; }, redId);
const thick = await page.evaluate(() => window.__app.TOOLS.colors.toLines());
ok(thick.strokes === 0 && thick.skipped === 1 && (await vecLayer()).shapes.length === 4, 'Formas grossas demais (acima da espessura máxima) não viram linhas e continuam como formas');
await page.evaluate(() => { const T = window.__app.TOOLS.colors; const L = window.__app.S.docs[0].layers.find((l) => l.vec); T.selectShapes(L.vec.shapes.filter((s) => s.color === '#000000').map((s) => s.id)); window.__app.S.settings.vecLinesRemove = true; window.__app.S.settings.vecLinesScope = 'current'; });
await page.evaluate(() => window.__app.TOOLS.colors.toLines());
const lines = await page.evaluate(() => {
  const d = window.__app.S.docs[0];
  const L = d.layers.find((l) => !l.vec && !l.cut && l.strokes.length);
  return L ? { name: L.name, strokes: L.strokes.map((s) => ({ closed: s.closed, width: s.width, n: s.pts.length, pts: s.pts })) } : null;
});
ok(!!lines && lines.name === 'Linhas de Vetor 1', `Linhas numa camada comum: "${lines?.name}"`);
ok(lines && lines.strokes.length >= 2 && lines.strokes.length <= 4, `Anel + linha viram poucas linhas editáveis (${lines?.strokes.length})`);
const circ = lines?.strokes.find((st) => st.closed);
const meanR = circ ? circ.pts.reduce((a, p) => a + Math.hypot(p.x - 140, p.y - 60), 0) / circ.pts.length : 0;
ok(circ && Math.abs(meanR - 30) < 1.5, `Anel vira uma linha fechada no centro do traço (raio médio ${meanR.toFixed(2)} ≈ 30)`);
ok(circ && circ.width >= 3 && circ.width <= 7, `Espessura do anel medida (${circ?.width} px; traço original ≈ 4–5 px)`);
const seg = lines?.strokes.find((st) => !st.closed);
ok(seg && seg.width >= 2 && seg.width <= 5.5 && seg.pts.every((p) => p.x > 14 && p.x < 126), `Linha reta vira uma linha aberta (espessura ${seg?.width})`);
V = await vecLayer();
ok(V.shapes.length === 2 && !V.shapes.some((sh) => sh.color === '#000000'), '"Remover as formas convertidas": formas pretas saem da camada vetorial');
const lineCov = await page.evaluate(() => {
  const A = window.__app; const c = A.cut.renderFrameToCanvas(A.S.docs[0], A.S.docW, A.S.docH, A.S.docW, A.S.docH, { layerFilter: (l) => !l.vec && !l.cut });
  const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data;
  const fr = A.S.frames[0].canvas.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let inter = 0, uni = 0;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] > 100, b = fr[i] === 0 && fr[i + 1] === 0 && fr[i + 2] === 0;
    if (a && b) inter++; if (a || b) uni++;
  }
  return inter / uni;
});
ok(lineCov > 0.6, `As linhas cobrem o traço original (IoU ${(lineCov * 100).toFixed(0)}%)`);
await page.evaluate(() => window.__app.setTool('edit'));
await page.evaluate(() => { const d = window.__app.S.docs[0]; d.activeLayer = d.layers.findIndex((l) => l.name === 'Linhas de Vetor 1'); });
ok(await page.evaluate(() => window.__app.S.docs[0].layers[window.__app.S.docs[0].activeLayer].strokes.every((s) => s.kind === 'curve' && s.pts.every((p) => p.p > 0 && p.p <= 1))), 'Linhas convertidas são curvas normais com pressão (editáveis como as feitas à mão)');
await key('Control+z');
ok(await page.evaluate(() => !window.__app.S.docs[0].layers.some((l) => l.name === 'Linhas de Vetor 1' && l.strokes.length)) && (await vecLayer()).shapes.length === 4, 'Ctrl+Z desfaz a conversão (formas de volta, sem linhas)');
await key('Control+y');
await page.evaluate(() => { const d = window.__app.S.docs[0]; d.activeLayer = d.layers.findIndex((l) => l.vec); window.__app.setTool('colors'); });

// ---------------------------------------------------------------- 6. salvar / abrir
console.log('6) Salvar e abrir projeto');
const proj = await page.evaluate(() => { const u = window.__app.serializeProject(); return new TextDecoder().decode(u); });
fs.writeFileSync(`${OUT}/vetor.giffact`, proj);
const pj = JSON.parse(proj);
const pl = pj.frames[0].layers.find((l) => l.vec);
ok(!!pl && Array.isArray(pl.strokes) && pl.strokes.length === 0 && pl.vec.shapes.length === 2, 'Projeto guarda a camada vetorial (com strokes: [] — versões antigas a abrem como camada vazia)');
const before = JSON.stringify(await vecLayer());
await page.evaluate(async (txt) => { await window.__app.loadProjectBytes(new TextEncoder().encode(txt)); }, proj);
await sleep(200);
ok(JSON.stringify(await vecLayer()) === before, 'Projeto reaberto com as mesmas formas, cores e nós');
ok(await page.evaluate(() => window.__app.S.docs[0].layers.some((l) => l.name === 'Linhas de Vetor 1' && l.strokes.length >= 2)), '…e com as linhas convertidas');
const bad = JSON.parse(proj);
bad.frames[0].layers.push({ id: 'zz', name: 'ruim', visible: true, locked: false, opacity: 1, strokes: [], vec: { shapes: 'x' } });
bad.frames[0].layers.push({ id: 'zz2', name: 'meio', visible: true, locked: false, opacity: 1, strokes: [], vec: { shapes: [{ id: 'a', color: 'azul', rings: [[{ x: 1, y: 1 }, { x: 5, y: 1 }, { x: 5, y: 5 }], [{ x: 'q' }]] }, { rings: 3 }] } });
await page.evaluate(async (txt) => { await window.__app.loadProjectBytes(new TextEncoder().encode(txt)); }, JSON.stringify(bad));
await sleep(150);
const san = await page.evaluate(() => { const ls = window.__app.S.docs[0].layers; const a = ls.find((l) => l.name === 'ruim'), b = ls.find((l) => l.name === 'meio'); return { a: !!a && !a.vec, b: b?.vec?.shapes.length === 1 && b.vec.shapes[0].rings.length === 1 && b.vec.shapes[0].color === '#000000' }; });
ok(san.a && san.b, 'Dados vetoriais inválidos no arquivo são saneados (sem travar)');
await page.evaluate(async (txt) => { await window.__app.loadProjectBytes(new TextEncoder().encode(txt)); }, proj);
await sleep(150);

// ---------------------------------------------------------------- 7. exportação
console.log('7) Exportação PNG/SVG');
async function exportZip(content, format = 'png', scale = '2') {
  await page.keyboard.press('Control+e');
  await page.selectOption('#exFormat', format);
  await page.selectOption('#exFrames', 'current');
  await page.selectOption('#exSizeMode', 'scale');
  await page.fill('#exScale', scale);
  await page.selectOption('#exBg', 'transparent');
  await page.selectOption('#exContent', content);
  if (await page.isChecked('#exIncludeGif')) await page.uncheck('#exIncludeGif');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exGo')]);
  const zip = `${OUT}/${content}_${format}.zip`; await dl.saveAs(zip);
  const dir = `${OUT}/${content}_${format}`;
  execFileSync('python3', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, dir]);
  await sleep(200);
  return path.join(dir, fs.readdirSync(dir)[0]);
}
const pix = (f, pts) => JSON.parse(execFileSync('python3', ['-c', `
import sys, json
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGBA'); a = im.load()
print(json.dumps({'size': list(im.size), 'px': [list(a[x, y]) for x, y in json.loads(sys.argv[2])]}))`, f, JSON.stringify(pts)]).toString());
const vf = await exportZip('vectors');
ok(path.basename(vf) === 'vetor_001.png', `Nome padrão para "Só formas vetoriais": ${path.basename(vf)}`);
const pv = pix(vf, [[100, 100], [10, 10], [314, 254], [280, 120], [340, 120], [140, 247]]);
ok(pv.size.join('×') === '400×320', `PNG em 2× (${pv.size.join('×')})`);
ok(pv.px[0].join() === '51,170,85,255' && pv.px[2].join() === '0,0,255,255', `PNG "só vetores": formas preenchidas nas cores certas (${pv.px[0]} / ${pv.px[2]})`);
ok(pv.px[1][3] === 0 && pv.px[3][3] === 0 && pv.px[4][3] === 0 && pv.px[5][3] === 0, 'Transparente no fundo e sem as linhas convertidas');
const lf = await exportZip('lines');
const plf = pix(lf, [[100, 100], [340, 120]]);
ok(plf.px[0][3] === 0 && plf.px[1][3] > 200, 'PNG "só linhas": linhas convertidas presentes, formas vetoriais ausentes');
const bf = await exportZip('both');
const pbf = pix(bf, [[100, 100], [340, 120]]);
ok(pbf.px[0][3] === 255 && pbf.px[1][3] > 200, 'PNG "Tudo": formas e linhas juntas');
const sf = await exportZip('vectors', 'svg');
const svg = fs.readFileSync(sf, 'utf8');
const paths = svg.match(/<path [^>]*>/g) || [];
ok(paths.length === 2 && paths.every((p) => /fill-rule="evenodd"/.test(p) && / d="M[\d.\s-]+C/.test(p)) && !svg.includes('<image'), `SVG "só vetores": ${paths.length} caminhos Bézier reais (M…C…Z), sem imagens embutidas`);
ok(/<g id="Vetor 1"/.test(svg) && svg.includes('fill="#33aa55"'), 'SVG com grupo da camada e cores das formas');
const sAll = fs.readFileSync(await exportZip('both', 'svg'), 'utf8');
ok((sAll.match(/<path /g) || []).length >= 4, 'SVG "Tudo": formas + linhas');
await page.evaluate(() => { document.getElementById('dlgExport').hidden = true; });

// ---------------------------------------------------------------- 8. todos os quadros
console.log('8) Aplicar em todos os quadros');
const gif = fs.readFileSync('samples/parcial_disposal1.gif').toString('base64');
await page.evaluate(async (b64) => { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); await window.__app.loadAny('parcial.gif', u); }, gif);
await sleep(200);
const nF = await page.evaluate(() => window.__app.S.frames.length);
await page.evaluate(() => { window.__app.setTool('select'); window.__app.setTool('colors'); });
ok(await waitFor(() => !!window.__app.TOOLS.colors.session), `GIF de ${nF} quadros analisado`);
s = await sess();
const big = s.counts.indexOf(Math.max(...s.counts));
await page.evaluate((i) => { const T = window.__app.TOOLS.colors; T.pickIndex(i); T.deleteSelected(); }, big);
await page.selectOption('#vecScope', 'all');
await page.click('#vecGenerate');
ok(await waitFor(() => !window.__app.TOOLS.colors.session && !window.__app.TOOLS.colors.busy, null, 30000), 'Gerado em todos os quadros');
const all = await page.evaluate((delHex) => window.__app.S.docs.map((d) => { const L = d.layers.find((l) => l.vec); return L ? { name: L.name, n: L.vec.shapes.length, bad: L.vec.shapes.filter((s) => s.color === delHex).length } : null; }), s.pal[big]);
ok(all.every((x) => x && x.name === 'Vetor 1' && x.n > 0), `Camada "Vetor 1" em todos os ${nF} quadros (${all.map((x) => x?.n).join(', ')} formas)`);
ok(all.every((x) => x && x.bad === 0), 'Mesma cor excluída em todos os quadros (paleta pela cor mais próxima)');
await page.evaluate(() => window.__app.goFrame(1));
await key('Control+z');
ok(await page.evaluate(() => !window.__app.S.docs[1].layers.some((l) => l.vec) && window.__app.S.docs[0].layers.some((l) => l.vec)), 'Desfazer é por quadro (como nas outras ferramentas)');
// intervalo
await page.evaluate(() => window.__app.goFrame(0));
await page.click('#vecNew');
await page.selectOption('#vecScope', 'range');
await page.fill('#vecFrom', '2'); await page.dispatchEvent('#vecFrom', 'change');
await page.fill('#vecTo', '3'); await page.dispatchEvent('#vecTo', 'change');
await page.click('#vecGenerate');
await waitFor(() => !window.__app.TOOLS.colors.session && !window.__app.TOOLS.colors.busy, null, 30000);
const rng = await page.evaluate(() => window.__app.S.docs.map((d) => d.layers.some((l) => l.vec && l.name === 'Vetor 2')));
ok(rng.filter(Boolean).length === 2 && rng[1] && rng[2], `Intervalo de quadros 2–3: ${rng.map((b) => (b ? '■' : '□')).join('')}`);
// traço → linhas em todos os quadros com a camada
await page.evaluate(() => { const d = window.__app.S.docs[0]; d.activeLayer = d.layers.findIndex((l) => l.name === 'Vetor 1'); window.__app.S.settings.vecLinesScope = 'layer'; window.__app.S.settings.vecLinesRemove = false; window.__app.TOOLS.colors.sel.clear(); });
const tl = await page.evaluate(() => window.__app.TOOLS.colors.toLines());
const vec1Frames = all.filter(Boolean).length - 1;
ok(tl.frames >= 1 && tl.frames <= vec1Frames && tl.strokes > 0, `Converter em linhas em todos os quadros com a camada (${tl.strokes} linhas em ${tl.frames} quadro(s))`);

// ---------------------------------------------------------------- 9. ajuda e idiomas
console.log('9) Ajuda e textos');
await page.keyboard.press('F1'); await sleep(150);
const help = await page.locator('#dlgHelp').innerText();
ok(help.includes('Seletor de cores (I)') && help.includes('Seletor de cores (vetorizar)'), 'Ajuda tem o passo e os atalhos do Seletor de cores');
ok(!/como no |no estilo|no espírito/i.test(help.split('Seletor de cores (vetorizar)')[1] || 'x'), 'Textos novos sem comparação com outros programas');
await key('Escape');
await page.evaluate(() => window.__app.i18n.setLang('en')); await sleep(150);
await page.evaluate(() => window.__app.setTool('colors'));
ok((await page.locator('#pToolTitle').textContent()) === 'Color selector (vectorize)', 'Nome da ferramenta traduzido (en)');
await page.evaluate(() => window.__app.i18n.setLang('pt-BR'));

ok(errors.length === 0, 'Sem erros na página' + (errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''));
await browser.close();
server.close();
console.log(failures ? `\n${failures} FALHA(S)` : '\nSELETOR DE CORES OK');
process.exit(failures ? 1 : 0);
