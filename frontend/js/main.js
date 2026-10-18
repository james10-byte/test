import { createApi } from './api.js';
import { detectLanguage, setLanguage, t } from './i18n.js';
import { parseRoute } from './router.js';
import { ensureToken, loadSettings, saveSettings } from './storage.js';
import { brandMark, h, icon } from './ui.js';
import { renderAbout } from './views/about.js';
import { renderDashboard } from './views/dashboard.js';
import { renderDocs } from './views/docs.js';
import { renderHistory } from './views/history.js';
import { renderMonitor } from './views/monitor.js';
import { renderSettings } from './views/settings.js';
import { renderStudio } from './views/studio.js';
import { emptyState } from './ui.js';

const NAVIGATION = [
  { name: 'dashboard', hash: '#/', icon: 'dashboard', label: 'nav.dashboard' },
  { name: 'studio', hash: '#/studio', icon: 'studio', label: 'nav.studio' },
  { name: 'monitor', hash: '#/monitor', icon: 'monitor', label: 'nav.monitor' },
  { name: 'history', hash: '#/history', icon: 'history', label: 'nav.history' },
  { name: 'settings', hash: '#/settings', icon: 'settings', label: 'nav.settings' },
  { name: 'docs', hash: '#/docs', icon: 'docs', label: 'nav.docs' },
  { name: 'about', hash: '#/about', icon: 'about', label: 'nav.about' }
];

const VIEWS = {
  dashboard: renderDashboard,
  studio: renderStudio,
  monitor: renderMonitor,
  history: renderHistory,
  settings: renderSettings,
  docs: renderDocs,
  about: renderAbout,
  notFound: (main) => {
    main.append(h('h1', { class: 'page-title' }, '404'), emptyState({ title: t('dashboard.emptyTitle'), action: h('a', { class: 'button', href: '#/' }, t('nav.dashboard')) }));
  }
};

const HEALTH_INTERVAL_MS = 30000;
const root = document.getElementById('app');
const colorScheme = window.matchMedia('(prefers-color-scheme: light)');

let settings = loadSettings();
ensureToken();
settings = loadSettings();
let connection = navigator.onLine ? 'checking' : 'offline';
let cleanup = null;
let main = null;
let firstRender = true;
let closeDrawer = () => {};

const effectiveSettings = () => ({ ...settings, apiBase: settings.apiBase || window.INCONNU_CONFIG?.apiBase || '' });
const api = createApi({ getSettings: effectiveSettings });

function applyTheme() {
  const resolved = settings.theme === 'system' ? (colorScheme.matches ? 'light' : 'dark') : settings.theme;
  document.documentElement.dataset.theme = resolved;
}

function applyLanguage() {
  setLanguage(detectLanguage(settings.language, navigator.languages ?? [navigator.language]));
}

const context = {
  api,
  getSettings: effectiveSettings,
  updateSettings(patch) {
    settings = saveSettings(patch);
    applyTheme();
    if ('language' in patch) {
      applyLanguage();
      renderApplication();
    }
    return settings;
  }
};

function statusText() {
  if (connection === 'offline') return t('status.offline');
  if (connection === 'unreachable') return t('status.unreachable');
  if (connection === 'online') return t('status.online');
  return t('status.checking');
}

function updateStatus() {
  const indicator = document.getElementById('connection-status');
  if (indicator) {
    indicator.className = `connection connection-${connection}`;
    indicator.querySelector('.connection-text').textContent = connection === 'offline' ? t('status.offline').split('.')[0] : statusText();
  }
  const banner = document.getElementById('banner');
  if (banner) {
    const visible = connection === 'offline' || connection === 'unreachable';
    banner.hidden = !visible;
    banner.textContent = visible ? statusText() : '';
  }
}

async function checkHealth() {
  if (!navigator.onLine) {
    connection = 'offline';
    updateStatus();
    return;
  }
  try {
    await api.health();
    connection = 'online';
  } catch {
    connection = 'unreachable';
  }
  updateStatus();
}

function buildShell() {
  const route = parseRoute(location.hash);
  const links = NAVIGATION.map((item) =>
    h(
      'a',
      { class: 'nav-link', href: item.hash, 'aria-current': item.name === route.name ? 'page' : null },
      icon(item.icon),
      h('span', null, t(item.label))
    )
  );
  const sidebar = h(
    'aside',
    { class: 'sidebar', id: 'sidebar' },
    h('a', { class: 'brand', href: '#/' }, brandMark(32), h('span', { class: 'brand-name' }, t('app.name'))),
    h('nav', { class: 'nav', 'aria-label': t('nav.primary') }, links),
    h('div', { id: 'connection-status', class: 'connection connection-checking' }, h('span', { class: 'connection-dot' }), h('span', { class: 'connection-text' }, t('status.checking')))
  );
  const scrim = h('div', { class: 'scrim', hidden: true });
  const toggle = h('button', { type: 'button', class: 'icon-button menu-button', 'aria-expanded': 'false', 'aria-controls': 'sidebar', 'aria-label': t('nav.menu') }, icon('menu', { size: 22 }));
  const setDrawer = (open) => {
    sidebar.classList.toggle('sidebar-open', open);
    scrim.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', () => setDrawer(!sidebar.classList.contains('sidebar-open')));
  scrim.addEventListener('click', () => setDrawer(false));
  sidebar.addEventListener('click', (event) => {
    if (event.target.closest('a')) setDrawer(false);
  });
  closeDrawer = () => setDrawer(false);
  const topbar = h('header', { class: 'topbar' }, h('a', { class: 'brand brand-compact', href: '#/' }, brandMark(28), h('span', { class: 'brand-name' }, t('app.name'))), toggle);
  main = h('main', { id: 'main', class: 'main', tabindex: '-1' });
  return h(
    'div',
    { class: 'shell' },
    h('a', { class: 'skip-link', href: '#main' }, t('nav.skip')),
    topbar,
    sidebar,
    scrim,
    h('div', { class: 'content' }, h('div', { id: 'banner', class: 'banner', role: 'status', hidden: true }), main)
  );
}

function renderRoute() {
  if (cleanup) cleanup();
  cleanup = null;
  const route = parseRoute(location.hash);
  for (const link of document.querySelectorAll('.nav-link')) {
    const target = parseRoute(link.getAttribute('href'));
    if (target.name === route.name) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  main.replaceChildren();
  const view = VIEWS[route.name] ?? VIEWS.notFound;
  cleanup = view(main, { ...context, route }) ?? null;
  if (!firstRender) main.focus({ preventScroll: true });
  firstRender = false;
  window.scrollTo(0, 0);
  document.title = `${route.name === 'dashboard' ? '' : `${t(NAVIGATION.find((item) => item.name === route.name)?.label ?? 'app.name')} · `}${t('app.name')}`;
}

function renderApplication() {
  if (cleanup) cleanup();
  cleanup = null;
  root.replaceChildren(buildShell());
  updateStatus();
  renderRoute();
}

applyLanguage();
applyTheme();
renderApplication();
window.addEventListener('hashchange', renderRoute);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeDrawer();
});
window.addEventListener('online', checkHealth);
window.addEventListener('offline', () => {
  connection = 'offline';
  updateStatus();
});
colorScheme.addEventListener('change', applyTheme);
checkHealth();
setInterval(checkHealth, HEALTH_INTERVAL_MS);

