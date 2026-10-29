// Testes das funções da versão 1.1: menu Projeto (cliques reais), tema claro/escuro, animações neon,
// idioma, Ajuda e Sobre (links). Roda na web (Chrome headless) ou no Electron: `node test/features.mjs [electron]`.
import { chromium, _electron as electron } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const MODE = process.argv[2] === 'electron' ? 'electron' : 'web';
const OUT = path.resolve('test-output/features-' + MODE);
async function shot(name) { await page.evaluate(() => { const t = document.getElementById('toasts'); if (t) t.replaceChildren(); }); await page.screenshot({ path: path.join(OUT, name) }); }
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const ok = (c, m) => { console.log((c ? '  ✔ ' : '  ✘ ') + m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const VERSION = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;

let page, app, browser, ctx, server, url;
// waitForFunction usa eval (bloqueado pela CSP); faz polling com evaluate
const waitFor = async (fn, arg, timeout = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { try { if (await page.evaluate(fn, arg)) return true; } catch {} await sleep(80); }
  return false;
};
const ready = () => waitFor(() => !!window.__app);

if (MODE === 'web') {
  const ROOT = path.resolve('app');
  server = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    const p = path.join(ROOT, u === '/' ? 'index.html' : u);
    if (!p.startsWith(ROOT) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' }[path.extname(p)] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  });
  await new Promise((r) => server.listen(0, r));
  url = `http://localhost:${server.address().port}/index.html`;
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  ctx = await browser.newContext({ viewport: { width: 1280, height: 760 }, acceptDownloads: true, locale: 'pt-BR', colorScheme: 'dark' });
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.goto(url);
} else {
  app = await electron.launch({
    executablePath: path.resolve('node_modules/electron/dist/electron'),
    args: ['--no-sandbox', '--lang=pt-BR', '.'],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(String(e)));
  await app.evaluate(({ BrowserWindow }) => { const b = BrowserWindow.getAllWindows()[0]; b.unmaximize(); b.setContentSize(1280, 760); });
  // estado limpo (o localStorage do Electron persiste entre execuções)
  await ready();
  await page.evaluate(() => localStorage.clear());
  await page.reload();
}
await ready();
const reload = async () => { await page.reload(); await ready(); await sleep(150); };
const stubConfirm = () => page.evaluate(() => { window.confirm = () => true; });
const visibleInViewport = async (sel) => page.evaluate((sel) => {
  const el = document.querySelector(sel); if (!el || el.hidden) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 20 || r.height < 20) return false;
  if (r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) return false;
  // o elemento no centro de cada item é o próprio item (nada por cima, nada cortando)
  return [...el.querySelectorAll('button')].filter((b) => b.offsetParent).every((b) => {
    const q = b.getBoundingClientRect();
    const hit = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
    return hit && b.contains(hit);
  });
}, sel);

// ---------------------------------------------------------------- 1. menu Projeto
console.log(`[${MODE}] 1) Menu Projeto (cliques reais)`);
ok(await page.title() === 'Giffact', `Título da página: "${await page.title()}"`);
await page.click('#btnProject');
ok(await page.isVisible('#menuProject'), 'Clique em "Projeto" abre o menu');
ok(await visibleInViewport('#menuProject'), 'Menu inteiro visível, dentro da janela e não cortado pela barra');
ok(await page.getAttribute('#btnProject', 'aria-expanded') === 'true', 'aria-expanded=true no botão');
const labels = await page.$$eval('#menuProject button', (bs) => bs.map((b) => b.textContent.trim()));
ok(['Novo projeto', 'Abrir GIF…', 'Abrir projeto…', 'Salvar projeto', 'Salvar projeto como…'].every((l) => labels.some((x) => x.startsWith(l))), 'Itens: ' + labels.join(' | '));
ok(await page.isDisabled('#menuProject [data-act="save"]') && await page.isDisabled('#menuProject [data-act="new"]'), 'Sem documento: Salvar/Novo desabilitados');
await page.keyboard.press('Escape');
ok(await page.isHidden('#menuProject'), 'Esc fecha o menu');
await page.click('#btnProject');
await page.mouse.click(640, 400);
ok(await page.isHidden('#menuProject'), 'Clique fora fecha o menu');
await page.click('#btnProject'); await page.click('#btnProject');
ok(await page.isHidden('#menuProject'), 'Segundo clique no botão fecha o menu');
// teclado
await page.focus('#btnProject'); await page.keyboard.press('Enter');
ok(await page.isVisible('#menuProject') && await page.evaluate(() => document.activeElement?.closest('#menuProject') != null), 'Enter abre o menu e foca o 1º item habilitado');
await page.keyboard.press('Escape');

// carrega o GIF de exemplo pelo botão da tela inicial (clique real)
await page.click('#wDemo');
await waitFor(() => window.__app.S.loaded);
ok(await page.evaluate(() => window.__app.S.frames.length) === 12, 'GIF de exemplo aberto (12 quadros)');
// desenha um traço para ter alterações
await page.evaluate(() => window.__app.setTool('line'));
const box = await page.locator('#canvas').boundingBox();
await page.mouse.click(box.x + box.width / 2 - 80, box.y + box.height / 2);
await page.mouse.click(box.x + box.width / 2 + 80, box.y + box.height / 2 + 30);
await page.keyboard.press('Enter');
ok(await page.evaluate(() => window.__app.S.dirty && window.__app.S.docs[0].layers[0].strokes.length === 1), 'Traço desenhado (documento alterado)');

let savedProject;
if (MODE === 'web') {
  await page.click('#btnProject');
  ok(!(await page.isDisabled('#menuProject [data-act="save"]')), 'Com documento: Salvar habilitado');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#menuProject [data-act="save"]')]);
  savedProject = path.join(OUT, dl.suggestedFilename()); await dl.saveAs(savedProject);
  ok(savedProject.endsWith('sample_anime.giffact'), `Projeto → Salvar baixou ${path.basename(savedProject)}`);
  ok(await page.isHidden('#menuProject'), 'Menu fecha depois de escolher um item');
  ok(await page.evaluate(() => !window.__app.S.dirty), 'Documento marcado como salvo');
  const [dl2] = await Promise.all([page.waitForEvent('download'), (async () => { await page.click('#btnProject'); await page.click('#menuProject [data-act="saveAs"]'); })()]);
  ok(dl2.suggestedFilename().endsWith('.giffact'), `Projeto → Salvar como também baixa (${dl2.suggestedFilename()})`);
} else {
  const p1 = path.join(OUT, 'meu_projeto.giffact'), p2 = path.join(OUT, 'copia.giffact');
  await app.evaluate(({ dialog }, p) => { globalThis.__saveCalls = 0; dialog.showSaveDialog = async () => { globalThis.__saveCalls++; return { canceled: false, filePath: p }; }; }, p1);
  await page.click('#btnProject');
  await page.click('#menuProject [data-act="save"]');
  await waitFor(() => !window.__app.S.dirty);
  await sleep(200);
  ok(fs.existsSync(p1) && JSON.parse(fs.readFileSync(p1, 'utf8')).app === 'giffact', `Projeto → Salvar gravou ${path.basename(p1)} (app: "giffact")`);
  const title = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
  ok(title === 'meu_projeto.giffact — Giffact', `Título da janela: "${title}"`);
  // Ctrl+S de novo: grava no mesmo arquivo sem perguntar
  await page.evaluate(() => { window.__app.S.dirty = true; });
  await page.keyboard.press('Control+s'); await sleep(400);
  ok(await app.evaluate(() => globalThis.__saveCalls) === 1, 'Ctrl+S salva de novo no mesmo arquivo sem abrir diálogo');
  await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => { globalThis.__saveCalls++; return { canceled: false, filePath: p }; }; }, p2);
  await page.click('#btnProject');
  await page.click('#menuProject [data-act="saveAs"]');
  await sleep(500);
  ok(fs.existsSync(p2) && await app.evaluate(() => globalThis.__saveCalls) === 2, 'Projeto → Salvar como pede um novo arquivo e grava copia.giffact');
  savedProject = p1;
}
// Exportar pelo menu
await page.click('#btnProject');
await page.click('#menuProject [data-act="exportSvg"]');
ok(await page.isVisible('#dlgExport') && await page.inputValue('#exFormat') === 'svg', 'Projeto → Exportar SVG abre o diálogo já em SVG');
await page.click('#exCancel');

// Novo projeto (com alterações → confirma)
await page.evaluate(() => { window.__app.S.dirty = true; });
let asked = 0;
await page.evaluate(() => { window.__asked = 0; const c = window.confirm; window.confirm = (m) => { window.__asked++; return true; }; });
await page.click('#btnProject');
await page.click('#menuProject [data-act="new"]');
await waitFor(() => !window.__app.S.loaded);
asked = await page.evaluate(() => window.__asked);
ok(asked === 1, 'Novo projeto pede confirmação quando há alterações');
ok(await page.evaluate(() => !window.__app.S.loaded && !document.getElementById('welcome').classList.contains('hidden')), 'Novo projeto fecha o documento e volta à tela inicial');
ok(await page.evaluate(() => document.querySelectorAll('#strip .th').length === 0), 'Linha do tempo vazia');

// Abrir projeto pelo menu — inclusive um arquivo antigo .gifline (GIF Linework 1.0)
const old = JSON.parse(fs.readFileSync(savedProject, 'utf8'));
old.app = 'gif-linework';
const oldPath = path.join(OUT, 'antigo.gifline');
fs.writeFileSync(oldPath, JSON.stringify(old));
const openViaMenu = async (file) => {
  if (MODE === 'web') {
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), (async () => { await page.click('#btnProject'); await page.click('#menuProject [data-act="openProject"]'); })()]);
    await fc.setFiles(file);
  } else {
    await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, file);
    await page.click('#btnProject'); await page.click('#menuProject [data-act="openProject"]');
  }
  return waitFor(() => window.__app.S.loaded);
};
ok(await openViaMenu(oldPath) && await page.evaluate(() => window.__app.S.docs[0].layers[0].strokes.length) === 1, 'Projeto → Abrir projeto abre arquivo antigo .gifline com os traços');
await stubConfirm();
await page.evaluate(() => window.__app.doNew());
ok(await openViaMenu(savedProject) && await page.evaluate(() => window.__app.S.frames.length) === 12, 'Projeto → Abrir projeto abre o .giffact salvo');
const oldJson = path.join(OUT, 'antigo.json'); fs.writeFileSync(oldJson, JSON.stringify(old));
await page.evaluate(() => window.__app.doNew());
ok(await openViaMenu(oldJson), 'Projeto → Abrir projeto aceita também .json antigo');

