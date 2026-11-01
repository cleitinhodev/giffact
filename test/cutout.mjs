// Testes da ferramenta Recorte (máscara → camada de pixels do GIF): fechar a máscara, editar pontos,
// alfa correto (dentro = pixels do quadro, fora = transparente, borda suavizada), quadros (atual/todos/intervalo),
// desfazer, reeditar, salvar/abrir projeto e exportação PNG/SVG (só recortes / só linhas / ambos).
// Uso: `node test/cutout.mjs` (requer `node build.mjs` antes).
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve('app');
const OUT = path.resolve('test-output/cutout');
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
const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 }, acceptDownloads: true, deviceScaleFactor: 1, locale: 'pt-BR' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('dialog', (d) => d.accept());
await page.goto(`http://localhost:${server.address().port}/index.html`);
const waitFor = async (fn, timeout = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { try { if (await page.evaluate(fn)) return true; } catch {} await sleep(80); }
  return false;
};
await waitFor(() => !!window.__app);
await page.evaluate(() => localStorage.clear());

const loadFile = async (file) => {
  const b64 = fs.readFileSync(file).toString('base64');
  await page.evaluate(async ([name, b64]) => {
    const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    await window.__app.loadAny(name, u);
  }, [path.basename(file), b64]);
  await sleep(200);
};
await loadFile('samples/parcial_disposal1.gif');
const box = await page.locator('#canvas').boundingBox();
const at = async (x, y) => {
  const [sx, sy] = await page.evaluate(([x, y]) => {
    const S = window.__app.S, v = S.view, c = document.getElementById('canvas');
    const m = new DOMMatrix().translate(c.clientWidth / 2 + v.panX, c.clientHeight / 2 + v.panY).rotate(v.rot).scale(v.zoom).translate(-S.docW / 2, -S.docH / 2);
    const p = m.transformPoint(new DOMPoint(x, y)); return [p.x, p.y];
  }, [x, y]);
  return [box.x + sx, box.y + sy];
};
const click = async (x, y, opts) => { const [sx, sy] = await at(x, y); await page.mouse.click(sx, sy, opts); await sleep(220); };
const drag = async (a, b) => {
  const [sx, sy] = await at(...a); const [ex, ey] = await at(...b);
  await page.mouse.move(sx, sy); await page.mouse.down(); await page.mouse.move(ex, ey, { steps: 6 }); await page.mouse.up(); await sleep(120);
};
const tool = () => page.evaluate(() => { const T = window.__app.TOOLS.cutout; return { mode: T.mode, pts: T.pts.map((p) => ({ ...p })) }; });
const layers = (fi) => page.evaluate((fi) => { const S = window.__app.S; const d = S.docs[fi ?? S.cur]; return { active: d.activeLayer, list: d.layers.map((l) => ({ name: l.name, cut: l.cut ? JSON.parse(JSON.stringify(l.cut)) : null, strokes: l.strokes.length, visible: l.visible })) }; }, fi);
const key = (k) => page.keyboard.press(k);

// ---------------------------------------------------------------- 1. ferramenta e atalho
console.log('1) Ferramenta Recorte');
ok(await page.locator('#toolbar button[data-tool="cutout"]').count() === 1, 'Botão "Recorte" na barra de ferramentas');
await page.locator('#canvas').focus();
await key('x');
ok(await page.evaluate(() => window.__app.S.tool) === 'cutout', 'Atalho X ativa o Recorte');
ok(await page.isVisible('#cutApply') && await page.isVisible('#cutScope'), 'Painel de opções com Aplicar e "Aplicar em"');
ok(await page.locator('#cutApply').isDisabled() && await page.locator('#cutEditMask').isDisabled(), 'Aplicar/Editar máscara desativados sem máscara');

