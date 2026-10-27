// Teste ponta a ponta da versão web (Chrome headless via playwright-core)
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve('app');
const OUT = path.resolve('test-output');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  const ext = path.extname(p);
  res.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' }[ext] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✔ ' : '  ✘ ') + msg); if (!cond) failures++; };

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 960 }, acceptDownloads: true, deviceScaleFactor: 1, locale: 'pt-BR' });
const page = await ctx.newPage();
// waitForFunction usa eval em polling (bloqueado pela CSP); faz polling com evaluate
const waitFor = async (fn, timeout = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { try { if (await page.evaluate(fn)) return; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('timeout esperando condição');
};
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://localhost:${PORT}/index.html`);
await waitFor(() => !!window.__app);
await page.screenshot({ path: `${OUT}/00_boas_vindas.png` });

const loadFile = async (file) => {
  const b64 = fs.readFileSync(file).toString('base64');
  await page.evaluate(async ([name, b64]) => {
    const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    await window.__app.loadAny(name, u);
  }, [path.basename(file), b64]);
};

// ---------- 1. decodificação vs Pillow ----------
console.log('1) Decodificação de GIF (comparação com Pillow)');
// GIFs do repositório + GIFs extras opcionais (pasta definida em GIF_SAMPLES, usados só se existirem)
const EXTRA = process.env.GIF_SAMPLES || '../gif-sample';
const gifs = ['samples/parcial_disposal1.gif', 'samples/transparente_disposal2.gif',
  ...['transparente.gif', 'teste_quadros.gif', 'amostra_009_600x337.gif'].map((f) => path.join(EXTRA, f)).filter((f) => fs.existsSync(f))];
const ref = JSON.parse(execFileSync('python3', ['test/ref_frames.py', ...gifs], { maxBuffer: 1 << 26 }).toString());
for (const g of gifs) {
  await loadFile(g);
  const r = ref[g];
  const res = await page.evaluate((frames) => {
    const S = window.__app.S;
    let maxDiff = 0, sum = 0, n = 0;
    frames.forEach((px, fi) => {
      const c = S.frames[fi].canvas.getContext('2d');
      const d = c.getImageData(0, 0, S.docW, S.docH).data;
      for (const [x, y, R, G, B, A] of px) {
        const i = (y * S.docW + x) * 4;
        // compara cor só onde opaco; alfa sempre
        let diff = Math.abs(d[i + 3] - A);
        if (A > 0 && d[i + 3] > 0) diff = Math.max(diff, Math.abs(d[i] - R), Math.abs(d[i + 1] - G), Math.abs(d[i + 2] - B));
        maxDiff = Math.max(maxDiff, diff); sum += diff; n++;
      }
    });
    return { n: S.frames.length, w: S.docW, h: S.docH, maxDiff, mean: sum / n, delays: S.frames.map((f) => f.delay) };
  }, r.frames);
  const expDel = r.durs.map((d) => (d >= 20 ? d : 100));
  ok(JSON.stringify(res.delays) === JSON.stringify(expDel), `${path.basename(g)}: tempos dos quadros iguais ao arquivo (${[...new Set(res.delays)].join('/')} ms)`);
  ok(res.n === r.n && res.w === r.size[0] && res.h === r.size[1], `${path.basename(g)}: ${res.n} quadros ${res.w}×${res.h} (Pillow: ${r.n} ${r.size.join('×')})`);
  ok(res.mean < 1.5 && res.maxDiff <= 8, `${path.basename(g)}: pixels batem com Pillow (dif. média ${res.mean.toFixed(3)}, máx ${res.maxDiff})`);
}

// ---------- 2. desenho com o mouse ----------
console.log('2) Ferramentas de desenho');
await loadFile('samples/parcial_disposal1.gif');
await page.waitForTimeout(200);
const box = await page.locator('#canvas').boundingBox();
const toScreen = (x, y) => page.evaluate(([x, y]) => {
  const S = window.__app.S;
  const v = S.view;
  const W = document.getElementById('canvas').clientWidth, H = document.getElementById('canvas').clientHeight;
  const m = new DOMMatrix().translate(W / 2 + v.panX, H / 2 + v.panY).rotate(v.rot).scale(v.zoom).translate(-S.docW / 2, -S.docH / 2);
  const p = m.transformPoint(new DOMPoint(x, y));
  return [p.x, p.y];
}, [x, y]);
const at = async (x, y) => { const [sx, sy] = await toScreen(x, y); return [box.x + sx, box.y + sy]; };
const strokes = () => page.evaluate(() => { const S = window.__app.S; return S.docs[S.cur].layers[S.docs[S.cur].activeLayer].strokes; });
const key = (k) => page.keyboard.press(k);

// Curva: 4 cliques + Enter
await key('c');
for (const [x, y] of [[40, 60], [90, 30], [140, 70], [190, 40]]) { const [sx, sy] = await at(x, y); await page.mouse.click(sx, sy); await page.waitForTimeout(60); }
await key('Enter');
let st = await strokes();
ok(st.length === 1 && st[0].kind === 'curve' && st[0].pts.length === 4, `Curva criada com 4 pontos (${st.length} traço, ${st[0]?.pts.length} pts)`);

// Curva terminada com duplo clique
for (const [x, y] of [[40, 200], [100, 160]]) { const [sx, sy] = await at(x, y); await page.mouse.click(sx, sy); await page.waitForTimeout(250); }
{ const [sx, sy] = await at(160, 210); await page.mouse.dblclick(sx, sy); }
st = await strokes();
ok(st.length === 2 && st[1].pts.length === 3, `Curva por duplo clique com 3 pontos (tem ${st[1]?.pts.length})`);

// Curva fechada clicando no primeiro ponto
for (const [x, y] of [[230, 150], [280, 150], [280, 200], [230, 200], [230, 150]]) { const [sx, sy] = await at(x, y); await page.mouse.click(sx, sy); await page.waitForTimeout(250); }
st = await strokes();
ok(st.length === 3 && st[2].closed === true && st[2].pts.length === 4, `Curva fechada ao clicar no 1º ponto (closed=${st[2]?.closed})`);

// Esc cancela
for (const [x, y] of [[20, 20], [60, 20]]) { const [sx, sy] = await at(x, y); await page.mouse.click(sx, sy); await page.waitForTimeout(250); }
await key('Escape');
ok((await strokes()).length === 3, 'Esc cancela a curva em andamento');

// Linha reta (polilinha)
await key('l');
for (const [x, y] of [[20, 110], [70, 110], [70, 150]]) { const [sx, sy] = await at(x, y); await page.mouse.click(sx, sy); await page.waitForTimeout(250); }
await key('Enter');
st = await strokes();
ok(st.length === 4 && st[3].kind === 'line' && st[3].pts.length === 3, 'Linha reta com 3 pontos');

// Caneta à mão livre com estabilizador
await key('b');
{
  const pts = [];
  for (let i = 0; i <= 60; i++) pts.push([100 + i * 2, 120 + Math.sin(i / 8) * 25 + (i % 3) * 0.8]);
  const [sx, sy] = await at(...pts[0]);
  await page.mouse.move(sx, sy); await page.mouse.down();
  for (const p of pts.slice(1)) { const [x, y] = await at(...p); await page.mouse.move(x, y, { steps: 2 }); }
  await page.mouse.up();
}
st = await strokes();
ok(st.length === 5 && st[4].kind === 'curve' && st[4].pts.length >= 3 && st[4].pts.length < 60, `Caneta: traço convertido em curva editável com ${st[4]?.pts.length} pontos`);
await page.screenshot({ path: `${OUT}/01_desenho.png` });

// ---------- 3. edição ----------
console.log('3) Edição');
await key('n');
{
  const p0 = st[0].pts[1];
  const [sx, sy] = await at(p0.x, p0.y);
  await page.mouse.move(sx, sy); await page.mouse.down();
  const [ex, ey] = await at(p0.x + 10, p0.y + 20);
  await page.mouse.move(ex, ey, { steps: 5 }); await page.mouse.up();
  const s2 = (await strokes()).find((s) => s.id === st[0].id);
  ok(s2 && Math.abs(s2.pts[1].x - (p0.x + 10)) < 0.6 && Math.abs(s2.pts[1].y - (p0.y + 20)) < 0.6, 'Editar: arrastar ponto de controle');
}
{
  // Ctrl+arrastar move o traço inteiro (usa a linha reta)
  const s = (await strokes())[3];
  const [sx, sy] = await at((s.pts[0].x + s.pts[1].x) / 2, s.pts[0].y);
  await page.keyboard.down('Control');
  await page.mouse.move(sx, sy); await page.mouse.down();
  const [ex, ey] = await at((s.pts[0].x + s.pts[1].x) / 2 + 5, s.pts[0].y + 7);
  await page.mouse.move(ex, ey, { steps: 4 }); await page.mouse.up();
  await page.keyboard.up('Control');
  const s2 = (await strokes()).find((q) => q.id === s.id);
  ok(s2 && Math.abs(s2.pts[2].x - s.pts[2].x - 5) < 0.6 && Math.abs(s2.pts[2].y - s.pts[2].y - 7) < 0.6, 'Editar: Ctrl+arrastar move o traço inteiro');
}
{
  // arrastar no meio da linha insere ponto
  const s = (await strokes())[3];
  const [sx, sy] = await at(s.pts[1].x, (s.pts[1].y + s.pts[2].y) / 2);
  await page.mouse.move(sx, sy); await page.mouse.down();
  const [ex, ey] = await at(s.pts[1].x + 12, (s.pts[1].y + s.pts[2].y) / 2);
  await page.mouse.move(ex, ey, { steps: 4 }); await page.mouse.up();
  const s2 = (await strokes()).find((q) => q.id === s.id);
  ok(s2 && s2.pts.length === 4, `Editar: arrastar na linha insere ponto (${s2?.pts.length} pts)`);
  // Alt+clique apaga ponto
  const q = s2.pts[2];
  const [ax, ay] = await at(q.x, q.y);
  await page.keyboard.down('Alt'); await page.mouse.click(ax, ay); await page.keyboard.up('Alt');
  const s3 = (await strokes()).find((z) => z.id === s.id);
  ok(s3 && s3.pts.length === 3, 'Editar: Alt+clique apaga ponto');
}
// Espessura
await key('w');
{
  const s = (await strokes())[0];
  const sm = s.pts[2];
  const before = s.width;
  const L = await page.evaluate(() => 0);
  void L;
  // clica num ponto do traço (pontos de controle ficam sobre a curva)
  const [sx, sy] = await at(sm.x, sm.y);
  await page.mouse.move(sx, sy); await page.mouse.down();
  await page.mouse.move(sx + 80, sy, { steps: 6 }); await page.mouse.up();
  const s2 = (await strokes()).find((q) => q.id === s.id);
  ok(s2 && s2.width > before * 1.5, `Espessura: arrastar engrossa (${before} → ${s2?.width})`);
}
// Pressão
await key('u');
{
  const s = (await strokes())[0];
  const q = s.pts[0];
  const [sx, sy] = await at(q.x, q.y);
  await page.mouse.move(sx, sy); await page.mouse.down();
  await page.mouse.move(sx, sy + 60, { steps: 6 }); await page.mouse.up();
  const s2 = (await strokes()).find((z) => z.id === s.id);
  ok(s2 && s2.pts[0].p < 0.5, `Pressão: arrastar para baixo afina o ponto (p=${s2?.pts[0].p.toFixed(2)})`);
}
// Cor
await page.evaluate(() => { window.__app.S.settings.color = '#e53935'; });
await key('k');
{
  const s = (await strokes())[3];
  const [sx, sy] = await at(s.pts[0].x + 3, s.pts[0].y);
  await page.mouse.click(sx, sy);
  const s2 = (await strokes()).find((z) => z.id === s.id);
  ok(s2 && s2.color === '#e53935', 'Cor: clique recolore o traço');
}
await page.evaluate(() => { window.__app.S.settings.color = '#111111'; });

// ---------- 4. borracha ----------
console.log('4) Borracha vetorial');
await key('e');
{
  // modo interseção: cria duas linhas que se cruzam e uma terceira cruzando
  await key('l');
  for (const [x, y] of [[20, 20], [300, 20]]) { const [sx, sy] = await at(x, y); await page.mouse.click(sx, sy); await page.waitForTimeout(250); }
  await key('Enter');
  for (const [x, y] of [[100, 5], [100, 40]]) { const [sx, sy] = await at(x, y); await page.mouse.click(sx, sy); await page.waitForTimeout(250); }
  await key('Enter');
  for (const [x, y] of [[200, 5], [200, 40]]) { const [sx, sy] = await at(x, y); await page.mouse.click(sx, sy); await page.waitForTimeout(250); }
  await key('Enter');
  const n0 = (await strokes()).length;
  await page.evaluate(() => { window.__app.S.settings.eraserMode = 'intersect'; });
  await key('e');
  const [sx, sy] = await at(150, 20); // meio do trecho entre x=100 e x=200
  await page.mouse.move(sx, sy); await page.mouse.click(sx, sy);
  const after = await strokes();
  const horiz = after.filter((s) => s.kind === 'line' && s.pts.every((p) => Math.abs(p.y - 20) < 0.5));
  const xs = horiz.map((s) => [Math.min(...s.pts.map((p) => p.x)), Math.max(...s.pts.map((p) => p.x))]).sort((a, b) => a[0] - b[0]);
  ok(after.length === n0 + 1 && horiz.length === 2 && Math.abs(xs[0][1] - 100) < 1.5 && Math.abs(xs[1][0] - 200) < 1.5,
    `Borracha até interseção: cortou entre x=100 e x=200 → ${JSON.stringify(xs.map((r) => r.map((v) => +v.toFixed(1))))}`);
  // modo traço inteiro
  await page.evaluate(() => { window.__app.S.settings.eraserMode = 'stroke'; });
  const [vx, vy] = await at(100, 35);
  await page.mouse.click(vx, vy);
  ok((await strokes()).length === after.length - 1, 'Borracha traço inteiro: apagou o traço tocado');
  // modo área: passa no meio da linha horizontal esquerda
  await page.evaluate(() => { window.__app.S.settings.eraserMode = 'area'; window.__app.S.settings.eraserSize = 10; });
  const n1 = (await strokes()).length;
  const [ax, ay] = await at(60, 12), [bx, by] = await at(60, 28);
  await page.mouse.move(ax, ay); await page.mouse.down(); await page.mouse.move(bx, by, { steps: 5 }); await page.mouse.up();
  ok((await strokes()).length === n1 + 1, `Borracha de área: dividiu o traço em dois (${n1} → ${(await strokes()).length})`);
}

// ---------- 5. seleção / transformação / desfazer ----------
console.log('5) Seleção, transformação, desfazer/refazer');
await key('v');
{
  const before = await strokes();
  const target = before[0];
  const [sx, sy] = await at(target.pts[2].x, target.pts[2].y);
  await page.mouse.move(sx, sy); await page.mouse.down();
  await page.mouse.move(sx + 30, sy + 15, { steps: 5 }); await page.mouse.up();
  const moved = (await strokes()).find((s) => s.id === target.id);
  const z = await page.evaluate(() => window.__app.S.view.zoom);
  ok(moved && Math.abs(moved.pts[0].x - target.pts[0].x - 30 / z) < 0.7, 'Seleção: arrastar move o traço selecionado');
  await page.keyboard.press('Control+z');
  const und = (await strokes()).find((s) => s.id === target.id);
  ok(und && Math.abs(und.pts[0].x - target.pts[0].x) < 0.01, 'Ctrl+Z desfaz');
  await page.keyboard.press('Control+y');
  const red = (await strokes()).find((s) => s.id === target.id);
  ok(red && Math.abs(red.pts[0].x - moved.pts[0].x) < 0.01, 'Ctrl+Y refaz');
  // seleção em caixa + escala pela alça
  await page.keyboard.press('Control+a');
  const nsel = await page.evaluate(() => window.__app.S.selection.size);
  ok(nsel === (await strokes()).length, `Ctrl+A seleciona todos (${nsel})`);
  await page.keyboard.press('Control+c');
}
await page.screenshot({ path: `${OUT}/02_selecao.png` });

// ---------- 6. quadros, camadas, onion ----------
console.log('6) Quadros, camadas e papel de seda');
await key('ArrowRight');
ok(await page.evaluate(() => window.__app.S.cur) === 1, 'Seta → vai para o quadro 2');
ok((await strokes()).length === 0, 'Quadro 2 tem seu próprio plano (vazio)');
await page.keyboard.press('Alt+ArrowLeft');
const copied = (await strokes()).length;
ok(copied > 0, `Alt+← copiou ${copied} traço(s) do quadro anterior`);
await page.click('#lyAdd');
ok(await page.evaluate(() => window.__app.S.docs[1].layers.length) === 2, 'Nova camada no quadro 2');
ok(await page.evaluate(() => window.__app.S.docs[0].layers.length) === 1, 'Quadro 1 continua com 1 camada (camadas por quadro)');
await key('c');
for (const [x, y] of [[50, 100], [120, 60], [200, 100]]) { const [sx, sy] = await at(x, y); await page.mouse.click(sx, sy); await page.waitForTimeout(250); }
await key('Enter');
await key('o');
await key('d');
ok(await page.evaluate(() => window.__app.S.cur) === 2 && await page.evaluate(() => window.__app.S.settings.onion), 'Tecla D avança; O liga o papel de seda');
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/03_onion.png` });
// colar em intervalo (Ctrl+V cola a seleção copiada antes)
await page.keyboard.press('Control+v');
ok((await strokes()).length > 0, 'Ctrl+V cola os traços copiados');
await key('a'); await key('a');
ok(await page.evaluate(() => window.__app.S.cur) === 0, 'Tecla A volta quadros');

// ---------- 7. auto-traçar ----------
console.log('7) Auto-traçar');
await page.click('#btnTrace');
await page.click('#trGo');
await waitFor(() => document.getElementById('dlgTrace').hidden);
const traced = await page.evaluate(() => window.__app.S.docs[0].layers.find((l) => l.name === 'Rascunho automático')?.strokes.length || 0);
ok(traced > 3, `Auto-traçado criou ${traced} traços`);
await page.screenshot({ path: `${OUT}/04_autotrace.png` });
await page.keyboard.press('Control+z');
ok(await page.evaluate(() => (window.__app.S.docs[0].layers.find((l) => l.name === 'Rascunho automático')?.strokes.length || 0)) === 0, 'Desfazer remove o auto-traçado');

// ---------- 8. exportar PNG 2x ----------
console.log('8) Exportação');
await page.keyboard.press('Control+e');
await page.selectOption('#exFormat', 'png');
await page.selectOption('#exFrames', 'all');
await page.selectOption('#exSizeMode', 'scale');
await page.fill('#exScale', '2');
await page.selectOption('#exBg', 'transparent');
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exGo')]);
const zipPath = `${OUT}/${dl.suggestedFilename()}`;
await dl.saveAs(zipPath);
const pngDir = `${OUT}/png2x`;
fs.mkdirSync(pngDir, { recursive: true });
execFileSync('python3', ['-c', `import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])`, zipPath, pngDir]);
const files = fs.readdirSync(pngDir).sort();
ok(files.length === 10 && files[0] === 'linhas_001.png' && files[9] === 'linhas_010.png', `ZIP com 10 PNGs numerados (${files[0]} … ${files[files.length - 1]})`);
const info = JSON.parse(execFileSync('python3', ['-c', `
import sys, json
from PIL import Image
out=[]
for f in sys.argv[1:]:
    im=Image.open(f).convert('RGBA')
    a=im.getchannel('A')
    hist=a.histogram()
    opaque=sum(hist[1:])
    out.append({'f':f.split('/')[-1],'size':im.size,'opaque':opaque,'corner':im.getpixel((0,0))[3]})
