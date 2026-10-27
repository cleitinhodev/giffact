// Linha do tempo virtualizada: só os quadros visíveis (+ margem) existem no DOM.
// Funciona com centenas/milhares de quadros sem pesar memória nem layout.
import { S, on, goFrame, frameHasStrokes } from './state';
import { $, h } from './dom';
import { drawFrameLayers } from './render';
import { t, onLangChange } from './i18n';

const TH_H = 70;          // altura da miniatura (px CSS)
const GAP = 4;            // espaço entre miniaturas
const BORDER = 2;         // borda de cada miniatura
const PAD = 8;            // margem lateral da faixa
const OVERSCAN = 6;       // miniaturas extras de cada lado
const CACHE_MAX = 240;    // miniaturas renderizadas guardadas (LRU)

interface Slot { el: HTMLElement; holder: HTMLElement; num: HTMLElement; i: number }

let tw = 93;              // largura da miniatura (px CSS)
let itemW = tw + BORDER * 2 + GAP;
let inner: HTMLElement;   // espaçador com a largura total
let slots = new Map<number, Slot>();
let free: Slot[] = [];
// cache LRU: índice do quadro -> canvas renderizado + versão
const cache = new Map<number, { c: HTMLCanvasElement; ver: number; lines: boolean }>();
let pending = new Set<number>();
let raf = 0;
let layoutRaf = 0;
let playTimer = 0;
export let playing = false;

const strip = () => $('strip');
const showLines = () => $<HTMLInputElement>('tlShowLines').checked;

export function initTimeline() {
  $('tlFirst').onclick = () => goFrame(0);
  $('tlLast').onclick = () => goFrame(S.frames.length - 1);
  $('tlPrev').onclick = () => goFrame(S.cur - 1);
  $('tlNext').onclick = () => goFrame(S.cur + 1);
  $('tlPlay').onclick = () => togglePlay();
  $<HTMLInputElement>('tlShowLines').onchange = () => refreshVisible();
  inner = h('div', { class: 'strip-inner' });
  strip().append(inner);
  on('loaded', build);
  on('frame', () => { markCurrent(true); });
  on('doc', () => {
    // redesenha o que mudou com atraso para não pesar enquanto desenha
    clearTimeout(docT);
    docT = window.setTimeout(refreshVisible, 250);
  });
  on('settings', () => markCurrent(false));
  onLangChange(() => {
    for (const sl of slots.values()) {
      sl.el.title = t('tl.thumb.title', { n: sl.i + 1, ms: S.frames[sl.i]?.delay ?? 0 });
      (sl.el.querySelector('.dot') as HTMLElement).title = t('tl.hasLines');
    }
    markCurrent(false);
  });
  const st = strip();
  st.addEventListener('scroll', () => scheduleLayout(), { passive: true });
  // roda do mouse rola na horizontal
  st.addEventListener('wheel', (e) => {
    if (e.ctrlKey) return;
    const unit = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? st.clientWidth : 1;
    const d = (Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX) * unit;
    if (!d) return;
    st.scrollLeft += d;
    e.preventDefault();
  }, { passive: false });
  new ResizeObserver(() => scheduleLayout()).observe(st);
  // clique delegado: um só listener para todas as miniaturas
  inner.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest('.th') as HTMLElement | null;
    if (el) goFrame(+el.dataset.i!);
  });
}
let docT = 0;

function build() {
  stopPlay();
  for (const s of slots.values()) s.el.remove();
  slots.clear();
  free = [];
  cache.clear();
  pending.clear();
  tw = S.docH ? Math.max(24, Math.min(160, Math.round((TH_H * S.docW) / S.docH))) : 24;
  itemW = tw + BORDER * 2 + GAP;
  const n = S.frames.length;
  inner.style.width = (n ? PAD * 2 + n * itemW - GAP : 0) + 'px';
  inner.style.setProperty('--tw', tw + 'px');
  strip().scrollLeft = 0;
  layout();
  markCurrent(true);
}

function scheduleLayout() {
  if (!layoutRaf) layoutRaf = requestAnimationFrame(() => { layoutRaf = 0; layout(); });
}

/** Faixa de índices visíveis (com margem) */
function visibleRange(): [number, number] {
  const st = strip();
  const n = S.frames.length;
  if (!n) return [0, -1];
  const a = Math.floor((st.scrollLeft - PAD) / itemW) - OVERSCAN;
  const b = Math.ceil((st.scrollLeft + st.clientWidth - PAD) / itemW) + OVERSCAN;
  return [Math.max(0, a), Math.min(n - 1, b)];
}

function newSlot(): Slot {
  const holder = h('div', { class: 'ph' });
  const num = h('span', {});
  const el = h('div', { class: 'th' }, holder, h('div', { class: 'lbl' }, num, h('span', { class: 'dot', title: t('tl.hasLines') })));
  inner.append(el);
  return { el, holder, num, i: -1 };
}