// ---------------------------------------------------------------- 2. desenhar e fechar
console.log('2) Desenhar e fechar a máscara');
// Esc cancela
await click(30, 30); await click(80, 30);
ok((await tool()).mode === 'draw' && (await tool()).pts.length === 2, 'Cliques adicionam pontos (modo desenho)');
await key('Escape');
ok((await tool()).mode === 'idle' && (await tool()).pts.length === 0, 'Esc cancela a máscara');
// duplo clique fecha (modo suave)
await click(30, 30); await click(80, 30); await click(80, 80);
{ const [sx, sy] = await at(30, 80); await page.mouse.dblclick(sx, sy); await sleep(150); }
let T = await tool();
ok(T.mode === 'edit' && T.pts.length === 4 && T.pts.every((p) => !p.c), `Duplo clique fecha a máscara suave (${T.pts.length} pontos, modo edição)`);
await key('Escape');
// Enter com < 3 pontos não fecha
await click(30, 30); await click(80, 30); await key('Enter');
ok((await tool()).mode === 'draw', 'Enter com 2 pontos não fecha (mínimo 3)');
await key('Escape');
// modo polígono, botão direito desfaz, clique no 1º ponto fecha
await page.click('#toolOptions [data-cutmode="poly"]');
ok(await page.evaluate(() => window.__app.S.settings.cutPoly) === true, 'Modo Polígono selecionado');
for (const p of [[100, 60], [220, 60], [220, 180], [100, 180], [60, 120]]) await click(...p);
ok((await tool()).pts.length === 5, '5 pontos colocados');
await click(60, 120, { button: 'right' });
ok((await tool()).pts.length === 4, 'Botão direito desfaz o último ponto');
await click(100.5, 60.5);
T = await tool();
ok(T.mode === 'edit' && T.pts.length === 4 && T.pts.every((p) => p.c === 1), 'Clique no 1º ponto fecha o polígono (cantos retos)');
await page.screenshot({ path: `${OUT}/01_mascara.png` });

// ---------------------------------------------------------------- 3. editar antes de aplicar
console.log('3) Editar a máscara antes de aplicar');
await drag([220, 180], [240, 200]);
T = await tool();
ok(Math.abs(T.pts[2].x - 240) < 1.5 && Math.abs(T.pts[2].y - 200) < 1.5, `Arrastar ponto move só ele (${T.pts[2].x.toFixed(1)}, ${T.pts[2].y.toFixed(1)})`);
await drag([150, 120], [160, 125]);
T = await tool();
ok(Math.abs(T.pts[0].x - 110) < 1.5 && Math.abs(T.pts[0].y - 65) < 1.5 && Math.abs(T.pts[2].x - 250) < 1.5, 'Arrastar o interior move a máscara inteira');
await drag([160, 125], [150, 120]);
T = await tool();
ok(Math.abs(T.pts[0].x - 100) < 1.5 && Math.abs(T.pts[2].x - 240) < 1.5, 'Máscara volta ao lugar');
const nBefore = (await layers()).list.length;

// ---------------------------------------------------------------- 4. aplicar
console.log('4) Aplicar o recorte');
await key('Enter');
let L = await layers();
const cutL = L.list[L.active];
ok(L.list.length === nBefore + 1 && cutL.cut && cutL.strokes === 0, `Nova camada "${cutL.name}" com máscara (${cutL.cut?.pts.length} pontos) e sem traços`);
ok(cutL.name === 'Recorte 1', 'Nome da camada: "Recorte 1"');
ok((await tool()).mode === 'idle', 'Ferramenta volta ao estado inicial');
ok(await page.locator('#layerList li.cutlayer').count() === 1 && (await page.locator('#layerList li.cutlayer .cnt').textContent()) === '✂', 'Lista de camadas marca a camada de recorte com ✂');
const others = await page.evaluate(() => window.__app.S.docs.filter((d, i) => i !== window.__app.S.cur && d.layers.some((l) => l.cut)).length);
ok(others === 0, 'Escopo "Quadro atual": nenhum outro quadro recebeu o recorte');

