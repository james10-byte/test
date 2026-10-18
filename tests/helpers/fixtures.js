import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { loadConfig } from '../../backend/src/config.js';
import { buildZip } from './zipBuilder.js';

export const makeTemporaryDirectory = (prefix = 'fixture-') => fs.mkdtemp(path.join(os.tmpdir(), prefix));

export async function makeTestConfig(overrides = {}) {
  const root = await makeTemporaryDirectory('config-');
  const androidHome = path.join(root, 'sdk');
  await fs.mkdir(androidHome, { recursive: true });
  const config = loadConfig({
    DATA_DIR: root,
    ANDROID_HOME: androidHome,
    GRADLE_COMMAND: path.join(root, 'fake-gradle.sh'),
    ...overrides
  });
  return { config, root };
}

export const sampleIcon = () =>
  sharp({ create: { width: 256, height: 256, channels: 4, background: { r: 30, g: 120, b: 220, alpha: 1 } } }).png().toBuffer();

export const sampleHtml = () => Buffer.from('<!doctype html><html><body><h1>Hello</h1><img src="logo.png"></body></html>');

export const sampleSiteZip = () =>
  buildZip([
    { name: 'index.html', data: '<html><body><link href="css/a.css"></body></html>' },
    { name: 'css/a.css', data: 'body{}' },
    { name: '_next/chunk.js', data: 'x' }
  ]);

export const fakeApk = () =>
  buildZip([
    { name: 'AndroidManifest.xml', data: 'manifest' },
    { name: 'classes.dex', data: 'dex' },
    { name: 'resources.arsc', data: 'arsc' },
    { name: 'META-INF/CERT.RSA', data: 'signature' }
  ]);

export async function writeExecutable(file, body) {
  await fs.writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

export const validConfig = (overrides = {}) => ({
  appName: 'Demo App',
  packageId: 'com.example.demo',
  versionName: '1.2.3',
  versionCode: 7,
  orientation: 'portrait',
  statusBarColor: '#112233',
  navigationBarColor: '#445566',
  inputType: 'html',
  ...overrides
});

export async function waitFor(predicate, { timeout = 30000, interval = 25 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
