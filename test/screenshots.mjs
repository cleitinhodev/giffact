// Gera as capturas de tela do README (docs/screenshots). Uso: `node build.mjs && node test/screenshots.mjs`
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('docs/screenshots');
fs.mkdirSync(OUT, { recursive: true });
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

async function shot({ name, locale, scheme, setup }) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 }, locale, colorScheme: scheme, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(url);
  for (let i = 0; i < 100 && !(await page.evaluate(() => !!window.__app)); i++) await sleep(50);
  await page.click('#wDemo');
  for (let i = 0; i < 100 && (await page.evaluate(() => window.__app.S.frames.length)) < 12; i++) await sleep(50);
  // rascunho automático das linhas no quadro atual, para a captura não ficar vazia
  await page.click('#btnTrace'); await sleep(150);
  await page.click('#trGo');
  for (let i = 0; i < 200 && !(await page.evaluate(() => document.getElementById('dlgTrace').hidden)); i++) await sleep(50);
  await page.evaluate(() => { window.__app.S.settings.bgOpacity = 0.55; window.__app.fitView(); });
  await sleep(200);
  if (setup) await setup(page);
  // faixas neon numa posição visível
  await page.evaluate(() => document.getAnimations().forEach((a) => { if (a.animationName?.startsWith('streak')) { a.pause(); a.currentTime = (a.effect.getTiming().duration || 0) * 0.38; } }));
  await page.evaluate(() => document.getElementById('toasts')?.replaceChildren());
  await sleep(100);
  await page.screenshot({ path: path.join(OUT, name) });
  console.log('  ✔ ' + name);
  await ctx.close();
}
await shot({ name: 'dark-neon.png', locale: 'en-US', scheme: 'dark' });
await shot({ name: 'light.png', locale: 'en-US', scheme: 'light' });
await shot({ name: 'about.png', locale: 'en-US', scheme: 'dark', setup: async (p) => { await p.click('#btnAbout'); await sleep(200); } });
await shot({ name: 'project-menu.png', locale: 'en-US', scheme: 'dark', setup: async (p) => { await p.click('#btnProject'); await sleep(150); } });
await shot({ name: 'japanese.png', locale: 'ja-JP', scheme: 'dark' });
await shot({ name: 'pt-BR.png', locale: 'pt-BR', scheme: 'light' });
await browser.close();
server.close();
