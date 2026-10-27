// Internacionalização: dicionários, detecção de idioma, t() e aplicação em HTML (data-i18n*)
import { en, type Dict, type Key } from './en';
import { pt } from './pt';
import { es } from './es';
import { fr } from './fr';
import { de } from './de';
import { it } from './it';
import { ja } from './ja';
import { zh } from './zh';
import { ko } from './ko';
import { ru } from './ru';

export type { Key };
export interface LangInfo { code: string; name: string; dict: Dict }
/** Idiomas suportados. `name` é sempre o nome nativo (autoglossônimo). */
export const LANGS: LangInfo[] = [
  { code: 'en', name: 'English', dict: en },
  { code: 'pt-BR', name: 'Português (Brasil)', dict: pt },
  { code: 'es', name: 'Español', dict: es },
  { code: 'fr', name: 'Français', dict: fr },
  { code: 'de', name: 'Deutsch', dict: de },
  { code: 'it', name: 'Italiano', dict: it },
  { code: 'ja', name: '日本語', dict: ja },
  { code: 'zh-CN', name: '中文（简体）', dict: zh },
  { code: 'ko', name: '한국어', dict: ko },
  { code: 'ru', name: 'Русский', dict: ru },
];

let cur: LangInfo = LANGS[0];
/** Pseudo-localização para testes: envolve todo texto traduzido em ⟦…⟧ */
let pseudo = false;
const listeners = new Set<() => void>();

/** Escolhe o idioma a partir de uma lista de locales (navigator.languages). */
export function matchLang(locales: readonly string[]): string {
  for (const raw of locales) {
    if (!raw) continue;
    const l = raw.toLowerCase();
    if (l.startsWith('pt')) return 'pt-BR';
    if (l.startsWith('zh')) return 'zh-CN';
    const base = l.split(/[-_]/)[0];
    const hit = LANGS.find((x) => x.code.toLowerCase() === l || x.code.toLowerCase().split('-')[0] === base);
    if (hit) return hit.code;
  }
  return 'en';
}
export function detectLang(): string {
  const list = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]) as readonly string[];
  return matchLang(list);
}

export function getLang() { return cur.code; }
export function setLang(code: string) {
  const hit = LANGS.find((l) => l.code === code) || LANGS[0];
  cur = hit;
  document.documentElement.lang = hit.code;
  applyI18n();
  listeners.forEach((f) => f());
}
export function onLangChange(fn: () => void) { listeners.add(fn); }
export function setPseudo(on: boolean) { pseudo = on; setLang(cur.code); }

/** Traduz uma chave; parâmetros {nome} são substituídos. */
export function t(key: Key, params?: Record<string, string | number>): string {
  let s: string = cur.dict[key] ?? en[key] ?? key;
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
  return pseudo ? `⟦${s}⟧` : s;
}
/** Verifica se um texto é uma das traduções de uma chave (em qualquer idioma). */
export function isAnyTranslation(key: Key, text: string) {
  return LANGS.some((l) => l.dict[key] === text);
}

/**
 * Aplica traduções nos elementos marcados:
 *  data-i18n="chave"        -> textContent
 *  data-i18n-title="chave"  -> title (e aria-label se não houver texto)
 *  data-i18n-ph="chave"     -> placeholder
 *  data-i18n-aria="chave"   -> aria-label
 */
export function applyI18n(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n as Key); });
  root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    const v = t(el.dataset.i18nTitle as Key);
    el.title = v;
    if (!el.hasAttribute('data-i18n') && !el.querySelector('[data-i18n]')) el.setAttribute('aria-label', v);
  });
  root.querySelectorAll<HTMLInputElement>('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh as Key); });
  root.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria as Key)); });
}

/** Textos que o processo principal do Electron precisa (diálogos nativos). */
export function nativeStrings() {
  const keys = ['native.openGif', 'native.openProject', 'native.saveProject', 'native.chooseFolder', 'native.filterMedia', 'native.filterProject',
    'native.filterAny', 'native.filterAll', 'native.unsavedTitle', 'native.unsavedMsg', 'native.quit', 'native.cancel'] as const;
  const o: Record<string, string> = {};
  for (const k of keys) o[k] = cur.dict[k] ?? en[k];
  return o;
}