// ---------------------------------------------------------------- 5. alfa
console.log('5) Alfa do resultado');
const alpha = await page.evaluate(() => {
  const a = window.__app, S = a.S, d = S.docs[S.cur], Lr = d.layers[d.activeLayer];
  const fr = S.frames[S.cur].canvas;
  const c = a.cut.cutCanvas(Lr.cut, fr);
  const cd = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const fd = fr.getContext('2d').getImageData(0, 0, fr.width, fr.height).data;
  let inside = 0, insideBad = 0, outside = 0, outsideBad = 0, partial = 0, frameOpaqueIn = 0;
  const poly = Lr.cut.pts;
  const path = new Path2D(); poly.forEach((p, i) => (i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y))); path.closePath();
  const g = document.createElement('canvas').getContext('2d');
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    const i = (y * c.width + x) * 4;
    const cx = x + 0.5, cy = y + 0.5;
    const inn = g.isPointInPath(path, cx, cy) && g.isPointInPath(path, cx - 1.5, cy) && g.isPointInPath(path, cx + 1.5, cy) && g.isPointInPath(path, cx, cy - 1.5) && g.isPointInPath(path, cx, cy + 1.5);
    const out = !g.isPointInPath(path, cx, cy) && !g.isPointInPath(path, cx - 1.5, cy) && !g.isPointInPath(path, cx + 1.5, cy) && !g.isPointInPath(path, cx, cy - 1.5) && !g.isPointInPath(path, cx, cy + 1.5);
    if (inn) { inside++; if (fd[i + 3]) frameOpaqueIn++; if (Math.abs(cd[i] - fd[i]) > 1 || Math.abs(cd[i + 1] - fd[i + 1]) > 1 || Math.abs(cd[i + 2] - fd[i + 2]) > 1 || Math.abs(cd[i + 3] - fd[i + 3]) > 1) insideBad++; }
    else if (out) { outside++; if (cd[i + 3] !== 0) outsideBad++; }
    else if (cd[i + 3] > 0 && cd[i + 3] < fd[i + 3]) partial++;
  }
  return { inside, insideBad, outside, outsideBad, partial, frameOpaqueIn, w: c.width, h: c.height };
});
ok(alpha.w === 320 && alpha.h === 240, `Recorte no tamanho do quadro (${alpha.w}×${alpha.h})`);
ok(alpha.inside > 10000 && alpha.insideBad === 0 && alpha.frameOpaqueIn > 1000, `Dentro: ${alpha.inside} px idênticos ao quadro do GIF (${alpha.frameOpaqueIn} opacos)`);
ok(alpha.outside > 30000 && alpha.outsideBad === 0, `Fora: ${alpha.outside} px totalmente transparentes`);
ok(alpha.partial > 20, `Borda antisserrilhada (${alpha.partial} px com alfa parcial)`);
const feather = await page.evaluate(() => {
  const a = window.__app, S = a.S, fr = S.frames[S.cur].canvas;
  const m = { pts: [{ x: 100, y: 60, c: 1 }, { x: 220, y: 60, c: 1 }, { x: 220, y: 180, c: 1 }, { x: 100, y: 180, c: 1 }], feather: 0 };
  const count = (mm) => { const d = a.cut.renderCut(mm, fr, 320, 240).getContext('2d').getImageData(0, 0, 320, 240).data; let n = 0; for (let y = 0; y < 240; y++) { const i = (y * 320 + 100) * 4; } for (let i = 3; i < d.length; i += 4) { const x = (i >> 2) % 320, y = ((i >> 2) / 320) | 0; const fa = fr.getContext('2d').getImageData(x, y, 1, 1).data[3]; if (fa === 255 && d[i] > 0 && d[i] < 250) n++; if (n > 5000) break; } return n; };
  // amostra só a coluna de borda esquerda (rápido): alfa ao longo de x = 90..110 na linha 120
  const row = (mm) => { const d = a.cut.renderCut(mm, fr, 320, 240).getContext('2d').getImageData(88, 120, 24, 1).data; return Array.from({ length: 24 }, (_, k) => d[k * 4 + 3]); };
  void count;
  return { sharp: row(m), soft: row({ ...m, feather: 8 }) };
});
const ramp = (r) => r.filter((v) => v > 5 && v < 250).length;
ok(ramp(feather.soft) >= 4 && ramp(feather.soft) > ramp(feather.sharp), `Borda suave (8 px) cria degradê: ${ramp(feather.soft)} px intermediários vs ${ramp(feather.sharp)} na borda nítida`);

