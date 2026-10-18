const KEY = 'inconnu.settings.v1';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export const DEFAULT_SETTINGS = Object.freeze({
  language: null,
  theme: 'dark',
  apiBase: '',
  apiKey: '',
  clientToken: null,
  defaults: Object.freeze({
    packageId: 'dev.inconnuboy.apkbuilder',
    versionName: '1.0.0',
    orientation: 'unspecified',
    statusBarColor: '#0B1020',
    navigationBarColor: '#0B1020'
  })
});

export const isValidToken = (value) => typeof value === 'string' && TOKEN_PATTERN.test(value);

export function generateToken(cryptoSource = globalThis.crypto) {
  const bytes = new Uint8Array(32);
  cryptoSource.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function loadSettings(storage = globalThis.localStorage) {
  let stored = {};
  try {
    stored = JSON.parse(storage?.getItem(KEY) ?? '{}') ?? {};
  } catch {
    stored = {};
  }
  const settings = {
    ...DEFAULT_SETTINGS,
    ...stored,
    defaults: { ...DEFAULT_SETTINGS.defaults, ...(stored.defaults ?? {}) }
  };
  if (!['dark', 'light', 'system'].includes(settings.theme)) settings.theme = 'dark';
  if (!isValidToken(settings.clientToken)) settings.clientToken = null;
  return settings;
}

export function saveSettings(patch, storage = globalThis.localStorage) {
  const current = loadSettings(storage);
  const next = {
    ...current,
    ...patch,
    defaults: { ...current.defaults, ...(patch.defaults ?? {}) }
  };
  storage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function ensureToken(storage = globalThis.localStorage, cryptoSource = globalThis.crypto) {
  const settings = loadSettings(storage);
  if (settings.clientToken) return settings.clientToken;
  const token = generateToken(cryptoSource);
  saveSettings({ clientToken: token }, storage);
  return token;
}

export function normalizeApiBase(value) {
  const trimmed = String(value ?? '').trim().replace(/\/+$/, '');
  if (trimmed === '') return '';
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.origin}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return null;
  }
}