// ---------------------------------------------------------------- 2. tema
console.log(`[${MODE}] 2) Tema claro/escuro`);
const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
if (MODE === 'web') ok(await theme() === 'dark', 'Padrão "sistema" segue prefers-color-scheme: dark');
if (MODE === 'web') {
  await page.emulateMedia({ colorScheme: 'light' }); await sleep(100);
  ok(await theme() === 'light', 'Mudança no tema do sistema aplica na hora (claro)');
  await page.emulateMedia({ colorScheme: 'dark' }); await sleep(100);
}
await page.click('#btnTheme');
ok(await visibleInViewport('#menuTheme'), 'Menu de aparência visível');
ok(await page.getAttribute('#menuTheme [data-theme-opt="system"]', 'aria-checked') === 'true', 'Opção marcada: Seguir o sistema');
await page.click('#menuTheme [data-theme-opt="light"]'); await sleep(50);
ok(await theme() === 'light' && await page.isHidden('#menuTheme'), 'Clique em "Claro" aplica o tema claro e fecha o menu');
const bgLight = await page.evaluate(() => getComputedStyle(document.getElementById('side')).backgroundColor);
await page.evaluate(() => window.__app.fitView());
await sleep(300);
await shot('tema_claro.png');
await reload();
ok(await theme() === 'light', 'Tema claro lembrado após recarregar');
await page.click('#btnTheme'); await page.click('#menuTheme [data-theme-opt="dark"]');
ok(await theme() === 'dark', 'Clique em "Escuro" aplica o tema escuro');
const bgDark = await page.evaluate(() => getComputedStyle(document.getElementById('side')).backgroundColor);
ok(bgLight !== bgDark, `Cores dos painéis mudam (${bgLight} → ${bgDark})`);
// contraste (WCAG) dos textos principais nos dois temas
const contrast = () => page.evaluate(() => {
  const parse = (c) => { const m = c.match(/[\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 }; };
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const L = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const cr = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => { const d = document.createElement('div'); d.style.color = cs.getPropertyValue(n); document.body.append(d); const c = parse(getComputedStyle(d).color); d.remove(); return c; };
  const white = { r: 255, g: 255, b: 255, a: 1 }, base = document.documentElement.dataset.theme === 'light' ? white : { r: 11, g: 13, b: 44, a: 1 };
  const panel = over(v('--panel'), base), solid = v('--panel-solid');
  return {
    fgPanel: cr(v('--fg'), panel), fg2Panel: cr(v('--fg2'), panel), fgDialog: cr(v('--fg'), solid), fg2Dialog: cr(v('--fg2'), solid),
    primary: cr(v('--acc-ink'), v('--acc2')), accDialog: cr(v('--acc'), solid),
  };
});
for (const th of ['dark', 'light']) {
  await page.evaluate((t) => window.__app.prefs.setTheme(t), th);
  const c = await contrast();
  const min = Math.min(c.fgPanel, c.fg2Panel, c.fgDialog, c.fg2Dialog, c.primary);
  ok(min >= 4.5 && c.accDialog >= 3, `Contraste ${th}: texto ${c.fgPanel.toFixed(1)}:1, secundário ${c.fg2Panel.toFixed(1)}:1, botão primário ${c.primary.toFixed(1)}:1, destaque ${c.accDialog.toFixed(1)}:1 (mín. 4.5)`);
}
await page.evaluate(() => window.__app.prefs.setTheme('dark'));

// ---------------------------------------------------------------- 3. animações neon
console.log(`[${MODE}] 3) Animações neon`);
const anims = () => page.evaluate(() => document.getAnimations().filter((a) => a.animationName?.startsWith('streak')).map((a) => ({
  name: a.animationName, target: a.effect.target.id || a.effect.target.className, pseudo: a.effect.pseudoElement, state: a.playState,
  props: [...new Set(a.effect.getKeyframes().flatMap((k) => Object.keys(k)))].filter((k) => !['offset', 'computedOffset', 'easing', 'composite'].includes(k)),
})));
let an = await anims();
ok(an.length >= 4, `Faixas neon animando: ${an.map((a) => a.target + a.pseudo).join(', ')}`);
ok(an.every((a) => a.props.every((p) => p === 'transform' || p === 'opacity')), 'Só transform/opacity são animados (composição na GPU)');
ok(an.every((a) => a.pseudo && a.target !== 'canvas'), 'Nenhuma animação no canvas (apenas pseudo-elementos das bordas)');
// desempenho: o canvas não é redesenhado pelas animações
const renders = await page.evaluate(async () => {
  const c = document.getElementById('canvas'); const ctx2 = c.getContext('2d'); let n = 0;
  const orig = ctx2.clearRect; ctx2.clearRect = function (...a) { n++; return orig.apply(this, a); };
  await new Promise((r) => setTimeout(r, 1200)); ctx2.clearRect = orig; return n;
});
ok(renders === 0, `Canvas parado enquanto as faixas animam (${renders} redesenhos em 1,2 s)`);
// pausa quando a janela fica oculta
await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
an = await anims();
ok(await page.evaluate(() => document.documentElement.classList.contains('paused')) && an.every((a) => a.state === 'paused'), 'Janela oculta: animações pausadas');
await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
ok((await anims()).every((a) => a.state === 'running'), 'Janela visível: animações retomadas');
// screenshot do tema escuro com as faixas em posição visível
await page.evaluate(() => { for (const a of document.getAnimations()) if (a.animationName?.startsWith('streak')) { a.pause(); a.currentTime = (a.effect.getComputedTiming().duration || 8000) * 0.38; } });
await shot('tema_escuro_neon.png');
await page.evaluate(() => { for (const a of document.getAnimations()) a.play(); });
// desligar pelo menu
await page.click('#btnTheme');
ok(await page.isChecked('#optAnim'), 'Caixa "Animações neon" marcada por padrão');
await page.click('#optAnim');
ok(await page.isVisible('#menuTheme'), 'Menu continua aberto ao marcar/desmarcar a caixa');
ok((await anims()).length === 0 && await page.evaluate(() => document.documentElement.classList.contains('anim-off')), 'Desmarcar desliga todas as faixas');
await page.keyboard.press('Escape');
await reload();
ok((await anims()).length === 0 && await page.evaluate(() => !window.__app.prefs.animationsOn()), 'Animações desligadas lembradas após recarregar');
await page.evaluate(() => window.__app.prefs.setAnimations(true));
ok((await anims()).length >= 4, 'Religar volta as faixas');
if (MODE === 'web') {
  // prefers-reduced-motion: sem escolha explícita, começa desligado
  const p2 = await ctx.newPage(); const save = page;
  await p2.emulateMedia({ reducedMotion: 'reduce' });
  await p2.evaluate(() => 0).catch(() => {});
  await p2.goto(url); page = p2; await ready();
  await page.evaluate(() => { const o = JSON.parse(localStorage.getItem('giffact-ui') || '{}'); o.anim = null; localStorage.setItem('giffact-ui', JSON.stringify(o)); });
  await reload();
  ok(await page.evaluate(() => document.documentElement.classList.contains('anim-off')) && (await anims()).length === 0, 'prefers-reduced-motion: reduce → animações desligadas por padrão');
  await page.click('#btnTheme');
  ok(await page.isVisible('#reducedNote'), 'Aviso de "movimento reduzido" aparece no menu');
  await page.click('#optAnim');
  ok((await anims()).length >= 4, 'Usuário ainda pode ligar as animações explicitamente');
  await page.keyboard.press('Escape');
  await p2.close(); page = save;
}

// ---------------------------------------------------------------- 4. idioma
console.log(`[${MODE}] 4) Idioma`);
ok(await page.evaluate(() => window.__app.i18n.getLang()) === 'pt-BR', 'Idioma detectado do sistema: pt-BR');
await page.click('#btnLang');
ok(await visibleInViewport('#menuLang'), 'Menu de idiomas visível');
const langs = await page.$$eval('#menuLang button', (bs) => bs.map((b) => b.textContent.replace('✓', '').trim()));
ok(langs.length === 10, 'Idiomas: ' + langs.join(', '));
await page.click('#menuLang [data-lang="en"]'); await sleep(50);
ok(await page.isHidden('#menuLang'), 'Menu de idiomas fecha após escolher');
ok(await page.textContent('#btnOpen .lbl') === 'Open GIF' && await page.textContent('#btnProject .lbl') === 'Project', 'Interface muda para inglês na hora (Open GIF / Project)');
ok(await page.evaluate(() => document.documentElement.lang) === 'en', '<html lang="en">');
ok(await page.textContent('#pToolTitle') !== '' && !/[ãçõ]/.test(await page.textContent('#side')), 'Painel lateral sem restos em português');
await page.click('#wDemo').catch(() => {});
await page.evaluate(async () => { if (!window.__app.S.loaded) { const a = window.__app; await a.loadAny('sample_anime.gif', a.makeDemoGif()); } });
await sleep(400);
await page.click('#btnProject');
ok((await page.textContent('#menuProject')).includes('Save project as…'), 'Menu Projeto em inglês');
await shot('interface_ingles.png');
await page.keyboard.press('Escape');
await reload();
ok(await page.evaluate(() => window.__app.i18n.getLang()) === 'en' && await page.textContent('#btnOpen .lbl') === 'Open GIF', 'Inglês lembrado após recarregar');
await page.click('#btnLang'); await page.click('#menuLang [data-lang="ja"]');
ok(await page.textContent('#btnOpen .lbl') === 'GIF を開く', 'Japonês: "GIF を開く"');
if (MODE === 'electron') {
  // o processo principal recebe os textos dos diálogos nativos no idioma escolhido
  await app.evaluate(({ dialog }) => { globalThis.__dlgOpts = null; dialog.showOpenDialog = async (_w, o) => { globalThis.__dlgOpts = o; return { canceled: true, filePaths: [] }; }; });
  await page.evaluate(() => { window.__app.S.dirty = false; });
  await page.click('#btnOpen'); await sleep(300);
  const o = await app.evaluate(() => globalThis.__dlgOpts);
  ok(o && o.title === 'GIF を開く' && o.filters.some((f) => f.name === 'すべてのファイル'), `Diálogo nativo em japonês: "${o?.title}" / filtros ${o?.filters?.map((f) => f.name).join(', ')}`);
}
await page.click('#btnLang'); await page.click('#menuLang [data-lang="pt-BR"]');
ok(await page.textContent('#btnOpen .lbl') === 'Abrir GIF', 'Volta para português');

// ---------------------------------------------------------------- 5. Ajuda e Sobre
console.log(`[${MODE}] 5) Ajuda e Sobre`);
await page.click('#btnHelp');
ok(await page.isVisible('#dlgHelp') && await page.locator('#dlgHelp ol.howto li').count() === 5 && (await page.textContent('#helpBody')).includes('Ctrl+S'), 'Ajuda: passo a passo (5 itens) + atalhos');
await page.click('#helpAbout');
ok(await page.isVisible('#dlgAbout') && await page.isHidden('#dlgHelp'), 'Botão "Sobre" dentro da Ajuda abre o Sobre');
await page.click('#aboutClose');
await page.click('#btnAbout');
ok(await page.isVisible('#dlgAbout'), 'Botão "Sobre" abre o diálogo');
ok((await page.textContent('#aboutVer')).includes(VERSION), `Versão mostrada: "${await page.textContent('#aboutVer')}"`);
ok(await page.evaluate(() => { const i = document.querySelector('.about-logo'); return i.complete && i.naturalWidth >= 128; }), 'Logo (giffact_icon) carregado');
const links = await page.$$eval('#dlgAbout a.linkbtn', (as) => as.map((a) => [a.id, a.getAttribute('href'), a.textContent.trim(), a.rel]));
const expected = { lnkGithub: 'https://github.com/cleitinhodev', lnkRepo: 'https://github.com/cleitinhodev/giffact', lnkSite: 'https://www.bugzinho.com/', lnkDonate: 'https://www.bugzinho.com/donate' };
ok(links.length === 4 && links.every(([id, href, , rel]) => expected[id] === href && rel.includes('noopener')), 'Links: ' + links.map((l) => `${l[2]} → ${l[1]}`).join(' · '));
await sleep(300);
await page.evaluate(() => { for (const a of document.getAnimations()) if (a.animationName === 'streak-box') { a.pause(); a.currentTime = 2200; } });
await shot('sobre.png');
await page.evaluate(() => { for (const a of document.getAnimations()) a.play(); });
let opened = [];
if (MODE === 'web') {
  await page.evaluate(() => { window.__opened = []; window.open = (u, t, f) => { window.__opened.push([u, t, f]); return null; }; });
  for (const id of Object.keys(expected)) await page.click('#' + id);
  opened = await page.evaluate(() => window.__opened);
  ok(opened.length === 4 && opened.every(([u, t, f], i) => u === Object.values(expected)[i] && t === '_blank' && /noopener/.test(f)), 'Web: cada botão abre o link numa nova aba (noopener)');
  ok(page.url() === url, 'Página do app não navegou para fora');
} else {
  await app.evaluate(({ shell }) => { globalThis.__opened = []; shell.openExternal = async (u) => { globalThis.__opened.push(u); }; });
  for (const id of Object.keys(expected)) await page.click('#' + id);
  await sleep(300);
  opened = await app.evaluate(() => globalThis.__opened);
  ok(JSON.stringify(opened) === JSON.stringify(Object.values(expected)), 'Electron: cada botão chama shell.openExternal com a URL certa');
  // segurança: só http/https
  await page.evaluate(async () => { for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://x/y', 'ms-settings:']) { try { await window.native.openExternal(u); } catch {} } });
  await page.evaluate(() => { window.open('file:///etc/hosts'); window.open('https://example.com/'); });
  await sleep(300);
  opened = await app.evaluate(() => globalThis.__opened);
  ok(opened.length === 5 && opened[4] === 'https://example.com/', 'Esquemas não-http(s) são recusados; window.open vai para o navegador externo');
  ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length) === 1, 'Nenhuma janela extra do Electron foi criada');
  const urlNow = await page.evaluate(() => location.protocol);
  ok(urlNow === 'file:', 'Janela continua no app (sem navegação)');
}
await page.keyboard.press('Escape');
ok(await page.isHidden('#dlgAbout'), 'Esc fecha o Sobre');

// ---------------------------------------------------------------- 6. ícones / marca
console.log(`[${MODE}] 6) Marca e ícones`);
ok(await page.evaluate(() => { const i = document.querySelector('#topbar .brand .logo'); return i.complete && i.naturalWidth > 0 && i.getAttribute('src') === 'favicon.png'; }), 'Logo da barra superior = giffact_favicon');
ok(await page.textContent('#topbar .brand-name') === 'Giffact', 'Nome "Giffact" na barra superior');
if (MODE === 'web') {
  ok(await page.evaluate(() => [...document.querySelectorAll('link[rel=icon]')].map((l) => l.getAttribute('href')).join()) === 'favicon.ico,favicon.png', 'Favicon da web = giffact_favicon');
} else {
  const info = await app.evaluate(({ app }) => ({ name: app.getName() }));
  ok(info.name === 'Giffact', `app.getName() = "${info.name}"`);
}

// ---------------------------------------------------------------- 7. Curva/Linha: botão direito volta um ponto
console.log(`[${MODE}] 7) Curva e Linha: botão direito volta ao ponto anterior (mouse real)`);
await stubConfirm();
await page.evaluate(async () => { const a = window.__app; a.S.dirty = false; await a.loadAny('sample_anime.gif', a.makeDemoGif()); a.fitView(); });
await waitFor(() => window.__app.S.frames.length === 12);
await sleep(300);
const cbox = await page.locator('#canvas').boundingBox();
// ponto na tela relativo ao centro do canvas
const P = (dx, dy) => [cbox.x + cbox.width / 2 + dx, cbox.y + cbox.height / 2 + dy];
const toDoc = (sx, sy) => page.evaluate(([sx, sy]) => {
  const S = window.__app.S, v = S.view, c = document.getElementById('canvas'), r = c.getBoundingClientRect();
  const m = new DOMMatrix().translate(c.clientWidth / 2 + v.panX, c.clientHeight / 2 + v.panY).rotate(v.rot).scale(v.zoom).translate(-S.docW / 2, -S.docH / 2);
  const p = m.inverse().transformPoint(new DOMPoint(sx - r.left, sy - r.top));
  return [p.x, p.y];
}, [sx, sy]);
const allStrokes = () => page.evaluate(() => { const S = window.__app.S; return S.docs[S.cur].layers.flatMap((l) => l.strokes.map((s) => ({ kind: s.kind, closed: s.closed, pts: s.pts.map((q) => [q.x, q.y]) }))); });
const inProgress = () => page.evaluate(() => { const a = window.__app; const t = a.TOOLS[a.S.tool]; return { tool: a.S.tool, n: t.pts ? t.pts.length : -1 }; });
const leftClick = async (dx, dy) => { const [x, y] = P(dx, dy); await page.mouse.click(x, y); await sleep(120); };
const rightClick = async (dx, dy) => { const [x, y] = P(dx, dy); await page.mouse.click(x, y, { button: 'right' }); await sleep(120); };
// menu de contexto bloqueado no canvas
await page.evaluate(() => { window.__ctx = []; window.addEventListener('contextmenu', (e) => { if (e.target.id === 'canvas') window.__ctx.push(e.defaultPrevented); }); });
await page.click('#canvas', { position: { x: 5, y: 5 } }).catch(() => {});
await page.keyboard.press('c');
ok((await inProgress()).tool === 'curve', 'Ferramenta Curva ativa (tecla C)');
await page.keyboard.press('Escape');
const base = (await allStrokes()).length;
const clicks = [[-150, -60], [-90, -100], [-30, -40], [30, -90]];
for (const [x, y] of clicks) await leftClick(x, y);
ok((await inProgress()).n === 4, `4 cliques esquerdos = 4 pontos (${(await inProgress()).n})`);
await rightClick(30, -90);
ok((await inProgress()).n === 3 && (await allStrokes()).length === base, 'Botão direito: volta ao ponto anterior (3 pontos), sem terminar nem criar traço');
await rightClick(100, 60);
let ip = await inProgress();
ok(ip.n === 2 && ip.tool === 'curve' && (await allStrokes()).length === base, `2º botão direito: 2 pontos, curva continua em andamento (${ip.n})`);
ok((await page.evaluate(() => window.__ctx)).length === 2 && (await page.evaluate(() => window.__ctx)).every(Boolean), 'Botão direito não abre o menu de contexto no canvas');
await leftClick(60, -20);
await leftClick(110, -70);
ok((await inProgress()).n === 4 && (await allStrokes()).length === base, 'Continua a mesma curva: +2 pontos = 4, nenhum traço novo');
// clique lento repetido no último ponto não termina nem duplica
await sleep(650); await leftClick(110, -70);
ok((await inProgress()).n === 4 && (await allStrokes()).length === base, 'Clique simples repetido no último ponto não termina a curva');
{ const [x, y] = P(160, -10); await page.mouse.dblclick(x, y); await sleep(200); }
let st = await allStrokes();
const nc = st[st.length - 1];
const expect = [];
for (const [x, y] of [clicks[0], clicks[1], [60, -20], [110, -70], [160, -10]]) expect.push(await toDoc(...P(x, y)));
const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1.5;
ok(st.length === base + 1 && nc.kind === 'curve' && nc.pts.length === 5 && nc.pts.every((q, i) => near(q, expect[i])),
  `Duplo clique termina: 1 traço de curva com 5 pontos nos lugares certos (2 mantidos + 2 novos + o do duplo clique): ${nc?.pts.length} pts`);
ok((await inProgress()).n === 0, 'Depois do duplo clique nada fica em andamento');
// Enter também termina
for (const [x, y] of [[-150, 60], [-100, 100], [-50, 60]]) await leftClick(x, y);
await rightClick(0, 0);
await page.keyboard.press('Enter'); await sleep(120);
st = await allStrokes();
ok(st.length === base + 2 && st[st.length - 1].pts.length === 2 && (await inProgress()).n === 0, `Enter termina: 3 pontos − 1 (botão direito) = traço com ${st[st.length - 1].pts.length} pontos`);
// botão direito no único ponto cancela, sem criar traço
await leftClick(-120, 120);
await rightClick(-120, 120);
ok((await inProgress()).n === 0 && (await allStrokes()).length === base + 2, 'Botão direito no único ponto: cancela a curva sem criar traço');
await rightClick(-60, 120);
ok((await allStrokes()).length === base + 2, 'Botão direito sem curva em andamento não faz nada');
await leftClick(-120, 120); await leftClick(-60, 130);
ok((await inProgress()).n === 2, 'Depois de cancelar, uma curva nova começa normalmente');
await page.keyboard.press('Backspace'); await sleep(60);
ok((await inProgress()).n === 1, 'Backspace continua removendo o último ponto');
await page.keyboard.press('Escape'); await sleep(60);
ok((await inProgress()).n === 0 && (await allStrokes()).length === base + 2, 'Esc continua cancelando');
// fechar clicando no 1º ponto continua funcionando
for (const [x, y] of [[-40, 40], [20, 40], [20, 100]]) await leftClick(x, y);
await leftClick(-40, 40);
st = await allStrokes();
ok(st.length === base + 3 && st[st.length - 1].closed === true && st[st.length - 1].pts.length === 3, 'Clicar no 1º ponto ainda fecha a curva');
// Linha reta: mesmo comportamento
await page.keyboard.press('l');
ok((await inProgress()).tool === 'line', 'Ferramenta Linha ativa (tecla L)');
for (const [x, y] of [[-160, -120], [-110, -120], [-60, -130]]) await leftClick(x, y);
await rightClick(-60, -130);
ip = await inProgress();
ok(ip.n === 2 && (await allStrokes()).length === base + 3, `Linha: botão direito volta um ponto e continua (${ip.n} pontos)`);
await leftClick(-20, -110);
{ const [x, y] = P(20, -125); await page.mouse.dblclick(x, y); await sleep(200); }
st = await allStrokes();
ok(st.length === base + 4 && st[st.length - 1].kind === 'line' && st[st.length - 1].pts.length === 4, `Linha: duplo clique termina com ${st[st.length - 1].pts.length} pontos`);
for (const [x, y] of [[100, 100], [150, 100]]) await leftClick(x, y);
await page.keyboard.press('Enter'); await sleep(120);
st = await allStrokes();
ok(st.length === base + 5 && st[st.length - 1].kind === 'line' && st[st.length - 1].pts.length === 2, 'Linha: Enter termina');
ok((await allStrokes()).length - base === 5, 'Nenhum traço extra: exatamente 5 traços criados no teste');
// textos de ajuda
await page.keyboard.press('c'); await sleep(100);
const hint = await page.evaluate(() => document.getElementById('side').textContent);
ok(hint.includes('O botão direito volta ao ponto anterior') && !hint.includes('ou botão direito termina'), 'Dica da ferramenta Curva atualizada (pt-BR)');
await page.click('#btnHelp'); await sleep(150);
const helpTxt = await page.evaluate(() => [...document.querySelectorAll('#helpBody div')].map((d) => d.textContent));
ok(helpTxt.some((x) => x.includes('Desfazer último ponto') && x.includes('Botão direito / Backspace')) && helpTxt.some((x) => x.includes('Terminar') && x.endsWith('Enter / duplo clique')),
  'Atalhos: "Botão direito / Backspace" desfaz ponto; terminar = "Enter / duplo clique"');
await page.keyboard.press('Escape');
await page.evaluate(() => { window.__app.S.dirty = false; });

ok(errors.length === 0, 'Sem erros no console' + (errors.length ? ': ' + errors.join(' | ') : ''));
if (MODE === 'electron') {
  await page.evaluate(() => localStorage.clear());
  // há traços não salvos: o app pergunta antes de sair (resposta automática "Sair sem salvar")
  await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 0; });
  await app.close();
} else { await browser.close(); server.close(); }
console.log(failures ? `\n${failures} FALHA(S)` : `\nFEATURES ${MODE.toUpperCase()} OK`);
process.exit(failures ? 1 : 0);
