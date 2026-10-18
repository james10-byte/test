import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { ApiError, createApi } from '../frontend/js/api.js';
import { formatBytes, formatDuration, isActiveState, isExpired, shortHash } from '../frontend/js/format.js';
import { sha256Hex } from '../frontend/js/hash.js';
import { detectLanguage, getCatalogs, setLanguage, t } from '../frontend/js/i18n.js';
import { parseRoute, routeHash } from '../frontend/js/router.js';
import { createSseParser } from '../frontend/js/sse.js';
import { ensureToken, generateToken, isValidToken, loadSettings, normalizeApiBase, saveSettings } from '../frontend/js/storage.js';
import { buildConfigPayload, validateAppForm, validatePackageId, validateUrl } from '../frontend/js/validation.js';

const memoryStorage = () => {
  const map = new Map();
  return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)) };
};

const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

test('every locale defines exactly the same keys and placeholders as English', () => {
  const { en, fr, pt } = getCatalogs();
  for (const [name, catalog] of Object.entries({ fr, pt })) {
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(en).sort(), `${name} keys differ`);
    for (const key of Object.keys(en)) {
      assert.ok(catalog[key].trim().length > 0, `${name}.${key} is empty`);
      assert.deepEqual(placeholders(catalog[key]), placeholders(en[key]), `${name}.${key} placeholders differ`);
    }
  }
});

test('every literal translation key used by the interface exists', async () => {
  const { en } = getCatalogs();
  const directory = path.resolve(import.meta.dirname, '../frontend/js');
  const files = [];
  for (const entry of await fs.readdir(directory, { recursive: true })) if (entry.endsWith('.js') && !entry.startsWith('locales')) files.push(path.join(directory, entry));
  const missing = [];
  for (const file of files) {
    const source = await fs.readFile(file, 'utf8');
    for (const match of source.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)) if (!(match[1] in en)) missing.push(`${path.basename(file)}: ${match[1]}`);
  }
  assert.deepEqual(missing, []);
});

test('translation lookup falls back to English and then to the key', () => {
  setLanguage('fr');
  assert.equal(t('nav.settings'), 'Paramètres');
  assert.equal(t('history.pageInfo', { from: 1, to: 5, total: 9 }), '1–5 sur 9');
  assert.equal(t('missing.key'), 'missing.key');
  assert.equal(setLanguage('xx'), false);
  setLanguage('en');
  assert.equal(t('studio.build'), 'Build APK');
});

test('language detection honors the saved choice then browser languages', () => {
  assert.equal(detectLanguage('pt', ['fr-FR']), 'pt');
  assert.equal(detectLanguage(null, ['de-DE', 'fr-CA']), 'fr');
  assert.equal(detectLanguage(null, ['ja']), 'en');
  assert.equal(detectLanguage('xx', []), 'en');
});

test('formatting helpers', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5 MB');
  assert.equal(formatBytes(-1), '');
  assert.equal(formatDuration(65000), '01:05');
  assert.equal(formatDuration(3723000), '1:02:03');
  assert.equal(shortHash('a'.repeat(64)), 'aaaaaaaa…aaaaaaaa');
  assert.equal(isExpired('2020-01-01T00:00:00Z', Date.parse('2026-01-01T00:00:00Z')), true);
  assert.equal(isExpired(null), false);
  assert.equal(isActiveState('compiling'), true);
  assert.equal(isActiveState('completed'), false);
});

test('routes are parsed strictly', () => {
  assert.deepEqual(parseRoute(''), { name: 'dashboard', params: {} });
  assert.deepEqual(parseRoute('#/'), { name: 'dashboard', params: {} });
  assert.deepEqual(parseRoute('#/studio'), { name: 'studio', params: {} });
  assert.deepEqual(parseRoute('#/monitor'), { name: 'monitor', params: {} });
  assert.deepEqual(parseRoute(`#/monitor/${'a'.repeat(32)}`), { name: 'monitor', params: { id: 'a'.repeat(32) } });
  assert.equal(parseRoute('#/monitor/../../etc').name, 'notFound');
  assert.equal(parseRoute('#/monitor/ABC').name, 'notFound');
  assert.equal(parseRoute('#/unknown').name, 'notFound');
  assert.equal(routeHash('monitor', { id: 'b'.repeat(32) }), `#/monitor/${'b'.repeat(32)}`);
  assert.equal(routeHash('dashboard'), '#/');
});

test('server-sent events are parsed across chunk boundaries', () => {
  const messages = [];
  const parser = createSseParser((message) => messages.push(message));
  parser.feed('id: 3\nevent: log\ndata: {"line":"hel');
  parser.feed('lo"}\n\nevent: heartbeat\ndata: {}\n');
  parser.feed('\n: comment\nevent: end\ndata: a\ndata: b\n\n');
  assert.deepEqual(messages, [
    { event: 'log', data: '{"line":"hello"}', id: '3' },
    { event: 'heartbeat', data: '{}', id: '3' },
    { event: 'end', data: 'a\nb', id: '3' }
  ]);
});

test('settings persist, merge defaults and reject corrupted storage', () => {
  const storage = memoryStorage();
  assert.equal(loadSettings(storage).theme, 'dark');
  saveSettings({ theme: 'light', defaults: { packageId: 'com.example.app' } }, storage);
  const loaded = loadSettings(storage);
  assert.equal(loaded.theme, 'light');
  assert.equal(loaded.defaults.packageId, 'com.example.app');
  assert.equal(loaded.defaults.versionName, '1.0.0');
  storage.setItem('inconnu.settings.v1', '{not json');
  assert.equal(loadSettings(storage).theme, 'dark');
  storage.setItem('inconnu.settings.v1', JSON.stringify({ theme: 'neon', clientToken: 'short' }));
  const sanitized = loadSettings(storage);
  assert.equal(sanitized.theme, 'dark');
  assert.equal(sanitized.clientToken, null);
});