print(json.dumps(out))`, ...files.map((f) => `${pngDir}/${f}`)]).toString());
ok(info.every((i) => i.size[0] === 640 && i.size[1] === 480), `PNGs em 2x: ${info[0].size.join('×')} (GIF 320×240)`);
ok(info[0].opaque > 2000 && info[0].corner === 0, `Quadro 1 tem linhas (${info[0].opaque} px) e fundo transparente`);
ok(info[1].opaque > 1000 && info[3].opaque === 0, 'Quadro 2 tem linhas; quadro 4 (sem desenho) vazio e transparente');

// tamanho explícito + fundo branco + só quadro atual + SVG
await page.keyboard.press('Control+e');
await page.selectOption('#exSizeMode', 'size');
await page.fill('#exW', '1000');
await page.dispatchEvent('#exW', 'input');
const hVal = await page.inputValue('#exH');
ok(hVal === '750', `Proporção mantida: 1000 × ${hVal}`);
await page.selectOption('#exFrames', 'current');
await page.selectOption('#exBg', 'white');
const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#exGo')]);
const zip2 = `${OUT}/explicit.zip`; await dl2.saveAs(zip2);
const d2 = `${OUT}/explicit`; fs.mkdirSync(d2, { recursive: true });
execFileSync('python3', ['-c', `import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])`, zip2, d2]);
const sz = JSON.parse(execFileSync('python3', ['-c', `import sys,json; from PIL import Image; im=Image.open(sys.argv[1]).convert('RGBA'); print(json.dumps([im.size, im.getpixel((0,0))]))`, `${d2}/linhas_001.png`]).toString());
ok(sz[0][0] === 1000 && sz[0][1] === 750 && sz[1][3] === 255 && sz[1][0] === 255, `Tamanho explícito 1000×750 com fundo branco (${JSON.stringify(sz)})`);

await page.keyboard.press('Control+Shift+e');
await page.selectOption('#exFrames', 'current');
await page.selectOption('#exSizeMode', 'scale');
const [dl3] = await Promise.all([page.waitForEvent('download'), page.click('#exGo')]);
const zip3 = `${OUT}/svg.zip`; await dl3.saveAs(zip3);
const d3 = `${OUT}/svg`; fs.mkdirSync(d3, { recursive: true });
execFileSync('python3', ['-c', `import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])`, zip3, d3]);
const svg = fs.readFileSync(`${d3}/linhas_001.svg`, 'utf8');
ok(svg.includes('<svg') && (svg.match(/<path /g) || []).length >= 5 && svg.includes('viewBox="0 0 320 240"'), `SVG exportado com ${(svg.match(/<path /g) || []).length} paths`);
// renderiza o SVG no navegador para garantir que é válido
const svgOk = await page.evaluate(async (txt) => {
  const img = new Image();
  img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(txt)));
  try { await img.decode(); return img.naturalWidth; } catch { return 0; }
}, svg);
ok(svgOk > 0, `SVG válido (renderiza com largura ${svgOk})`);

// ---------- 9. salvar / abrir projeto ----------
console.log('9) Projeto');
const before = await page.evaluate(() => window.__app.S.docs.map((d) => d.layers.map((l) => l.strokes.length)));
const [dl4] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
const projPath = `${OUT}/${dl4.suggestedFilename()}`; await dl4.saveAs(projPath);
ok(projPath.endsWith('.giffact'), `Projeto salvo como ${path.basename(projPath)} (${(fs.statSync(projPath).size / 1024).toFixed(0)} KB)`);
await page.reload();
await waitFor(() => !!window.__app);
await loadFile(projPath);
const after = await page.evaluate(() => window.__app.S.docs.map((d) => d.layers.map((l) => l.strokes.length)));
ok(JSON.stringify(before) === JSON.stringify(after), 'Projeto reaberto com as mesmas camadas/traços por quadro');
ok(await page.evaluate(() => window.__app.S.frames.length) === 10, 'GIF embutido no projeto decodificado de novo');

// ---------- 10. prévia + capturas ----------
console.log('10) Prévia e capturas de tela');
await page.evaluate(() => window.__app.goFrame(0));
await key('p');
await page.waitForTimeout(700);
ok(!(await page.locator('#dlgPreview').isHidden()), 'Prévia animada abre com P');
await page.screenshot({ path: `${OUT}/05_previa.png` });
await key('Escape');
await page.keyboard.press('F1');
await page.waitForTimeout(150);
await page.screenshot({ path: `${OUT}/06_atalhos.png` });
await key('Escape');

// GIF de exemplo estilo anime + desenho para captura bonita
await page.evaluate(async () => { const a = window.__app; await a.loadAny('exemplo_anime.gif', a.makeDemoGif()); });
ok(await page.evaluate(() => window.__app.S.frames.length) === 12, 'GIF de exemplo gerado (12 quadros)');


// ---------- 11. mesa digitalizadora (pressão via Pointer Events) ----------
console.log('11) Pressão da caneta (pointerType=pen)');
await page.evaluate(() => window.__app.setTool('pen'));
const penRes = await page.evaluate(async () => {
  const a = window.__app, S = a.S;
  const cv = document.getElementById('canvas');
  const r = cv.getBoundingClientRect();
  const before = S.docs[S.cur].layers[S.docs[S.cur].activeLayer].strokes.length;
  const fire = (type, i, pr) => cv.dispatchEvent(new PointerEvent(type, {
    pointerId: 7, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true,
    clientX: r.left + 200 + i * 6, clientY: r.top + 300 + Math.sin(i / 6) * 30,
    pressure: pr, buttons: type === 'pointerup' ? 0 : 1, button: type === 'pointermove' ? -1 : 0,
  }));
  fire('pointerdown', 0, 0.1);
  for (let i = 1; i <= 60; i++) { fire('pointermove', i, i < 30 ? 0.1 + i * 0.03 : 1 - (i - 30) * 0.03); await new Promise((r) => setTimeout(r, 4)); }
  fire('pointerup', 60, 0);
  const L = S.docs[S.cur].layers[S.docs[S.cur].activeLayer].strokes;
  const s = L[L.length - 1];
  return { added: L.length - before, ps: s ? s.pts.map((q) => q.p) : [] };
});
const pmin = Math.min(...penRes.ps), pmax = Math.max(...penRes.ps);
ok(penRes.added === 1 && pmax - pmin > 0.35, `Traço com pressão variável: p de ${pmin.toFixed(2)} a ${pmax.toFixed(2)} em ${penRes.ps.length} pontos`);

// ---------- 12. captura de vitrine com o GIF de exemplo ----------
await page.evaluate(() => { const a = window.__app; a.S.settings.onion = true; a.S.settings.bgOpacity = 0.55; a.goFrame(2); });
await page.click('#btnTrace');
await page.click('#trGo');
await waitFor(() => document.getElementById('dlgTrace').hidden);
await page.evaluate(() => window.__app.setTool('edit'));
await page.waitForTimeout(3500);
await page.evaluate(() => { document.getElementById('toasts').innerHTML = ''; });
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/07_exemplo_anime.png` });

ok(errors.length === 0, 'Sem erros no console' + (errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''));
await browser.close();
server.close();
console.log(failures ? `\n${failures} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
process.exit(failures ? 1 : 0);
