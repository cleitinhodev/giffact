// Empacota renderer (web) e processo principal do Electron com esbuild
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
rmSync('app', { recursive: true, force: true });
mkdirSync('app', { recursive: true });
cpSync('web', 'app', { recursive: true });
// ícone geral (janela/executável) e favicon (logo da barra superior / aba do navegador)
cpSync('build/icon.png', 'app/icon.png');
cpSync('build/icon.ico', 'app/icon.ico');
cpSync('build/favicon.png', 'app/favicon.png');
cpSync('build/favicon.ico', 'app/favicon.ico');

await build({
  entryPoints: ['src/renderer/main.ts'],
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  outfile: 'app/app.js',
  sourcemap: false,
  minify: process.argv.includes('--minify'),
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'info',
});
await build({
  entryPoints: ['src/electron/main.ts', 'src/electron/preload.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outdir: 'app',
  external: ['electron'],
  logLevel: 'info',
});
