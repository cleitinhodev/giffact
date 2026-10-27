// Testes de internacionalização: paridade de chaves e placeholders entre os 10 idiomas, escolha do idioma
// a partir do sistema, persistência, pseudo-localização (nenhum texto fixo no código) e layout em idiomas
// longos (alemão, russo) e CJK (japonês, chinês). Uso: `node test/i18n.mjs` (requer `node build.mjs` antes).
import { chromium } from 'playwright-core';
import { build } from 'esbuild';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const OUT = path.resolve('test-output/i18n');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const ok = (c, m) => { console.log((c ? '  ✔ ' : '  ✘ ') + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ 1. estático: dicionários
console.log('1) Dicionários');
const tmp = path.join(process.env.TMPDIR || '/tmp', 'giffact-i18n-test.mjs');
await build({ entryPoints: ['src/renderer/i18n/index.ts'], bundle: true, format: 'esm', platform: 'neutral', outfile: tmp, logLevel: 'error' });
const I = await import(pathToFileURL(tmp).href + '?' + Date.now());
const en = I.LANGS.find((l) => l.code === 'en').dict;
const enKeys = Object.keys(en).sort();
const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
ok(I.LANGS.length === 10, `10 idiomas: ${I.LANGS.map((l) => l.code).join(', ')}`);
ok(enKeys.length > 300, `Inglês (referência) tem ${enKeys.length} chaves`);
for (const L of I.LANGS) {
  const keys = Object.keys(L.dict).sort();
  const missing = enKeys.filter((k) => !(k in L.dict));
  const extra = keys.filter((k) => !(k in en));
  const empty = keys.filter((k) => typeof L.dict[k] !== 'string' || !L.dict[k].trim());
  const badPh = enKeys.filter((k) => k in L.dict && ph(L.dict[k]) !== ph(en[k]));
  ok(!missing.length && !extra.length && !empty.length && !badPh.length,
    `${L.code.padEnd(5)} ${keys.length} chaves` + (missing.length ? ` | faltando: ${missing.slice(0, 5)}` : '') + (extra.length ? ` | sobrando: ${extra.slice(0, 5)}` : '')
    + (empty.length ? ` | vazias: ${empty.slice(0, 5)}` : '') + (badPh.length ? ` | placeholders diferentes: ${badPh.slice(0, 5)}` : ''));
  if (L.code !== 'en') {
    // quantas frases ficaram idênticas ao inglês (nomes técnicos como PNG/SVG/OK são normais)
    const same = enKeys.filter((k) => L.dict[k] === en[k] && /[a-z]{4,}\s+[a-z]{3,}/i.test(en[k]));
    ok(same.length <= 3, `${L.code.padEnd(5)} frases não traduzidas (iguais ao inglês): ${same.length}${same.length ? ' → ' + same.slice(0, 5).join(', ') : ''}`);
  }
}
const cases = [[['fr-FR'], 'fr'], [['pt-PT'], 'pt-BR'], [['pt'], 'pt-BR'], [['zh-TW'], 'zh-CN'], [['de-AT'], 'de'], [['ja-JP'], 'ja'],
  [['ko-KR'], 'ko'], [['ru'], 'ru'], [['es-419'], 'es'], [['it-CH'], 'it'], [['en-GB'], 'en'], [['xx-YY'], 'en'], [['sv-SE', 'de-DE'], 'de'], [[], 'en']];
const badCases = cases.filter(([l, e]) => I.matchLang(l) !== e).map(([l, e]) => `${l}→${I.matchLang(l)} (esperado ${e})`);
ok(!badCases.length, `matchLang: ${cases.length} casos (fr-FR→fr, pt-PT→pt-BR, zh-TW→zh-CN, xx→en…)` + (badCases.length ? ' FALHAS: ' + badCases : ''));

// ------------------------------------------------------------ servidor web
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
const errors = [];
async function open(locale, viewport = { width: 1280, height: 760 }, colorScheme = 'dark') {
  const ctx = await browser.newContext({ viewport, locale, colorScheme });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.goto(url);
  await waitFor(page, () => !!window.__app);
  return { ctx, page };
}
async function waitFor(page, fn, arg, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { try { if (await page.evaluate(fn, arg)) return true; } catch {} await sleep(80); }
  return false;
}

// ------------------------------------------------------------ 2. detecção e persistência
console.log('2) Idioma do sistema e persistência');
for (const [loc, exp] of [['fr-FR', 'fr'], ['de-DE', 'de'], ['ja-JP', 'ja'], ['zh-TW', 'zh-CN'], ['pt-PT', 'pt-BR'], ['ko-KR', 'ko'], ['ru-RU', 'ru'], ['es-MX', 'es'], ['it-IT', 'it'], ['sv-SE', 'en']]) {
  const { ctx, page } = await open(loc);
  const got = await page.evaluate(() => window.__app.i18n.getLang());
  const lang = await page.evaluate(() => document.documentElement.lang);
  const label = await page.textContent('#btnOpen .lbl');
  const expLabel = I.LANGS.find((l) => l.code === exp).dict['top.open'];
  ok(got === exp && lang === exp && (!expLabel || label === expLabel), `Sistema ${loc} → ${got} (html lang=${lang}, "${label}")`);
  await ctx.close();
}
{
  const { ctx, page } = await open('fr-FR');
  await page.evaluate(() => window.__app.i18n.setLang('ko'));
  await page.reload(); await waitFor(page, () => !!window.__app);
  ok(await page.evaluate(() => window.__app.i18n.getLang()) === 'ko', 'Escolha manual (ko) vence o idioma do sistema e é lembrada');
  await ctx.close();
}

// ------------------------------------------------------------ 3. pseudo-localização: nada de texto fixo
console.log('3) Pseudo-localização (procura textos fixos no código)');
const { ctx: pctx, page } = await open('en-US');
await page.evaluate(() => window.__app.i18n.setPseudo(true));
const scan = (where) => page.evaluate((where) => {
  // aceita: números/unidades/símbolos, atalhos de teclado, nomes de idiomas (autoglossônimos), a marca, nomes de arquivo
  const allowed = (s) => {
    s = s.trim();
    if (!s) return true;
    if (s.includes('⟦')) return true;
    if (/^[\d\s.,:;%×x°/+\-–—()#↺↻↶↷⇐⇒▲▼◀▶⏮⏭⏪⏩✓✔＋…?|·•=*~]*$/u.test(s)) return true;
    if (/^[\d.,]*\s*(px|ms|%|fps|°|x)?$/i.test(s)) return true;
    if (/^(Giffact|PNG|SVG|GIF|ZIP|MIT|v?\d+\.\d+\.\d+)$/i.test(s)) return true;
    if (/\.(gif|png|svg|giffact|gifline|json|zip)$/i.test(s)) return true;
    if (/^[^\p{L}]+$/u.test(s)) return true; // só emoji/símbolos
    return false;
  };
  const isVisible = (el) => { for (let e = el; e; e = e.parentElement) { if (e.hidden) return false; const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return false; } return true; };
  const skip = (el) => el.closest('kbd, .k, [data-lang], #langName, .brand-name, .about-name, script, style, #toasts, .lyname, .layer-name, [contenteditable]');
  const bad = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || skip(el) || !isVisible(el)) continue;
    if (!allowed(n.textContent)) bad.push(`texto "${n.textContent.trim().slice(0, 40)}" em <${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''}>`);
  }
  for (const el of document.querySelectorAll('[title],[placeholder],[aria-label]')) {
    if (skip(el) || !isVisible(el)) continue;
    for (const a of ['title', 'placeholder', 'aria-label']) {
      const v = el.getAttribute(a);
      if (v != null && !allowed(v)) bad.push(`${a}="${v.slice(0, 40)}" em <${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}>`);
    }
  }
  return [...new Set(bad)].map((b) => `[${where}] ${b}`);
}, where);
const problems = [];
problems.push(...await scan('tela inicial'));
await page.click('#wDemo');
await waitFor(page, () => window.__app.S.frames.length === 12);
await sleep(300);
const tools = await page.evaluate(() => Object.keys(window.__app.TOOLS));
for (const tl of tools) { await page.evaluate((tl) => window.__app.setTool(tl), tl); await sleep(40); problems.push(...await scan('ferramenta ' + tl)); }
const closeAll = async () => { await page.keyboard.press('Escape'); await sleep(80); await page.evaluate(() => document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; })); await page.evaluate(() => document.querySelectorAll('.menu').forEach((m) => { m.hidden = true; m.classList.remove('open'); })); };
for (const [btn, name] of [['#btnProject', 'menu Projeto'], ['#btnLang', 'menu Idioma'], ['#btnTheme', 'menu Aparência'], ['#btnExport', 'Exportar'], ['#btnPreview', 'Prévia'], ['#btnTrace', 'Auto-traçar'], ['#btnHelp', 'Ajuda'], ['#btnAbout', 'Sobre'], ['#frToRange', 'Copiar para quadros']]) {
  await page.click(btn); await sleep(200);
  problems.push(...await scan(name));
  await closeAll();
}
// formato SVG no diálogo de exportação também
await page.evaluate(() => document.querySelector('#btnExport').click()); await sleep(100);
await page.evaluate(() => { const s = document.querySelector('#dlgExport input[value="svg"], #dlgExport [data-fmt="svg"]'); s?.click(); });
await sleep(100); problems.push(...await scan('Exportar SVG')); await closeAll();
ok(!problems.length, problems.length ? `Textos sem tradução encontrados (${problems.length}):\n      ` + problems.slice(0, 25).join('\n      ') : 'Nenhum texto fixo: tudo visível passa por t() (telas, ferramentas, menus e diálogos)');
await page.evaluate(() => window.__app.i18n.setPseudo(false));
await pctx.close();

