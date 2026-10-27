// Teste de layout com muitos quadros (web e Electron) em vários tamanhos de janela.
//   node test/layout.mjs            -> Chrome headless
//   xvfb-run -a node test/layout.mjs electron
import { chromium, _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const MODE = process.argv[2] === 'electron' ? 'electron' : 'web';
const OUT = path.resolve('test-output/layout-' + MODE);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const ok = (c, m) => { console.log((c ? '  ✔ ' : '  ✘ ') + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SIZES = [[1280, 720], [1920, 1080], [1024, 600]];
const GIFS = ['samples/muitos_300.gif', 'samples/muitos_600.gif', 'samples/largo_300x_900x200.gif', 'samples/parcial_disposal1.gif'];

let page, setSize, close, server, currentGif = null;
const errors = [];
if (MODE === 'web') {
  const ROOT = path.resolve('app');
  server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    const p = path.join(ROOT, u === '/' ? 'index.html' : u);
    if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' }[path.extname(p)] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  });
  await new Promise((r) => server.listen(0, r));
  // sem --hide-scrollbars para medir a barra de rolagem de verdade
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'], ignoreDefaultArgs: ['--hide-scrollbars'] });
  const url = `http://localhost:${server.address().port}/index.html`;
  const open = async (w, h) => {
    if (page) await page.close();
    page = await browser.newPage({ viewport: { width: w, height: h }, locale: 'pt-BR' });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(url);
    for (let t = 0; t < 200 && !(await page.evaluate(() => !!window.__app)); t++) await sleep(50);
  };
  await open(1280, 720);
  // o Chrome headless deixa de entregar eventos de roda depois de setViewportSize; abre uma página nova por tamanho
  setSize = async (w, h) => { const vs = page.viewportSize(); if (vs.width !== w || vs.height !== h) { await open(w, h); if (currentGif) await loadFile(currentGif); } };
  close = async () => { await browser.close(); server.close(); };
} else {
  const app = await electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron'), args: ['--no-sandbox', '--lang=pt-BR', '.'] });
  page = await app.firstWindow();
  setSize = async (w, h) => {
    await app.evaluate(({ BrowserWindow }, [w, h]) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(w, h); }, [w, h]);
    await sleep(500);
  };
  close = () => app.close();
}
if (MODE === 'electron') page.on('pageerror', (e) => errors.push(String(e)));
for (let t = 0; t < 200 && !(await page.evaluate(() => !!window.__app)); t++) await sleep(100);

async function loadFile(file) {
  currentGif = file;
  const b64 = fs.readFileSync(file).toString('base64');
  return page.evaluate(async ([name, b64]) => {
    const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    const t0 = performance.now();
    await window.__app.loadAny(name, u);
    return performance.now() - t0;
  }, [path.basename(file), b64]);
}

// mede tudo de uma vez dentro da página
const measure = () => page.evaluate(() => {
  const r = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
  const strip = document.getElementById('strip');
  const cur = strip.querySelector('.th.cur');
  const sr = strip.getBoundingClientRect();
  const cr = cur ? cur.getBoundingClientRect() : null;
  return {
    vw: window.innerWidth, vh: window.innerHeight,
    side: r('side'), toolbar: r('toolbar'), topbar: r('topbar'), stage: r('stage'), timeline: r('timeline'),
    docSW: document.documentElement.scrollWidth, docSH: document.documentElement.scrollHeight,
    stripSW: strip.scrollWidth, stripCW: strip.clientWidth, stripBar: strip.offsetHeight - strip.clientHeight,
    stripLeft: strip.scrollLeft, thCount: strip.querySelectorAll('.th').length,
    canvasCount: strip.querySelectorAll('canvas').length,
    curVisible: !!cr && cr.left >= sr.left - 0.5 && cr.right <= sr.right + 0.5,
    cur: window.__app.S.cur, n: window.__app.S.frames.length,
    sideSH: document.getElementById('side').scrollHeight, sideCH: document.getElementById('side').clientHeight,
  };
});
const inside = (b, m) => b.l >= -0.5 && b.t >= -0.5 && b.r <= m.vw + 0.5 && b.b <= m.vh + 0.5 && b.w > 0 && b.h > 0;

const tlHeights = new Set();
for (const [w, h] of SIZES) {
  await setSize(w, h);
  for (const g of GIFS) {
    const ms = await loadFile(g);
    const n = await page.evaluate(() => window.__app.S.frames.length);
    console.log(`\n[${w}×${h}] ${path.basename(g)} — ${n} quadros (carregado em ${(ms / 1000).toFixed(2)} s)`);
    await page.evaluate(() => window.__app.goFrame(0));
    await sleep(120);
    let m = await measure();
    const tag = `[${m.vw}×${m.vh}]`;
    ok(inside(m.side, m) && inside(m.toolbar, m) && inside(m.topbar, m) && inside(m.stage, m) && inside(m.timeline, m),
      `${tag} painel direito, barra de ferramentas, topo, tela e linha do tempo dentro da janela (painel: x ${m.side.l.toFixed(0)}–${m.side.r.toFixed(0)})`);
    ok(m.docSW <= m.vw && m.docSH <= m.vh, `${tag} página sem transbordar (${m.docSW}×${m.docSH})`);
    ok(m.stage.w > 300 && m.stage.h > 200, `${tag} área de desenho ${m.stage.w.toFixed(0)}×${m.stage.h.toFixed(0)}`);
    tlHeights.add(Math.round(m.timeline.h));
    if (n > 20) {
      ok(m.stripSW > m.stripCW && m.stripBar >= 8, `${tag} linha do tempo com rolagem horizontal (conteúdo ${m.stripSW}px, visível ${m.stripCW}px, barra ${m.stripBar}px)`);
      ok(m.thCount < 80, `${tag} virtualizada: só ${m.thCount} miniaturas no DOM de ${n}`);
      // End -> último quadro visível
      await page.locator('#canvas').focus();
      await page.keyboard.press('End');
      await sleep(80);
      m = await measure();
      ok(m.cur === n - 1 && m.curVisible, `${tag} End: quadro ${m.cur + 1} visível na faixa (scroll ${m.stripLeft})`);
      // setas para trás atravessando várias telas
      let allVis = true;
      for (let k = 0; k < 40; k++) { await page.keyboard.press(k % 2 ? 'ArrowLeft' : 'a'); if (k % 8 === 7) { const q = await measure(); allVis &&= q.curVisible; } }
      m = await measure();
      ok(m.cur === n - 41 && m.curVisible && allVis, `${tag} ←/A 40×: quadro ${m.cur + 1} sempre visível`);
      // Home + clique numa miniatura
      await page.keyboard.press('Home');
      await sleep(60);
      m = await measure();
      ok(m.cur === 0 && m.curVisible && m.stripLeft === 0, `${tag} Home volta ao início`);
      // roda do mouse rola horizontalmente
      const tb = m.timeline;
      await page.mouse.move(tb.l + tb.w / 2 - 40, tb.b - 60);
      await sleep(50);
      await page.mouse.move(tb.l + tb.w / 2, tb.b - 50);
      await page.mouse.wheel(0, 600);
      await sleep(150);
      const after = await measure();
      ok(after.stripLeft > 300, `${tag} roda do mouse sobre a faixa rola na horizontal (scrollLeft ${after.stripLeft})`);
      // clica numa miniatura visível
      const th = page.locator('#strip .th:not([style*="display: none"])').nth(5);
      const idx = +(await th.getAttribute('data-i'));
      await th.click();
      ok((await page.evaluate(() => window.__app.S.cur)) === idx, `${tag} clique na miniatura ${idx + 1} abre o quadro`);
    }
    // painel direito rola na vertical quando não cabe
    if (m.sideSH > m.sideCH) {
      await page.evaluate(() => { const s = document.getElementById('side'); s.scrollTop = s.scrollHeight; });
      const st = await page.evaluate(() => { const s = document.getElementById('side'); const last = s.lastElementChild.getBoundingClientRect(); return { top: s.scrollTop, lastBottom: last.bottom, sideBottom: s.getBoundingClientRect().bottom }; });
      ok(st.top > 0 && st.lastBottom <= st.sideBottom + 1, `${tag} painel direito rola na vertical até o fim (scrollTop ${st.top})`);
      await page.evaluate(() => { document.getElementById('side').scrollTop = 0; });
    }
  }
  // diálogos cabem na janela (rolam por dentro se preciso)
  for (const [btn, dlg] of [['#btnExport', 'dlgExport'], ['#btnPreview', 'dlgPreview'], ['#btnHelp', 'dlgHelp'], ['#btnTrace', 'dlgTrace']]) {
    await page.click(btn);
    await sleep(250);
    const d = await page.evaluate((id) => { const b = document.querySelector('#' + id + ' .dialog').getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height, vw: innerWidth, vh: innerHeight }; }, dlg);
    ok(inside(d, { vw: d.vw, vh: d.vh }), `[${w}×${h}] diálogo ${dlg} dentro da janela (${d.w.toFixed(0)}×${d.h.toFixed(0)})`);
    if (dlg === 'dlgPreview') await page.screenshot({ path: `${OUT}/previa_${w}x${h}.png` });
    await page.keyboard.press('Escape');
    await sleep(100);
  }
}
ok(tlHeights.size === 1, `Altura da linha do tempo fixa em todos os casos: ${[...tlHeights].join(', ')} px`);

// reprodução com 600 quadros: o atual acompanha
await loadFile('samples/muitos_600.gif');
await setSize(1280, 720);
await page.evaluate(() => window.__app.goFrame(0));
await page.locator('#canvas').focus();
await page.keyboard.press('Shift+P');
let playOk = true;
for (let k = 0; k < 8; k++) { await sleep(250); const m = await measure(); playOk &&= m.curVisible; }
await page.keyboard.press('Shift+P');
const mp = await measure();
ok(playOk && mp.cur > 10, `Reprodução: quadro atual sempre visível (chegou ao ${mp.cur + 1})`);

// fluidez: rola a faixa inteira e mede o tempo por quadro de animação
const perf = await page.evaluate(async () => {
  const st = document.getElementById('strip');
  const times = [];
  let last = performance.now();
  for (let x = 0; x <= st.scrollWidth; x += 400) {
    st.scrollLeft = x;
    await new Promise((r) => requestAnimationFrame(r));
    const now = performance.now(); times.push(now - last); last = now;
  }
  times.sort((a, b) => a - b);
  return { n: times.length, median: times[times.length >> 1], p95: times[Math.floor(times.length * 0.95)], maxDom: st.querySelectorAll('.th').length };
});
ok(perf.p95 < 50 && perf.maxDom < 80, `Rolagem da faixa inteira (600 quadros): mediana ${perf.median.toFixed(1)} ms/quadro, p95 ${perf.p95.toFixed(1)} ms, ${perf.maxDom} miniaturas no DOM`);

// desenhar num quadro distante atualiza a miniatura dele
await page.evaluate(() => window.__app.goFrame(450));
await page.evaluate(() => window.__app.setTool('curve'));
const cb = await page.locator('#canvas').boundingBox();
for (const [dx, dy] of [[-120, 0], [0, -60], [120, 0]]) { await page.mouse.click(cb.x + cb.width / 2 + dx, cb.y + cb.height / 2 + dy); await sleep(250); }
await page.keyboard.press('Enter');
await sleep(700);
ok(await page.evaluate(() => !!document.querySelector('#strip .th.cur.has')), 'Desenhar no quadro 451 marca a miniatura dele');
await page.evaluate(() => { document.getElementById('toasts').innerHTML = ''; });
await sleep(200);
await page.screenshot({ path: `${OUT}/muitos_quadros_1280x720.png` });
await setSize(1024, 600);
await page.evaluate(() => { document.getElementById('toasts').innerHTML = ''; });
await sleep(300);
await page.screenshot({ path: `${OUT}/muitos_quadros_1024x600.png` });

ok(errors.length === 0, 'Sem erros na página' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
// descarta alterações para a janela fechar sem o aviso de "não salvo"
await page.evaluate(() => { window.__app.S.dirty = false; window.native?.setDirty(false); });
await sleep(100);
await close();
console.log(failures ? `\n${failures} FALHA(S)` : `\nLAYOUT OK (${MODE})`);
process.exit(failures ? 1 : 0);
