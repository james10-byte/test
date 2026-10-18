import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { extractZip, readZipEntries } from '../backend/src/security/zipSafe.js';
import { buildZip } from './helpers/zipBuilder.js';

const limits = {
  maxCompressedBytes: 1024 * 1024,
  maxExtractedBytes: 1024 * 1024,
  maxEntryBytes: 512 * 1024,
  maxFiles: 50,
  maxDepth: 5
};

const temporaryDirectory = () => fs.mkdtemp(path.join(os.tmpdir(), 'zip-test-'));

const expectCode = (promiseFactory, code) =>
  assert.rejects(promiseFactory, (error) => error.code === code);

test('extracts a normal website preserving relative paths', async () => {
  const directory = await temporaryDirectory();
  const archive = buildZip([
    { name: 'index.html', data: '<html></html>' },
    { name: 'css/', data: '' },
    { name: 'css/site.css', data: 'body{}', deflate: true },
    { name: 'images/logo.png', data: Buffer.from([1, 2, 3, 4]) }
  ]);
  const result = await extractZip(archive, directory, limits);
  assert.deepEqual(result.files.sort(), ['css/site.css', 'images/logo.png', 'index.html']);
  assert.equal(await fs.readFile(path.join(directory, 'css/site.css'), 'utf8'), 'body{}');
  await fs.rm(directory, { recursive: true });
});

test('rejects non zip data and truncated archives', async () => {
  const directory = await temporaryDirectory();
  await expectCode(() => extractZip(Buffer.from('plain text that is definitely not a zip'), directory, limits), 'invalid_zip');
  const valid = buildZip([{ name: 'index.html', data: 'x' }]);
  await expectCode(() => extractZip(valid.subarray(0, valid.length - 10), directory, limits), 'invalid_zip');
  await fs.rm(directory, { recursive: true });
});

test('rejects path traversal', async () => {
  const directory = await temporaryDirectory();
  await expectCode(() => extractZip(buildZip([{ name: '../evil.txt', data: 'x' }]), directory, limits), 'path_traversal');
  await expectCode(() => extractZip(buildZip([{ name: 'a/../../evil.txt', data: 'x' }]), directory, limits), 'path_traversal');
  await expectCode(() => extractZip(buildZip([{ name: '..\\evil.txt', data: 'x' }]), directory, limits), 'path_traversal');
  await assert.rejects(() => fs.access(path.join(directory, '..', 'evil.txt')));
  await fs.rm(directory, { recursive: true });
});

test('rejects absolute paths', async () => {
  const directory = await temporaryDirectory();
  await expectCode(() => extractZip(buildZip([{ name: '/etc/passwd', data: 'x' }]), directory, limits), 'absolute_path');
  await expectCode(() => extractZip(buildZip([{ name: 'C:\\windows\\x.txt', data: 'x' }]), directory, limits), 'absolute_path');
  await fs.rm(directory, { recursive: true });
});

test('rejects symlinks and encrypted entries', async () => {
  const directory = await temporaryDirectory();
  await expectCode(() => extractZip(buildZip([{ name: 'link', data: '/etc/passwd', symlink: true }]), directory, limits), 'symlink_rejected');
  await expectCode(() => extractZip(buildZip([{ name: 'a.txt', data: 'x', encrypted: true }]), directory, limits), 'encrypted_zip');
  await fs.rm(directory, { recursive: true });
});

test('rejects excessive file counts and depth', async () => {
  const directory = await temporaryDirectory();
  const many = Array.from({ length: 51 }, (_, index) => ({ name: `f${index}.txt`, data: 'x' }));
  await expectCode(() => extractZip(buildZip(many), directory, limits), 'too_many_files');
  await expectCode(() => extractZip(buildZip([{ name: 'a/b/c/d/e/f/g.txt', data: 'x' }]), directory, limits), 'too_deep');
  await fs.rm(directory, { recursive: true });
});

test('rejects excessive declared and real extraction sizes', async () => {
  const directory = await temporaryDirectory();
  await expectCode(
    () => extractZip(buildZip([{ name: 'big.bin', data: 'x', declaredSize: 600 * 1024 }]), directory, limits),
    'entry_too_large'
  );
  const total = buildZip([
    { name: 'a.bin', data: Buffer.alloc(400 * 1024, 1), deflate: true },
    { name: 'b.bin', data: Buffer.alloc(400 * 1024, 2), deflate: true },
    { name: 'c.bin', data: Buffer.alloc(400 * 1024, 3), deflate: true }
  ]);
  await expectCode(() => extractZip(total, directory, limits), 'archive_too_large_extracted');
  await fs.rm(directory, { recursive: true });
});

test('rejects declared sizes that lie about the real content', async () => {
  const directory = await temporaryDirectory();
  const lying = buildZip([{ name: 'a.txt', data: Buffer.alloc(5000, 7), deflate: true, declaredSize: 10 }]);
  await expectCode(() => extractZip(lying, directory, limits), 'corrupt_entry');
  await fs.rm(directory, { recursive: true });
});

test('rejects suspicious compression ratios', () => {
  const bomb = buildZip([{ name: 'zeros.bin', data: Buffer.alloc(500 * 1024 * 3, 0), deflate: true }]);
  assert.throws(
    () => readZipEntries(bomb, { ...limits, maxEntryBytes: 4 * 1024 * 1024, maxExtractedBytes: 4 * 1024 * 1024, maxCompressedBytes: 4 * 1024 * 1024 }),
    (error) => error.code === 'suspicious_compression_ratio'
  );
});

test('rejects duplicate and conflicting names', async () => {
  const directory = await temporaryDirectory();
  await expectCode(() => extractZip(buildZip([{ name: 'a.txt', data: 'x' }, { name: 'A.TXT', data: 'y' }]), directory, limits), 'duplicate_entry');
  await expectCode(() => extractZip(buildZip([{ name: 'a', data: 'x' }, { name: 'a/b.txt', data: 'y' }]), directory, limits), 'conflicting_entries');
  await fs.rm(directory, { recursive: true });
});

test('rejects archives without files and ignores macOS metadata', async () => {
  const directory = await temporaryDirectory();
  await expectCode(() => extractZip(buildZip([{ name: 'empty/', data: '' }]), directory, limits), 'empty_archive');
  const result = await extractZip(
    buildZip([{ name: 'index.html', data: 'x' }, { name: '__MACOSX/._index.html', data: 'y' }, { name: '.DS_Store', data: 'z' }]),
    directory,
    limits
  );
  assert.deepEqual(result.files, ['index.html']);
  await fs.rm(directory, { recursive: true });
});

test('oversized archives are refused before parsing', () => {
  const archive = buildZip([{ name: 'a.txt', data: 'x' }]);
  assert.throws(() => readZipEntries(archive, { ...limits, maxCompressedBytes: 10 }), (error) => error.code === 'archive_too_large');
});
