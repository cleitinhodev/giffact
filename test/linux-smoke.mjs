// Teste de fumaça do build Linux empacotado (Xvfb): abre o app, abre um GIF pelo botão, desenha, exporta PNG.
// Uso: `xvfb-run -a node test/linux-smoke.mjs [executável]`
//   padrão: dist/linux-unpacked/giffact. Também aceita o .AppImage (rodado com APPIMAGE_EXTRACT_AND_RUN=1).
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const exe = path.resolve(process.argv[2] || 'dist/linux-unpacked/giffact');
const tag = path.basename(exe).replace(/[^\w.-]/g, '_');
const OUT = path.resolve('test-output/linux-' + tag);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
const ok = (c, m) => { console.log((c ? '  ✔ ' : '  ✘ ') + m); if (!c) failures++; };
const waitFor = async (page, fn, timeout = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { try { if (await page.evaluate(fn)) return true; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  return false;
};
console.log(`Linux: ${path.relative(process.cwd(), exe)}`);
ok(fs.existsSync(exe), 'Executável existe');
const t0 = Date.now();
const app = await electron.launch({
  executablePath: exe,
  args: ['--no-sandbox', '--lang=en-US'],
  env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  timeout: 60000,
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
ok(await waitFor(win, () => !!window.__app), `Janela abriu (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
await win.evaluate(() => localStorage.clear());
await win.reload();
await waitFor(win, () => !!window.__app);
const info = await app.evaluate(({ app, BrowserWindow }) => ({ name: app.getName(), version: app.getVersion(), packaged: app.isPackaged, title: BrowserWindow.getAllWindows()[0].getTitle(), n: BrowserWindow.getAllWindows().length }));
ok(info.packaged && info.name === 'Giffact' && info.version === '1.1.1', `App empacotado: ${info.name} ${info.version} (isPackaged=${info.packaged})`);
ok(info.title === 'Giffact' && info.n === 1, `Título da janela: "${info.title}"`);
ok(await win.evaluate(() => window.__app.i18n.getLang()) === 'en', 'Idioma do sistema (en-US) → inglês');
ok(await win.evaluate(() => { const i = document.querySelector('#topbar .brand .logo'); return i.complete && i.naturalWidth > 0; }), 'Logo carregado');

// abre um GIF pelo botão "Open GIF" (diálogo nativo simulado)
const gif = path.resolve('samples/parcial_disposal1.gif');
const exportDir = path.join(OUT, 'export');
fs.mkdirSync(exportDir);
await app.evaluate(({ dialog }, g) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [g] }); }, gif);
await win.click('#btnOpen');
ok(await waitFor(win, () => window.__app.S.loaded && window.__app.S.frames.length === 10), 'GIF aberto pelo botão "Open GIF" (10 quadros)');
const title = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
ok(title.includes('parcial_disposal1.gif'), `Título: "${title}"`);

// desenha uma curva com o mouse (com um clique direito para voltar um ponto)
await win.keyboard.press('c');
const box = await win.locator('#canvas').boundingBox();
const at = (dx, dy) => [box.x + box.width / 2 + dx, box.y + box.height / 2 + dy];
for (const [dx, dy] of [[-150, 0], [-50, -80], [0, 100], [50, 60]]) { await win.mouse.click(...at(dx, dy)); await win.waitForTimeout(150); }
await win.mouse.click(...at(50, 60), { button: 'right' }); await win.waitForTimeout(100);
await win.mouse.click(...at(50, 60), { button: 'right' }); await win.waitForTimeout(100);
await win.mouse.click(...at(50, 60)); await win.waitForTimeout(150);
await win.mouse.dblclick(...at(150, 0)); await win.waitForTimeout(200);
const st = await win.evaluate(() => window.__app.S.docs[0].layers[0].strokes.map((s) => s.pts.length));
ok(st.length === 1 && st[0] === 4, `Curva desenhada com o mouse (${st.length} traço, ${st[0]} pontos)`);

// exporta PNG (pasta escolhida no diálogo nativo simulado)
await app.evaluate(({ dialog, shell }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); shell.openPath = async () => ''; }, exportDir);
await win.keyboard.press('Control+e');
await win.selectOption('#exFormat', 'png');
await win.selectOption('#exFrames', 'all');
await win.selectOption('#exSizeMode', 'scale');
await win.fill('#exScale', '2');
await win.click('#exGo');
await waitFor(win, () => document.getElementById('dlgExport').hidden);
await win.waitForTimeout(400);
const files = fs.readdirSync(exportDir).sort();
ok(files.length === 10 && /^lines_001\.png$/.test(files[0]), `Exportou ${files.length} PNGs (${files[0]} …)`);
if (files.length) {
  const dims = execFileSync('python3', ['-c', 'import sys;from PIL import Image;im=Image.open(sys.argv[1]).convert("RGBA");print(im.size[0],im.size[1],sum(im.getchannel("A").histogram()[1:]))', path.join(exportDir, files[0])]).toString().trim();
  ok(dims.startsWith('640 480') && +dims.split(' ')[2] > 300, `PNG 2×: ${dims} (largura altura pixels-de-linha)`);
}
await win.evaluate(() => document.getElementById('toasts')?.replaceChildren());
await win.screenshot({ path: path.join(OUT, 'linux.png') });
ok(errors.length === 0, 'Sem erros no renderer' + (errors.length ? ': ' + errors.join(' | ') : ''));
await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 0; });
await win.evaluate(() => localStorage.clear());
await app.close();
console.log(failures ? `\n${failures} FALHA(S)` : '\nLINUX OK');
process.exit(failures ? 1 : 0);
