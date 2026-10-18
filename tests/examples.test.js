import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { validateBuildConfig } from '../backend/src/android/buildConfig.js';
import { ingestZip } from '../backend/src/project/projectIngest.js';
import { buildZip } from './helpers/zipBuilder.js';

const EXAMPLES = path.resolve(import.meta.dirname, '../examples');

async function collect(directory, prefix = '') {
  const entries = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) entries.push(...(await collect(path.join(directory, entry.name), `${prefix}${entry.name}/`)));
    else entries.push({ name: `${prefix}${entry.name}`, data: await fs.readFile(path.join(directory, entry.name)) });
  }
  return entries;
}

test('the sample website is a complete static site that the platform accepts without warnings', async () => {
  const archive = buildZip(await collect(path.join(EXAMPLES, 'sample-site')));
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'example-'));
  const result = await ingestZip(archive, destination, { maxUploadBytes: 1024 * 1024, maxExtractedBytes: 1024 * 1024, maxZipFiles: 50, maxZipDepth: 6 });
  assert.equal(result.entryFile, 'index.html');
  assert.deepEqual(result.files.sort(), ['css/style.css', 'images/logo.svg', 'index.html', 'js/app.js']);
  assert.deepEqual(result.warnings, []);
  await fs.rm(destination, { recursive: true });
});

test('the example build configurations pass server validation', async () => {
  const html = JSON.parse(await fs.readFile(path.join(EXAMPLES, 'build-config-html.json'), 'utf8'));
  const url = JSON.parse(await fs.readFile(path.join(EXAMPLES, 'build-config-url.json'), 'utf8'));
  assert.equal(validateBuildConfig(html).inputType, 'zip');
  assert.equal(validateBuildConfig(url).url, 'https://example.com/');
});