function layout() {
  if (!inner) return;
  const [a, b] = visibleRange();
  // libera os que saíram da faixa
  for (const [i, s] of slots) {
    if (i < a || i > b) { slots.delete(i); s.i = -1; s.el.style.display = 'none'; free.push(s); }
  }
  for (let i = a; i <= b; i++) {
    if (slots.has(i)) continue;
    const s = free.pop() || newSlot();
    s.i = i;
    s.el.dataset.i = String(i);
    s.el.style.display = '';
    s.el.style.transform = `translateX(${PAD + i * itemW}px)`;
    s.el.title = t('tl.thumb.title', { n: i + 1, ms: S.frames[i].delay });
    s.num.textContent = String(i + 1);
    s.holder.replaceChildren();
    decorate(s);
    slots.set(i, s);
    attachThumb(s);
  }
  // não deixa o pool crescer sem limite
  while (free.length > 40) free.pop()!.el.remove();
}

function decorate(s: Slot) {
  const i = s.i, st = S.settings;
  s.el.classList.toggle('cur', i === S.cur);
  s.el.classList.toggle('onion-prev', st.onion && i < S.cur && i >= S.cur - st.onionPrev);
  s.el.classList.toggle('onion-next', st.onion && i > S.cur && i <= S.cur + st.onionNext);
  s.el.classList.toggle('has', frameHasStrokes(i));
}

/** Coloca a miniatura em cache (se atual) ou agenda renderização */
function attachThumb(s: Slot) {
  const i = s.i;
  const c = cache.get(i);
  if (c) {
    cache.delete(i); cache.set(i, c); // toque LRU
    if (s.holder.firstChild !== c.c) s.holder.replaceChildren(c.c);
    if (c.ver === (S.frameVersion[i] || 0) && c.lines === showLines()) return;
  }
  pending.add(i);
  if (!raf) raf = requestAnimationFrame(flush);
}

function flush() {
  raf = 0;
  const t0 = performance.now();
  // prioriza o quadro atual e os mais próximos do centro
  const order = Array.from(pending).sort((x, y) => Math.abs(x - S.cur) - Math.abs(y - S.cur));
  for (const i of order) {
    pending.delete(i);
    const s = slots.get(i);
    if (!s) continue; // saiu da tela antes de renderizar
    renderThumb(i, s);
    if (performance.now() - t0 > 10) break;
  }
  if (pending.size) raf = requestAnimationFrame(flush);
}

function renderThumb(i: number, s: Slot) {
  const ver = S.frameVersion[i] || 0;
  const lines = showLines();
  let entry = cache.get(i);
  if (!entry) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const c = h('canvas', { width: Math.round(tw * dpr), height: Math.round(TH_H * dpr) }) as HTMLCanvasElement;
    c.style.width = tw + 'px';
    c.style.height = TH_H + 'px';
    entry = { c, ver: -1, lines };
    cache.set(i, entry);
    while (cache.size > CACHE_MAX) {
      const [k, old] = cache.entries().next().value!;
      if (slots.has(k)) { cache.delete(k); cache.set(k, old); if (cache.size <= CACHE_MAX) break; continue; }
      cache.delete(k);
      old.c.width = old.c.height = 0; // libera memória da GPU
    }
  }
  const c = entry.c;
  entry.ver = ver;
  entry.lines = lines;
  const g = c.getContext('2d')!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  const has = frameHasStrokes(i);
  g.globalAlpha = lines && has ? 0.45 : 1;
  g.imageSmoothingQuality = 'high';
  g.drawImage(S.frames[i].canvas, 0, 0, c.width, c.height);
  g.globalAlpha = 1;
  if (lines && has) {
    const sx = c.width / S.docW;
    g.setTransform(sx, 0, 0, c.height / S.docH, 0, 0);
    drawFrameLayers(g, S.docs[i], { scale: sx });
  }
  if (s.holder.firstChild !== c) s.holder.replaceChildren(c);
  s.el.classList.toggle('has', has);
}

function refreshVisible() {
  for (const s of slots.values()) { decorate(s); attachThumb(s); }
}

/** Atualiza destaque e, se pedido, rola para mostrar o quadro atual */
function markCurrent(scroll: boolean) {
  for (const s of slots.values()) decorate(s);
  if (scroll && S.loaded) scrollToFrame(S.cur);
  $('tlLabel').textContent = S.loaded ? t('tl.label', { cur: S.cur + 1, n: S.frames.length, ms: S.frames[S.cur].delay }) : '0 / 0';
}

export function scrollToFrame(i: number) {
  const st = strip();
  const l = PAD + i * itemW, r = l + itemW - GAP;
  const margin = Math.min(itemW, st.clientWidth / 4);
  if (l < st.scrollLeft + margin || r > st.scrollLeft + st.clientWidth - margin) {
    st.scrollLeft = Math.max(0, l - st.clientWidth / 2 + (itemW - GAP) / 2);
    layout(); // já cria as miniaturas da nova posição
  }
}

export function togglePlay() {
  if (playing) stopPlay(); else startPlay();
}
function startPlay() {
  if (!S.loaded || S.frames.length < 2) return;
  playing = true;
  $('tlPlay').textContent = '⏸';
  const step = () => {
    if (!playing) return;
    playTimer = window.setTimeout(() => { goFrame(S.cur + 1); step(); }, S.frames[S.cur].delay);
  };
  step();
}
export function stopPlay() {
  playing = false;
  clearTimeout(playTimer);
  const b = document.getElementById('tlPlay');
  if (b) b.textContent = '▶';
}