// ---------------------------------------------------------------- 6. visibilidade, proteção, desfazer
console.log('6) Visibilidade, proteção e desfazer');
await page.locator('#layerList li.cutlayer button').first().click();
ok((await layers()).list.find((l) => l.cut).visible === false, 'Olho esconde a camada de recorte');
await page.locator('#layerList li.cutlayer button').first().click();
ok((await layers()).list.find((l) => l.cut).visible === true, 'Olho mostra de novo');
await page.locator('#canvas').focus();
await key('c');
await click(20, 20); await click(60, 30); await key('Enter');
ok((await layers()).list.find((l) => l.cut).strokes === 0, 'Curva não desenha na camada de recorte (aviso)');
await key('x');
// desfaz: mostrar, esconder (olho) e o recorte
for (let i = 0; i < 3; i++) await key('Control+z');
ok((await layers()).list.every((l) => !l.cut), 'Ctrl+Z remove o recorte');
for (let i = 0; i < 3; i++) await key('Control+y');
ok((await layers()).list.some((l) => l.cut && l.visible), 'Ctrl+Y traz de volta');

// ---------------------------------------------------------------- 7. reeditar máscara
console.log('7) Reeditar a máscara de uma camada');
await page.evaluate(() => { const S = window.__app.S; const d = S.docs[S.cur]; d.activeLayer = d.layers.findIndex((l) => l.cut); window.__app.setTool('cutout'); });
await page.evaluate(() => { window.__app.setTool('select'); window.__app.setTool('cutout'); }); // atualiza o painel
ok(!(await page.locator('#cutEditMask').isDisabled()), '"Editar máscara" disponível com camada de recorte ativa');
await page.click('#cutEditMask');
ok((await tool()).mode === 'edit' && (await tool()).pts.length === 4, 'Máscara da camada carregada para edição');
await drag([150, 120], [170, 120]);
await page.click('#cutApply');
L = await layers();
const edited = L.list.filter((l) => l.cut);
ok(edited.length === 1 && Math.abs(edited[0].cut.pts[0].x - 120) < 1.5 && edited[0].name === 'Recorte 1', `Máscara reeditada no lugar (x0 = ${edited[0]?.cut.pts[0].x.toFixed(1)}), sem camada nova`);

// ---------------------------------------------------------------- 8. todos os quadros / intervalo
console.log('8) Aplicar em todos os quadros / intervalo');
await page.selectOption('#cutScope', 'all');
for (const p of [[10, 150], [70, 150], [70, 230], [10, 230]]) await click(...p);
await key('Enter'); await key('Enter');
let per = await page.evaluate(() => window.__app.S.docs.map((d) => d.layers.filter((l) => l.name === 'Recorte 2' && l.cut).length));
ok(per.length === 10 && per.every((n) => n === 1), `"Recorte 2" criado em todos os ${per.length} quadros`);
await page.selectOption('#cutScope', 'range');
await page.fill('#cutFrom', '3'); await page.dispatchEvent('#cutFrom', 'change');
await page.fill('#cutTo', '5'); await page.dispatchEvent('#cutTo', 'change');
for (const p of [[250, 10], [310, 10], [310, 60], [250, 60]]) await click(...p);
await page.click('#cutApply'); // no modo desenho: fecha e aplica de uma vez
per = await page.evaluate(() => window.__app.S.docs.map((d) => d.layers.some((l) => l.name === 'Recorte 3' && l.cut) ? 1 : 0));
ok(per.join('') === '0011100000', `Intervalo 3–5: ${per.join('')}`);
await page.selectOption('#cutScope', 'current');

