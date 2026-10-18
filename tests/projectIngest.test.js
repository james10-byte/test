import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { collectReferenceWarnings, detectEntryPoint, ingestHtml, ingestZip } from '../backend/src/project/projectIngest.js';
import { buildZip } from './helpers/zipBuilder.js';

const limits = {
  maxUploadBytes: 1024 * 1024,
  maxExtractedBytes: 1024 * 1024,
  maxZipFiles: 100,
  maxZipDepth: 6
};

const temporaryDirectory = () => fs.mkdtemp(path.join(os.tmpdir(), 'ingest-test-'));

test('entry point: index.html at the root wins', () => {
  assert.deepEqual(detectEntryPoint(['about.html', 'index.html', 'css/a.css']), { rootDirectory: '', entryFile: 'index.html' });
});

test('entry point: single html file is used', () => {
  assert.deepEqual(detectEntryPoint(['home.html', 'js/app.js']), { rootDirectory: '', entryFile: 'home.html' });
});

test('entry point: single wrapper directory is unwrapped', () => {
  assert.deepEqual(detectEntryPoint(['site/index.html', 'site/css/a.css']), { rootDirectory: 'site', entryFile: 'index.html' });
});

test('entry point: ambiguity is reported with candidates', () => {
  assert.throws(
    () => detectEntryPoint(['a.html', 'b.html']),
    (error) => error.code === 'ambiguous_entry_point' && error.details.candidates.length === 2
  );
  assert.throws(
    () => detectEntryPoint(['one/index.html', 'two/index.html']),
    (error) => error.code === 'ambiguous_entry_point'
  );
});

test('entry point: missing html is reported', () => {
  assert.throws(() => detectEntryPoint(['css/a.css', 'js/a.js']), (error) => error.code === 'missing_entry_point');
});

test('reference warnings list missing local and external resources', () => {
  const html = '<link href="css/site.css"><script src="js/app.js"></script><img src="/img/logo.png"><a href="#top"></a><img src="data:image/png;base64,AAA"><script src="https://cdn.example/lib.js"></script>';
  const warnings = collectReferenceWarnings(html, ['index.html', 'css/site.css', 'img/logo.png']);
  const missing = warnings.find((warning) => warning.code === 'missing_local_resources');
  const external = warnings.find((warning) => warning.code === 'external_resources');
  assert.deepEqual(missing.items, ['js/app.js']);
  assert.deepEqual(external.items, ['https://cdn.example/lib.js']);
});

test('reference warnings resolve relative to the entry directory and reject escapes', () => {
  const warnings = collectReferenceWarnings('<img src="../secret.png"><img src="a.png">', ['pages/a.png'], 'pages');
  assert.deepEqual(warnings[0].items, ['../secret.png']);
});

test('html ingestion writes index.html and warns about missing local resources', async () => {
  const directory = await temporaryDirectory();
  const result = await ingestHtml(Buffer.from('<!doctype html><html><body><img src="logo.png"></body></html>'), directory, { maxBytes: 1024 });
  assert.equal(result.entryFile, 'index.html');
  assert.equal(result.warnings[0].code, 'missing_local_resources');
  assert.ok((await fs.readFile(path.join(directory, 'index.html'), 'utf8')).includes('logo.png'));
  await fs.rm(directory, { recursive: true });
});

test('html ingestion rejects empty, binary, oversized and non html content', async () => {
  const directory = await temporaryDirectory();
  const run = (buffer, code) => assert.rejects(() => ingestHtml(buffer, directory, { maxBytes: 100 }), (error) => error.code === code);
  await run(Buffer.alloc(0), 'empty_html');
  await run(Buffer.from([0x3c, 0x68, 0x00, 0x01]), 'invalid_html');
  await run(Buffer.alloc(200, 0x61), 'html_too_large');
  await run(Buffer.from('just a plain sentence'), 'invalid_html');
  await run(Buffer.from([0xff, 0xfe, 0xfd, 0x3c]), 'invalid_encoding');
  await fs.rm(directory, { recursive: true });
});

test('zip ingestion detects the entry point inside a wrapper directory', async () => {
  const directory = await temporaryDirectory();
  const archive = buildZip([
    { name: 'mysite/index.html', data: '<html><link href="css/a.css"><img src="img/x.png"></html>' },
    { name: 'mysite/css/a.css', data: 'body{}' }
  ]);
  const result = await ingestZip(archive, directory, limits);
  assert.equal(result.rootDirectory, 'mysite');
  assert.equal(result.entryFile, 'index.html');
  assert.deepEqual(result.files.sort(), ['css/a.css', 'index.html']);
  assert.deepEqual(result.warnings[0].items, ['img/x.png']);
  await fs.rm(directory, { recursive: true });
});

test('zip ingestion propagates safety errors', async () => {
  const directory = await temporaryDirectory();
  await assert.rejects(() => ingestZip(buildZip([{ name: '../x.html', data: '<html>' }]), directory, limits), (error) => error.code === 'path_traversal');
  await assert.rejects(() => ingestZip(buildZip([{ name: 'readme.txt', data: 'hello' }]), directory, limits), (error) => error.code === 'missing_entry_point');
  await fs.rm(directory, { recursive: true });
});
