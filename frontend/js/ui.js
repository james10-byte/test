import { t } from './i18n.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
let gradientCounter = 0;

const ICON_PATHS = {
  dashboard: ['M4 4h7v7H4z', 'M13 4h7v4h-7z', 'M13 10h7v10h-7z', 'M4 13h7v7H4z'],
  studio: ['M12 3l8 4.5v9L12 21l-8-4.5v-9z', 'M12 12l8-4.5', 'M12 12v9', 'M12 12L4 7.5'],
  monitor: ['M3 12h4l3-8 4 16 3-8h4'],
  history: ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0', 'M12 7v5l3 2'],
  settings: ['M4 7h10', 'M18 7h2', 'M4 17h2', 'M10 17h10', 'M14 5v4', 'M6 15v4'],
  docs: ['M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z', 'M5 17a3 3 0 0 1 3-3h10'],
  about: ['M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0', 'M12 11v5', 'M12 8h.01'],
  plus: ['M12 5v14', 'M5 12h14'],
  download: ['M12 4v11', 'M7 11l5 5 5-5', 'M5 20h14'],
  trash: ['M5 7h14', 'M10 7V4h4v3', 'M7 7l1 13h8l1-13'],
  copy: ['M9 9h10v11H9z', 'M5 15V4h10'],
  x: ['M6 6l12 12', 'M18 6L6 18'],
  check: ['M5 12l4 4 10-10'],
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  upload: ['M12 16V5', 'M7 9l5-5 5 5', 'M5 20h14'],
  alert: ['M12 4l9 16H3z', 'M12 10v4', 'M12 17h.01'],
  file: ['M7 3h7l4 4v14H7z', 'M14 3v4h4'],
  refresh: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 5v6h-6'],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v6H4V6h6'],
  link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1']
};

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
}

export function h(tag, attributes, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (name === 'class') node.className = value;
    else if (name === 'text') node.textContent = value;
    else if (name.startsWith('on') && typeof value === 'function') node.addEventListener(name.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(name, '');
    else node.setAttribute(name, String(value));
  }
  append(node, children);
  return node;
}

export function icon(name, { size = 20 } = {}) {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('icon');
  for (const definition of ICON_PATHS[name] ?? []) {
    const path = document.createElementNS(SVG_NAMESPACE, 'path');
    path.setAttribute('d', definition);
    svg.append(path);
  }
  return svg;
}

export function brandMark(size = 30) {
  gradientCounter += 1;
  const identifier = `brand-gradient-${gradientCounter}`;
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const definitions = document.createElementNS(SVG_NAMESPACE, 'defs');
  const gradient = document.createElementNS(SVG_NAMESPACE, 'linearGradient');
  gradient.setAttribute('id', identifier);
  gradient.setAttribute('x1', '0');
  gradient.setAttribute('y1', '0');
  gradient.setAttribute('x2', '1');
  gradient.setAttribute('y2', '1');
  for (const [offset, color] of [['0', '#5b8cff'], ['1', '#8f7bff']]) {
    const stop = document.createElementNS(SVG_NAMESPACE, 'stop');
    stop.setAttribute('offset', offset);
    stop.setAttribute('stop-color', color);
    gradient.append(stop);
  }
  definitions.append(gradient);
  const body = document.createElementNS(SVG_NAMESPACE, 'rect');
  body.setAttribute('width', '32');
  body.setAttribute('height', '32');
  body.setAttribute('rx', '8');
  body.setAttribute('fill', `url(#${identifier})`);
  const arrow = document.createElementNS(SVG_NAMESPACE, 'path');
  arrow.setAttribute('d', 'M16 7v12M11 14.5l5 5 5-5M9 24h14');
  arrow.setAttribute('fill', 'none');
  arrow.setAttribute('stroke', '#07101f');
  arrow.setAttribute('stroke-width', '2.4');
  arrow.setAttribute('stroke-linecap', 'round');
  arrow.setAttribute('stroke-linejoin', 'round');
  svg.append(definitions, body, arrow);
  return svg;
}

export function toast(message, kind = 'info') {
  const region = document.getElementById('toasts');
  if (!region) return;
  const node = h('div', { class: `toast toast-${kind}` }, message);
  region.append(node);
  setTimeout(() => node.remove(), 5000);
}

export function stateBadge(state) {
  return h('span', { class: `badge badge-${state}` }, h('span', { class: 'badge-dot' }), t(`state.${state}`));
}

export function confirmDialog(message, { confirmLabel, cancelLabel = t('common.cancel') } = {}) {
  return new Promise((resolve) => {
    const dialog = h('dialog', { class: 'dialog' });
    const finish = (value) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    dialog.append(
      h('p', { class: 'dialog-message' }, message),
      h(
        'div',
        { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'button', onclick: () => finish(false) }, cancelLabel),
        h('button', { type: 'button', class: 'button button-danger', onclick: () => finish(true) }, confirmLabel ?? t('common.delete'))
      )
    );
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(false);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const field = h('textarea', { class: 'visually-hidden', 'aria-hidden': 'true' });
    field.value = text;
    document.body.append(field);
    field.select();
    const succeeded = document.execCommand('copy');
    field.remove();
    return succeeded;
  }
}

export function saveBlob(blob, filename) {
  const address = URL.createObjectURL(blob);
  const link = h('a', { href: address, download: filename, class: 'visually-hidden' });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(address), 10000);
}

export function errorMessage(error) {
  return error?.message ?? String(error);
}

export function emptyState({ title, body, action }) {
  return h('div', { class: 'empty' }, h('h2', { class: 'empty-title' }, title), body ? h('p', { class: 'empty-body' }, body) : null, action ?? null);
}

export function loadingState() {
  return h('p', { class: 'loading', role: 'status' }, t('common.loading'));
}

export function errorState(message, onRetry) {
  return h(
    'div',
    { class: 'notice notice-danger', role: 'alert' },
    icon('alert'),
    h('div', { class: 'notice-body' }, h('p', null, message), onRetry ? h('button', { type: 'button', class: 'button button-small', onclick: onRetry }, icon('refresh', { size: 16 }), t('common.retry')) : null)
  );
}
