// Testes do Subtrair (Recorte): áreas vermelhas pendentes, Remover (alfa 0), várias áreas, repetir,
// desfazer/refazer, "mesmos quadros", borda suave, reeditar máscara preservando remoções, salvar/abrir e exportação.
// Uso: `node test/cutout-subtract.mjs` (requer `node build.mjs` antes).
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve('app');
const OUT = path.resolve('test-output/cutout-subtract');
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
const sub = () => page.evaluate(() => { const T = window.__app.TOOLS.cutout; return { mode: T.mode, shapes: T.subShapes.map((s) => s.map((p) => ({ ...p }))), cur: T.subCur.length, name: T.subName }; });
const holesPer = () => page.evaluate(() => window.__app.S.docs.map((d) => (d.layers.find((l) => l.name === 'Recorte 1' && l.cut)?.cut.holes || []).length));
const toasts = [];
await page.exposeFunction('__toast', (m) => toasts.push(m));
await page.evaluate(() => window.addEventListener('app-toast', (e) => window.__toast(e.detail.msg)));
const polyIn = (pts, x, y, r = 1.5) => page.evaluate(([pts, x, y, r]) => {
  const p = new Path2D(); pts.forEach((q, i) => (i ? p.lineTo(q.x, q.y) : p.moveTo(q.x, q.y))); p.closePath();
  const g = document.createElement('canvas').getContext('2d');
  return [[0, 0], [-r, 0], [r, 0], [0, -r], [0, r]].every(([dx, dy]) => g.isPointInPath(p, x + dx, y + dy));
}, [pts, x, y, r]);

// ---------------------------------------------------------------- 1. só para camada de recorte
console.log('1) Subtrair só existe para uma camada de recorte');
await page.locator('#canvas').focus();
await key('x');
ok(await page.locator('#cutSubtract').count() === 0, 'Sem camada de recorte: sem botão "Subtrair"');
await key('s');
ok((await sub()).mode === 'idle', 'Tecla S sem camada de recorte não faz nada');
await page.click('#toolOptions [data-cutmode="poly"]');
await page.selectOption('#cutScope', 'all');
for (const p of [[40, 40], [280, 40], [280, 200], [40, 200]]) await click(...p);
await key('Enter'); await key('Enter');
ok((await holesPer()).length === 10 && (await page.evaluate(() => window.__app.S.docs.every((d) => d.layers.some((l) => l.name === 'Recorte 1' && l.cut)))), '"Recorte 1" aplicado em todos os quadros');
await page.selectOption('#cutScope', 'current');
await page.evaluate(() => window.__app.goFrame(2)); await sleep(150);
await page.locator('#layerList li.cutlayer .name, #layerList li.cutlayer').first().click(); await sleep(150);
ok(await page.isVisible('#cutSubtract') && !(await page.locator('#cutSubtract').isDisabled()), 'Camada de recorte selecionada: botão "Subtrair" disponível');

// ---------------------------------------------------------------- 2. desenhar áreas vermelhas
console.log('2) Áreas vermelhas (iguais à Curva)');
await page.click('#cutSubtract');
let U = await sub();
ok(U.mode === 'sub' && U.name === 'Recorte 1', 'Modo Subtrair na camada "Recorte 1"');
ok(await page.isVisible('#cutRemove') && await page.locator('#cutRemove').isDisabled(), '"Remover" desativado sem áreas');
ok(!(await page.isVisible('#cutApply')), 'Painel do Subtrair não mistura com Aplicar recorte');
const A = [[80, 80], [130, 80], [130, 130], [80, 130]];
for (const p of A) await click(...p);
await click(80.5, 80.5); // 1º ponto fecha
U = await sub();
ok(U.shapes.length === 1 && U.shapes[0].length === 4 && U.cur === 0, 'Clique no 1º ponto fecha a área vermelha (fica pendente)');
for (const p of [[180, 90], [230, 90], [205, 150]]) await click(...p);
await key('Enter');
ok((await sub()).shapes.length === 2, 'Enter fecha a 2ª área (várias pendentes ao mesmo tempo)');
await click(240, 160); await click(270, 160);
ok((await sub()).cur === 2, 'Desenhando 3ª área: 2 pontos');
await click(270, 160, { button: 'right' });
ok((await sub()).cur === 1, 'Botão direito volta um ponto');
await key('Escape');
U = await sub();
ok(U.mode === 'sub' && U.cur === 0 && U.shapes.length === 2, 'Esc descarta só a área em desenho');
await click(240, 160); await click(270, 160); await click(255, 190);
{ const [sx, sy] = await at(255, 190); await page.mouse.dblclick(sx, sy); await sleep(150); }
ok((await sub()).shapes.length === 3, 'Duplo clique fecha a área');
await key('Delete');
ok((await sub()).shapes.length === 2, 'Delete apaga a área vermelha selecionada');
await drag([130, 130], [140, 140]);
U = await sub();
ok(Math.abs(U.shapes[0][2].x - 140) < 1.5 && Math.abs(U.shapes[0][2].y - 140) < 1.5, 'Pontos da área pendente podem ser arrastados');
await drag([140, 140], [130, 130]);
ok(!(await page.locator('#cutRemove').isDisabled()), '"Remover" disponível com áreas pendentes');
await page.screenshot({ path: `${OUT}/01_areas_vermelhas.png` });

