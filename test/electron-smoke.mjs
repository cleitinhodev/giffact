// Teste de fumaça do app Electron (Linux, Xvfb): abre GIF via argv, desenha, exporta PNG 2x numa pasta real e salva projeto
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const OUT = path.resolve('test-output/electron');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
let failures = 0;
// waitForFunction usa eval (bloqueado pela CSP); faz polling com evaluate
const waitFor = async (page, fn, timeout = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { try { if (await page.evaluate(fn)) return; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('timeout esperando condição');
};
const ok = (c, m) => { console.log((c ? '  ✔ ' : '  ✘ ') + m); if (!c) failures++; };

const gif = path.resolve('samples/parcial_disposal1.gif');
const app = await electron.launch({
  executablePath: path.resolve('node_modules/electron/dist/electron'),
  args: ['--no-sandbox', '--lang=pt-BR', '.', gif],
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
await waitFor(win, () => !!(window.__app && window.__app.S.loaded));
ok(await win.evaluate(() => window.native?.isElectron === true), 'Preload expõe window.native (contextIsolation)');
ok(await win.evaluate(() => typeof require === 'undefined'), 'Renderer sem acesso a Node (nodeIntegration desligado)');
ok(await win.evaluate(() => window.__app.S.frames.length) === 10, 'GIF aberto pela linha de comando (10 quadros)');
const title = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
ok(title.includes('parcial_disposal1.gif'), `Título da janela: "${title}"`);

// desenha uma curva
await win.evaluate(() => window.__app.setTool('curve'));
const box = await win.locator('#canvas').boundingBox();
for (const [dx, dy] of [[-150, 0], [-50, -80], [50, 60], [150, 0]]) {
  await win.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
  await win.waitForTimeout(250);
}
await win.keyboard.press('Enter');
ok(await win.evaluate(() => window.__app.S.docs[0].layers[0].strokes.length) === 1, 'Curva desenhada');

// stub dos diálogos nativos
const exportDir = path.join(OUT, 'export');
fs.mkdirSync(exportDir);
const projFile = path.join(OUT, 'teste.giffact');
await app.evaluate(({ dialog, shell }, [dir, proj]) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: proj });
  shell.openPath = async () => '';
}, [exportDir, projFile]);

await win.keyboard.press('Control+e');
await win.selectOption('#exFormat', 'png');
await win.selectOption('#exFrames', 'all');
await win.selectOption('#exSizeMode', 'scale');
await win.fill('#exScale', '2');
await win.click('#exGo');
await waitFor(win, () => document.getElementById('dlgExport').hidden);
await win.waitForTimeout(300);
const files = fs.readdirSync(exportDir).sort();
ok(files.length === 10 && files[0] === 'linhas_001.png', `Exportou ${files.length} PNGs direto na pasta (${files[0]} …)`);
const dims = execFileSync('python3', ['-c', 'import sys;from PIL import Image;im=Image.open(sys.argv[1]).convert("RGBA");print(im.size[0],im.size[1],sum(im.getchannel("A").histogram()[1:]))', path.join(exportDir, files[0])]).toString().trim();
ok(dims.startsWith('640 480') && +dims.split(' ')[2] > 500, `PNG 2x: ${dims} (largura altura pixels-de-linha)`);

await win.keyboard.press('Control+s');
await win.waitForTimeout(800);
ok(fs.existsSync(projFile) && JSON.parse(fs.readFileSync(projFile, 'utf8')).frames.length === 10, `Projeto salvo em disco (${fs.existsSync(projFile) ? (fs.statSync(projFile).size / 1024).toFixed(0) + ' KB' : 'ausente'})`);
const title2 = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
ok(title2.startsWith('teste.giffact'), `Título após salvar: "${title2}"`);
await win.screenshot({ path: path.join(OUT, 'electron.png') });
ok(errors.length === 0, 'Sem erros no renderer' + (errors.length ? ': ' + errors.join(' | ') : ''));
await app.close();
console.log(failures ? `\n${failures} FALHA(S)` : '\nELECTRON OK');
process.exit(failures ? 1 : 0);
