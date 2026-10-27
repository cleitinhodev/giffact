// Preferências de interface: tema (sistema/escuro/claro), animações neon e idioma. Persistidas no localStorage.
import { LANGS, detectLang, getLang, setLang, onLangChange, nativeStrings } from './i18n';
import { native } from './platform';
import { $, h } from './dom';

export type ThemePref = 'system' | 'dark' | 'light';
interface UiPrefs { theme: ThemePref; anim: boolean | null; lang: string | null }
const KEY = 'giffact-ui';

const mqLight = window.matchMedia('(prefers-color-scheme: light)');
const mqReduce = window.matchMedia('(prefers-reduced-motion: reduce)');

function load(): UiPrefs {
  const d: UiPrefs = { theme: 'system', anim: null, lang: null };
  try {
    const o = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (o.theme === 'dark' || o.theme === 'light' || o.theme === 'system') d.theme = o.theme;
    if (typeof o.anim === 'boolean') d.anim = o.anim;
    if (typeof o.lang === 'string' && LANGS.some((l) => l.code === o.lang)) d.lang = o.lang;
  } catch { /* preferências corrompidas: usa padrão */ }
  return d;
}
export const prefs: UiPrefs = load();
function save() { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* */ } }

export const effectiveTheme = (): 'dark' | 'light' => (prefs.theme === 'system' ? (mqLight.matches ? 'light' : 'dark') : prefs.theme);
/** Animações: escolha explícita do usuário vence; sem escolha, segue prefers-reduced-motion. */
export const animationsOn = () => (prefs.anim === null ? !mqReduce.matches : prefs.anim);

export function applyTheme() {
  const root = document.documentElement;
  const eff = effectiveTheme();
  root.dataset.theme = eff;
  root.style.colorScheme = eff;
  const icon = document.getElementById('themeIcon');
  if (icon) icon.textContent = eff === 'light' ? '☀' : '🌙';
  document.querySelectorAll<HTMLElement>('#menuTheme [data-theme-opt]').forEach((b) => {
    const on = b.dataset.themeOpt === prefs.theme;
    b.setAttribute('aria-checked', String(on));
    b.classList.toggle('checked', on);
  });
}
export function applyAnim() {
  const on = animationsOn();
  document.documentElement.classList.toggle('anim-off', !on);
  const c = document.getElementById('optAnim') as HTMLInputElement | null;
  if (c) c.checked = on;
  const note = document.getElementById('reducedNote');
  if (note) note.hidden = !mqReduce.matches;
}
export function setTheme(t: ThemePref) { prefs.theme = t; save(); applyTheme(); }
export function setAnimations(on: boolean) { prefs.anim = on; save(); applyAnim(); }
export function chooseLang(code: string) { prefs.lang = code; save(); setLang(code); }

function buildLangMenu() {
  const m = $('menuLang');
  m.replaceChildren();
  for (const l of LANGS) {
    const b = h('button', { role: 'menuitemradio', 'data-lang': l.code, lang: l.code, 'aria-checked': String(l.code === getLang()), class: l.code === getLang() ? 'checked' : '' },
      h('span', {}, l.name), h('span', { class: 'mark' }, '✓'));
    b.onclick = () => chooseLang(l.code);
    m.append(b);
  }
}
const shortLang = (code: string) => (code === 'zh-CN' ? '中文' : code === 'ja' ? '日本語' : code === 'ko' ? '한국어' : code.split('-')[0].toUpperCase());

/** Aplica tema/animações o quanto antes (evita “piscar” no tema errado). */
export function initPrefsEarly() {
  applyTheme();
  applyAnim();
  setLang(prefs.lang || detectLang());
}

export function initPrefs() {
  mqLight.addEventListener('change', applyTheme);
  mqReduce.addEventListener('change', applyAnim);
  // pausa as animações quando a janela não está visível (minimizada/aba oculta)
  const vis = () => document.documentElement.classList.toggle('paused', document.hidden);
  document.addEventListener('visibilitychange', vis);
  vis();
  document.querySelectorAll<HTMLElement>('#menuTheme [data-theme-opt]').forEach((b) => {
    b.onclick = () => setTheme(b.dataset.themeOpt as ThemePref);
  });
  const anim = $<HTMLInputElement>('optAnim');
  anim.onchange = () => setAnimations(anim.checked);
  const syncLang = () => {
    $('langName').textContent = shortLang(getLang());
    buildLangMenu();
    native?.setLocaleStrings(nativeStrings());
  };
  onLangChange(syncLang);
  syncLang();
  applyTheme();
  applyAnim();
}
