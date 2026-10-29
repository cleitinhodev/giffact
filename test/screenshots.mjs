// Gera as capturas de tela do README (docs/screenshots).
// Uso: `node build.mjs && node test/screenshots.mjs [projeto.giffact | animacao.gif]`
//   - com um projeto .giffact: usa as linhas já traçadas nele (as capturas do README usam um projeto assim);
//   - com um GIF: roda o auto-traçar no quadro atual;
//   - sem argumento: usa o GIF de demonstração embutido.
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('docs/screenshots');
fs.mkdirSync(OUT, { recursive: true });
const SRC = process.argv[2] ? path.resolve(process.argv[2]) : '';
const ONLY = process.argv.slice(3);
const ROOT = path.resolve('app');
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const p = path.join(ROOT, u === '/' ? 'index.html' : u);
  if (!p.startsWith(ROOT) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' }[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const url = `http://localhost:${server.address().port}/index.html`;
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIEW = { width: 1440, height: 900 };
const LAYER_NAMES = { 'ja-JP': ['輪郭', '髪の線'], 'pt-BR': ['Contorno', 'Mechas do cabelo'] };

async function poll(page, fn, arg, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (await page.evaluate(fn, arg).catch(() => false)) return true; await sleep(50); }
  throw new Error('timeout');
}
/** doc → coordenadas de tela da página (sem rotação) */
async function toScreen(page, x, y) {
  const box = await page.locator('#canvas').boundingBox();
  const v = await page.evaluate(() => ({ ...window.__app.S.view, w: window.__app.S.docW, h: window.__app.S.docH }));
  return [box.x + box.width / 2 + v.panX + (x - v.w / 2) * v.zoom, box.y + box.height / 2 + v.panY + (y - v.h / 2) * v.zoom];
}
async function frameView(page, { zoom, cx, cy } = {}) {
  await page.evaluate(([zoom, cx, cy]) => {
    const a = window.__app; a.fitView();
    const z = zoom || a.S.view.zoom * 0.97;
    a.S.view.zoom = z;
    if (cx != null) { a.S.view.panX = (a.S.docW / 2 - cx) * z; a.S.view.panY = (a.S.docH / 2 - cy) * z; }
    a.setZoom(z);
  }, [zoom, cx, cy]);
  await sleep(150);
}

async function open(page, layerNames) {
  await page.goto(url);
  await poll(page, () => !!window.__app);
  if (SRC) {
    let bytes = fs.readFileSync(SRC);
    if (layerNames && SRC.endsWith('.giffact')) { // nomes das camadas no idioma da captura
      const obj = JSON.parse(bytes.toString('utf8'));
      for (const d of obj.frames) d.layers.forEach((l, i) => { if (layerNames[i]) l.name = layerNames[i]; });
      bytes = Buffer.from(JSON.stringify(obj));
    }
    const b64 = bytes.toString('base64');
    await page.evaluate(async ([name, b]) => { const bin = Uint8Array.from(atob(b), (c) => c.charCodeAt(0)); await window.__app.loadAny(name, bin); }, [path.basename(SRC), b64]);
  } else {
    await page.click('#wDemo');
  }
  await poll(page, () => window.__app.S.loaded && window.__app.S.frames.length > 1);
  const hasLines = await page.evaluate(() => window.__app.S.docs.some((d) => d.layers.some((l) => l.strokes.length)));
  if (!hasLines) {
    await page.click('#btnTrace'); await sleep(150);
    await page.click('#trGo');
    await poll(page, () => document.getElementById('dlgTrace').hidden, null, 30000);
  }
  await page.evaluate(() => { window.__app.S.settings.bgOpacity = 0.6; });
  await frameView(page);
}

/** Retira o traço mais longo da 2ª camada do quadro atual e o redesenha com cliques reais da ferramenta Curva,
 *  deixando os últimos pontos em andamento (mostra um traço sendo feito). */
async function strokeInProgress(page, keepLast = 3) {
  const pts = await page.evaluate(() => {
    const a = window.__app, d = a.S.docs[a.S.cur];
    const L = d.layers[d.layers.length > 1 ? 1 : 0];
    if (!L.strokes.length) return null;
    const len = (s) => s.pts.reduce((t, p, i) => (i ? t + Math.hypot(p.x - s.pts[i - 1].x, p.y - s.pts[i - 1].y) : 0), 0);
    const best = L.strokes.reduce((b, s) => (len(s) > len(b) ? s : b));
    L.strokes = L.strokes.filter((s) => s !== best);
    d.activeLayer = d.layers.indexOf(L);
    a.goFrame(a.S.cur);
    return best.pts.filter((_, i) => i % 2 === 0 || i === best.pts.length - 1).map((p) => [p.x, p.y]);
  });
  if (!pts) return;
  await page.evaluate(() => window.__app.setTool('curve'));
  const upto = Math.max(2, pts.length - keepLast);
  for (let i = 0; i < upto; i++) { const [x, y] = await toScreen(page, ...pts[i]); await page.mouse.click(x, y); await sleep(i ? 90 : 120); await sleep(520); }
  const [x, y] = await toScreen(page, ...pts[upto]);
  await page.mouse.move(x, y, { steps: 4 });
  await sleep(120);
}