// ---------------------------------------------------------------- 3. Remover
console.log('3) Remover');
await page.click('#cutRemove');
U = await sub();
let H = await holesPer();
ok(H[2] === 2 && H.filter((n, i) => i !== 2).every((n) => n === 0), `Remover grava 2 áreas só no quadro atual (${H.join('')})`);
ok(U.mode === 'sub' && U.shapes.length === 0, 'Áreas vermelhas limpas; continua no Subtrair para repetir');
ok(toasts.some((m) => m.includes('2 área(s) removida(s) em 1 quadro(s)')), 'Aviso de áreas removidas');
const alphaCheck = () => page.evaluate(() => {
  const a = window.__app, S = a.S, Lr = S.docs[S.cur].layers.find((l) => l.name === 'Recorte 1');
  const fr = S.frames[S.cur].canvas;
  const cd = a.cut.cutCanvas(Lr.cut, fr).getContext('2d').getImageData(0, 0, 320, 240).data;
  const fd = fr.getContext('2d').getImageData(0, 0, 320, 240).data;
  const g = document.createElement('canvas').getContext('2d');
  const path = (pts) => { const p = new Path2D(); pts.forEach((q, i) => (i ? p.lineTo(q.x, q.y) : p.moveTo(q.x, q.y))); p.closePath(); return p; };
  const holes = (Lr.cut.holes || []).map(path), main = path(Lr.cut.pts);
  const deep = (p, x, y) => [[0, 0], [-2, 0], [2, 0], [0, -2], [0, 2]].every(([dx, dy]) => g.isPointInPath(p, x + dx, y + dy));
  const near = (p, x, y) => [[0, 0], [-2, 0], [2, 0], [0, -2], [0, 2]].some(([dx, dy]) => g.isPointInPath(p, x + dx, y + dy));
  let inHole = 0, inHoleBad = 0, kept = 0, keptBad = 0, partial = 0;
  for (let y = 0; y < 240; y++) for (let x = 0; x < 320; x++) {
    const i = (y * 320 + x) * 4, cx = x + 0.5, cy = y + 0.5;
    if (holes.some((h) => deep(h, cx, cy))) { inHole++; if (cd[i + 3] !== 0) inHoleBad++; }
    else if (deep(main, cx, cy) && !holes.some((h) => near(h, cx, cy))) { kept++; if (Math.abs(cd[i + 3] - fd[i + 3]) > 1 || Math.abs(cd[i] - fd[i]) > 1) keptBad++; }
    else if (holes.some((h) => near(h, cx, cy)) && cd[i + 3] > 0 && cd[i + 3] < fd[i + 3]) partial++;
  }
  return { inHole, inHoleBad, kept, keptBad, partial };
});
let al = await alphaCheck();
ok(al.inHole > 3000 && al.inHoleBad === 0, `Áreas removidas: ${al.inHole} px com alfa 0`);
ok(al.kept > 30000 && al.keptBad === 0, `Resto do recorte intacto: ${al.kept} px iguais ao quadro`);
ok(al.partial > 10, `Borda das áreas removidas antisserrilhada (${al.partial} px parciais)`);