// ---------------------------------------------------------------- 9. projeto
console.log('9) Salvar e abrir projeto');
// traço numa camada de linhas, fora das máscaras (para testar o filtro de exportação)
await page.evaluate(() => { const S = window.__app.S; const d = S.docs[S.cur]; d.activeLayer = d.layers.findIndex((l) => !l.cut); });
await page.evaluate(() => window.__app.setTool('line'));
await click(260, 200); await click(310, 230); await key('Enter');
const before = await page.evaluate(() => JSON.stringify(window.__app.S.docs.map((d) => d.layers.map((l) => ({ n: l.name, c: l.cut || null, s: l.strokes.length })))));
const bytes = await page.evaluate(() => Array.from(window.__app.serializeProject()));
fs.writeFileSync(`${OUT}/recorte.giffact`, Buffer.from(bytes));
await page.reload(); await waitFor(() => !!window.__app);
await loadFile(`${OUT}/recorte.giffact`);
const after = await page.evaluate(() => JSON.stringify(window.__app.S.docs.map((d) => d.layers.map((l) => ({ n: l.name, c: l.cut || null, s: l.strokes.length })))));
ok(before === after && before.includes('"c":{"pts"'), 'Projeto reaberto com as mesmas camadas de recorte (máscara + borda) e traços');
// projeto com máscara inválida não quebra
const bad = JSON.parse(fs.readFileSync(`${OUT}/recorte.giffact`, 'utf8'));
bad.frames[0].layers.push({ id: 'zz', name: 'ruim', visible: true, locked: false, opacity: 1, strokes: [], cut: { pts: [{ x: 1 }], feather: 'x' } });
fs.writeFileSync(`${OUT}/ruim.giffact`, JSON.stringify(bad));
await loadFile(`${OUT}/ruim.giffact`);
ok(await page.evaluate(() => { const l = window.__app.S.docs[0].layers.find((l) => l.name === 'ruim'); return !!l && !l.cut; }), 'Máscara inválida no arquivo vira camada comum (saneamento)');
await loadFile(`${OUT}/recorte.giffact`);