// ------------------------------------------------------------ 4. layout em idiomas longos e CJK
console.log('4) Layout em alemão, russo, francês, japonês, chinês e coreano');
const layoutCheck = (page) => page.evaluate(() => {
  const issues = [];
  const vw = innerWidth;
  const top = document.getElementById('topbar').getBoundingClientRect();
  if (document.getElementById('topbar').scrollWidth > document.getElementById('topbar').clientWidth + 1) issues.push('barra superior transborda');
  for (const b of document.querySelectorAll('#topbar button')) {
    if (!b.offsetParent) continue;
    const r = b.getBoundingClientRect();
    if (r.right > vw + 0.5 || r.left < -0.5) issues.push(`botão ${b.id || b.textContent.trim()} fora da janela`);
    if (r.top < top.top - 1 || r.bottom > top.bottom + 1) issues.push(`botão ${b.id || b.textContent.trim()} quebrou linha na barra`);
  }
  const side = document.getElementById('side');
  if (side && side.scrollWidth > side.clientWidth + 1) issues.push(`painel lateral com rolagem horizontal (${side.scrollWidth}>${side.clientWidth})`);
  for (const el of document.querySelectorAll('#side button, #side label, #toolbar button, #timeline button')) {
    if (!el.offsetParent) continue;
    if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflow !== 'hidden') issues.push(`texto cortado em ${el.id || el.textContent.trim().slice(0, 20)}`);
  }
  return issues;
});
const dlgCheck = (page, id) => page.evaluate((id) => {
  const d = document.querySelector('#' + id + ' .dlg, #' + id + ' > div');
  if (!d) return ['sem caixa ' + id];
  const r = d.getBoundingClientRect(); const issues = [];
  if (r.right > innerWidth + 0.5 || r.left < -0.5 || r.bottom > innerHeight + 0.5 || r.top < -0.5) issues.push(`${id} sai da janela`);
  if (d.scrollWidth > d.clientWidth + 1) issues.push(`${id} com rolagem horizontal`);
  for (const b of d.querySelectorAll('button')) { if (b.offsetParent && b.scrollWidth > b.clientWidth + 2) issues.push(`${id}: botão cortado "${b.textContent.trim().slice(0, 25)}"`); }
  return issues;
}, id);
for (const lang of ['de', 'ru', 'fr', 'ja', 'zh-CN', 'ko']) {
  for (const vp of [{ width: 1024, height: 600 }, { width: 1280, height: 720 }]) {
    const { ctx, page } = await open('en-US', vp);
    await page.evaluate((l) => window.__app.i18n.setLang(l), lang);
    await page.click('#wDemo');
    await waitFor(page, () => window.__app.S.frames.length === 12);
    await sleep(250);
    const issues = await layoutCheck(page);
    for (const [btn, id] of [['#btnExport', 'dlgExport'], ['#btnHelp', 'dlgHelp'], ['#btnAbout', 'dlgAbout'], ['#btnTrace', 'dlgTrace']]) {
      await page.click(btn); await sleep(150);
      issues.push(...await dlgCheck(page, id));
      await page.keyboard.press('Escape'); await sleep(60);
      await page.evaluate(() => document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; }));
    }
    await page.click('#btnProject'); await sleep(100);
    const menuOk = await page.evaluate(() => { const r = document.getElementById('menuProject').getBoundingClientRect(); return r.right <= innerWidth && r.bottom <= innerHeight && r.left >= 0; });
    if (!menuOk) issues.push('menu Projeto sai da janela');
    if ((lang === 'de' || lang === 'ja') && vp.width === 1280) await page.screenshot({ path: path.join(OUT, `layout_${lang}.png`) });
    await page.keyboard.press('Escape');
    ok(!issues.length, `${lang.padEnd(5)} ${vp.width}×${vp.height}: ` + (issues.length ? issues.slice(0, 6).join('; ') : 'sem cortes nem transbordo'));
    await ctx.close();
  }
}

// ------------------------------------------------------------ 5. capturas inglês / japonês
console.log('5) Capturas');
for (const lang of ['en', 'ja']) {
  const { ctx, page } = await open(lang === 'en' ? 'en-US' : 'ja-JP');
  await page.click('#wDemo');
  await waitFor(page, () => window.__app.S.frames.length === 12);
  await sleep(400);
  await page.evaluate(() => document.getElementById('toasts')?.replaceChildren());
  await page.screenshot({ path: path.join(OUT, `interface_${lang}.png`) });
  ok(fs.statSync(path.join(OUT, `interface_${lang}.png`)).size > 20000, `Captura interface_${lang}.png`);
  await ctx.close();
}

ok(!errors.length, errors.length ? 'Erros na página: ' + errors.slice(0, 3).join(' | ') : 'Nenhum erro de JavaScript');
await browser.close();
server.close();
fs.rmSync(tmp, { force: true });
console.log(failures ? `\n${failures} FALHA(S) NO I18N` : '\nI18N OK');
process.exit(failures ? 1 : 0);
