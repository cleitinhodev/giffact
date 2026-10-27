// Menus suspensos da barra superior. Ficam no <body> com position: fixed, assim nada
// (ex.: overflow da barra) consegue cortá-los. Um menu aberto por vez.
let openMenu: { btn: HTMLElement; menu: HTMLElement } | null = null;

const items = (menu: HTMLElement) =>
  Array.from(menu.querySelectorAll<HTMLElement>('button:not([disabled]), label.menu-check input')).filter((el) => el.offsetParent !== null);

function place(btn: HTMLElement, menu: HTMLElement) {
  const r = btn.getBoundingClientRect();
  menu.style.left = '0px'; menu.style.top = '0px';
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  let left = r.left;
  if (left + mw > vw - 6) left = Math.max(6, r.right - mw);
  let top = r.bottom + 4;
  if (top + mh > vh - 6) top = Math.max(6, r.top - mh - 4);
  menu.style.left = Math.round(left) + 'px';
  menu.style.top = Math.round(top) + 'px';
  menu.style.maxHeight = (vh - 12) + 'px';
}

export function closeMenus() {
  if (!openMenu) return;
  const { btn, menu } = openMenu;
  menu.hidden = true;
  menu.classList.remove('open');
  btn.setAttribute('aria-expanded', 'false');
  btn.classList.remove('on');
  openMenu = null;
}
export const isMenuOpen = () => !!openMenu;

export function openMenuFor(btn: HTMLElement, menu: HTMLElement, focusFirst = false) {
  closeMenus();
  menu.hidden = false;
  menu.classList.add('open');
  place(btn, menu);
  btn.setAttribute('aria-expanded', 'true');
  btn.classList.add('on');
  openMenu = { btn, menu };
  if (focusFirst) items(menu)[0]?.focus();
}

/** Liga um botão a um menu. `onOpen` roda antes de mostrar (para atualizar estado). */
export function bindMenu(btn: HTMLElement, menu: HTMLElement, onOpen?: () => void) {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (openMenu?.menu === menu) { closeMenus(); return; }
    onOpen?.();
    // e.detail === 0 => ativado pelo teclado (Enter/Espaço)
    openMenuFor(btn, menu, (e as MouseEvent).detail === 0);
  });
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); onOpen?.(); openMenuFor(btn, menu, true); }
  });
  // itens comuns fecham o menu ao serem ativados; checkboxes não
  menu.addEventListener('click', (e) => {
    // (o item pode já ter sido removido do DOM, p.ex. o menu de idiomas é reconstruído ao trocar)
    const b = (e.target as HTMLElement).closest('button');
    if (b) setTimeout(closeMenus, 0);
  });
}

export function initMenus() {
  document.addEventListener('pointerdown', (e) => {
    if (!openMenu) return;
    const tg = e.target as Node;
    if (openMenu.menu.contains(tg) || openMenu.btn.contains(tg)) return;
    closeMenus();
  }, true);
  window.addEventListener('keydown', (e) => {
    if (!openMenu) return;
    const list = items(openMenu.menu);
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const b = openMenu.btn; closeMenus(); b.focus(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); list[(i + 1) % list.length]?.focus(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); list[(i - 1 + list.length) % list.length]?.focus(); return; }
    if (e.key === 'Tab') { closeMenus(); return; }
  }, true);
  window.addEventListener('resize', closeMenus);
  window.addEventListener('blur', closeMenus);
}