// ---------------------------------------------------------------- 4. repetir, desfazer
console.log('4) Repetir e desfazer');
for (const p of [[60, 60], [75, 60], [75, 75], [60, 75]]) await click(...p);
await key('Enter'); // fecha
await key('Enter'); // sem área em desenho: Remover
H = await holesPer();
ok(H[2] === 3, `Remover de novo acrescenta (${H[2]} áreas)`);
await key('Control+z');
ok((await holesPer())[2] === 2, 'Ctrl+Z desfaz só a última remoção');
await key('Control+y');
ok((await holesPer())[2] === 3, 'Ctrl+Y refaz');
await key('Control+z'); await key('Control+z');
ok((await holesPer())[2] === 0 && (await page.evaluate(() => window.__app.S.docs[2].layers.some((l) => l.name === 'Recorte 1' && l.cut))), 'Desfazer as duas remoções mantém o recorte original');
await key('Control+y'); await key('Control+y');
ok((await holesPer())[2] === 3, 'Refaz as duas');

// ---------------------------------------------------------------- 5. mesmos quadros
console.log('5) Mesmos quadros deste recorte');
await page.selectOption('#cutSubScope', 'layer');
for (const p of [[250, 50], [270, 50], [260, 70]]) await click(...p);
await page.click('#cutRemove'); // fecha e remove
H = await holesPer();
ok(H[2] === 4 && H.filter((n, i) => i !== 2).every((n) => n === 1), `Área aplicada em todos os quadros com "Recorte 1" (${H.join(',')})`);
await page.selectOption('#cutSubScope', 'current');
ok((await page.locator('#cutCancel').textContent()) === 'Concluir', 'Sem áreas pendentes, o botão vira "Concluir"');
await page.click('#cutCancel');
ok((await sub()).mode === 'idle', 'Concluir sai do Subtrair');

// ---------------------------------------------------------------- 6. reeditar a máscara mantém as remoções
console.log('6) Editar máscara mantém as áreas removidas');
await page.click('#cutEditMask');
await drag([200, 180], [205, 180]);
await key('Enter');
const L2 = (await layers(2)).list.find((l) => l.name === 'Recorte 1');
ok(L2.cut.holes?.length === 4 && Math.abs(L2.cut.pts[0].x - 45) < 1.5, `Máscara movida (x0 = ${L2.cut.pts[0].x.toFixed(1)}) e as 4 áreas removidas continuam`);
await page.evaluate(() => window.__app.goFrame(2));
al = await alphaCheck();
ok(al.inHoleBad === 0 && al.keptBad === 0, 'Alfa continua correto depois de reeditar');
const soft = await page.evaluate(() => {
  const a = window.__app, S = a.S, Lr = S.docs[S.cur].layers.find((l) => l.name === 'Recorte 1'), fr = S.frames[S.cur].canvas;
  const row = (m) => { const d = a.cut.renderCut(m, fr, 320, 240).getContext('2d').getImageData(70, 105, 70, 1).data; return Array.from({ length: 70 }, (_, k) => [d[k * 4 + 3], fr.getContext('2d').getImageData(70 + k, 105, 1, 1).data[3]]); };
  return { sharp: row(Lr.cut), soft: row({ ...Lr.cut, feather: 6 }) };
});
const ramp = (r) => r.filter(([v, f]) => f === 255 && v > 5 && v < 250).length;
ok(soft.soft[35][0] === 0 && ramp(soft.soft) > ramp(soft.sharp) && ramp(soft.soft) >= 4, `Borda suave vale também nas áreas removidas (centro 0, ${ramp(soft.soft)} px em degradê vs ${ramp(soft.sharp)})`);

