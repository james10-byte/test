import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../backend/src/config.js';

test('defaults are safe and complete', () => {
  const config = loadConfig({});
  assert.equal(config.port, 3000);
  assert.equal(config.queue.concurrency, 1);
  assert.equal(config.limits.maxUploadBytes, 50 * 1024 * 1024);
  assert.equal(config.apiKey, null);
  assert.deepEqual(config.allowedOrigins, []);
});

test('environment overrides are parsed', () => {
  const config = loadConfig({ PORT: '8080', WORKER_CONCURRENCY: '3', ALLOWED_ORIGINS: 'https://a.example, https://b.example' });
  assert.equal(config.port, 8080);
  assert.equal(config.queue.concurrency, 3);
  assert.equal(config.allowedOrigins.length, 2);
});

test('invalid numbers are rejected', () => {
  assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT/);
  assert.throws(() => loadConfig({ QUEUE_LIMIT: '0' }), /QUEUE_LIMIT/);
  assert.throws(() => loadConfig({ BUILD_TIMEOUT_SECONDS: '1' }), /BUILD_TIMEOUT_SECONDS/);
});

test('invalid origins are rejected', () => {
  assert.throws(() => loadConfig({ ALLOWED_ORIGINS: 'not a url' }), /ALLOWED_ORIGINS/);
});

test('production requires an https public base url', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /PUBLIC_BASE_URL/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'http://example.com' }), /https/);
  assert.equal(loadConfig({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://example.com' }).environment, 'production');
});