// ---------------------------------------------------------------- 10. exportação
console.log('10) Exportação PNG/SVG');
await page.evaluate(() => window.__app.goFrame(0));
const framePx = await page.evaluate(() => { const c = window.__app.S.frames[0].canvas; return Array.from(c.getContext('2d').getImageData(0, 0, 320, 240).data); });
fs.writeFileSync(`${OUT}/frame0.raw`, Buffer.from(framePx));
async function exportZip(content, format = 'png') {
  await page.keyboard.press('Control+e');
  await page.selectOption('#exFormat', format);
  await page.selectOption('#exFrames', 'current');
  await page.selectOption('#exSizeMode', 'scale');
  await page.fill('#exScale', '1');
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
const masks = await page.evaluate(() => window.__app.S.docs[0].layers.filter((l) => l.cut).map((l) => l.cut));
const stats = (f) => JSON.parse(execFileSync('python3', ['-c', `
import sys, json
from PIL import Image, ImageDraw
im = Image.open(sys.argv[1]).convert('RGBA'); W, H = im.size
fr = Image.frombytes('RGBA', (320, 240), open(sys.argv[2], 'rb').read())
masks = json.loads(sys.argv[3])
m = Image.new('L', (W, H), 0); d = ImageDraw.Draw(m)
for mk in masks: d.polygon([(p['x'], p['y']) for p in mk['pts']], fill=255)
from PIL import ImageFilter
inner = m.filter(ImageFilter.MinFilter(7)); outer = m.filter(ImageFilter.MaxFilter(7))
a = im.load(); f = fr.load(); I = inner.load(); O = outer.load()
st = dict(size=[W, H], inEq=0, inBad=0, outOpaque=0, lineBox=0)
for y in range(H):
  for x in range(W):
    if I[x, y]:
      if max(abs(a[x, y][k] - f[x, y][k]) for k in range(4)) <= 2: st['inEq'] += 1
      else: st['inBad'] += 1
    elif not O[x, y] and a[x, y][3] > 0: st['outOpaque'] += 1
for y in range(195, 236):
  for x in range(255, 316):
    if a[x, y][3] > 0 and not O[x, y]: st['lineBox'] += 1
print(json.dumps(st))`, f, `${OUT}/frame0.raw`, JSON.stringify(masks)]).toString());
const cutsFile = await exportZip('cuts');
ok(path.basename(cutsFile) === 'recorte_001.png', `Nome padrão segue o conteúdo: ${path.basename(cutsFile)}`);
const cuts = stats(cutsFile);
ok(cuts.size.join('×') === '320×240' && cuts.inEq > 10000 && cuts.inBad === 0, `"Só recortes": pixels do GIF dentro das máscaras (${cuts.inEq} px iguais, ${cuts.inBad} diferentes)`);
ok(cuts.outOpaque === 0 && cuts.lineBox === 0, 'PNG transparente fora das máscaras e sem as linhas');
const linesFile = await exportZip('lines');
ok(path.basename(linesFile) === 'linhas_001.png', `…e volta para ${path.basename(linesFile)} em "Só linhas"`);
const lines = stats(linesFile);
ok(lines.lineBox > 30 && lines.inEq < cuts.inEq / 4, `"Só linhas": linha presente (${lines.lineBox} px) e recortes ausentes`);
const both = stats(await exportZip('both'));
ok(both.lineBox > 30 && both.inEq > 10000 && both.inBad === 0, '"Linhas e recortes": as duas coisas no mesmo PNG');
const svgFile = await exportZip('cuts', 'svg');
const svg = fs.readFileSync(svgFile, 'utf8');
ok(/<image id="Recorte 1"[^>]*href="data:image\/png;base64,/.test(svg) && !svg.includes('<path'), 'SVG "só recortes": camada de recorte como <image> PNG embutido, sem traços');
// 2x: recorte gerado na resolução de saída
await page.keyboard.press('Control+e');
await page.fill('#exScale', '2'); await page.selectOption('#exContent', 'cuts');
const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#exGo')]);
await dl2.saveAs(`${OUT}/cuts2x.zip`);
execFileSync('python3', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', `${OUT}/cuts2x.zip`, `${OUT}/cuts2x`]);
const sz2 = execFileSync('python3', ['-c', 'import sys,os; from PIL import Image; d=sys.argv[1]; im=Image.open(os.path.join(d, os.listdir(d)[0])); print(im.size[0], im.size[1], im.mode)', `${OUT}/cuts2x`]).toString().trim();
ok(sz2 === '640 480 RGBA', `PNG 2x: ${sz2}`);
await page.evaluate(() => { document.getElementById('dlgExport').hidden = true; });

// ---------------------------------------------------------------- 11. ajuda e idioma
console.log('11) Ajuda e textos');
await page.keyboard.press('F1'); await sleep(150);
const help = await page.locator('#dlgHelp').innerText();
ok(help.includes('Ferramenta Recorte') && help.includes('Recorte (X)'), 'Ajuda lista o atalho X e o passo do Recorte');
ok(!/SAI/.test(help.split('Recorte (máscara)')[1] || ''), 'Seção nova sem menção ao SAI');
await key('Escape');
await page.evaluate(() => window.__app.i18n.setLang('en')); await sleep(150);
await page.evaluate(() => window.__app.setTool('cutout'));
ok((await page.locator('#pToolTitle').textContent()) === 'Cutout (mask)', 'Nome da ferramenta traduzido (en)');
await page.evaluate(() => window.__app.i18n.setLang('pt-BR'));

ok(errors.length === 0, 'Sem erros na página' + (errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''));
await browser.close();
server.close();
console.log(failures ? `\n${failures} FALHA(S)` : '\nRECORTE OK');
process.exit(failures ? 1 : 0);