async function shot({ name, locale = 'en-US', scheme = 'dark', setup, clip }) {
  if (ONLY.length && !ONLY.includes(name)) return;
  const ctx = await browser.newContext({ viewport: VIEW, locale, colorScheme: scheme, deviceScaleFactor: 1, acceptDownloads: true });
  const page = await ctx.newPage();
  await open(page, LAYER_NAMES[locale]);
  if (setup) await setup(page);
  // faixas neon pausadas numa posição bonita
  await page.evaluate(() => {
    // posição (fração da duração, depois do atraso) de cada faixa: espalhadas pelas bordas, todas visíveis
    const at = { 'topbar::after': 0.42, 'timeline::before': 0.3, 'main::before': 0.33, 'main::after': 0.5 };
    document.getAnimations().forEach((a) => {
      if (!a.animationName?.startsWith('streak')) return;
      const tm = a.effect.getTiming(), key = (a.effect.target?.id || 'box') + (a.effect.pseudoElement || '');
      a.pause(); a.currentTime = (tm.delay || 0) + (tm.duration || 0) * (at[key] ?? 0.45);
    });
  });
  await page.evaluate(() => document.getElementById('toasts')?.replaceChildren());
  await sleep(150);
  await page.screenshot({ path: path.join(OUT, name), clip });
  console.log('  ✔ ' + name);
  await ctx.close();
}

await shot({ name: 'dark-neon.png', setup: (p) => strokeInProgress(p) });
await shot({ name: 'light.png', scheme: 'light', setup: (p) => strokeInProgress(p) });
await shot({
  name: 'onion-skin.png', setup: async (p) => {
    await p.evaluate(() => { const s = window.__app.S.settings; s.onion = true; s.onionPrev = 1; s.onionNext = 1; s.onionOpacity = 0.55; s.bgVisible = false; window.__app.goFrame(window.__app.S.cur); });
    await p.evaluate(() => window.__app.setTool('pen'));
    await frameView(p, { zoom: 1.8, cx: 215, cy: 215 });
  },
});
await shot({
  name: 'edit-points.png', setup: async (p) => {
    await p.evaluate(() => { const a = window.__app, d = a.S.docs[a.S.cur]; d.activeLayer = 0; a.S.settings.bgOpacity = 0.45; a.goFrame(a.S.cur); a.setTool('edit'); });
    await frameView(p, { zoom: 3.4, cx: 300, cy: 150 });
    // passa o mouse sobre o contorno do rosto para destacar o polígono de controle
    const target = await p.evaluate(() => {
      const a = window.__app, L = a.S.docs[a.S.cur].layers[0];
      let best = null, bd = 1e9;
      for (const s of L.strokes) for (const q of s.pts) { const d = Math.hypot(q.x - 347, q.y - 140); if (d < bd) { bd = d; best = q; } }
      return best && [best.x, best.y];
    });
    if (target) { const [x, y] = await toScreen(p, target[0] + 0.3, target[1] + 6); await p.mouse.move(x, y, { steps: 3 }); await sleep(150); }
  },
});
await shot({
  name: 'export.png', setup: async (p) => {
    await p.keyboard.press('Control+e'); await sleep(200);
    await p.selectOption('#exFormat', 'png');
    await p.selectOption('#exFrames', 'drawn');
    await p.selectOption('#exSizeMode', 'scale');
    await p.fill('#exScale', '2'); await p.dispatchEvent('#exScale', 'input');
    await sleep(200);
  },
});
await shot({
  name: 'preview.png', setup: async (p) => {
    await p.evaluate(() => window.__app.goFrame(0));
    await p.keyboard.press('p');
    await sleep(200);
    if (await p.isChecked('#pvBg')) await p.click('#pvBg');
    // pausa num quadro já traçado
    await poll(p, () => /(^|\D)3\s*\/\s*12/.test(document.getElementById('pvLabel').textContent), null, 8000);
    await p.click('#pvPlay');
    await sleep(150);
  },
});
await shot({ name: 'about.png', setup: async (p) => { await p.click('#btnAbout'); await sleep(250); } });
await shot({ name: 'project-menu.png', setup: async (p) => { await p.click('#btnProject'); await sleep(200); } });
await shot({ name: 'japanese.png', locale: 'ja-JP', setup: (p) => strokeInProgress(p) });
await shot({ name: 'pt-BR.png', locale: 'pt-BR', scheme: 'light', setup: (p) => strokeInProgress(p) });

// exemplo de resultado: linhas do quadro atual exportadas em PNG 2× (fundo branco)
if (!ONLY.length || ONLY.includes('lines-example.png')) {
  const ctx = await browser.newContext({ viewport: VIEW, locale: 'en-US', colorScheme: 'dark', acceptDownloads: true });
  const page = await ctx.newPage();
  await open(page);
  await page.keyboard.press('Control+e'); await sleep(200);
  await page.selectOption('#exFormat', 'png');
  await page.selectOption('#exFrames', 'current');
  await page.selectOption('#exSizeMode', 'scale');
  await page.fill('#exScale', '2'); await page.dispatchEvent('#exScale', 'input');
  await page.selectOption('#exBg', 'white');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#exGo')]);
  const tmp = path.join(OUT, '.lines-download');
  await dl.saveAs(tmp);
  const buf = fs.readFileSync(tmp); fs.rmSync(tmp);
  if (buf[0] === 0x89) fs.writeFileSync(path.join(OUT, 'lines-example.png'), buf);
  else { // .zip com um único PNG
    const { unzipSync } = await import('fflate');
    const files = unzipSync(new Uint8Array(buf));
    const first = Object.keys(files).find((n) => n.endsWith('.png'));
    fs.writeFileSync(path.join(OUT, 'lines-example.png'), files[first]);
  }
  console.log('  ✔ lines-example.png (' + (await dl.suggestedFilename()) + ')');
  await ctx.close();
}
await browser.close();
server.close();