test('access tokens are generated once, valid and url safe', () => {
  const storage = memoryStorage();
  const token = ensureToken(storage);
  assert.ok(isValidToken(token));
  assert.equal(token.length, 43);
  assert.equal(ensureToken(storage), token);
  assert.notEqual(generateToken(), generateToken());
  assert.equal(isValidToken('short'), false);
  assert.equal(isValidToken('x'.repeat(129)), false);
  assert.equal(isValidToken('has space '.repeat(5)), false);
});

test('api base addresses are normalized', () => {
  assert.equal(normalizeApiBase(''), '');
  assert.equal(normalizeApiBase(' https://api.example.com/ '), 'https://api.example.com');
  assert.equal(normalizeApiBase('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(normalizeApiBase('ftp://x.example'), null);
  assert.equal(normalizeApiBase('not a url'), null);
});

test('validation mirrors the server rules', () => {
  assert.equal(validatePackageId('com.example.app'), null);
  assert.equal(validatePackageId('single').key, 'validation.packageId');
  assert.equal(validatePackageId('com.example.class').key, 'validation.packageKeyword');
  assert.equal(validatePackageId('Com.Example').key, 'validation.packageId');
  assert.equal(validateUrl('https://example.com'), null);
  assert.equal(validateUrl('http://example.com').key, 'validation.https');
  assert.equal(validateUrl('nope').key, 'validation.url');
  assert.equal(validateUrl('').key, 'validation.required');
  const base = { appName: 'Demo', packageId: 'com.example.demo', versionName: '1.0.0', versionCode: '1', statusBarColor: '#112233', navigationBarColor: '#445566', inputType: 'html', file: {} };
  assert.deepEqual(validateAppForm(base), {});
  const broken = validateAppForm({ ...base, appName: ' ', versionCode: '0', versionName: 'a b', statusBarColor: 'red', file: null });
  assert.deepEqual(Object.keys(broken).sort(), ['appName', 'source', 'statusBarColor', 'versionCode', 'versionName']);
  assert.equal(validateAppForm({ ...base, versionCode: '1.5' }).versionCode.key, 'validation.versionCode');
  assert.equal(validateAppForm({ ...base, inputType: 'url', url: 'http://x.example', file: null }).source.key, 'validation.https');
});

test('the configuration payload matches what the server accepts', () => {
  const payload = buildConfigPayload({
    appName: '  Demo  ',
    packageId: 'com.example.demo',
    versionName: '1.0.0',
    versionCode: '12',
    orientation: 'portrait',
    statusBarColor: '#aabbcc',
    navigationBarColor: '#112233',
    inputType: 'url',
    url: ' https://example.com ',
    icon: { background: 'transparent', scale: 1 }
  });
  assert.equal(payload.appName, 'Demo');
  assert.equal(payload.versionCode, 12);
  assert.equal(payload.statusBarColor, '#AABBCC');
  assert.equal(payload.url, 'https://example.com');
  assert.equal(payload.signing, 'debug');
});

test('sha-256 helper matches a known digest', async () => {
  assert.equal(await sha256Hex(new TextEncoder().encode('abc').buffer), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await sha256Hex(new ArrayBuffer(1), {}), null);
});

test('api client sends credentials and maps errors', async () => {
  const calls = [];
  const settings = { apiBase: 'https://api.example.com', clientToken: 'x'.repeat(43), apiKey: 'secret' };
  const responses = [
    new Response(JSON.stringify({ builds: [], stats: {} }), { status: 200 }),
    new Response(JSON.stringify({ error: { code: 'build_not_found', message: 'Build not found.' } }), { status: 404 })
  ];
  const api = createApi({ getSettings: () => settings, fetchImpl: async (address, options) => { calls.push([address, options.headers]); return responses.shift(); } });
  await api.listBuilds({ limit: 5, offset: 10 });
  assert.equal(calls[0][0], 'https://api.example.com/api/builds?limit=5&offset=10');
  assert.equal(calls[0][1]['X-Client-Token'], settings.clientToken);
  assert.equal(calls[0][1].Authorization, 'Bearer secret');
  await assert.rejects(() => api.getBuild('a'.repeat(32)), (error) => error instanceof ApiError && error.status === 404 && error.code === 'build_not_found');
  const offline = createApi({ getSettings: () => ({ ...settings, apiKey: '' }), fetchImpl: async () => { throw new TypeError('failed'); } });
  await assert.rejects(() => offline.getBuild('a'.repeat(32)), (error) => error.code === 'network_error' && error.status === 0);
});

test('the sse stream reader delivers events and sends the resume header', async () => {
  let seenHeaders;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('id: 1\nevent: log\ndata: {"line":"a"}\n\nevent: end\n'));
      controller.enqueue(new TextEncoder().encode('data: {"state":"completed"}\n\n'));
      controller.close();
    }
  });
  const api = createApi({ getSettings: () => ({ apiBase: '', clientToken: 'x'.repeat(43), apiKey: '' }), fetchImpl: async (address, options) => { seenHeaders = options.headers; return new Response(body, { status: 200 }); } });
  const events = [];
  await api.streamEvents('a'.repeat(32), { signal: new AbortController().signal, lastEventId: 7, onEvent: (event) => events.push(event) });
  assert.equal(seenHeaders['Last-Event-ID'], '7');
  assert.deepEqual(events.map((event) => [event.type, event.data]), [['log', { line: 'a' }], ['end', { state: 'completed' }]]);
});