// ---------------------------------------------------------------- 7. projeto
console.log('7) Salvar e abrir projeto');
const snap = () => page.evaluate(() => JSON.stringify(window.__app.S.docs.map((d) => d.layers.map((l) => ({ n: l.name, c: l.cut || null })))));
const before = await snap();
const bytes = await page.evaluate(() => Array.from(window.__app.serializeProject()));
fs.writeFileSync(`${OUT}/subtrair.giffact`, Buffer.from(bytes));
await page.reload(); await waitFor(() => !!window.__app);
await page.evaluate(() => window.addEventListener('app-toast', (e) => window.__toast(e.detail.msg)));
await loadFile(`${OUT}/subtrair.giffact`);
ok(before === await snap() && before.includes('"holes":'), 'Projeto reaberto com as áreas removidas');
const proj = JSON.parse(fs.readFileSync(`${OUT}/subtrair.giffact`, 'utf8'));
const pl = proj.frames[2].layers.find((l) => l.name === 'Recorte 1');
pl.cut.holes.push([{ x: 1, y: 1 }, { x: 2, y: 2 }], 'lixo');
const old = JSON.parse(JSON.stringify(proj)); for (const f of old.frames) for (const l of f.layers) if (l.cut) delete l.cut.holes;
fs.writeFileSync(`${OUT}/ruim.giffact`, JSON.stringify(proj));
fs.writeFileSync(`${OUT}/antigo.giffact`, JSON.stringify(old));
await loadFile(`${OUT}/ruim.giffact`);
ok(await page.evaluate(() => window.__app.S.docs[2].layers.find((l) => l.name === 'Recorte 1').cut.holes.length) === 4, 'Áreas inválidas no arquivo são descartadas (saneamento)');
await loadFile(`${OUT}/antigo.giffact`);
ok(await page.evaluate(() => window.__app.S.docs.every((d) => { const l = d.layers.find((l) => l.name === 'Recorte 1'); return l && l.cut && !l.cut.holes; })), 'Projeto sem áreas removidas (beta.1) abre normalmente');
await loadFile(`${OUT}/subtrair.giffact`);

// ---------------------------------------------------------------- 8. exportação
console.log('8) Exportação');
await page.evaluate(() => window.__app.goFrame(2));
await page.keyboard.press('Control+e');
await page.selectOption('#exFormat', 'png');
await page.selectOption('#exFrames', 'current');
await page.selectOption('#exSizeMode', 'scale');
await page.fill('#exScale', '1');
await page.selectOption('#exBg', 'transparent');
await page.selectOption('#exContent', 'cuts');
if (await page.isChecked('#exIncludeGif')) await page.uncheck('#exIncludeGif');
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exGo')]);
await dl.saveAs(`${OUT}/cuts.zip`);
execFileSync('python3', ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', `${OUT}/cuts.zip`, `${OUT}/cuts`]);
const png = path.join(`${OUT}/cuts`, fs.readdirSync(`${OUT}/cuts`)[0]);
const framePx = await page.evaluate(() => { const c = window.__app.S.frames[2].canvas; return [[105, 105], [205, 110], [67, 67], [260, 58], [160, 170], [100, 180]].map(([x, y]) => c.getContext('2d').getImageData(x, y, 1, 1).data[3]); });
const px = JSON.parse(execFileSync('python3', ['-c', `
import sys, json
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGBA')
print(json.dumps([im.getpixel(p)[3] for p in [(105,105),(205,110),(67,67),(260,58),(160,170),(100,180)]]))`, png]).toString());
ok(px.slice(0, 4).every((v) => v === 0), `PNG exportado: alfa 0 nas 4 áreas removidas (${px.slice(0, 4).join(',')})`);
ok(px[4] === framePx[4] && px[5] === framePx[5] && framePx[4] > 0, `PNG exportado: resto do recorte com os pixels do GIF (alfa ${px[4]}, ${px[5]})`);
await page.evaluate(() => { document.getElementById('dlgExport').hidden = true; });

// ---------------------------------------------------------------- 9. ajuda
console.log('9) Ajuda e textos');
await page.keyboard.press('F1'); await sleep(150);
const help = await page.locator('#dlgHelp').innerText();
ok(help.includes('Subtrair (S)') && help.includes('Subtrair do recorte selecionado') && help.includes('Remover as áreas vermelhas'), 'Ajuda: passo e atalhos do Subtrair');
ok(!/\bSAI\b/.test(help.split('Recorte (máscara)')[1] || ''), 'Sem menção ao SAI');
await key('Escape');
await page.evaluate(() => window.__app.i18n.setLang('en')); await sleep(150);
await page.evaluate(() => { window.__app.setTool('cutout'); const S = window.__app.S, d = S.docs[S.cur]; d.activeLayer = d.layers.findIndex((l) => l.cut); window.__app.setTool('select'); window.__app.setTool('cutout'); });
ok((await page.locator('#cutSubtract').textContent()) === 'Subtract', 'Botão traduzido (en)');
await page.evaluate(() => window.__app.i18n.setLang('pt-BR'));

ok(errors.length === 0, 'Sem erros na página' + (errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''));
await browser.close();
server.close();
console.log(failures ? `\n${failures} FALHA(S)` : '\nSUBTRAIR OK');
process.exit(failures ? 1 : 0);
